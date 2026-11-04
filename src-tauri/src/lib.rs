mod adapter;
mod discovery;
mod model;
mod settings;

use adapter::{creality::CrealityWsAdapter, AdapterEvent, ConnectionState, PrinterAdapter};
use model::{PrintState, PrinterStatus};
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
    raw_log_dir: PathBuf,
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
                notify(&app, "Verbindung verloren", &format!("{name} ist nicht mehr erreichbar. Ich versuche es weiter."));
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
                    notes.push(("Druck fertig".into(), format!("„{file}“ ist fertig gedruckt.")))
                }
                PrintState::Failed if st.notify_error => {
                    notes.push(("Druck fehlgeschlagen".into(), format!("„{file}“ wurde mit einem Fehler beendet.")))
                }
                PrintState::Aborted if st.notify_error => {
                    notes.push(("Druck abgebrochen".into(), format!("„{file}“ wurde abgebrochen.")))
                }
                _ => {}
            }
        }
        let prev_err = prev.as_ref().and_then(|p| p.error_code).unwrap_or(0);
        let err = s.error_code.unwrap_or(0);
        if prev.is_some() && err != 0 && err != prev_err && st.notify_error {
            notes.push(("Druckerfehler".into(), format!("Der Drucker meldet Fehlercode {err}.")));
        }

        inner.status = Some(s.clone());
    }
    let _ = app.emit("printer://status", Some(&s));
    for (t, b) in notes {
        notify(app, &t, &b);
    }
    if job_done {
        save_jobs(state);
        let _ = app.emit("printer://jobs", ());
    }
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
        .map_err(|_| "Einstellungen konnten nicht gespeichert werden.".to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let log_dir = app.path().app_log_dir()?;
            let paths = Paths {
                settings: config_dir.join("settings.json"),
                jobs: data_dir.join("jobs.json"),
                raw_log_dir: log_dir.join("raw"),
            };
            let settings = Settings::load(&paths.settings);
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
                }),
                generation: AtomicU64::new(0),
                disconnect_seq: AtomicU64::new(0),
                paths,
            }));

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
            clear_jobs,
            discover_printers,
            raw_log_dir
        ])
        .run(tauri::generate_context!())
        .expect("Druckerwacht konnte nicht gestartet werden");
}
