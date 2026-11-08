//! Gemeinsame Bausteine für Drucker mit HTTP-Schnittstelle (Moonraker, OctoPrint, PrusaLink):
//! eine Abfrage-Schleife mit Verbindungszustand und Wiederverbinden sowie ein HTTP-Client.

use super::{AdapterEvent, ConnectionState};
use crate::model::PrinterStatus;
use crate::settings::PrinterProfile;
use std::future::Future;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

/// Abstand zwischen zwei Statusabfragen
pub const POLL_EVERY: Duration = Duration::from_millis(1500);
const MAX_BACKOFF_S: u64 = 15;

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(5))
        .user_agent("Druckerwacht")
        .build()
        .unwrap_or_default()
}

/// Client für Uploads (große Dateien, langsame Drucker)
pub fn upload_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("Druckerwacht")
        .build()
        .unwrap_or_default()
}

pub fn base_url(p: &PrinterProfile) -> String {
    let host = if p.host.contains(':') && !p.host.starts_with('[') { format!("[{}]", p.host) } else { p.host.clone() };
    if p.port() == 80 {
        format!("http://{host}")
    } else {
        format!("http://{host}:{}", p.port())
    }
}

/// Verständlicher Grund für einen HTTP-Fehler
pub fn humanize(e: &reqwest::Error) -> String {
    if let Some(s) = e.status() {
        return match s.as_u16() {
            401 | 403 => crate::i18n::tr("Zugriff verweigert – API-Schlüssel bzw. Passwort prüfen", "Access denied – check the API key or password").into(),
            404 => crate::i18n::tr("Schnittstelle nicht gefunden – Druckertyp und Port prüfen", "Interface not found – check the printer type and port").into(),
            409 => crate::i18n::tr("Drucker ist nicht bereit (nicht mit dem Server verbunden)", "Printer is not ready (not connected to the server)").into(),
            c => crate::trf!("Drucker antwortet mit Fehler {c}", "Printer answered with error {c}"),
        };
    }
    super::creality::humanize_error(&e.to_string())
}

/// Fragt den Status regelmäßig ab und meldet Verbindung und Status – bis `shutdown`.
/// `fetch` liefert den aktuellen Status oder einen für Menschen formulierten Fehler.
pub async fn poll_loop<F, Fut>(printer: PrinterProfile, tx: mpsc::UnboundedSender<AdapterEvent>, mut shutdown: watch::Receiver<bool>, fetch: F)
where
    F: Fn(PrinterProfile) -> Fut,
    Fut: Future<Output = Result<PrinterStatus, String>>,
{
    let host = printer.host.clone();
    let mut attempt: u32 = 0;
    let mut connected = false;
    let mut last: Option<PrinterStatus> = None;
    loop {
        if *shutdown.borrow() {
            return;
        }
        if !connected {
            attempt += 1;
            let _ = tx.send(AdapterEvent::Connection(ConnectionState::Connecting { host: host.clone(), attempt }));
        }
        let wait = match fetch(printer.clone()).await {
            Ok(status) => {
                if !connected {
                    connected = true;
                    attempt = 0;
                    let _ = tx.send(AdapterEvent::Connection(ConnectionState::Connected { host: host.clone(), since_ms: chrono::Utc::now().timestamp_millis() }));
                }
                if last.as_ref() != Some(&status) {
                    last = Some(status.clone());
                    let _ = tx.send(AdapterEvent::Status(status));
                }
                POLL_EVERY
            }
            Err(reason) => {
                connected = false;
                let retry_in_s = (1u64 << attempt.clamp(1, 4)).min(MAX_BACKOFF_S);
                let _ = tx.send(AdapterEvent::Connection(ConnectionState::Reconnecting { host: host.clone(), attempt: attempt.max(1), retry_in_s, reason }));
                Duration::from_secs(retry_in_s)
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = shutdown.changed() => {}
        }
    }
}

/// Zahl aus JSON (Zahl oder String)
pub fn f(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|x: &f64| x.is_finite())
}
