//! Automatische Suche: scannt die eigenen /24-Netze nach offenem Port 9999 und prüft,
//! ob dort tatsächlich ein Creality-WebSocket antwortet.

use crate::adapter::creality::PORT;
use futures_util::{stream, SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FoundPrinter {
    pub ip: String,
    pub model: Option<String>,
    pub hostname: Option<String>,
}

fn candidate_hosts() -> Vec<Ipv4Addr> {
    let mut hosts = Vec::new();
    let Ok(ifaces) = if_addrs::get_if_addrs() else { return hosts };
    for iface in ifaces {
        if iface.is_loopback() {
            continue;
        }
        if let IpAddr::V4(ip) = iface.ip() {
            if !ip.is_private() {
                continue;
            }
            let o = ip.octets();
            for last in 1..=254u8 {
                let h = Ipv4Addr::new(o[0], o[1], o[2], last);
                if h != ip && !hosts.contains(&h) {
                    hosts.push(h);
                }
            }
        }
    }
    hosts
}

async fn port_open(ip: Ipv4Addr) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(ip), PORT);
    matches!(
        tokio::time::timeout(Duration::from_millis(600), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

async fn identify(ip: Ipv4Addr) -> Option<FoundPrinter> {
    let url = format!("ws://{ip}:{PORT}");
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(3), connect_async(url.as_str()))
        .await
        .ok()?
        .ok()?;
    let _ = ws
        .send(Message::text(r#"{"method":"get","params":{"reqPrinterPara":1}}"#))
        .await;
    let mut found = FoundPrinter { ip: ip.to_string(), model: None, hostname: None };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while found.model.is_none() {
        let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, ws.next()).await else { break };
        if let Message::Text(t) = msg {
            if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&t) {
                if let Some(Value::String(m)) = o.get("model") {
                    found.model = Some(m.clone());
                }
                if let Some(Value::String(h)) = o.get("hostname") {
                    found.hostname = Some(h.clone());
                }
            }
        }
    }
    let _ = ws.close(None).await;
    // Ein offener WebSocket auf 9999 reicht als Treffer, auch ohne Modellnamen.
    Some(found)
}

pub async fn discover() -> Vec<FoundPrinter> {
    let open: Vec<Ipv4Addr> = stream::iter(candidate_hosts())
        .map(|ip| async move { port_open(ip).await.then_some(ip) })
        .buffer_unordered(128)
        .filter_map(|x| async move { x })
        .collect()
        .await;

    let mut found: Vec<FoundPrinter> = stream::iter(open)
        .map(identify)
        .buffer_unordered(8)
        .filter_map(|x| async move { x })
        .collect()
        .await;
    found.sort_by_key(|f| f.ip.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0));
    found
}
