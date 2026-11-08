//! Klipper-Drucker über Moonraker (Standard-Port 7125): Voron, Sovol SV06+/SV07/SV08,
//! Elegoo Neptune 4, Qidi, Creality mit Root und viele mehr.
//!
//! Status: `GET /printer/objects/query?…` (dokumentierte Moonraker-API), alle 1,5 s.
//! Befehle: `/printer/print/pause|resume|cancel`, G-Code über `/printer/gcode/script`,
//! Upload über `/server/files/upload`. Ein API-Schlüssel ist optional (Header `X-Api-Key`).

use super::http::{base_url, client, f, humanize, poll_loop, upload_client};
use super::{AdapterEvent, PrinterAdapter};
use crate::model::{PrintState, PrinterStatus};
use crate::settings::PrinterProfile;
use futures_util::{future::BoxFuture, FutureExt};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

const OBJECTS: &str = "webhooks&print_stats&virtual_sdcard&display_status&extruder&heater_bed&gcode_move&fan&motion_report&toolhead";

pub struct MoonrakerAdapter;

impl PrinterAdapter for MoonrakerAdapter {
    fn run(&self, printer: PrinterProfile, tx: mpsc::UnboundedSender<AdapterEvent>, shutdown: watch::Receiver<bool>) -> BoxFuture<'static, ()> {
        poll_loop(printer, tx, shutdown, fetch).boxed()
    }
}

fn req(p: &PrinterProfile, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    let r = client().request(method, format!("{}{path}", base_url(p)));
    if p.key.is_empty() {
        r
    } else {
        r.header("X-Api-Key", &p.key)
    }
}

async fn fetch(p: PrinterProfile) -> Result<PrinterStatus, String> {
    let v: Value = req(&p, reqwest::Method::GET, &format!("/printer/objects/query?{OBJECTS}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| humanize(&e))?
        .json()
        .await
        .map_err(|_| crate::i18n::tr("Unerwartete Antwort – ist das ein Moonraker-Drucker?", "Unexpected answer – is this a Moonraker printer?").to_string())?;
    Ok(parse(&v["result"]["status"]))
}

/// Moonraker-Objekte → einheitlicher Status
pub fn parse(s: &Value) -> PrinterStatus {
    let ps = &s["print_stats"];
    let klippy = s["webhooks"]["state"].as_str().unwrap_or("ready");
    let mut state = match ps["state"].as_str().unwrap_or("") {
        "printing" => PrintState::Printing,
        "paused" => PrintState::Paused,
        "complete" => PrintState::Finished,
        "cancelled" => PrintState::Aborted,
        "error" => PrintState::Failed,
        "standby" => PrintState::Idle,
        _ => PrintState::Unknown,
    };
    if klippy == "shutdown" || klippy == "error" {
        state = PrintState::Failed;
    }
    let progress = f(&s["display_status"]["progress"]).filter(|x| *x > 0.0).or_else(|| f(&s["virtual_sdcard"]["progress"])).map(|x| (x * 100.0).clamp(0.0, 100.0));
    let print_s = f(&ps["print_duration"]);
    let remaining_s = match (print_s, progress) {
        (Some(t), Some(p)) if p > 1.0 && p < 100.0 => Some(t / (p / 100.0) - t),
        _ => None,
    };
    let pos = s["motion_report"]["live_position"].as_array().or_else(|| s["toolhead"]["position"].as_array());
    let position = pos.and_then(|a| Some([f(a.first()?)?, f(a.get(1)?)?, f(a.get(2)?)?]));
    let file = ps["filename"].as_str().filter(|n| !n.is_empty()).map(str::to_string);
    PrinterStatus {
        nozzle_temp: f(&s["extruder"]["temperature"]),
        nozzle_target: f(&s["extruder"]["target"]),
        bed_temp: f(&s["heater_bed"]["temperature"]),
        bed_target: f(&s["heater_bed"]["target"]),
        state,
        preparing: state == PrintState::Printing && progress.unwrap_or(0.0) < 0.05,
        file_name: file,
        progress,
        layer: ps["info"]["current_layer"].as_i64(),
        total_layers: ps["info"]["total_layer"].as_i64(),
        elapsed_s: f(&ps["total_duration"]),
        remaining_s,
        speed_mm_s: f(&s["motion_report"]["live_velocity"]),
        speed_pct: f(&s["gcode_move"]["speed_factor"]).map(|x| x * 100.0),
        flow_pct: f(&s["gcode_move"]["extrude_factor"]).map(|x| x * 100.0),
        flow_mm3_s: f(&s["motion_report"]["live_extruder_velocity"]).map(|e| e * std::f64::consts::PI * 0.875 * 0.875),
        fan_pct: f(&s["fan"]["speed"]).map(|x| x * 100.0),
        used_material_mm: f(&ps["filament_used"]),
        position,
        ..Default::default()
    }
}

pub async fn print_action(p: &PrinterProfile, action: &str) -> Result<(), String> {
    req(p, reqwest::Method::POST, &format!("/printer/print/{action}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map(|_| ())
        .map_err(|e| humanize(&e))
}

pub async fn gcode(p: &PrinterProfile, script: &str) -> Result<(), String> {
    let r = client().post(format!("{}/printer/gcode/script", base_url(p))).query(&[("script", script)]);
    let r = if p.key.is_empty() { r } else { r.header("X-Api-Key", &p.key) };
    // G28 und Leveling dauern; Moonraker antwortet erst danach – nicht darauf warten
    match tokio::time::timeout(std::time::Duration::from_secs(4), r.send()).await {
        Err(_) => Ok(()),
        Ok(res) => res.and_then(|r| r.error_for_status()).map(|_| ()).map_err(|e| humanize(&e)),
    }
}

pub async fn upload(p: &PrinterProfile, name: &str, data: Vec<u8>, start: bool) -> Result<(), String> {
    let part = reqwest::multipart::Part::bytes(data).file_name(name.to_string()).mime_str("application/octet-stream").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part).text("root", "gcodes").text("print", if start { "true" } else { "false" });
    let r = upload_client().post(format!("{}/server/files/upload", base_url(p))).multipart(form);
    let r = if p.key.is_empty() { r } else { r.header("X-Api-Key", &p.key) };
    r.send().await.and_then(|r| r.error_for_status()).map(|_| ()).map_err(|e| humanize(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_printing_status() {
        // Aufbau wie in der Moonraker-Dokumentation (printer.objects.query)
        let s = serde_json::json!({
            "webhooks": {"state": "ready"},
            "print_stats": {"filename": "benchy.gcode", "total_duration": 1300.0, "print_duration": 1200.0, "filament_used": 1520.5, "state": "printing", "info": {"current_layer": 42, "total_layer": 120}},
            "virtual_sdcard": {"progress": 0.40},
            "display_status": {"progress": 0.42},
            "extruder": {"temperature": 214.6, "target": 215.0},
            "heater_bed": {"temperature": 59.8, "target": 60.0},
            "gcode_move": {"speed_factor": 1.5, "extrude_factor": 0.95},
            "fan": {"speed": 0.8},
            "motion_report": {"live_velocity": 180.2, "live_position": [100.0, 80.0, 8.4, 3.0]}
        });
        let st = parse(&s);
        assert_eq!(st.state, PrintState::Printing);
        assert!(!st.preparing);
        assert_eq!(st.file_name.as_deref(), Some("benchy.gcode"));
        assert!((st.progress.unwrap() - 42.0).abs() < 1e-9);
        assert_eq!((st.layer, st.total_layers), (Some(42), Some(120)));
        assert!((st.speed_pct.unwrap() - 150.0).abs() < 1e-9);
        assert!((st.flow_pct.unwrap() - 95.0).abs() < 1e-9);
        assert!((st.fan_pct.unwrap() - 80.0).abs() < 1e-9);
        assert_eq!(st.position, Some([100.0, 80.0, 8.4]));
        // Restzeit: 1200 s für 42 % → gesamt ~2857 s → Rest ~1657 s
        assert!((st.remaining_s.unwrap() - 1657.14).abs() < 1.0);
    }

    #[test]
    fn maps_states() {
        let st = |state: &str, klippy: &str| parse(&serde_json::json!({"webhooks": {"state": klippy}, "print_stats": {"state": state}})).state;
        assert_eq!(st("standby", "ready"), PrintState::Idle);
        assert_eq!(st("paused", "ready"), PrintState::Paused);
        assert_eq!(st("complete", "ready"), PrintState::Finished);
        assert_eq!(st("cancelled", "ready"), PrintState::Aborted);
        assert_eq!(st("printing", "shutdown"), PrintState::Failed);
    }
}
