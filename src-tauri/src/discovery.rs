//! Automatische Suche: scannt die eigenen /24-Netze und erkennt
//! - Creality (KE, K1-Familie): WebSocket auf Port 9999
//! - Klipper/Moonraker: `/printer/info` auf Port 7125 (oder hinter Mainsail/Fluidd auf Port 80)
//! - PrusaLink: `/api/version` verlangt Digest-Anmeldung (Port 80)
//! - OctoPrint: Startseite nennt „OctoPrint“ (Port 80)

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
    /// "creality", "moonraker", "octoprint" oder "prusalink"
    pub kind: String,
    /// Port, falls nicht der Standard des Typs
    pub port: Option<u16>,
}

const MOONRAKER: u16 = 7125;
const HTTP: u16 = 80;

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

async fn port_open(ip: Ipv4Addr, port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
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
    let mut found = FoundPrinter { ip: ip.to_string(), model: None, hostname: None, kind: "creality".into(), port: None };
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

/// Klipper, OctoPrint oder PrusaLink über HTTP erkennen
async fn identify_http(ip: Ipv4Addr, port: u16) -> Option<FoundPrinter> {
    let c = reqwest::Client::builder().timeout(Duration::from_secs(3)).build().ok()?;
    let base = if port == HTTP { format!("http://{ip}") } else { format!("http://{ip}:{port}") };
    let hit = |kind: &str, model: &str, hostname: Option<String>, std_port: u16| FoundPrinter {
        ip: ip.to_string(),
        model: Some(model.to_string()),
        hostname,
        kind: kind.into(),
        port: (port != std_port).then_some(port),
    };
    // Moonraker (Port 7125 oder über Mainsail/Fluidd auf Port 80)
    if let Ok(r) = c.get(format!("{base}/printer/info")).send().await {
        let code = r.status().as_u16();
        if let Ok(v) = r.json::<Value>().await {
            if code == 200 && v["result"].is_object() {
                return Some(hit("moonraker", "Klipper", v["result"]["hostname"].as_str().map(str::to_string), MOONRAKER));
            }
            // Moonraker mit Anmeldung: antwortet mit JSON-Fehler 401
            if code == 401 && v["error"]["code"].as_i64() == Some(401) {
                return Some(hit("moonraker", "Klipper", None, MOONRAKER));
            }
        }
    }
    if port != HTTP {
        return None;
    }
    // PrusaLink: ohne Anmeldung 401 mit Digest-Aufforderung
    if let Ok(r) = c.get(format!("{base}/api/version")).send().await {
        let digest = r.headers().get("www-authenticate").and_then(|h| h.to_str().ok()).map(|h| h.trim_start().starts_with("Digest")).unwrap_or(false);
        if r.status().as_u16() == 401 && digest {
            return Some(hit("prusalink", "Prusa", None, HTTP));
        }
    }
    // OctoPrint: Start- bzw. Anmeldeseite
    if let Ok(r) = c.get(&base).send().await {
        if r.status().is_success() {
            let body = r.text().await.unwrap_or_default();
            if body.contains("OctoPrint") {
                return Some(hit("octoprint", "OctoPrint", None, HTTP));
            }
        }
    }
    None
}

pub async fn discover() -> Vec<FoundPrinter> {
    let targets: Vec<(Ipv4Addr, u16)> = candidate_hosts().into_iter().flat_map(|ip| [(ip, PORT), (ip, MOONRAKER), (ip, HTTP)]).collect();
    let open: Vec<(Ipv4Addr, u16)> = stream::iter(targets)
        .map(|(ip, port)| async move { port_open(ip, port).await.then_some((ip, port)) })
        .buffer_unordered(128)
        .filter_map(|x| async move { x })
        .collect()
        .await;
    // Creality-Drucker haben auch eine Weboberfläche auf Port 80 – die nicht doppelt prüfen
    let creality: std::collections::HashSet<Ipv4Addr> = open.iter().filter(|(_, p)| *p == PORT).map(|(ip, _)| *ip).collect();
    let moonraker: std::collections::HashSet<Ipv4Addr> = open.iter().filter(|(_, p)| *p == MOONRAKER).map(|(ip, _)| *ip).collect();
    let checks: Vec<(Ipv4Addr, u16)> = open.into_iter().filter(|(ip, p)| *p != HTTP || !(creality.contains(ip) || moonraker.contains(ip))).collect();

    let mut found: Vec<FoundPrinter> = stream::iter(checks)
        .map(|(ip, port)| async move { if port == PORT { identify(ip).await } else { identify_http(ip, port).await } })
        .buffer_unordered(12)
        .filter_map(|x| async move { x })
        .collect()
        .await;
    found.sort_by_key(|f| (f.ip.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0), f.kind.clone()));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Mini-HTTP-Server, der auf jeden Pfad mit der passenden Antwort reagiert
    async fn serve(routes: Vec<(&'static str, &'static str)>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else { return };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let resp = routes.iter().find(|(p, _)| *p == path).map(|(_, r)| r.to_string()).unwrap_or_else(|| "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".into());
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        port
    }

    fn ok_json(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn recognizes_moonraker() {
        let body: &'static str = Box::leak(ok_json(r#"{"result":{"state":"ready","hostname":"voron"}}"#).into_boxed_str());
        let port = serve(vec![("/printer/info", body)]).await;
        let f = identify_http(Ipv4Addr::LOCALHOST, port).await.unwrap();
        assert_eq!(f.kind, "moonraker");
        assert_eq!(f.hostname.as_deref(), Some("voron"));
        assert_eq!(f.port, Some(port));
    }

    #[tokio::test]
    async fn unknown_device_is_ignored() {
        let port = serve(vec![]).await;
        assert!(identify_http(Ipv4Addr::LOCALHOST, port).await.is_none());
    }
}
