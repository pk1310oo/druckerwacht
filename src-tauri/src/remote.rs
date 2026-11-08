//! Handy im WLAN: ein kleiner Webserver (Port 8787), der eine Handy-Seite mit Live-Status aller
//! Drucker ausliefert. Zugriff nur mit dem geheimen Schlüssel aus dem QR-Code (`?k=…`).
//! Erlaubte Befehle vom Handy: Pause, Fortsetzen, Abbrechen, Tempo, Licht.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

pub const PORT: u16 = 8787;
const PAGE: &str = include_str!("../resources/remote.html");

/// Zufälliger Schlüssel (32 Hex-Zeichen) aus den zufälligen Startwerten der Standardbibliothek
pub fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i ^ chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Adresse dieses Computers im Heimnetz (für den QR-Code)
pub fn lan_ip() -> Option<String> {
    let ifaces = if_addrs::get_if_addrs().ok()?;
    let mut ips: Vec<std::net::Ipv4Addr> = ifaces
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v) if v.is_private() => Some(v),
            _ => None,
        })
        .collect();
    // 192.168.x.x zuerst (typisches Heimnetz), virtuelle Netze (z. B. 172.17 von Docker) zuletzt
    ips.sort_by_key(|ip| match ip.octets()[0] {
        192 => 0,
        10 => 1,
        _ => 2,
    });
    ips.first().map(|ip| ip.to_string())
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
}

impl Request {
    pub fn param(&self, k: &str) -> Option<&str> {
        self.query.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_request(head: &str) -> Option<Request> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?;
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let query = q
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k), decode(v))
        })
        .collect();
    Some(Request { method, path: path.to_string(), query })
}

/// Antwort der App auf eine Anfrage
pub enum Reply {
    Html(&'static str),
    Json(String),
    Jpeg(Vec<u8>),
    Status(u16, &'static str),
    /// Fehlermeldung als Text (z. B. „Es läuft gerade kein Druck.“)
    Text(u16, String),
}

/// Vom Handy erlaubte Befehle (bewusst keine Heiz- oder Achsbefehle)
pub fn allowed_action(a: &str) -> bool {
    matches!(a, "pause" | "resume" | "stop" | "light:0" | "light:1") || a.strip_prefix("speed:").map(|v| v.parse::<u32>().is_ok()).unwrap_or(false)
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Prüft Schlüssel und Weg; `handle` liefert die eigentliche Antwort.
pub async fn route<F, Fut>(req: &Request, token: &str, handle: F) -> Reply
where
    F: FnOnce(&'static str, Option<String>) -> Fut,
    Fut: std::future::Future<Output = Reply>,
{
    if req.path == "/" || req.path == "/index.html" {
        return Reply::Html(PAGE);
    }
    if req.path == "/favicon.ico" {
        return Reply::Status(404, "Not Found");
    }
    let ok = !token.is_empty() && req.param("k").map(|k| same(k, token)).unwrap_or(false);
    if !ok {
        return Reply::Status(403, "Forbidden");
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/state") => handle("state", None).await,
        ("GET", "/api/photo") => handle("photo", None).await,
        ("POST", "/api/control") => match req.param("a") {
            Some(a) if allowed_action(a) => handle("control", Some(a.to_string())).await,
            _ => Reply::Status(400, "Bad Request"),
        },
        _ => Reply::Status(404, "Not Found"),
    }
}

async fn write_reply(sock: &mut TcpStream, reply: Reply) {
    let (code, text, ctype, body): (u16, &str, &str, Vec<u8>) = match reply {
        Reply::Html(h) => (200, "OK", "text/html; charset=utf-8", h.as_bytes().to_vec()),
        Reply::Json(j) => (200, "OK", "application/json; charset=utf-8", j.into_bytes()),
        Reply::Jpeg(b) => (200, "OK", "image/jpeg", b),
        Reply::Status(c, t) => (c, t, "text/plain; charset=utf-8", t.as_bytes().to_vec()),
        Reply::Text(c, t) => (c, "Error", "text/plain; charset=utf-8", t.into_bytes()),
    };
    let head = format!(
        "HTTP/1.1 {code} {text}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(&body).await;
    let _ = sock.shutdown().await;
}

/// Server-Schleife; endet, sobald `stop` auf true springt.
pub async fn serve<H, Fut>(listener: TcpListener, token: String, mut stop: watch::Receiver<bool>, handle: H)
where
    H: Fn(&'static str, Option<String>) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = Reply> + Send,
{
    loop {
        let accepted = tokio::select! {
            r = listener.accept() => r,
            _ = stop.changed() => return,
        };
        let Ok((mut sock, _)) = accepted else { continue };
        let token = token.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            let mut n = 0;
            // Nur den Kopf lesen (Anfragen ohne Inhalt), höchstens 8 KB und 5 s
            let read = tokio::time::timeout(Duration::from_secs(5), async {
                while n < buf.len() {
                    match sock.read(&mut buf[n..]).await {
                        Ok(0) | Err(_) => break,
                        Ok(m) => {
                            n += m;
                            if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
            })
            .await;
            if read.is_err() || n == 0 {
                return;
            }
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let reply = match parse_request(&head) {
                Some(req) => route(&req, &token, handle).await,
                None => Reply::Status(400, "Bad Request"),
            };
            write_reply(&mut sock, reply).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_checks_actions() {
        let r = parse_request("POST /api/control?k=ab%20c&a=speed%3A150 HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/api/control");
        assert_eq!(r.param("k"), Some("ab c"));
        assert_eq!(r.param("a"), Some("speed:150"));
        assert!(allowed_action("pause") && allowed_action("speed:50") && allowed_action("light:1"));
        assert!(!allowed_action("nozzle:300") && !allowed_action("level") && !allowed_action("speed:x"));
        assert_eq!(new_token().len(), 32);
        assert_ne!(new_token(), new_token());
    }

    #[tokio::test]
    async fn token_is_required() {
        let ok = |_: &'static str, _: Option<String>| async { Reply::Json("{}".into()) };
        let get = |q: &str| parse_request(&format!("GET /api/state{q} HTTP/1.1\r\n\r\n")).unwrap();
        assert!(matches!(route(&get(""), "geheim", ok).await, Reply::Status(403, _)));
        assert!(matches!(route(&get("?k=falsch"), "geheim", ok).await, Reply::Status(403, _)));
        assert!(matches!(route(&get("?k=geheim"), "geheim", ok).await, Reply::Json(_)));
        assert!(matches!(route(&get("?k="), "", ok).await, Reply::Status(403, _)));
        let page = parse_request("GET / HTTP/1.1\r\n\r\n").unwrap();
        assert!(matches!(route(&page, "geheim", ok).await, Reply::Html(_)));
        let bad = parse_request("POST /api/control?k=geheim&a=nozzle:300 HTTP/1.1\r\n\r\n").unwrap();
        assert!(matches!(route(&bad, "geheim", ok).await, Reply::Status(400, _)));
    }

    #[tokio::test]
    async fn serves_over_tcp() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = watch::channel(false);
        tokio::spawn(serve(l, "k1".into(), rx, |_: &'static str, _: Option<String>| async { Reply::Json(r#"{"ok":true}"#.into()) }));
        let body = reqwest::get(format!("http://127.0.0.1:{port}/api/state?k=k1")).await.unwrap().text().await.unwrap();
        assert_eq!(body, r#"{"ok":true}"#);
        let page = reqwest::get(format!("http://127.0.0.1:{port}/")).await.unwrap().text().await.unwrap();
        assert!(page.contains("Druckerwacht"));
        tx.send(true).unwrap();
    }
}
