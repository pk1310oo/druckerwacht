//! Drucker über OctoPrint (Standard-Port 80) – praktisch jeder Marlin-Drucker, z. B. Ender 3,
//! Prusa MK3, Anycubic i3. Braucht einen API-Schlüssel (OctoPrint → Einstellungen → API).
//!
//! Status: `GET /api/printer` und `GET /api/job`. Befehle: `POST /api/job`,
//! G-Code über `POST /api/printer/command`, Upload über `POST /api/files/local`.

use super::http::{base_url, client, f, humanize, poll_loop, upload_client};
use super::{AdapterEvent, PrinterAdapter};
use crate::model::{PrintState, PrinterStatus};
use crate::settings::PrinterProfile;
use futures_util::{future::BoxFuture, FutureExt};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

pub struct OctoPrintAdapter;

impl PrinterAdapter for OctoPrintAdapter {
    fn run(&self, printer: PrinterProfile, tx: mpsc::UnboundedSender<AdapterEvent>, shutdown: watch::Receiver<bool>) -> BoxFuture<'static, ()> {
        poll_loop(printer, tx, shutdown, fetch).boxed()
    }
}

fn req(p: &PrinterProfile, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    client().request(method, format!("{}{path}", base_url(p))).header("X-Api-Key", &p.key)
}

async fn fetch(p: PrinterProfile) -> Result<PrinterStatus, String> {
    if p.key.is_empty() {
        return Err(crate::i18n::tr("API-Schlüssel fehlt (OctoPrint → Einstellungen → API)", "API key missing (OctoPrint → Settings → API)").into());
    }
    let job: Value = req(&p, reqwest::Method::GET, "/api/job")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| humanize(&e))?
        .json()
        .await
        .map_err(|_| crate::i18n::tr("Unerwartete Antwort – ist das OctoPrint?", "Unexpected answer – is this OctoPrint?").to_string())?;
    // 409 heißt: OctoPrint läuft, aber der Drucker ist nicht verbunden
    let printer = match req(&p, reqwest::Method::GET, "/api/printer").send().await {
        Ok(r) if r.status().as_u16() == 409 => None,
        Ok(r) => r.error_for_status().map_err(|e| humanize(&e))?.json::<Value>().await.ok(),
        Err(e) => return Err(humanize(&e)),
    };
    Ok(parse(printer.as_ref(), &job))
}

/// `/api/printer` (fehlt, wenn der Drucker nicht verbunden ist) + `/api/job` → einheitlicher Status
pub fn parse(printer: Option<&Value>, job: &Value) -> PrinterStatus {
    let flags = printer.map(|p| &p["state"]["flags"]);
    let flag = |k: &str| flags.and_then(|f| f[k].as_bool()).unwrap_or(false);
    let progress = f(&job["progress"]["completion"]).map(|x| x.clamp(0.0, 100.0));
    let file = job["job"]["file"]["name"].as_str().filter(|n| !n.is_empty()).map(str::to_string);
    let state = if printer.is_none() || flag("closedOrError") || flag("error") {
        PrintState::Failed
    } else if flag("paused") || flag("pausing") {
        PrintState::Paused
    } else if flag("printing") || flag("cancelling") {
        PrintState::Printing
    } else if file.is_some() && progress.map(|p| p >= 99.9).unwrap_or(false) {
        PrintState::Finished
    } else {
        PrintState::Idle
    };
    let t = printer.map(|p| &p["temperature"]);
    let temp = |tool: &str, k: &str| t.and_then(|t| f(&t[tool][k]));
    PrinterStatus {
        nozzle_temp: temp("tool0", "actual"),
        nozzle_target: temp("tool0", "target"),
        bed_temp: temp("bed", "actual"),
        bed_target: temp("bed", "target"),
        state,
        preparing: state == PrintState::Printing && progress.unwrap_or(0.0) < 0.05,
        file_name: file,
        progress,
        elapsed_s: f(&job["progress"]["printTime"]),
        remaining_s: f(&job["progress"]["printTimeLeft"]),
        ..Default::default()
    }
}

pub async fn job_command(p: &PrinterProfile, body: Value) -> Result<(), String> {
    req(p, reqwest::Method::POST, "/api/job")
        .json(&body)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map(|_| ())
        .map_err(|e| humanize(&e))
}

pub async fn gcode(p: &PrinterProfile, lines: &[String]) -> Result<(), String> {
    req(p, reqwest::Method::POST, "/api/printer/command")
        .json(&serde_json::json!({ "commands": lines }))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map(|_| ())
        .map_err(|e| humanize(&e))
}

pub async fn upload(p: &PrinterProfile, name: &str, data: Vec<u8>, start: bool) -> Result<(), String> {
    let part = reqwest::multipart::Part::bytes(data).file_name(name.to_string()).mime_str("application/octet-stream").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part).text("select", start.to_string()).text("print", start.to_string());
    upload_client()
        .post(format!("{}/api/files/local", base_url(p)))
        .header("X-Api-Key", &p.key)
        .multipart(form)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map(|_| ())
        .map_err(|e| humanize(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_job_and_printer() {
        // Aufbau wie in der OctoPrint-REST-Dokumentation
        let printer = serde_json::json!({
            "temperature": {"tool0": {"actual": 209.6, "target": 210.0}, "bed": {"actual": 59.9, "target": 60.0}},
            "state": {"text": "Printing", "flags": {"operational": true, "printing": true, "paused": false, "error": false, "closedOrError": false}}
        });
        let job = serde_json::json!({
            "job": {"file": {"name": "whistle_v2.gcode"}},
            "progress": {"completion": 22.5, "printTime": 276, "printTimeLeft": 912},
            "state": "Printing"
        });
        let st = parse(Some(&printer), &job);
        assert_eq!(st.state, PrintState::Printing);
        assert_eq!(st.nozzle_temp, Some(209.6));
        assert_eq!(st.bed_target, Some(60.0));
        assert_eq!(st.file_name.as_deref(), Some("whistle_v2.gcode"));
        assert_eq!(st.remaining_s, Some(912.0));
    }

    #[test]
    fn states() {
        let job = |c: f64| serde_json::json!({"job": {"file": {"name": "a.gcode"}}, "progress": {"completion": c}});
        let pr = |flags: Value| serde_json::json!({"state": {"flags": flags}});
        assert_eq!(parse(Some(&pr(serde_json::json!({"paused": true}))), &job(50.0)).state, PrintState::Paused);
        assert_eq!(parse(Some(&pr(serde_json::json!({"operational": true}))), &job(100.0)).state, PrintState::Finished);
        assert_eq!(parse(Some(&pr(serde_json::json!({"operational": true}))), &job(0.0)).state, PrintState::Idle);
        assert_eq!(parse(None, &job(0.0)).state, PrintState::Failed);
    }
}
