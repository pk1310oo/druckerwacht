//! Normalisiertes Datenmodell + toleranter Parser für die Creality-WebSocket-Nachrichten.
//!
//! Die Schnittstelle (ws://<ip>:9999) ist undokumentiert. Der Drucker schickt JSON-Objekte,
//! die jeweils nur einen *Teil* der Felder enthalten. Deshalb werden alle Nachrichten einer
//! Verbindung in eine Map zusammengeführt (`merge`) und daraus wird bei jeder Änderung ein
//! vollständiger `PrinterStatus` abgeleitet (`parse`).
//!
//! Regeln des Parsers:
//! - Zahlen dürfen als Zahl, als String ("25.120000") oder als Bool kommen.
//! - Fehlende oder unbekannte Felder führen nie zu einem Fehler, sondern zu `None`.
//! - Für jedes Feld sind mehrere Kandidaten-Schlüssel hinterlegt (Firmware-Varianten).
//!
//! Die Feldnamen stammen aus öffentlich bekannten Mitschnitten der K1/KE-Familie und
//! MÜSSEN mit einem echten Mitschnitt des eigenen Druckers (scripts/probe.mjs) bestätigt werden.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum PrintState {
    Idle,
    Printing,
    Paused,
    Finished,
    Failed,
    Aborted,
    #[default]
    Unknown,
}

impl PrintState {
    pub fn is_active(self) -> bool {
        matches!(self, PrintState::Printing | PrintState::Paused)
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterStatus {
    pub model: Option<String>,
    pub hostname: Option<String>,

    pub nozzle_temp: Option<f64>,
    pub nozzle_target: Option<f64>,
    pub bed_temp: Option<f64>,
    pub bed_target: Option<f64>,
    pub chamber_temp: Option<f64>,

    pub state: PrintState,
    pub state_code: Option<i64>,
    pub file_name: Option<String>,
    pub progress: Option<f64>,
    pub layer: Option<i64>,
    pub total_layers: Option<i64>,
    pub elapsed_s: Option<f64>,
    pub remaining_s: Option<f64>,

    /// Tatsächliche Geschwindigkeit in mm/s
    pub speed_mm_s: Option<f64>,
    /// Geschwindigkeitsfaktor in %
    pub speed_pct: Option<f64>,
    /// Flussfaktor in %
    pub flow_pct: Option<f64>,
    /// Volumenstrom in mm³/s
    pub flow_mm3_s: Option<f64>,
    pub fan_pct: Option<f64>,
    pub fan_aux_pct: Option<f64>,
    pub fan_case_pct: Option<f64>,

    pub error_code: Option<i64>,
    pub error_key: Option<i64>,

    pub max_nozzle_temp: Option<f64>,
    pub max_bed_temp: Option<f64>,
}

/// Führt eine eingehende Nachricht in den bisherigen Zustand zusammen.
/// Gibt `true` zurück, wenn es ein Objekt war (also potenziell Daten enthielt).
pub fn merge(target: &mut Map<String, Value>, incoming: &Value) -> bool {
    match incoming {
        Value::Object(obj) => {
            for (k, v) in obj {
                target.insert(k.clone(), v.clone());
            }
            true
        }
        _ => false,
    }
}

fn to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
    .filter(|f| f.is_finite())
}

fn num(map: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| map.get(*k).and_then(to_f64))
}

fn int(map: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    num(map, keys).map(|f| f.round() as i64)
}

fn text(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match map.get(*k) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    })
}

fn pct(v: Option<f64>) -> Option<f64> {
    v.map(|p| p.clamp(0.0, 1000.0))
}

/// Statuscode → Zustand. Annahme (K1-Familie): 0 bereit, 1 druckt, 2 fertig,
/// 3 fehlgeschlagen, 4 abgebrochen, 5 pausiert. Unbekannte Codes → Unknown.
///
/// Bestätigt am echten Ender 3 V3 KE (Firmware V1.1.0.17): im Leerlauf ohne Datei
/// meldet er `state: 4`. Ein End-/Unbekannt-Zustand ohne Datei und ohne Fortschritt
/// wird deshalb in `parse` als „bereit“ gewertet.
fn map_state(code: Option<i64>) -> PrintState {
    match code {
        Some(0) => PrintState::Idle,
        Some(1) => PrintState::Printing,
        Some(2) => PrintState::Finished,
        Some(3) => PrintState::Failed,
        Some(4) => PrintState::Aborted,
        Some(5) => PrintState::Paused,
        _ => PrintState::Unknown,
    }
}

fn clean_file_name(raw: String) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(&raw).to_string();
    base.strip_suffix(".gcode")
        .or_else(|| base.strip_suffix(".GCODE"))
        .map(str::to_string)
        .unwrap_or(base)
}

pub fn parse(map: &Map<String, Value>) -> PrinterStatus {
    let state_code = int(map, &["state", "printState"]);
    let (error_code, error_key) = match map.get("err") {
        Some(Value::Object(e)) => (int(e, &["errcode", "code"]), int(e, &["key"])),
        _ => (int(map, &["errcode"]), None),
    };

    let file_name = text(map, &["printFileName", "fileName", "printFile"]).map(clean_file_name);
    let progress = num(map, &["printProgress", "dProgress", "progress"]).map(|p| p.clamp(0.0, 100.0));
    let mut state = map_state(state_code);
    let no_job = file_name.is_none() && progress.unwrap_or(0.0) <= 0.0;
    if no_job && !state.is_active() {
        state = PrintState::Idle;
    }

    PrinterStatus {
        model: text(map, &["model", "modelName"]),
        hostname: text(map, &["hostname", "deviceName"]),

        nozzle_temp: num(map, &["nozzleTemp", "nozzleTemp0"]),
        nozzle_target: num(map, &["targetNozzleTemp", "targetNozzleTemp0"]),
        bed_temp: num(map, &["bedTemp0", "bedTemp"]),
        bed_target: num(map, &["targetBedTemp0", "targetBedTemp"]),
        chamber_temp: num(map, &["boxTemp", "chamberTemp"]),

        state,
        state_code,
        file_name,
        progress,
        layer: int(map, &["layer", "curLayer"]),
        total_layers: int(map, &["TotalLayer", "totalLayer", "totalLayers"]),
        elapsed_s: num(map, &["printJobTime"]).filter(|s| *s >= 0.0),
        remaining_s: num(map, &["printLeftTime"]).filter(|s| *s >= 0.0),

        speed_mm_s: num(map, &["realTimeSpeed", "curSpeed"]).filter(|s| *s >= 0.0),
        speed_pct: pct(num(map, &["curFeedratePct", "feedratePct"])),
        flow_pct: pct(num(map, &["curFlowratePct", "curFlowPct", "flowRatePct", "flowrate"])),
        flow_mm3_s: num(map, &["realTimeFlow"]).filter(|s| *s >= 0.0),
        fan_pct: pct(num(map, &["modelFanPct", "fanPct"])),
        fan_aux_pct: pct(num(map, &["auxiliaryFanPct"])),
        fan_case_pct: pct(num(map, &["caseFanPct"])),

        error_code,
        error_key,

        max_nozzle_temp: num(map, &["maxNozzleTemp"]).filter(|t| *t > 0.0),
        max_bed_temp: num(map, &["maxBedTemp"]).filter(|t| *t > 0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tolerates_strings_partials_and_garbage() {
        let mut m = Map::new();
        merge(&mut m, &json!({"nozzleTemp":"214.560000","targetNozzleTemp":215,"state":1}));
        merge(&mut m, &json!({"printProgress":47,"printFileName":"/usr/data/printer_data/gcodes/Benchy.gcode"}));
        merge(&mut m, &json!({"bedTemp0":"abc","layer":null,"err":{"errcode":0,"key":0}}));
        assert!(!merge(&mut m, &json!("ok")));
        let s = parse(&m);
        assert_eq!(s.nozzle_temp, Some(214.56));
        assert_eq!(s.nozzle_target, Some(215.0));
        assert_eq!(s.bed_temp, None);
        assert_eq!(s.layer, None);
        assert_eq!(s.state, PrintState::Printing);
        assert_eq!(s.progress, Some(47.0));
        assert_eq!(s.file_name.as_deref(), Some("Benchy"));
        assert_eq!(s.error_code, Some(0));
    }

    /// Echter Mitschnitt: Ender 3 V3 KE im Leerlauf (Firmware V1.1.0.17)
    #[test]
    fn real_ke_idle_capture() {
        let mut m = Map::new();
        for line in include_str!("../fixtures/ke-idle.jsonl").lines().filter(|l| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(line).unwrap();
            if v["dir"] == "in" {
                merge(&mut m, &v["msg"]);
            }
        }
        let s = parse(&m);
        assert_eq!(s.state_code, Some(4));
        assert_eq!(s.state, PrintState::Idle, "state 4 ohne Datei = Leerlauf");
        assert_eq!(s.file_name, None);
        assert_eq!(s.model.as_deref(), Some("F005"));
        assert_eq!(s.nozzle_temp, Some(18.45));
        assert_eq!(s.bed_temp, Some(18.62));
        assert_eq!(s.nozzle_target, Some(0.0));
        assert_eq!(s.flow_pct, Some(100.0));
        assert_eq!(s.speed_pct, Some(100.0));
        assert_eq!(s.speed_mm_s, Some(0.0));
        assert_eq!(s.fan_pct, Some(0.0));
        assert_eq!(s.max_nozzle_temp, Some(300.0));
        assert_eq!(s.max_bed_temp, Some(100.0));
        assert_eq!(s.error_code, Some(0));
    }

    #[test]
    fn state4_with_file_is_aborted() {
        let mut m = Map::new();
        merge(&mut m, &json!({"state": 4, "printFileName": "/x/Benchy.gcode", "printProgress": 30}));
        assert_eq!(parse(&m).state, PrintState::Aborted);
    }

    #[test]
    fn unknown_state_code() {
        let mut m = Map::new();
        merge(&mut m, &json!({"state": 42, "printFileName": "a.gcode"}));
        let s = parse(&m);
        assert_eq!(s.state, PrintState::Unknown);
        assert_eq!(s.state_code, Some(42));
    }
}
