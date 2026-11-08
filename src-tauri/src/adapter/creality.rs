//! Adapter für die lokale Creality-Schnittstelle (WebSocket, Port 9999),
//! die auch Creality Print nutzt. Nur lesend.
//!
//! Protokoll-Annahmen (aus Mitschnitten der K1/KE-Familie, mit probe.mjs zu bestätigen):
//! - Der Drucker schickt unaufgefordert JSON-Objekte mit Teil-Updates.
//! - Gelegentlich kommt `{"ModeCode":"heart_beat"}`; Creality Print antwortet mit `ok`.
//!   (Der Ender 3 V3 KE mit Firmware V1.1.0.17 schickte in 10 min keinen Heartbeat.)
//! - `{"method":"get","params":{"reqPrinterPara":1}}` fordert einen vollständigen Status an.
//!   Das ist eine reine Leseanfrage.

use super::{AdapterEvent, ConnectionState, PrinterAdapter};
use crate::settings::PrinterProfile;
use crate::model::{merge, parse, parse_history, PrinterStatus};
use futures_util::{future::BoxFuture, FutureExt, SinkExt, StreamExt};
use serde_json::{Map, Value};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub const PORT: u16 = 9999;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// Kommt so lange gar nichts, gilt die Verbindung als tot. Der KE schickt nur Änderungen,
/// im Leerlauf mit Pausen von bis zu ~15 s (gemessen) – daher großzügig.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Wie oft wir aktiv einen vollständigen Status anfordern (hält die Verbindung zusätzlich wach).
const REFRESH_EVERY: Duration = Duration::from_secs(20);
const MAX_BACKOFF_S: u64 = 15;

const REQUEST_STATUS: &str = r#"{"method":"get","params":{"reqPrinterPara":1}}"#;
/// Verlauf anfordern (reine Leseanfrage). Bestätigt ist, dass der KE `historyList` nach jedem
/// Druckende schickt; ob er diese Anfrage beantwortet, ist am Gerät noch zu prüfen – sonst
/// wird sie einfach ignoriert und die Liste kommt mit dem nächsten Druckende.
const REQUEST_HISTORY: &str = r#"{"method":"get","params":{"reqHistory":1}}"#;

pub struct CrealityWsAdapter;

impl PrinterAdapter for CrealityWsAdapter {
    fn run(
        &self,
        printer: PrinterProfile,
        tx: mpsc::UnboundedSender<AdapterEvent>,
        shutdown: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()> {
        let port = printer.port.unwrap_or(PORT);
        run_loop(printer.host, port, tx, shutdown).boxed()
    }
}

async fn run_loop(
    host: String,
    port: u16,
    tx: mpsc::UnboundedSender<AdapterEvent>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut attempt: u32 = 0;
    loop {
        if *shutdown.borrow() {
            return;
        }
        attempt += 1;
        let _ = tx.send(AdapterEvent::Connection(ConnectionState::Connecting {
            host: host.clone(),
            attempt,
        }));

        let url = format!("ws://{host}:{port}");
        let reason = match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(url.as_str())).await {
            Ok(Ok((ws, _resp))) => {
                attempt = 0;
                let _ = tx.send(AdapterEvent::Connection(ConnectionState::Connected {
                    host: host.clone(),
                    since_ms: chrono::Utc::now().timestamp_millis(),
                }));
                match session(ws, &tx, &mut shutdown).await {
                    None => return, // reguläres Beenden
                    Some(r) => r,
                }
            }
            Ok(Err(e)) => humanize_error(&e.to_string()),
            Err(_) => crate::i18n::tr("Drucker antwortet nicht", "Printer not responding").to_string(),
        };

        let retry_in_s = backoff(attempt.max(1));
        let _ = tx.send(AdapterEvent::Connection(ConnectionState::Reconnecting {
            host: host.clone(),
            attempt: attempt.max(1),
            retry_in_s,
            reason,
        }));
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(retry_in_s)) => {}
            _ = shutdown.changed() => {}
        }
    }
}

fn backoff(attempt: u32) -> u64 {
    (1u64 << attempt.min(4)).min(MAX_BACKOFF_S)
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Gibt `None` bei regulärem Beenden zurück, sonst den Grund des Verbindungsverlusts.
async fn session(
    ws: Ws,
    tx: &mpsc::UnboundedSender<AdapterEvent>,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<String> {
    let (mut sink, mut stream) = ws.split();
    let mut merged: Map<String, Value> = Map::new();
    let mut last: Option<PrinterStatus> = None;

    let send = |text: &str| {
        let _ = tx.send(AdapterEvent::Raw { incoming: false, text: text.to_string() });
        Message::text(text.to_string())
    };

    if sink.send(send(REQUEST_STATUS)).await.is_err() {
        return Some(crate::i18n::tr("Verbindung sofort wieder getrennt", "Connection closed immediately").into());
    }
    let _ = sink.send(send(REQUEST_HISTORY)).await;

    let mut refresh = tokio::time::interval(REFRESH_EVERY);
    refresh.tick().await; // erster Tick sofort – überspringen

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = sink.close().await;
                return None;
            }
            _ = refresh.tick() => {
                if sink.send(send(REQUEST_STATUS)).await.is_err() {
                    return Some(crate::i18n::tr("Verbindung unterbrochen", "Connection interrupted").into());
                }
            }
            next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => {
                let msg = match next {
                    Err(_) => return Some(crate::i18n::tr("Keine Daten mehr vom Drucker", "No more data from the printer").into()),
                    Ok(None) => return Some(crate::i18n::tr("Drucker hat die Verbindung beendet", "Printer closed the connection").into()),
                    Ok(Some(Err(e))) => return Some(humanize_error(&e.to_string())),
                    Ok(Some(Ok(m))) => m,
                };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Binary(b) => match String::from_utf8(b.to_vec()) {
                        Ok(s) => s,
                        Err(_) => continue,
                    },
                    Message::Close(_) => return Some(crate::i18n::tr("Drucker hat die Verbindung beendet", "Printer closed the connection").into()),
                    _ => continue, // Ping/Pong erledigt tungstenite
                };
                let _ = tx.send(AdapterEvent::Raw { incoming: true, text: text.clone() });

                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };

                if value.get("ModeCode").and_then(Value::as_str) == Some("heart_beat") {
                    if sink.send(send("ok")).await.is_err() {
                        return Some(crate::i18n::tr("Verbindung unterbrochen", "Connection interrupted").into());
                    }
                    continue;
                }

                if let Some(h) = value.as_object().and_then(parse_history) {
                    let _ = tx.send(AdapterEvent::History(h));
                    // Die lange Liste nicht in den Live-Zustand übernehmen
                    if let Some(o) = value.as_object() {
                        let mut rest = o.clone();
                        rest.remove("historyList");
                        if merge(&mut merged, &Value::Object(rest)) {
                            let status = parse(&merged);
                            if last.as_ref() != Some(&status) {
                                last = Some(status.clone());
                                let _ = tx.send(AdapterEvent::Status(status));
                            }
                        }
                    }
                    continue;
                }

                if merge(&mut merged, &value) {
                    let status = parse(&merged);
                    if last.as_ref() != Some(&status) {
                        last = Some(status.clone());
                        let _ = tx.send(AdapterEvent::Status(status));
                    }
                }
            }
        }
    }
}

pub(super) fn humanize_error(raw: &str) -> String {
    let r = raw.to_lowercase();
    if r.contains("refused") {
        crate::i18n::tr("Verbindung abgelehnt – ist die IP richtig?", "Connection refused – is the IP correct?").into()
    } else if r.contains("unreachable") || r.contains("no route") {
        crate::i18n::tr("Drucker im Netz nicht erreichbar", "Printer not reachable on the network").into()
    } else if r.contains("timed out") || r.contains("timeout") {
        crate::i18n::tr("Drucker antwortet nicht", "Printer not responding").into()
    } else if r.contains("reset") || r.contains("broken pipe") {
        crate::i18n::tr("Verbindung unterbrochen", "Connection interrupted").into()
    } else {
        crate::i18n::tr("Verbindung fehlgeschlagen", "Connection failed").into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Simuliert den Drucker: schickt Teil-Updates + Heartbeat, trennt dann die Verbindung.
    #[tokio::test]
    async fn parses_heartbeats_and_reconnects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (got_ok_tx, mut got_ok_rx) = mpsc::unbounded_channel::<String>();

        tokio::spawn(async move {
            for round in 0..2 {
                let (sock, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
                ws.send(Message::text(r#"{"nozzleTemp":"210.5","targetNozzleTemp":215,"state":1}"#)).await.unwrap();
                ws.send(Message::text(r#"{"ModeCode":"heart_beat"}"#)).await.unwrap();
                ws.send(Message::text(format!(r#"{{"printProgress":{}}}"#, 40 + round))).await.unwrap();
                // Antworten des Clients einsammeln
                let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
                while let Ok(Some(Ok(m))) = tokio::time::timeout_at(deadline, ws.next()).await {
                    if let Message::Text(t) = m { let _ = got_ok_tx.send(t.to_string()); }
                }
                drop(ws); // Verbindung abreißen lassen
            }
        });

        let (tx, mut rx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = watch::channel(false);
        tokio::spawn(run_loop("127.0.0.1".into(), port, tx, stop_rx));

        let mut connects = 0;
        let mut progresses = vec![];
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while progresses.len() < 2 {
            let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("Zeitüberschreitung").unwrap();
            match ev {
                AdapterEvent::Connection(ConnectionState::Connected { .. }) => connects += 1,
                AdapterEvent::Status(s) => {
                    assert_eq!(s.nozzle_temp, Some(210.5));
                    if let Some(p) = s.progress { if !progresses.contains(&p) { progresses.push(p); } }
                }
                _ => {}
            }
        }
        assert_eq!(connects, 2, "nach dem Abriss muss neu verbunden werden");
        assert_eq!(progresses, vec![40.0, 41.0]);

        let mut replies = vec![];
        while let Ok(t) = got_ok_rx.try_recv() { replies.push(t); }
        assert!(replies.iter().any(|t| t == "ok"), "Heartbeat muss mit ok beantwortet werden: {replies:?}");
        assert!(replies.iter().any(|t| t.contains("reqPrinterPara")));
        let _ = stop_tx.send(true);
    }
}
