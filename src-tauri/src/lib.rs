#[macro_use]
mod i18n;
mod adapter;
mod discovery;
mod extras;
mod model;
mod printjob;
mod settings;
mod slicer;
mod threemf;

use adapter::{creality::CrealityWsAdapter, AdapterEvent, ConnectionState, PrinterAdapter};
use model::{PrintState, PrinterHistory, PrinterStatus};
use serde::{Deserialize, Serialize};
use settings::Settings;
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, watch};

/// 60 Minuten bei einer Probe pro Sekunde
const MAX_SAMPLES: usize = 3600;
const MAX_JOBS: usize = 300;
/// Erst nach dieser Zeit ohne Verbindung wird „Verbindung verloren“ gemeldet.
const DISCONNECT_GRACE: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    t: i64,
    nozzle: Option<f64>,
    nozzle_target: Option<f64>,
    bed: Option<f64>,
    bed_target: Option<f64>,
    speed: Option<f64>,
    flow: Option<f64>,
    fan: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    file: String,
    started_ms: i64,
    ended_ms: i64,
    duration_s: f64,
    /// "finished" | "failed" | "aborted"
    result: String,
    layers: Option<i64>,
}

#[derive(Default)]
struct ActiveJob {
    file: String,
    started_ms: i64,
    total_layers: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    connection: ConnectionState,
    status: Option<PrinterStatus>,
    samples: Vec<Sample>,
}

struct Inner {
    settings: Settings,
    connection: ConnectionState,
    status: Option<PrinterStatus>,
    samples: VecDeque<Sample>,
    jobs: Vec<JobRecord>,
    active_job: Option<ActiveJob>,
    shutdown: Option<watch::Sender<bool>>,
    disconnect_notified: bool,
    printer_history: Option<PrinterHistory>,
}

pub struct AppState {
    inner: Mutex<Inner>,
    /// Erhöht sich bei jedem Verbindungsneustart, damit alte Tasks ihre Events verwerfen.
    generation: AtomicU64,
    /// Erhöht sich bei jedem Verbindungsverlust (für die verzögerte Meldung).
    disconnect_seq: AtomicU64,
    paths: Paths,
}

struct Paths {
    settings: PathBuf,
    jobs: PathBuf,
    printer_history: PathBuf,
    raw_log_dir: PathBuf,
    queue_dir: PathBuf,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl AppState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // Ein Panic in einem anderen Thread soll die App nicht lahmlegen.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
    // Zusätzlich aufs Handy, wenn ein ntfy-Thema eingetragen ist
    let topic = app.state::<Arc<AppState>>().lock().settings.ntfy_topic.clone();
    if !topic.is_empty() {
        let (title, body) = (title.to_string(), body.to_string());
        tauri::async_runtime::spawn(async move {
            let _ = extras::push(&topic, &title, &body, "printer").await;
        });
    }
}

/// (Neu)start der Verbindung mit den aktuellen Einstellungen.
fn restart_connection(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (host, old) = {
        let mut inner = state.lock();
        let old = inner.shutdown.take();
        inner.status = None;
        inner.samples.clear();
        inner.disconnect_notified = false;
        (inner.settings.printer_ip.clone(), old)
    };
    if let Some(tx) = old {
        let _ = tx.send(true);
    }

    if host.is_empty() {
        set_connection(app, &state, ConnectionState::Unconfigured);
        let _ = app.emit("printer://status", Option::<PrinterStatus>::None);
        return;
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    state.lock().shutdown = Some(shutdown_tx);
    let (tx, mut rx) = mpsc::unbounded_channel::<AdapterEvent>();

    let adapter: Box<dyn PrinterAdapter> = Box::new(CrealityWsAdapter);
    tauri::async_runtime::spawn(adapter.run(host, tx, shutdown_rx));

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let state = app.state::<Arc<AppState>>();
            if state.generation.load(Ordering::SeqCst) != gen {
                break;
            }
            match ev {
                AdapterEvent::Connection(c) => set_connection(&app, &state, c),
                AdapterEvent::Status(s) => handle_status(&app, &state, s),
                AdapterEvent::Raw { incoming, text } => write_raw(&state, incoming, &text),
                AdapterEvent::History(h) => {
                    if let Ok(data) = serde_json::to_string(&h) {
                        let _ = std::fs::write(&state.paths.printer_history, data);
                    }
                    state.lock().printer_history = Some(h.clone());
                    let _ = app.emit("printer://history", &h);
                }
            }
        }
    });
}

fn set_connection(app: &AppHandle, state: &Arc<AppState>, c: ConnectionState) {
    let was_connected = {
        let mut inner = state.lock();
        let was = inner.connection.is_connected();
        if c.is_connected() {
            inner.disconnect_notified = false;
        }
        if inner.connection == c {
            return;
        }
        inner.connection = c.clone();
        was
    };
    let _ = app.emit("printer://connection", &c);

    if was_connected && !c.is_connected() && !matches!(c, ConnectionState::Unconfigured) {
        // Verzögert melden – kurze Aussetzer sollen niemanden wecken.
        let seq = state.disconnect_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(DISCONNECT_GRACE).await;
            let state = app.state::<Arc<AppState>>();
            if state.disconnect_seq.load(Ordering::SeqCst) != seq {
                return;
            }
            let (should, name) = {
                let mut inner = state.lock();
                let should = !inner.connection.is_connected()
                    && !matches!(inner.connection, ConnectionState::Unconfigured)
                    && inner.settings.notify_disconnect
                    && !inner.disconnect_notified;
                if should {
                    inner.disconnect_notified = true;
                }
                (should, inner.settings.printer_name.clone())
            };
            if should {
                notify(&app, "Verbindung verloren", &trf!("{name} ist nicht mehr erreichbar. Ich versuche es weiter.", "{name} is no longer reachable. Still trying."));
            }
        });
    }
}

fn handle_status(app: &AppHandle, state: &Arc<AppState>, s: PrinterStatus) {
    let mut notes: Vec<(String, String)> = Vec::new();
    let mut job_done = false;
    {
        let mut inner = state.lock();
        let prev = inner.status.clone();
        let prev_state = prev.as_ref().map(|p| p.state).unwrap_or_default();
        let file = s.file_name.clone().unwrap_or_else(|| "Unbenannter Druck".into());

        // --- Druckauftrag verfolgen (für den Verlauf) ---
        if s.state.is_active() {
            let changed = inner.active_job.as_ref().map(|j| j.file != file).unwrap_or(true);
            if changed {
                let started = now_ms() - (s.elapsed_s.unwrap_or(0.0) * 1000.0) as i64;
                inner.active_job = Some(ActiveJob { file: file.clone(), started_ms: started, total_layers: None });
            }
            if let Some(j) = inner.active_job.as_mut() {
                j.total_layers = s.total_layers.or(j.total_layers);
            }
        } else if matches!(s.state, PrintState::Finished | PrintState::Failed | PrintState::Aborted) {
            if let Some(j) = inner.active_job.take() {
                let ended = now_ms();
                let result = match s.state {
                    PrintState::Finished => "finished",
                    PrintState::Failed => "failed",
                    _ => "aborted",
                };
                inner.jobs.insert(
                    0,
                    JobRecord {
                        file: j.file,
                        started_ms: j.started_ms,
                        ended_ms: ended,
                        duration_s: s.elapsed_s.unwrap_or(((ended - j.started_ms) / 1000) as f64),
                        result: result.into(),
                        layers: j.total_layers,
                    },
                );
                inner.jobs.truncate(MAX_JOBS);
                job_done = true;
            }
        } else if s.state == PrintState::Idle {
            inner.active_job = None;
        }

        // --- Benachrichtigungen (nur bei echten Übergängen) ---
        let st = &inner.settings;
        if prev_state.is_active() && prev_state != s.state {
            match s.state {
                PrintState::Finished if st.notify_finished => {
                    let next = extras::Queue::new(state.paths.queue_dir.clone()).list().into_iter().next();
                    let body = match next {
                        Some(n) => {
                            let next = n.name;
                            trf!("„{file}“ ist fertig gedruckt. Als Nächstes wartet „{next}“ – Platte leeren und starten.", "“{file}” has finished printing. Next up is “{next}” – clear the plate and start it.")
                        }
                        None => trf!("„{file}“ ist fertig gedruckt.", "“{file}” has finished printing."),
                    };
                    notes.push((crate::i18n::tr("Druck fertig", "Print finished").into(), body))
                }
                PrintState::Paused if st.notify_finished => {
                    notes.push((crate::i18n::tr("Druck pausiert", "Print paused").into(), trf!("„{file}“ ist pausiert – zum Beispiel für einen Filamentwechsel.", "“{file}” is paused – for example for a filament change.")))
                }
                PrintState::Failed if st.notify_error => {
                    notes.push((crate::i18n::tr("Druck fehlgeschlagen", "Print failed").into(), trf!("„{file}“ wurde mit einem Fehler beendet.", "“{file}” ended with an error.")))
                }
                PrintState::Aborted if st.notify_error => {
                    notes.push((crate::i18n::tr("Druck abgebrochen", "Print cancelled").into(), trf!("„{file}“ wurde abgebrochen.", "“{file}” was cancelled.")))
                }
                _ => {}
            }
        }
        let prev_err = prev.as_ref().and_then(|p| p.error_code).unwrap_or(0);
        let err = s.error_code.unwrap_or(0);
        if prev.is_some() && err != 0 && err != prev_err && st.notify_error {
            notes.push((crate::i18n::tr("Druckerfehler", "Printer error").into(), trf!("Der Drucker meldet Fehlercode {err}.", "The printer reports error code {err}.")));
        }

        inner.status = Some(s.clone());
    }
    let _ = app.emit("printer://status", Some(&s));
    update_tray(app, &s);
    for (t, b) in notes {
        notify(app, &t, &b);
    }
    if job_done {
        save_jobs(state);
        let _ = app.emit("printer://jobs", ());
    }
}

/// Text für die Menüleiste: „47 % · 22:26“ beim Drucken, „⏸ 47 %“ in der Pause, sonst leer.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn tray_text(s: &PrinterStatus) -> String {
    let pct = s.progress.unwrap_or(0.0).round() as i64;
    match s.state {
        PrintState::Printing if s.preparing => "🔥".into(),
        PrintState::Printing => match s.remaining_s {
            Some(r) if r > 0.0 => {
                let end = chrono::Local::now() + chrono::Duration::seconds(r as i64);
                format!("{pct} % · {}", end.format("%H:%M"))
            }
            _ => format!("{pct} %"),
        },
        PrintState::Paused => format!("⏸ {pct} %"),
        PrintState::Finished => "✓".into(),
        _ => String::new(),
    }
}

#[cfg(target_os = "macos")]
fn update_tray(app: &AppHandle, s: &PrinterStatus) {
    static LAST: Mutex<String> = Mutex::new(String::new());
    let text = tray_text(s);
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if *last == text {
            return;
        }
        *last = text.clone();
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(if text.is_empty() { None } else { Some(text.as_str()) });
        let _ = tray.set_tooltip(Some(if text.is_empty() { "Druckerwacht".to_string() } else { format!("Druckerwacht · {text}") }));
    }
}

#[cfg(not(target_os = "macos"))]
fn update_tray(_app: &AppHandle, _s: &PrinterStatus) {}

#[cfg(target_os = "macos")]
fn setup_tray(app: &tauri::App) {
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
    let Some(icon) = app.default_window_icon().cloned() else { return };
    let _ = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Druckerwacht")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app);
}

#[cfg(not(target_os = "macos"))]
fn setup_tray(_app: &tauri::App) {}

fn write_raw(state: &Arc<AppState>, incoming: bool, text: &str) {
    if !state.lock().settings.raw_log {
        return;
    }
    let dir = &state.paths.raw_log_dir;
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let file = dir.join(format!("{}.jsonl", chrono::Local::now().format("%Y-%m-%d")));
    let payload = serde_json::from_str::<serde_json::Value>(text).unwrap_or(serde_json::Value::String(text.into()));
    let line = serde_json::json!({ "t": now_ms(), "dir": if incoming { "in" } else { "out" }, "msg": payload });
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{line}");
    }
}

fn save_jobs(state: &Arc<AppState>) {
    let jobs = state.lock().jobs.clone();
    if let Some(dir) = state.paths.jobs.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(data) = serde_json::to_string(&jobs) {
        let _ = std::fs::write(&state.paths.jobs, data);
    }
}

/// Eine Probe pro Sekunde für die Diagramme.
fn spawn_sampler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            let state = app.state::<Arc<AppState>>();
            let sample = {
                let mut inner = state.lock();
                if !inner.connection.is_connected() {
                    continue;
                }
                let Some(s) = inner.status.as_ref() else { continue };
                let sample = Sample {
                    t: now_ms(),
                    nozzle: s.nozzle_temp,
                    nozzle_target: s.nozzle_target,
                    bed: s.bed_temp,
                    bed_target: s.bed_target,
                    speed: s.speed_mm_s,
                    flow: s.flow_pct,
                    fan: s.fan_pct,
                };
                inner.samples.push_back(sample.clone());
                while inner.samples.len() > MAX_SAMPLES {
                    inner.samples.pop_front();
                }
                sample
            };
            let _ = app.emit("printer://sample", &sample);
        }
    });
}

// ----------------------------------------------------------------------------- Befehle

#[tauri::command]
fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    state.lock().settings.clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, Arc<AppState>>, settings: Settings) -> Result<Settings, String> {
    let settings = settings.normalized();
    settings
        .save(&state.paths.settings)
        .map_err(|_| crate::i18n::tr("Einstellungen konnten nicht gespeichert werden.", "Settings could not be saved.").to_string())?;
    let reconnect = {
        let mut inner = state.lock();
        let reconnect = inner.settings.printer_ip != settings.printer_ip;
        inner.settings = settings.clone();
        reconnect
    };
    if reconnect {
        restart_connection(&app);
    }
    Ok(settings)
}

#[tauri::command]
fn reconnect(app: AppHandle) {
    restart_connection(&app);
}

#[tauri::command]
fn get_snapshot(state: State<'_, Arc<AppState>>) -> Snapshot {
    let inner = state.lock();
    Snapshot {
        connection: inner.connection.clone(),
        status: inner.status.clone(),
        samples: inner.samples.iter().cloned().collect(),
    }
}

#[tauri::command]
fn get_jobs(state: State<'_, Arc<AppState>>) -> Vec<JobRecord> {
    state.lock().jobs.clone()
}

#[tauri::command]
fn get_printer_history(state: State<'_, Arc<AppState>>) -> Option<PrinterHistory> {
    state.lock().printer_history.clone()
}

#[tauri::command]
fn clear_jobs(state: State<'_, Arc<AppState>>) {
    state.lock().jobs.clear();
    save_jobs(&state);
}

#[tauri::command]
async fn discover_printers() -> Vec<discovery::FoundPrinter> {
    discovery::discover().await
}

#[tauri::command]
fn raw_log_dir(state: State<'_, Arc<AppState>>) -> String {
    state.paths.raw_log_dir.to_string_lossy().into_owned()
}

// ----------------------------------------------------------------------------- Slicer

#[tauri::command]
fn slicer_info(state: State<'_, Arc<AppState>>) -> serde_json::Value {
    let custom = state.lock().settings.orca_path.clone();
    serde_json::to_value(slicer::find_orca(&custom)).unwrap_or_default()
}

#[tauri::command]
fn slicer_presets(app: AppHandle) -> Result<slicer::Presets, String> {
    slicer::load_presets(&app)
}

#[tauri::command]
fn slicer_save_preset(app: AppHandle, kind: String, preset: serde_json::Value) -> Result<(), String> {
    slicer::save_user_preset(&app, &kind, preset)
}

#[tauri::command]
fn slicer_delete_preset(app: AppHandle, kind: String, name: String) -> Result<(), String> {
    slicer::delete_user_preset(&app, &kind, &name)
}

#[tauri::command]
async fn slicer_slice(app: AppHandle, job: slicer::SliceJob) -> Result<slicer::SliceResult, String> {
    let custom = app.state::<Arc<AppState>>().lock().settings.orca_path.clone();
    let info = slicer::find_orca(&custom);
    let Some(path) = info.path_buf() else {
        return Err(crate::i18n::tr("OrcaSlicer wurde nicht gefunden. Bitte installieren oder den Pfad in den Einstellungen eintragen.", "OrcaSlicer was not found. Please install it or enter its path in Settings.").into());
    };
    slicer::slice(app, path, job).await
}

#[tauri::command]
fn slicer_cancel(app: AppHandle) {
    slicer::cancel(&app);
}

/// Liest eine 3D-Datei (STL/OBJ/3MF), die der Nutzer gewählt oder hineingezogen hat.
#[tauri::command]
fn read_model_file(path: String) -> Result<String, String> {
    use base64::Engine;
    let p = std::path::Path::new(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["stl", "obj", "3mf"].contains(&ext.as_str()) {
        return Err(crate::i18n::tr("Nur STL-, OBJ- und 3MF-Dateien werden unterstützt.", "Only STL, OBJ and 3MF files are supported.").into());
    }
    let meta = std::fs::metadata(p).map_err(|_| crate::i18n::tr("Datei nicht gefunden.", "File not found.").to_string())?;
    if meta.len() > 400 * 1024 * 1024 {
        return Err(crate::i18n::tr("Die Datei ist zu groß (über 400 MB).", "The file is too large (over 400 MB).").into());
    }
    let bytes = std::fs::read(p).map_err(|_| crate::i18n::tr("Datei konnte nicht gelesen werden.", "The file could not be read.").to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Liest den zuletzt erzeugten G-Code für die Vorschau (nur aus dem Slice-Ordner).
#[tauri::command]
fn read_gcode(app: AppHandle, path: String) -> Result<String, String> {
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("slice");
    let p = std::path::Path::new(&path);
    if !p.starts_with(&base) {
        return Err(crate::i18n::tr("Zugriff verweigert.", "Access denied.").into());
    }
    std::fs::read_to_string(p).map_err(|_| crate::i18n::tr("G-Code konnte nicht gelesen werden.", "The G-code could not be read.").to_string())
}

/// Speichert den erzeugten G-Code an einen vom Nutzer gewählten Ort.
#[tauri::command]
fn export_gcode(app: AppHandle, from: String, to: String, pauses: Option<Vec<u32>>) -> Result<(), String> {
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("slice");
    if !std::path::Path::new(&from).starts_with(&base) {
        return Err(crate::i18n::tr("Zugriff verweigert.", "Access denied.").into());
    }
    let saved = crate::i18n::tr("Datei konnte nicht gespeichert werden.", "The file could not be saved.");
    let data = std::fs::read(&from).map_err(|_| saved.to_string())?;
    std::fs::write(&to, with_pauses(data, pauses.as_deref())).map_err(|_| saved.to_string())
}

/// G-Code mit den gewünschten Filamentwechsel-Pausen (unverändert, wenn keine gesetzt sind).
fn with_pauses(data: Vec<u8>, pauses: Option<&[u32]>) -> Vec<u8> {
    match pauses {
        Some(l) if !l.is_empty() => printjob::insert_pauses(&String::from_utf8_lossy(&data), l).into_bytes(),
        _ => data,
    }
}

/// Sprache für Meldungen aus dem Backend (von der Oberfläche gesetzt).
#[tauri::command]
fn set_ui_language(lang: String) {
    i18n::set_english(lang == "en");
}

/// Öffnet eine Projektseite im Standardbrowser – nur Adressen des Druckerwacht-Repositorys.
#[tauri::command]
fn open_project_link(url: String) -> Result<(), String> {
    const BASE: &str = "https://github.com/pk1310oo/druckerwacht";
    let ok = (url == BASE || url.starts_with(&format!("{BASE}/")))
        && url.chars().all(|c| c.is_ascii_alphanumeric() || "/:.-_?=&#%+".contains(c));
    if !ok {
        return Err(crate::i18n::tr("Diese Adresse darf nicht geöffnet werden.", "This address may not be opened.").into());
    }
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(windows)]
    let prog = "explorer";
    #[cfg(not(any(target_os = "macos", windows)))]
    let prog = "xdg-open";
    std::process::Command::new(prog)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|_| crate::i18n::tr("Browser konnte nicht geöffnet werden.", "The browser could not be opened.").to_string())
}

/// Pause, Fortsetzen oder Abbrechen – nur wenn der Zustand dazu passt.
#[tauri::command]
async fn printer_control(app: AppHandle, action: String) -> Result<(), String> {
    let (host, state, preparing) = {
        let st = app.state::<Arc<AppState>>();
        let inner = st.lock();
        let s = inner.status.as_ref();
        (inner.settings.printer_ip.clone(), s.map(|s| s.state), s.map(|s| s.preparing).unwrap_or(false))
    };
    if host.is_empty() {
        return Err(crate::i18n::tr("Keine Drucker-IP eingetragen.", "No printer IP address set.").into());
    }
    let ok = match (action.as_str(), state) {
        ("pause", Some(PrintState::Printing)) => !preparing,
        ("resume", Some(PrintState::Paused)) => true,
        ("stop", Some(PrintState::Printing | PrintState::Paused)) => true,
        (a, Some(PrintState::Printing | PrintState::Paused)) if a.starts_with("speed:") => true,
        _ => false,
    };
    if !ok {
        return Err(match action.as_str() {
            "pause" if preparing => crate::i18n::tr("Während Heizen und Leveling nimmt der Drucker keine Pause an.", "The printer does not accept a pause while heating and leveling.").into(),
            "pause" => crate::i18n::tr("Pausieren geht nur während eines Drucks.", "Pausing only works during a print.").into(),
            "resume" => crate::i18n::tr("Der Drucker ist nicht pausiert.", "The printer is not paused.").into(),
            a if a.starts_with("speed:") => crate::i18n::tr("Die Geschwindigkeit lässt sich nur während eines Drucks ändern.", "The speed can only be changed during a print.").into(),
            _ => crate::i18n::tr("Es läuft gerade kein Druck.", "No print is running.").into(),
        });
    }
    printjob::control(&host, None, &action).await
}

fn project_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
        Some(e) if e == "druckerwacht" => Ok(p),
        _ => Err(crate::i18n::tr("Projektdateien haben die Endung .druckerwacht.", "Project files use the .druckerwacht extension.").into()),
    }
}

/// Speichert ein Projekt an den vom Nutzer gewählten Ort.
#[tauri::command]
fn save_project(path: String, contents: String) -> Result<(), String> {
    let p = project_path(&path)?;
    let tmp = p.with_extension("druckerwacht.tmp");
    std::fs::write(&tmp, contents).map_err(|_| crate::i18n::tr("Projekt konnte nicht gespeichert werden.", "The project could not be saved.").to_string())?;
    std::fs::rename(&tmp, &p).map_err(|_| crate::i18n::tr("Projekt konnte nicht gespeichert werden.", "The project could not be saved.").to_string())
}

/// Liest ein Projekt.
#[tauri::command]
fn read_project(path: String) -> Result<String, String> {
    let p = project_path(&path)?;
    let meta = std::fs::metadata(&p).map_err(|_| crate::i18n::tr("Projektdatei nicht gefunden.", "Project file not found.").to_string())?;
    if meta.len() > 800 * 1024 * 1024 {
        return Err(crate::i18n::tr("Die Projektdatei ist zu groß.", "The project file is too large.").into());
    }
    std::fs::read_to_string(&p).map_err(|_| crate::i18n::tr("Projekt konnte nicht gelesen werden.", "The project could not be read.").to_string())
}

/// Sendet den erzeugten G-Code an den Drucker und startet ihn auf Wunsch.
#[tauri::command]
async fn printer_send(app: AppHandle, path: String, start: bool, pauses: Option<Vec<u32>>) -> Result<String, String> {
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("slice");
    let p = std::path::PathBuf::from(&path);
    if !p.starts_with(&base) {
        return Err(crate::i18n::tr("Zugriff verweigert.", "Access denied.").into());
    }
    let (host, busy, max_nozzle, max_bed) = {
        let state = app.state::<Arc<AppState>>();
        let inner = state.lock();
        let s = inner.status.as_ref();
        let busy = s.map(|s| s.state.is_active()).unwrap_or(false);
        // Grenzen meldet der Drucker selbst (KE: 300 / 100 °C); sonst die KE-Werte
        let max_nozzle = s.and_then(|s| s.max_nozzle_temp).unwrap_or(300.0);
        let max_bed = s.and_then(|s| s.max_bed_temp).unwrap_or(100.0);
        (inner.settings.printer_ip.clone(), busy, max_nozzle, max_bed)
    };
    if host.is_empty() {
        return Err(crate::i18n::tr("Keine Drucker-IP eingetragen.", "No printer IP address set.").into());
    }
    if start && busy {
        return Err(crate::i18n::tr("Der Drucker druckt gerade – bitte warten, bis der aktuelle Druck beendet ist.", "The printer is busy – please wait until the current print has finished.").into());
    }
    let data = std::fs::read(&p).map_err(|_| crate::i18n::tr("G-Code konnte nicht gelesen werden.", "The G-code could not be read.").to_string())?;
    let data = with_pauses(data, pauses.as_deref());
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    upload_and_start(&app, &host, &name, &data, start, max_nozzle, max_bed).await
}

/// Prüft, lädt hoch und startet auf Wunsch. Liefert den Dateinamen am Drucker.
async fn upload_and_start(app: &AppHandle, host: &str, file_name: &str, data: &[u8], start: bool, max_nozzle: f64, max_bed: f64) -> Result<String, String> {
    printjob::check_gcode(data, max_nozzle, max_bed)?;
    let name = printjob::printer_file_name(file_name);
    let host = host.to_string();
    let app2 = app.clone();
    let last = std::sync::atomic::AtomicI32::new(-1);
    printjob::upload(&host, None, &name, data, move |f| {
        let pct = (f * 100.0) as i32;
        if last.swap(pct, std::sync::atomic::Ordering::Relaxed) != pct {
            let _ = app2.emit("printer://upload", pct);
        }
    })
    .await?;
    if start {
        printjob::start(&host, None, &name).await?;
    }
    Ok(name)
}

// ----------------------------------------------------------------------------- Extras

#[tauri::command]
async fn ntfy_test(topic: String) -> Result<(), String> {
    extras::push(
        topic.trim(),
        crate::i18n::tr("Druckerwacht verbunden", "Druckerwacht connected"),
        crate::i18n::tr("Ab jetzt bekommst du hier Nachrichten von deinem Drucker.", "From now on you'll get messages from your printer here."),
        "white_check_mark",
    )
    .await
}

fn queue(app: &AppHandle) -> extras::Queue {
    extras::Queue::new(app.state::<Arc<AppState>>().paths.queue_dir.clone())
}

#[tauri::command]
fn queue_list(app: AppHandle) -> Vec<extras::QueueItem> {
    queue(&app).list()
}

/// Legt eine Kopie des gesliceten G-Codes (mit eingefügten Pausen) in die Warteschlange.
#[tauri::command]
fn queue_add(app: AppHandle, path: String, name: String, time_s: Option<f64>, filament_g: Option<f64>, pauses: Option<Vec<u32>>) -> Result<Vec<extras::QueueItem>, String> {
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("slice");
    if !std::path::Path::new(&path).starts_with(&base) {
        return Err(crate::i18n::tr("Zugriff verweigert.", "Access denied.").into());
    }
    let data = std::fs::read(&path).map_err(|_| crate::i18n::tr("G-Code konnte nicht gelesen werden.", "The G-code could not be read.").to_string())?;
    let data = with_pauses(data, pauses.as_deref());
    let item = extras::QueueItem {
        id: format!("q{}", now_ms()),
        name: name.trim_end_matches(".gcode").to_string(),
        added_ms: now_ms(),
        time_s,
        filament_g,
        pauses: pauses.unwrap_or_default().into_iter().filter(|&l| l > 0).map(|l| l + 1).collect(),
    };
    queue(&app).add(item, &data)
}

#[tauri::command]
fn queue_remove(app: AppHandle, id: String) -> Result<Vec<extras::QueueItem>, String> {
    queue(&app).remove(&id)
}

#[tauri::command]
fn queue_shift(app: AppHandle, id: String, delta: i32) -> Result<Vec<extras::QueueItem>, String> {
    queue(&app).shift(&id, delta)
}

/// Startet einen Eintrag der Warteschlange und nimmt ihn heraus. Liefert den Namen am Drucker.
#[tauri::command]
async fn queue_start(app: AppHandle, id: String) -> Result<String, String> {
    let q = queue(&app);
    let item = q.list().into_iter().find(|i| i.id == id).ok_or(crate::i18n::tr("Eintrag nicht gefunden.", "Entry not found."))?;
    let (host, busy, max_nozzle, max_bed) = {
        let st = app.state::<Arc<AppState>>();
        let inner = st.lock();
        let s = inner.status.as_ref();
        (
            inner.settings.printer_ip.clone(),
            s.map(|s| s.state.is_active()).unwrap_or(false),
            s.and_then(|s| s.max_nozzle_temp).unwrap_or(300.0),
            s.and_then(|s| s.max_bed_temp).unwrap_or(100.0),
        )
    };
    if host.is_empty() {
        return Err(crate::i18n::tr("Keine Drucker-IP eingetragen.", "No printer IP address set.").into());
    }
    if busy {
        return Err(crate::i18n::tr("Der Drucker druckt gerade – bitte warten, bis der aktuelle Druck beendet ist.", "The printer is busy – please wait until the current print has finished.").into());
    }
    let data = std::fs::read(q.file(&id)).map_err(|_| crate::i18n::tr("G-Code konnte nicht gelesen werden.", "The G-code could not be read.").to_string())?;
    let name = upload_and_start(&app, &host, &format!("{}.gcode", item.name), &data, true, max_nozzle, max_bed).await?;
    q.remove(&id)?;
    Ok(name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(slicer::SlicerState::default())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let log_dir = app.path().app_log_dir()?;
            let paths = Paths {
                settings: config_dir.join("settings.json"),
                jobs: data_dir.join("jobs.json"),
                printer_history: data_dir.join("printer_history.json"),
                raw_log_dir: log_dir.join("raw"),
                queue_dir: data_dir.join("queue"),
            };
            let settings = Settings::load(&paths.settings);
            let printer_history: Option<PrinterHistory> = std::fs::read_to_string(&paths.printer_history)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());
            let jobs: Vec<JobRecord> = std::fs::read_to_string(&paths.jobs)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            app.manage(Arc::new(AppState {
                inner: Mutex::new(Inner {
                    settings,
                    connection: ConnectionState::Unconfigured,
                    status: None,
                    samples: VecDeque::with_capacity(MAX_SAMPLES),
                    jobs,
                    active_job: None,
                    shutdown: None,
                    disconnect_notified: false,
                    printer_history,
                }),
                generation: AtomicU64::new(0),
                disconnect_seq: AtomicU64::new(0),
                paths,
            }));

            setup_tray(app);
            restart_connection(app.handle());
            spawn_sampler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            reconnect,
            get_snapshot,
            get_jobs,
            get_printer_history,
            clear_jobs,
            discover_printers,
            raw_log_dir,
            slicer_info,
            slicer_presets,
            slicer_save_preset,
            slicer_delete_preset,
            slicer_slice,
            slicer_cancel,
            read_model_file,
            read_gcode,
            export_gcode,
            printer_send,
            open_project_link,
            set_ui_language,
            save_project,
            read_project,
            printer_control,
            ntfy_test,
            queue_list,
            queue_add,
            queue_remove,
            queue_shift,
            queue_start
        ])
        .run(tauri::generate_context!())
        .expect("Druckerwacht konnte nicht gestartet werden");
}

#[cfg(test)]
mod tray_tests {
    use super::*;

    #[test]
    fn tray_texts() {
        let mut s = PrinterStatus::default();
        assert_eq!(tray_text(&s), "");
        s.state = PrintState::Printing;
        s.progress = Some(46.6);
        s.remaining_s = Some(3600.0);
        let t = tray_text(&s);
        assert!(t.starts_with("47 % · ") && t.len() > 8, "{t}");
        s.state = PrintState::Paused;
        assert_eq!(tray_text(&s), "⏸ 47 %");
        s.state = PrintState::Printing;
        s.preparing = true;
        assert_eq!(tray_text(&s), "🔥");
    }
}
