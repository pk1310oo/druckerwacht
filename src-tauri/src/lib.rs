#[macro_use]
mod i18n;
mod adapter;
mod ai;
mod discovery;
mod extras;
mod model;
mod printjob;
mod remote;
mod settings;
mod slicer;
mod threemf;

use adapter::{control, AdapterEvent, ConnectionState};
use model::{PrintState, PrinterHistory, PrinterStatus};
use serde::{Deserialize, Serialize};
use settings::{PrinterProfile, Settings};
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
    /// Zuletzt für den Zeitraffer fotografierte Schicht
    last_frame_layer: Option<i64>,
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
    /// Neuestes Kamerabild (Zeit in ms, JPEG) – für Fotos in Handy-Nachrichten
    last_snapshot: Option<(i64, Vec<u8>)>,
    /// Alle übrigen gespeicherten Drucker (laufen im Hintergrund mit)
    others: Vec<OtherPrinter>,
    /// Laufende Handy-Seite: Stopp-Signal und verwendeter Schlüssel
    remote: Option<(watch::Sender<bool>, String)>,
    /// Letzter Fehler der Handy-Seite (z. B. Port belegt)
    remote_error: Option<String>,
    /// KI-Fehlerwächter: geglätteter Zustand und Anzeige
    ai_pred: ai::Prediction,
    ai: AiStatus,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct AiStatus {
    /// "off", "nomodel", "nocamera", "idle", "watching", "warning", "failing"
    state: String,
    /// Modell geladen (Datei vorhanden)
    model: bool,
    /// Download läuft: 0–100
    download_pct: Option<f64>,
    /// Letzte Bewertung (Summe der Konfidenzen) und geglätteter Wert
    score: f32,
    ewm: f32,
    frames: u32,
    last_ms: i64,
    /// Bereits gemeldet/pausiert in diesem Druck
    #[serde(skip)]
    warned: bool,
    #[serde(skip)]
    alerted: bool,
    #[serde(skip)]
    print_key: String,
}

/// Kurzstatus eines weiteren Druckers für die Übersicht
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct OtherPrinter {
    id: String,
    name: String,
    kind: String,
    connection: ConnectionState,
    status: Option<PrinterStatus>,
    #[serde(skip)]
    last_emit_ms: i64,
}

impl OtherPrinter {
    fn new(p: &PrinterProfile) -> Self {
        Self { id: p.id.clone(), name: p.name.clone(), kind: p.kind.clone(), connection: ConnectionState::Connecting { host: p.host.clone(), attempt: 1 }, status: None, last_emit_ms: 0 }
    }
}

fn emit_others(app: &AppHandle, state: &Arc<AppState>) {
    let list = state.lock().others.clone();
    let _ = app.emit("printers://others", &list);
}

/// Hält die Verbindung zu einem weiteren Drucker und meldet Druckende und Fehler.
fn spawn_other(app: &AppHandle, gen: u64, p: PrinterProfile, shutdown: watch::Receiver<bool>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<AdapterEvent>();
    let adapter = adapter::for_kind(&p.kind);
    tauri::async_runtime::spawn(adapter.run(p.clone(), tx, shutdown));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let state = app.state::<Arc<AppState>>();
            if state.generation.load(Ordering::SeqCst) != gen {
                break;
            }
            let mut note: Option<(String, String)> = None;
            let emit = {
                let mut inner = state.lock();
                let notify_finished = inner.settings.notify_finished;
                let notify_error = inner.settings.notify_error;
                let Some(o) = inner.others.iter_mut().find(|o| o.id == p.id) else { break };
                match ev {
                    AdapterEvent::Connection(c) => {
                        let changed = o.connection != c;
                        o.connection = c;
                        changed
                    }
                    AdapterEvent::Status(s) => {
                        let prev = o.status.as_ref().map(|x| x.state).unwrap_or_default();
                        if prev.is_active() && prev != s.state {
                            let name = o.name.clone();
                            let file = s.file_name.clone().unwrap_or_default();
                            note = match s.state {
                                PrintState::Finished if notify_finished => Some((trf!("{name}: Druck fertig", "{name}: print finished"), trf!("„{file}“ ist fertig gedruckt.", "“{file}” has finished printing."))),
                                PrintState::Failed | PrintState::Aborted if notify_error => Some((trf!("{name}: Druck beendet", "{name}: print stopped"), trf!("„{file}“ wurde mit einem Fehler beendet oder abgebrochen.", "“{file}” ended with an error or was cancelled."))),
                                PrintState::Paused if notify_finished => Some((trf!("{name}: Druck pausiert", "{name}: print paused"), trf!("„{file}“ ist pausiert.", "“{file}” is paused."))),
                                _ => None,
                            };
                        }
                        let state_changed = prev != s.state;
                        o.status = Some(s);
                        let due = now_ms() - o.last_emit_ms >= 1000;
                        state_changed || due
                    }
                    _ => false,
                }
            };
            if emit {
                if let Some(o) = state.lock().others.iter_mut().find(|o| o.id == p.id) {
                    o.last_emit_ms = now_ms();
                }
                emit_others(&app, &state);
            }
            if let Some((t, b)) = note {
                notify(&app, &t, &b);
            }
        }
    });
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
    timelapse_dir: PathBuf,
    /// Kopien der zuletzt gesendeten Drucke (für „Nochmal drucken“)
    sent_dir: PathBuf,
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
    // Zusätzlich aufs Handy, wenn ein ntfy-Thema eingetragen ist – mit Kamerafoto, falls vorhanden
    let (topic, has_cam, snap_url) = {
        let st = app.state::<Arc<AppState>>();
        let inner = st.lock();
        let s = &inner.settings;
        (s.ntfy_topic.clone(), !s.local_camera.trim().is_empty(), extras::snapshot_url(&s.camera_url))
    };
    if topic.is_empty() {
        return;
    }
    let (title, body, app) = (title.to_string(), body.to_string(), app.clone());
    tauri::async_runtime::spawn(async move {
        let mut photo: Option<Vec<u8>> = None;
        if has_cam || snap_url.is_some() {
            // Die Oberfläche schickt bei Pause/Fertig/Fehler sofort ein frisches Bild – kurz darauf warten
            tokio::time::sleep(Duration::from_secs(4)).await;
            let recent = app.state::<Arc<AppState>>().lock().last_snapshot.clone().filter(|(t, _)| now_ms() - t < 120_000);
            photo = recent.map(|(_, b)| b);
            if photo.is_none() {
                if let Some(url) = snap_url {
                    photo = extras::fetch_snapshot(&url).await;
                }
            }
        }
        let sent = match photo {
            Some(img) => extras::push_image(&topic, &title, &body, "printer", img).await,
            None => Err(String::new()),
        };
        if sent.is_err() {
            let _ = extras::push(&topic, &title, &body, "printer").await;
        }
    });
}

/// (Neu)start der Verbindung mit den aktuellen Einstellungen.
fn restart_connection(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (active, others, old) = {
        let mut inner = state.lock();
        let old = inner.shutdown.take();
        inner.status = None;
        inner.samples.clear();
        inner.disconnect_notified = false;
        let active = inner.settings.active().cloned().filter(|p| !p.host.is_empty());
        let others: Vec<PrinterProfile> = inner.settings.printers.iter().filter(|p| Some(&p.id) != active.as_ref().map(|a| &a.id) && !p.host.is_empty()).cloned().collect();
        inner.others = others.iter().map(OtherPrinter::new).collect();
        (active, others, old)
    };
    if let Some(tx) = old {
        let _ = tx.send(true);
    }
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    state.lock().shutdown = Some(shutdown_tx);
    emit_others(app, &state);

    // Weitere Drucker laufen im Hintergrund mit (Übersicht, Meldungen)
    for p in others {
        spawn_other(app, gen, p, shutdown_rx.clone());
    }

    let Some(active) = active else {
        set_connection(app, &state, ConnectionState::Unconfigured);
        let _ = app.emit("printer://status", Option::<PrinterStatus>::None);
        return;
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<AdapterEvent>();
    let adapter = adapter::for_kind(&active.kind);
    tauri::async_runtime::spawn(adapter.run(active, tx, shutdown_rx));

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
    if c.is_connected() && !was_connected {
        probe_camera_once(app);
    }

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
    // Zeitraffer: (Ordner, Standbild-Adresse, Bildnummer) für ein neues Bild; Ordner zum Abschließen
    let mut frame: Option<(PathBuf, String, i64)> = None;
    let mut finish_tl: Option<PathBuf> = None;
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
                inner.active_job = Some(ActiveJob { file: file.clone(), started_ms: started, total_layers: None, last_frame_layer: None });
            }
            let snap = (inner.settings.timelapse && !s.preparing)
                .then(|| extras::snapshot_url(&inner.settings.camera_url))
                .flatten();
            let tl_dir = state.paths.timelapse_dir.clone();
            if let Some(j) = inner.active_job.as_mut() {
                j.total_layers = s.total_layers.or(j.total_layers);
                // Pro neuer Schicht ein Bild
                if let (Some(url), Some(layer)) = (snap, s.layer) {
                    if layer > 0 && j.last_frame_layer != Some(layer) && s.state == PrintState::Printing {
                        j.last_frame_layer = Some(layer);
                        frame = Some((tl_dir.join(extras::timelapse_key(j.started_ms, &j.file)), url, layer));
                    }
                }
            }
        } else if matches!(s.state, PrintState::Finished | PrintState::Failed | PrintState::Aborted) {
            if let Some(j) = inner.active_job.take() {
                if j.last_frame_layer.is_some() {
                    finish_tl = Some(state.paths.timelapse_dir.join(extras::timelapse_key(j.started_ms, &j.file)));
                }
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
    if let Some((dir, url, layer)) = frame {
        tauri::async_runtime::spawn(async move {
            if let Some(img) = extras::fetch_snapshot(&url).await {
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(dir.join(format!("{layer:06}.jpg")), img);
            }
        });
    }
    if let Some(dir) = finish_tl {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Kurz warten, damit das letzte Bild noch ankommt
            tokio::time::sleep(Duration::from_secs(5)).await;
            let ok = tauri::async_runtime::spawn_blocking(move || extras::finish_timelapse(&dir, 30)).await;
            if matches!(ok, Ok(Ok(_))) {
                let _ = app.emit("printer://timelapse", ());
            }
        });
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

/// Linux: WebKitGTK lehnt Kamerazugriff ohne eigenen Handler still ab – für die Webcam am
/// Computer erlauben (nur Kamera/Mikrofon-Anfragen der eigenen Oberfläche).
#[cfg(target_os = "linux")]
fn allow_webcam(app: &tauri::App) {
    use webkit2gtk::glib::prelude::ObjectExt;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.with_webview(|wv| {
        let view = wv.inner();
        // Ist die Schnittstelle beim Laden der Seite aus, fehlt navigator.mediaDevices bis zum
        // nächsten Laden – daher nach dem Einschalten einmal neu laden.
        let mut reload = false;
        if let Some(settings) = WebViewExt::settings(&view) {
            if !settings.enables_media_stream() {
                settings.set_enable_media_stream(true);
                reload = true;
            }
        }
        view.connect_permission_request(|_, req| {
            if req.is::<UserMediaPermissionRequest>() {
                req.allow();
                true
            } else {
                false
            }
        });
        if reload {
            view.reload();
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn allow_webcam(_app: &tauri::App) {}

/// Nach dem Verbinden einmal nach einer Kamera am Drucker suchen, wenn noch keine eingetragen ist.
fn probe_camera_once(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let (host, empty, creality) = {
        let inner = state.lock();
        let creality = inner.settings.active().map(|p| p.kind == "creality").unwrap_or(false);
        (inner.settings.printer_ip.clone(), inner.settings.camera_url.trim().is_empty(), creality)
    };
    if host.is_empty() || !empty || !creality {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(url) = extras::probe_camera(&host).await else { return };
        let state = app.state::<Arc<AppState>>();
        let settings = {
            let mut inner = state.lock();
            if !inner.settings.camera_url.trim().is_empty() || inner.settings.printer_ip != host {
                return;
            }
            inner.settings.camera_url = url;
            inner.settings.clone()
        };
        let _ = settings.save(&state.paths.settings);
        let _ = app.emit("settings://changed", &settings);
    });
}

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
        let reconnect = inner.settings.printers != settings.printers || inner.settings.active_printer != settings.active_printer;
        inner.settings = settings.clone();
        reconnect
    };
    if reconnect {
        restart_connection(&app);
    }
    apply_remote(&app);
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
fn get_others(state: State<'_, Arc<AppState>>) -> Vec<OtherPrinter> {
    state.lock().others.clone()
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
/// Kalibrier-Turm: Werte je Höhe in den gesliceten G-Code schreiben (Datei wird ersetzt).
#[tauri::command]
fn gcode_calib(path: String, kind: String, steps: Vec<(f64, f64)>) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.extension().map(|e| e != "gcode").unwrap_or(true) {
        return Err(crate::i18n::tr("Nur G-Code-Dateien.", "G-code files only.").into());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    if text.contains("DRUCKERWACHT_CALIB") {
        return Ok(());
    }
    std::fs::write(&p, printjob::insert_steps(&text, &kind, &steps)?).map_err(|e| e.to_string())
}

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
    // Außerdem: Suche nach einem Creality-Fehlercode (nur Ziffern)
    let error_search = url.strip_prefix("https://duckduckgo.com/?q=creality+error+").map(|c| !c.is_empty() && c.len() <= 6 && c.chars().all(|x| x.is_ascii_digit())).unwrap_or(false);
    // Modellsuche auf den großen Plattformen
    let model_search = ["https://www.printables.com/search/models?q=", "https://www.thingiverse.com/search?q=", "https://makerworld.com/en/search/models?keyword="].iter().any(|p| url.starts_with(p));
    let ok = (url == BASE || url.starts_with(&format!("{BASE}/")) || error_search || model_search)
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
    control_active(&app, &action).await
}

/// Befehl an den aktiven Drucker – gemeinsam für App und Handy-Seite
async fn control_active(app: &AppHandle, action: &str) -> Result<(), String> {
    let a = active_printer(app)?;
    let cmd = control::parse(action).ok_or(crate::i18n::tr("Unbekannter Befehl.", "Unknown command."))?;
    let running = matches!(a.state, Some(PrintState::Printing | PrintState::Paused));
    let refuse: Option<&str> = match &cmd {
        control::Cmd::Pause if a.preparing => Some(crate::i18n::tr("Während Heizen und Leveling nimmt der Drucker keine Pause an.", "The printer does not accept a pause while heating and leveling.")),
        control::Cmd::Pause if a.state != Some(PrintState::Printing) => Some(crate::i18n::tr("Pausieren geht nur während eines Drucks.", "Pausing only works during a print.")),
        control::Cmd::Resume if a.state != Some(PrintState::Paused) => Some(crate::i18n::tr("Der Drucker ist nicht pausiert.", "The printer is not paused.")),
        control::Cmd::Speed(_) if !running => Some(crate::i18n::tr("Die Geschwindigkeit lässt sich nur während eines Drucks ändern.", "The speed can only be changed during a print.")),
        c if c.needs_job() && !running => Some(crate::i18n::tr("Es läuft gerade kein Druck.", "No print is running.")),
        c if c.needs_idle() && running => Some(crate::i18n::tr("Das geht nur, wenn gerade nicht gedruckt wird.", "This only works while the printer isn't printing.")),
        control::Cmd::Nozzle(t) | control::Cmd::PidNozzle(t) if *t as f64 > a.max_nozzle => Some(crate::i18n::tr("So heiß kann die Düse dieses Druckers nicht werden.", "This printer's nozzle can't get that hot.")),
        control::Cmd::Bed(t) | control::Cmd::PidBed(t) | control::Cmd::Level(t) if *t as f64 > a.max_bed => Some(crate::i18n::tr("So heiß kann das Bett dieses Druckers nicht werden.", "This printer's bed can't get that hot.")),
        _ => None,
    };
    if let Some(msg) = refuse {
        return Err(msg.into());
    }
    control::run(&a.profile, &cmd).await
}

/// Aktiver Drucker mit den Werten, die Befehle und Uploads prüfen
struct Active {
    profile: PrinterProfile,
    state: Option<PrintState>,
    preparing: bool,
    max_nozzle: f64,
    max_bed: f64,
}

fn active_printer(app: &AppHandle) -> Result<Active, String> {
    let st = app.state::<Arc<AppState>>();
    let inner = st.lock();
    let profile = inner
        .settings
        .active()
        .cloned()
        .filter(|p| !p.host.is_empty())
        .ok_or(crate::i18n::tr("Kein Drucker eingerichtet.", "No printer set up."))?;
    let s = inner.status.as_ref();
    let (lim_n, lim_b) = control::temp_limits(&profile.kind);
    Ok(Active {
        state: s.map(|s| s.state),
        preparing: s.map(|s| s.preparing).unwrap_or(false),
        // Grenzen meldet der Drucker teils selbst (KE: 300 / 100 °C); sonst Werte je Druckertyp
        max_nozzle: s.and_then(|s| s.max_nozzle_temp).unwrap_or(lim_n),
        max_bed: s.and_then(|s| s.max_bed_temp).unwrap_or(lim_b),
        profile,
    })
}

fn busy_error() -> String {
    crate::i18n::tr("Der Drucker druckt gerade – bitte warten, bis der aktuelle Druck beendet ist.", "The printer is busy – please wait until the current print has finished.").into()
}

/// Eine vom Nutzer gewählte G-Code-Datei an den aktiven Drucker senden (für alle Druckertypen,
/// z. B. aus OrcaSlicer, PrusaSlicer oder Cura).
#[tauri::command]
async fn printer_send_file(app: AppHandle, path: String, start: bool) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["gcode", "gco", "g", "bgcode"].contains(&ext.as_str()) {
        return Err(crate::i18n::tr("Nur G-Code-Dateien (.gcode, .bgcode) können gesendet werden.", "Only G-code files (.gcode, .bgcode) can be sent.").into());
    }
    let a = active_printer(&app)?;
    if start && a.state.map(|s| s.is_active()).unwrap_or(false) {
        return Err(busy_error());
    }
    let data = std::fs::read(&p).map_err(|_| crate::i18n::tr("Datei konnte nicht gelesen werden.", "The file could not be read.").to_string())?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // Binär-G-Code (Prusa) lässt sich nicht als Text prüfen
    let check = ext != "bgcode";
    upload_and_start(&app, &a, &name, data, start, check).await
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

/// Datensicherung (Einstellungen, Spulen, Wartung …) als JSON-Datei schreiben bzw. lesen.
fn backup_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);
    match p.extension().and_then(|e| e.to_str()) {
        Some("json") => Ok(p),
        _ => Err(crate::i18n::tr("Bitte eine .json-Datei wählen.", "Please choose a .json file.").into()),
    }
}

#[tauri::command]
fn backup_write(path: String, contents: String) -> Result<(), String> {
    std::fs::write(backup_path(&path)?, contents).map_err(|_| crate::i18n::tr("Sicherung konnte nicht gespeichert werden.", "The backup could not be saved.").to_string())
}

/// Teilen-Bild (PNG) speichern
#[tauri::command]
fn save_png(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let p = std::path::PathBuf::from(&path);
    if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("png")) != Some(true) {
        return Err(crate::i18n::tr("Bitte eine .png-Datei wählen.", "Please choose a .png file.").into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim_start_matches("data:image/png;base64,")).map_err(|e| e.to_string())?;
    if bytes.len() < 8 || &bytes[1..4] != b"PNG" {
        return Err("PNG?".into());
    }
    std::fs::write(p, bytes).map_err(|_| crate::i18n::tr("Bild konnte nicht gespeichert werden.", "The image could not be saved.").to_string())
}

#[tauri::command]
fn backup_read(path: String) -> Result<String, String> {
    let p = backup_path(&path)?;
    if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > 20 * 1024 * 1024 {
        return Err(crate::i18n::tr("Die Datei ist zu groß für eine Sicherung.", "The file is too large for a backup.").into());
    }
    std::fs::read_to_string(&p).map_err(|_| crate::i18n::tr("Sicherung konnte nicht gelesen werden.", "The backup could not be read.").to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentModel {
    path: String,
    name: String,
    modified_ms: i64,
}

const MODEL_EXT: [&str; 3] = ["stl", "3mf", "obj"];

/// Neu heruntergeladene Modelle (STL/3MF/OBJ oder ZIP mit Modellen) im Download-Ordner
#[tauri::command]
fn recent_models(app: AppHandle, since_ms: i64) -> Vec<RecentModel> {
    let Ok(dir) = app.path().download_dir() else { return vec![] };
    let mut out: Vec<RecentModel> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let ext = p.extension()?.to_string_lossy().to_lowercase();
                    if !(MODEL_EXT.contains(&ext.as_str()) || ext == "zip") {
                        return None;
                    }
                    let m = e.metadata().ok()?;
                    let ms = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
                    if ms < since_ms || m.len() == 0 {
                        return None;
                    }
                    if ext == "zip" && zip_models(&p).map(|v| v.is_empty()).unwrap_or(true) {
                        return None;
                    }
                    Some(RecentModel { name: p.file_name()?.to_string_lossy().into_owned(), path: p.to_string_lossy().into_owned(), modified_ms: ms })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|m| -m.modified_ms);
    out
}

fn zip_models(p: &std::path::Path) -> Option<Vec<String>> {
    let f = std::fs::File::open(p).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    Some(
        (0..z.len())
            .filter_map(|i| {
                let e = z.by_index(i).ok()?;
                let n = e.name().ok()?.to_string();
                let ext = n.rsplit('.').next()?.to_lowercase();
                (MODEL_EXT.contains(&ext.as_str()) && !n.starts_with("__MACOSX")).then_some(n)
            })
            .collect(),
    )
}

/// Modelle aus einer ZIP-Datei (z. B. von Printables) entpacken – liefert die Pfade
#[tauri::command]
fn unzip_models(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let p = std::path::PathBuf::from(&path);
    let names = zip_models(&p).ok_or_else(|| crate::i18n::tr("Die ZIP-Datei konnte nicht gelesen werden.", "The ZIP file could not be read.").to_string())?;
    let dest = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("downloads").join(p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(std::fs::File::open(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for n in names.iter().take(20) {
        let mut e = z.by_name(n).map_err(|e| e.to_string())?;
        if e.size() > 400 * 1024 * 1024 {
            continue;
        }
        // Nur den Dateinamen verwenden – keine Pfade aus dem Archiv
        let file = n.rsplit(['/', '\\']).next().unwrap_or(n);
        let target = dest.join(file);
        let mut f = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut e, &mut f).map_err(|e| e.to_string())?;
        out.push(target.to_string_lossy().into_owned());
    }
    Ok(out)
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
    let a = active_printer(&app)?;
    if start && a.state.map(|s| s.is_active()).unwrap_or(false) {
        return Err(busy_error());
    }
    let data = std::fs::read(&p).map_err(|_| crate::i18n::tr("G-Code konnte nicht gelesen werden.", "The G-code could not be read.").to_string())?;
    let data = with_pauses(data, pauses.as_deref());
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    upload_and_start(&app, &a, &name, data, start, true).await
}

/// Prüft, lädt hoch und startet auf Wunsch. Liefert den Dateinamen am Drucker.
async fn upload_and_start(app: &AppHandle, a: &Active, file_name: &str, data: Vec<u8>, start: bool, check: bool) -> Result<String, String> {
    if check {
        printjob::check_gcode(&data, a.max_nozzle, a.max_bed)?;
    }
    let app2 = app.clone();
    let last = std::sync::atomic::AtomicI32::new(-1);
    let _ = app.emit("printer://upload", 0);
    let copy = data.clone();
    let name = control::upload(&a.profile, file_name, data, start, move |f| {
        let pct = (f * 100.0) as i32;
        if last.swap(pct, std::sync::atomic::Ordering::Relaxed) != pct {
            let _ = app2.emit("printer://upload", pct);
        }
    })
    .await?;
    let _ = app.emit("printer://upload", 100);
    remember_sent(app, &name, &copy);
    Ok(name)
}

const SENT_KEEP: usize = 15;

/// Kopie eines gesendeten Drucks behalten (die neuesten 15)
fn remember_sent(app: &AppHandle, name: &str, data: &[u8]) {
    let dir = app.state::<Arc<AppState>>().paths.sent_dir.clone();
    if std::fs::create_dir_all(&dir).is_err() || std::fs::write(dir.join(name), data).is_err() {
        return;
    }
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect())
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(SENT_KEEP) {
        let _ = std::fs::remove_file(p);
    }
}

/// Dateinamen der gespeicherten Drucke
#[tauri::command]
fn reprint_names(state: State<'_, Arc<AppState>>) -> Vec<String> {
    std::fs::read_dir(&state.paths.sent_dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

/// Einen früheren Druck erneut hochladen und starten
#[tauri::command]
async fn reprint(app: AppHandle, name: String) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(crate::i18n::tr("Ungültiger Dateiname.", "Invalid file name.").into());
    }
    let path = app.state::<Arc<AppState>>().paths.sent_dir.join(&name);
    let data = std::fs::read(&path).map_err(|_| crate::i18n::tr("Die gespeicherte Kopie gibt es nicht mehr.", "The saved copy no longer exists.").to_string())?;
    let a = active_printer(&app)?;
    if a.state.map(|s| s.is_active()).unwrap_or(false) {
        return Err(busy_error());
    }
    let check = !name.to_lowercase().ends_with(".bgcode");
    upload_and_start(&app, &a, &name, data, true, check).await
}

// ----------------------------------------------------------------------------- KI-Fehlerwächter

fn ai_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_default().join("ai")
}

fn emit_ai(app: &AppHandle) {
    let st = app.state::<Arc<AppState>>();
    let s = st.lock().ai.clone();
    let _ = app.emit("ai://status", &s);
}

/// Prüft alle 10 s während eines Drucks ein Kamerabild.
fn spawn_ai_watch(app: AppHandle, data_dir: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let model_path = ai::model_path(&data_dir);
        let detector: ai::Shared = Default::default();
        let mut saved_frames = 0u32;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let st = app.state::<Arc<AppState>>().inner().clone();
            let (enabled, pause, cam_url, status, local_cam, connected) = {
                let i = st.lock();
                (i.settings.ai_enabled, i.settings.ai_pause, i.settings.camera_url.clone(), i.status.clone(), !i.settings.local_camera.is_empty(), matches!(i.connection, ConnectionState::Connected { .. }))
            };
            let model = ai::model_ready(&model_path);
            let printing = connected && status.as_ref().map(|s| s.state == PrintState::Printing && !s.preparing).unwrap_or(false);
            let has_cam = local_cam || !cam_url.trim().is_empty();
            let base = if !enabled { "off" } else if !model { "nomodel" } else if !has_cam { "nocamera" } else if !printing { "idle" } else { "watching" };
            {
                let mut i = st.lock();
                if i.ai.download_pct.is_none() {
                    i.ai.model = model;
                }
                // Neuer Druck → Kurzzeitwerte zurücksetzen
                let key = status.as_ref().map(|s| format!("{}", s.file_name.clone().unwrap_or_default())).unwrap_or_default();
                let active = status.as_ref().map(|s| s.state.is_active()).unwrap_or(false);
                if !active {
                    i.ai.print_key.clear();
                } else if i.ai.print_key != key {
                    i.ai.print_key = key;
                    i.ai.warned = false;
                    i.ai.alerted = false;
                    i.ai_pred.reset_print();
                }
                if base != "watching" || !matches!(i.ai.state.as_str(), "warning" | "failing") || !printing {
                    i.ai.state = base.into();
                }
            }
            emit_ai(&app);
            if base != "watching" {
                continue;
            }
            // Bild: Webcam am Computer liefert laufend Fotos; sonst die Kamera am Drucker abfragen
            let now = now_ms();
            let mut frame = st.lock().last_snapshot.as_ref().filter(|(t, _)| now - t < 30_000).map(|(_, b)| b.clone());
            if frame.is_none() && !cam_url.trim().is_empty() {
                if let Some(url) = extras::snapshot_url(&cam_url) {
                    if let Some(b) = extras::fetch_snapshot(&url).await {
                        st.lock().last_snapshot = Some((now, b.clone()));
                        frame = Some(b);
                    }
                }
            }
            let Some(jpeg) = frame.filter(|b| extras::is_jpeg(b)) else { continue };
            let det = detector.clone();
            let mp = model_path.clone();
            let result = tauri::async_runtime::spawn_blocking(move || -> Result<f32, String> {
                let d = {
                    let mut g = det.lock().map_err(|_| "lock")?;
                    if g.is_none() {
                        *g = Some(Arc::new(ai::Detector::load(&mp)?));
                    }
                    g.clone().unwrap()
                };
                Ok(d.detect(&jpeg)?.iter().map(|f| f.0).sum())
            })
            .await;
            let Ok(Ok(p)) = result else { continue };
            let (warn_now, fail_now) = {
                let mut i = st.lock();
                i.ai_pred.update(p);
                let warning = i.ai_pred.is_failing(1.0, 1.0);
                let failing = i.ai_pred.is_failing(1.0, ai::ESCALATING_FACTOR);
                i.ai.score = p;
                i.ai.ewm = i.ai_pred.ewm_mean;
                i.ai.frames = i.ai_pred.current_frame_num;
                i.ai.last_ms = now;
                i.ai.state = if failing { "failing" } else if warning { "warning" } else { "watching" }.into();
                let warn_now = warning && !i.ai.warned;
                let fail_now = failing && !i.ai.alerted;
                if warn_now {
                    i.ai.warned = true;
                }
                if fail_now {
                    i.ai.alerted = true;
                }
                (warn_now, fail_now)
            };
            emit_ai(&app);
            saved_frames += 1;
            if saved_frames % 30 == 0 {
                let pred = st.lock().ai_pred.clone();
                let _ = std::fs::create_dir_all(data_dir.join("ai"));
                let _ = std::fs::write(data_dir.join("ai").join("state.json"), serde_json::to_string(&pred).unwrap_or_default());
            }
            if fail_now {
                if pause {
                    let paused = control_active(&app, "pause").await.is_ok();
                    notify(
                        &app,
                        crate::i18n::tr("KI-Wächter: Druck pausiert", "AI watch: print paused"),
                        if paused {
                            crate::i18n::tr("Das Kamerabild sieht nach einem misslungenen Druck aus (Spaghetti oder abgelöst). Bitte nachsehen und dann fortsetzen oder abbrechen.", "The camera picture looks like a failed print (spaghetti or detached). Please check, then resume or cancel.")
                        } else {
                            crate::i18n::tr("Fehler erkannt, aber die Pause wurde nicht angenommen – bitte sofort nachsehen!", "Failure detected but the pause was not accepted – please check right away!")
                        },
                    );
                } else {
                    notify(&app, crate::i18n::tr("KI-Wächter: Druck misslungen?", "AI watch: print failing?"), crate::i18n::tr("Das Kamerabild sieht nach einem misslungenen Druck aus. Bitte nachsehen.", "The camera picture looks like a failed print. Please check."));
                }
            } else if warn_now {
                notify(&app, crate::i18n::tr("KI-Wächter: Bitte kurz nachsehen", "AI watch: please take a look"), crate::i18n::tr("Im Kamerabild könnte etwas schiefgehen – noch kein Alarm.", "Something might be going wrong in the camera picture – no alarm yet."));
            }
        }
    });
}

#[tauri::command]
fn ai_status(state: State<'_, Arc<AppState>>) -> AiStatus {
    state.lock().ai.clone()
}

/// Modell einmalig herunterladen (~200 MB) – Fortschritt über „ai://status“
#[tauri::command]
async fn ai_download(app: AppHandle) -> Result<(), String> {
    let dir = ai_dir(&app);
    let path = ai::model_path(app.path().app_data_dir().map_err(|e| e.to_string())?.as_path());
    if ai::model_ready(&path) {
        return Ok(());
    }
    {
        let st = app.state::<Arc<AppState>>();
        let mut i = st.lock();
        if i.ai.download_pct.is_some() {
            return Ok(());
        }
        i.ai.download_pct = Some(0.0);
    }
    let result: Result<(), String> = async {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("part");
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(1800)).build().map_err(|e| e.to_string())?;
        let mut resp = client.get(ai::MODEL_URL).send().await.and_then(|r| r.error_for_status()).map_err(|_| crate::i18n::tr("Download fehlgeschlagen – ist der Computer online?", "Download failed – is the computer online?").to_string())?;
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut got: u64 = 0;
        let mut last = -1i64;
        use std::io::Write;
        while let Some(chunk) = resp.chunk().await.map_err(|_| crate::i18n::tr("Download abgebrochen.", "Download interrupted.").to_string())? {
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            let pct = (got as f64 / ai::MODEL_SIZE as f64 * 100.0).min(100.0);
            if pct as i64 != last {
                last = pct as i64;
                app.state::<Arc<AppState>>().lock().ai.download_pct = Some(pct);
                emit_ai(&app);
            }
        }
        drop(file);
        if got != ai::MODEL_SIZE {
            let _ = std::fs::remove_file(&tmp);
            return Err(crate::i18n::tr("Die heruntergeladene Datei ist unvollständig.", "The downloaded file is incomplete.").into());
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }
    .await;
    {
        let st = app.state::<Arc<AppState>>();
        let mut i = st.lock();
        i.ai.download_pct = None;
        i.ai.model = ai::model_ready(&path);
    }
    emit_ai(&app);
    result
}

// ----------------------------------------------------------------------------- Handy im WLAN

/// Zustand aller Drucker für die Handy-Seite
fn remote_state(app: &AppHandle) -> String {
    let state = app.state::<Arc<AppState>>();
    let inner = state.lock();
    let caps = |kind: &str| (matches!(kind, "creality" | "moonraker" | "octoprint"), kind == "creality");
    let mut list = Vec::new();
    if let Some(p) = inner.settings.active() {
        let (speed, light) = caps(&p.kind);
        list.push(serde_json::json!({ "id": p.id, "name": p.name, "kind": p.kind, "active": true, "connection": inner.connection, "status": inner.status, "speed": speed, "light": light }));
    }
    for o in &inner.others {
        list.push(serde_json::json!({ "id": o.id, "name": o.name, "kind": o.kind, "active": false, "connection": o.connection, "status": o.status, "speed": false, "light": false }));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let photo = inner.last_snapshot.as_ref().filter(|(t, _)| now - t < 15 * 60_000).map(|(t, _)| *t);
    serde_json::json!({ "printers": list, "photoMs": photo }).to_string()
}

/// Startet oder stoppt die Handy-Seite passend zu den Einstellungen.
fn apply_remote(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let (enabled, token, running) = {
        let inner = state.lock();
        (inner.settings.remote_enabled, inner.settings.remote_token.clone(), inner.remote.as_ref().map(|(_, t)| t.clone()))
    };
    if running.is_some() && (!enabled || running.as_deref() != Some(token.as_str())) {
        if let Some((stop, _)) = state.lock().remote.take() {
            let _ = stop.send(true);
        }
    }
    if !enabled || token.is_empty() || (running.as_deref() == Some(token.as_str())) {
        if !enabled {
            state.lock().remote_error = None;
        }
        return;
    }
    let (tx, rx) = watch::channel(false);
    state.lock().remote = Some((tx, token.clone()));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let st = app.state::<Arc<AppState>>().inner().clone();
        match tokio::net::TcpListener::bind(("0.0.0.0", remote::PORT)).await {
            Ok(listener) => {
                st.lock().remote_error = None;
                let _ = app.emit("remote://changed", ());
                let handler_app = app.clone();
                remote::serve(listener, token, rx, move |what: &'static str, action: Option<String>| {
                    let app = handler_app.clone();
                    async move {
                        match what {
                            "state" => remote::Reply::Json(remote_state(&app)),
                            "photo" => {
                                let shot = app.state::<Arc<AppState>>().lock().last_snapshot.as_ref().map(|(_, b)| b.clone());
                                match shot {
                                    Some(b) => remote::Reply::Jpeg(b),
                                    None => remote::Reply::Status(404, "Not Found"),
                                }
                            }
                            _ => match control_active(&app, action.as_deref().unwrap_or("")).await {
                                Ok(()) => remote::Reply::Json("{}".into()),
                                Err(e) => remote::Reply::Text(409, e),
                            },
                        }
                    }
                })
                .await;
            }
            Err(e) => {
                let mut inner = st.lock();
                inner.remote = None;
                inner.remote_error = Some(if e.kind() == std::io::ErrorKind::AddrInUse {
                    crate::i18n::tr("Port 8787 ist schon belegt (läuft Druckerwacht zweimal?).", "Port 8787 is already in use (is Druckerwacht running twice?).").to_string()
                } else {
                    e.to_string()
                });
                drop(inner);
                let _ = app.emit("remote://changed", ());
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteInfo {
    enabled: bool,
    running: bool,
    url: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn remote_info(state: State<'_, Arc<AppState>>) -> RemoteInfo {
    let inner = state.lock();
    let url = remote::lan_ip().map(|ip| format!("http://{ip}:{}/?k={}", remote::PORT, inner.settings.remote_token));
    RemoteInfo { enabled: inner.settings.remote_enabled, running: inner.remote.is_some() && inner.remote_error.is_none(), url, error: inner.remote_error.clone() }
}

/// Neuer Schlüssel: alte QR-Codes und gespeicherte Links funktionieren danach nicht mehr.
#[tauri::command]
fn remote_new_token(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Settings, String> {
    let settings = {
        let mut inner = state.lock();
        inner.settings.remote_token = remote::new_token();
        inner.settings.clone()
    };
    settings.save(&state.paths.settings)?;
    let _ = app.emit("settings://changed", &settings);
    apply_remote(&app);
    Ok(settings)
}

// ----------------------------------------------------------------------------- Extras

/// Sucht jetzt nach einer Kamera am Drucker (für den Knopf in den Einstellungen).
#[tauri::command]
async fn camera_probe(app: AppHandle) -> Option<String> {
    let host = app.state::<Arc<AppState>>().lock().settings.printer_ip.clone();
    if host.is_empty() {
        return None;
    }
    extras::probe_camera(&host).await
}

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
    let a = active_printer(&app)?;
    if a.state.map(|s| s.is_active()).unwrap_or(false) {
        return Err(busy_error());
    }
    let data = std::fs::read(q.file(&id)).map_err(|_| crate::i18n::tr("G-Code konnte nicht gelesen werden.", "The G-code could not be read.").to_string())?;
    let name = upload_and_start(&app, &a, &format!("{}.gcode", item.name), data, true, true).await?;
    q.remove(&id)?;
    Ok(name)
}

/// Zeitraffer-Bild der Webcam am Computer für die aktuelle Schicht (JPEG, base64).
#[tauri::command]
fn timelapse_add_frame(app: AppHandle, layer: i64, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    if !extras::is_jpeg(&bytes) {
        return Err("kein JPEG".into());
    }
    let state = app.state::<Arc<AppState>>();
    let dir = {
        let mut inner = state.lock();
        inner.last_snapshot = Some((now_ms(), bytes.clone()));
        let printing = inner.status.as_ref().map(|s| s.state == PrintState::Printing).unwrap_or(false);
        let timelapse = inner.settings.timelapse;
        let Some(j) = inner.active_job.as_mut().filter(|_| printing && timelapse) else { return Ok(()) };
        if j.last_frame_layer == Some(layer) {
            return Ok(());
        }
        j.last_frame_layer = Some(layer);
        state.paths.timelapse_dir.join(extras::timelapse_key(j.started_ms, &j.file))
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{layer:06}.jpg")), bytes).map_err(|e| e.to_string())
}

/// Frisches Kamerabild der Webcam am Computer (z. B. bei Pause oder Druckende) – für die Handy-Nachricht.
#[tauri::command]
fn camera_snapshot(app: AppHandle, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    if !extras::is_jpeg(&bytes) {
        return Err("kein JPEG".into());
    }
    app.state::<Arc<AppState>>().lock().last_snapshot = Some((now_ms(), bytes));
    Ok(())
}

#[tauri::command]
fn timelapse_list(app: AppHandle) -> Vec<extras::Timelapse> {
    extras::list_timelapses(&app.state::<Arc<AppState>>().paths.timelapse_dir)
}

fn timelapse_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(crate::i18n::tr("Ungültiger Zeitraffer.", "Invalid timelapse.").into());
    }
    Ok(app.state::<Arc<AppState>>().paths.timelapse_dir.join(format!("{id}.mov")))
}

#[tauri::command]
fn timelapse_export(app: AppHandle, id: String, to: String) -> Result<(), String> {
    std::fs::copy(timelapse_file(&app, &id)?, &to)
        .map(|_| ())
        .map_err(|_| crate::i18n::tr("Datei konnte nicht gespeichert werden.", "The file could not be saved.").to_string())
}

#[tauri::command]
fn timelapse_delete(app: AppHandle, id: String) -> Result<(), String> {
    let f = timelapse_file(&app, &id)?;
    let _ = std::fs::remove_file(f.with_extension("jpg"));
    std::fs::remove_file(f).map_err(|e| e.to_string())
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
                timelapse_dir: data_dir.join("timelapse"),
                sent_dir: data_dir.join("sent"),
            };
            let mut settings = Settings::load(&paths.settings);
            // Schlüssel für die Handy-Seite einmalig erzeugen und sofort sichern
            if settings.remote_token.is_empty() {
                settings.remote_token = remote::new_token();
                let _ = settings.save(&paths.settings);
            }
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
                    last_snapshot: None,
                    others: Vec::new(),
                    remote: None,
                    remote_error: None,
                    ai_pred: std::fs::read_to_string(data_dir.join("ai").join("state.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
                    ai: AiStatus::default(),
                }),
                generation: AtomicU64::new(0),
                disconnect_seq: AtomicU64::new(0),
                paths,
            }));

            setup_tray(app);
            allow_webcam(app);
            restart_connection(app.handle());
            apply_remote(app.handle());
            spawn_sampler(app.handle().clone());
            spawn_ai_watch(app.handle().clone(), data_dir.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            reconnect,
            get_snapshot,
            get_jobs,
            get_printer_history,
            gcode_calib,
            remote_info,
            ai_status,
            ai_download,
            backup_write,
            recent_models,
            unzip_models,
            save_png,
            reprint_names,
            reprint,
            backup_read,
            remote_new_token,
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
            printer_send_file,
            get_others,
            camera_probe,
            ntfy_test,
            queue_list,
            queue_add,
            queue_remove,
            queue_shift,
            queue_start,
            timelapse_list,
            timelapse_add_frame,
            camera_snapshot,
            timelapse_export,
            timelapse_delete
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
