//! Prusa-Drucker über PrusaLink (Prusa MK4/MK4S, MK3.9, Mini, XL, Core One).
//! Anmeldung per HTTP-Digest mit Benutzer „maker“ und dem Passwort vom Druckerdisplay
//! (Einstellungen → Netzwerk → PrusaLink). Alternativ „benutzer:passwort“ eintragen.
//!
//! Status: `GET /api/v1/status` und `GET /api/v1/job`. Befehle: `PUT /api/v1/job/{id}/pause|resume`,
//! `DELETE /api/v1/job/{id}`. Upload: `PUT /api/v1/files/usb/{name}` mit `Print-After-Upload`.
//! G-Code-Befehle (Temperaturen, Tempo) bietet PrusaLink nicht an.

use super::http::{base_url, client, f, humanize, poll_loop, upload_client};
use super::{AdapterEvent, PrinterAdapter};
use crate::model::{PrintState, PrinterStatus};
use crate::settings::PrinterProfile;
use futures_util::{future::BoxFuture, FutureExt};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

pub struct PrusaLinkAdapter;

impl PrinterAdapter for PrusaLinkAdapter {
    fn run(&self, printer: PrinterProfile, tx: mpsc::UnboundedSender<AdapterEvent>, shutdown: watch::Receiver<bool>) -> BoxFuture<'static, ()> {
        poll_loop(printer, tx, shutdown, fetch).boxed()
    }
}

fn credentials(p: &PrinterProfile) -> (String, String) {
    match p.key.split_once(':') {
        Some((u, pw)) => (u.to_string(), pw.to_string()),
        None => ("maker".into(), p.key.clone()),
    }
}

/// Sendet eine Anfrage; antwortet der Drucker mit 401 und Digest-Aufforderung, wird sie
/// mit Anmeldung wiederholt.
async fn send(p: &PrinterProfile, method: reqwest::Method, path: &str, body: Option<Vec<u8>>, headers: &[(&str, &str)], long: bool) -> Result<reqwest::Response, String> {
    let url = format!("{}{path}", base_url(p));
    let c = if long { upload_client() } else { client() };
    let build = |auth: Option<String>| {
        let mut r = c.request(method.clone(), &url);
        for (k, v) in headers {
            r = r.header(*k, *v);
        }
        if let Some(b) = &body {
            r = r.body(b.clone());
        }
        if let Some(a) = auth {
            r = r.header("Authorization", a);
        }
        r
    };
    let first = build(None).send().await.map_err(|e| humanize(&e))?;
    if first.status().as_u16() != 401 {
        return first.error_for_status().map_err(|e| humanize(&e));
    }
    let challenge = first.headers().get("www-authenticate").and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
    let mut prompt = digest_auth::parse(&challenge)
        .map_err(|_| crate::i18n::tr("Zugriff verweigert – Passwort prüfen", "Access denied – check the password").to_string())?;
    let (user, pass) = credentials(p);
    let ctx = digest_auth::AuthContext::new_with_method(user, pass, path, None::<Vec<u8>>, digest_auth::HttpMethod::from(method.as_str()));
    let answer = prompt.respond(&ctx).map_err(|e| e.to_string())?;
    build(Some(answer.to_header_string())).send().await.and_then(|r| r.error_for_status()).map_err(|e| humanize(&e))
}

async fn fetch(p: PrinterProfile) -> Result<PrinterStatus, String> {
    let status: Value = send(&p, reqwest::Method::GET, "/api/v1/status", None, &[], false)
        .await?
        .json()
        .await
        .map_err(|_| crate::i18n::tr("Unerwartete Antwort – ist das ein Prusa mit PrusaLink?", "Unexpected answer – is this a Prusa with PrusaLink?").to_string())?;
    // Kein Druck → 204 ohne Inhalt
    let job = match send(&p, reqwest::Method::GET, "/api/v1/job", None, &[], false).await {
        Ok(r) if r.status().as_u16() == 200 => r.json::<Value>().await.ok(),
        _ => None,
    };
    Ok(parse(&status, job.as_ref()))
}

/// `/api/v1/status` (+ `/api/v1/job`, falls ein Druck läuft) → einheitlicher Status
pub fn parse(status: &Value, job: Option<&Value>) -> PrinterStatus {
    let pr = &status["printer"];
    let state = match pr["state"].as_str().unwrap_or("") {
        "PRINTING" => PrintState::Printing,
        "PAUSED" => PrintState::Paused,
        "FINISHED" => PrintState::Finished,
        "STOPPED" => PrintState::Aborted,
        "ERROR" | "ATTENTION" => PrintState::Failed,
        "IDLE" | "READY" | "BUSY" => PrintState::Idle,
        _ => PrintState::Unknown,
    };
    let progress = f(&status["job"]["progress"]).map(|x| x.clamp(0.0, 100.0));
    let file = job.and_then(|j| j["file"]["display_name"].as_str().or_else(|| j["file"]["name"].as_str())).map(str::to_string);
    PrinterStatus {
        nozzle_temp: f(&pr["temp_nozzle"]),
        nozzle_target: f(&pr["target_nozzle"]),
        bed_temp: f(&pr["temp_bed"]),
        bed_target: f(&pr["target_bed"]),
        state,
        preparing: state == PrintState::Printing && progress.unwrap_or(0.0) < 0.05,
        file_name: file,
        progress,
        elapsed_s: f(&status["job"]["time_printing"]),
        remaining_s: f(&status["job"]["time_remaining"]),
        speed_pct: f(&pr["speed"]),
        flow_pct: f(&pr["flow"]),
        ..Default::default()
    }
}

/// ID des laufenden Druckauftrags (für Pause/Fortsetzen/Abbrechen)
async fn job_id(p: &PrinterProfile) -> Result<i64, String> {
    let st: Value = send(p, reqwest::Method::GET, "/api/v1/status", None, &[], false).await?.json().await.map_err(|e| e.to_string())?;
    st["job"]["id"].as_i64().ok_or_else(|| crate::i18n::tr("Es läuft gerade kein Druck.", "No print is running.").to_string())
}

pub async fn job_action(p: &PrinterProfile, action: &str) -> Result<(), String> {
    let id = job_id(p).await?;
    match action {
        "stop" => send(p, reqwest::Method::DELETE, &format!("/api/v1/job/{id}"), None, &[], false).await.map(|_| ()),
        a => send(p, reqwest::Method::PUT, &format!("/api/v1/job/{id}/{a}"), None, &[], false).await.map(|_| ()),
    }
}

pub async fn upload(p: &PrinterProfile, name: &str, data: Vec<u8>, start: bool) -> Result<(), String> {
    let path = format!("/api/v1/files/usb/{}", urlencode(name));
    let headers = [("Content-Type", "application/octet-stream"), ("Overwrite", "?1"), ("Print-After-Upload", if start { "?1" } else { "?0" })];
    send(p, reqwest::Method::PUT, &path, Some(data), &headers, true).await.map(|_| ())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status() {
        // Aufbau wie in der PrusaLink-OpenAPI (v1)
        let status = serde_json::json!({
            "job": {"id": 7, "progress": 36.0, "time_remaining": 2400, "time_printing": 1300},
            "printer": {"state": "PRINTING", "temp_bed": 59.9, "target_bed": 60.0, "temp_nozzle": 214.8, "target_nozzle": 215.0, "speed": 100, "flow": 95}
        });
        let job = serde_json::json!({"id": 7, "file": {"name": "BENCHY~1.BGC", "display_name": "benchy_0.4n_0.2mm_PLA.bgcode"}});
        let st = parse(&status, Some(&job));
        assert_eq!(st.state, PrintState::Printing);
        assert_eq!(st.file_name.as_deref(), Some("benchy_0.4n_0.2mm_PLA.bgcode"));
        assert_eq!(st.progress, Some(36.0));
        assert_eq!(st.remaining_s, Some(2400.0));
        assert_eq!(st.flow_pct, Some(95.0));
        let idle = parse(&serde_json::json!({"printer": {"state": "IDLE"}}), None);
        assert_eq!(idle.state, PrintState::Idle);
        assert_eq!(urlencode("Würfel 2.gcode"), "W%C3%BCrfel%202.gcode");
    }
}
