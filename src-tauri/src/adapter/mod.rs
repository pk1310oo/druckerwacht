//! Austauschbare Verbindungsschicht.
//!
//! Ein Adapter verbindet sich mit dem Drucker, hält die Verbindung (inkl. Reconnect) und
//! liefert ausschließlich *normalisierte* Ereignisse. Der Rest der App kennt das
//! Protokoll nicht. Ein späterer Moonraker-Adapter (Port 7125) implementiert einfach
//! denselben Trait.

pub mod creality;

use crate::model::{PrinterHistory, PrinterStatus};
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
        host: String,
        tx: mpsc::UnboundedSender<AdapterEvent>,
        shutdown: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()>;
}
