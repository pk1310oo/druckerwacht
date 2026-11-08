//! Austauschbare Verbindungsschicht.
//!
//! Ein Adapter verbindet sich mit dem Drucker, hält die Verbindung (inkl. Reconnect) und
//! liefert ausschließlich *normalisierte* Ereignisse. Der Rest der App kennt das
//! Protokoll nicht.
//!
//! - `creality`: WebSocket :9999 (Ender 3 V3 KE, K1-Familie, Ender 3 V3)
//! - `moonraker`: Klipper über Moonraker (Voron, Sovol, Elegoo Neptune 4, Qidi …)
//! - `octoprint`: OctoPrint (praktisch jeder Marlin-Drucker)
//! - `prusalink`: PrusaLink (Prusa MK4, MK3.9, Mini, XL, Core One)
//!
//! Befehle (Pause, Tempo, Temperaturen, Upload …) laufen über `control`.

pub mod control;
pub mod creality;
mod http;
pub mod moonraker;
pub mod octoprint;
pub mod prusalink;

use crate::model::{PrinterHistory, PrinterStatus};
use crate::settings::PrinterProfile;
use futures_util::future::BoxFuture;
use serde::Serialize;
use tokio::sync::{mpsc, watch};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectionState {
    /// Keine IP eingetragen
    Unconfigured,
    #[serde(rename_all = "camelCase")]
    Connecting { host: String, attempt: u32 },
    #[serde(rename_all = "camelCase")]
    Connected { host: String, since_ms: i64 },
    #[serde(rename_all = "camelCase")]
    Reconnecting {
        host: String,
        attempt: u32,
        retry_in_s: u64,
        /// Bereits für Menschen formulierter Grund (deutsch)
        reason: String,
    },
}

impl ConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, ConnectionState::Connected { .. })
    }
}

#[derive(Debug)]
pub enum AdapterEvent {
    Connection(ConnectionState),
    Status(PrinterStatus),
    /// Druckverlauf des Druckers (kommt nach Druckende oder auf Anfrage)
    History(PrinterHistory),
    /// Rohe Nachricht (für optionalen Mitschnitt)
    Raw { incoming: bool, text: String },
}

pub trait PrinterAdapter: Send + Sync + 'static {
    /// Läuft, bis `shutdown` auf `true` gesetzt wird. Reconnect ist Sache des Adapters.
    fn run(
        &self,
        printer: PrinterProfile,
        tx: mpsc::UnboundedSender<AdapterEvent>,
        shutdown: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()>;
}

/// Passender Adapter für einen Druckertyp.
pub fn for_kind(kind: &str) -> Box<dyn PrinterAdapter> {
    match kind {
        "moonraker" => Box::new(moonraker::MoonrakerAdapter),
        "octoprint" => Box::new(octoprint::OctoPrintAdapter),
        "prusalink" => Box::new(prusalink::PrusaLinkAdapter),
        _ => Box::new(creality::CrealityWsAdapter),
    }
}
