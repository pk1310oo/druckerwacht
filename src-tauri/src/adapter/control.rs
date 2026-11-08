//! Befehle an den Drucker – unabhängig vom Druckertyp.
//!
//! Die Oberfläche schickt kurze Befehle wie `pause`, `speed:150`, `nozzle:215` oder `level`.
//! Hier werden sie geprüft (Grenzen, erlaubt während eines Drucks?) und für den jeweiligen
//! Drucker übersetzt:
//! - Creality (KE/K1): belegte WebSocket-Befehle (`setFeedratePct`, `nozzleTempControl`,
//!   `bedTempControl`, `lightSw`, `gcodeCmd` …; Quelle: Home-Assistant-Integration ha_creality_ws)
//! - Moonraker: Klipper-G-Code, OctoPrint: Marlin-G-Code, PrusaLink: nur Pause/Fortsetzen/Abbrechen
//!
//! Welche Bedienelemente die Oberfläche zeigt, steht in `src/lib/printers.ts` (`capsOf`).

use super::{moonraker, octoprint, prusalink};
use crate::settings::PrinterProfile;
use serde_json::json;

#[derive(Debug, Clone, PartialEq)]
pub enum Cmd {
    Pause,
    Resume,
    Stop,
    /// Geschwindigkeitsfaktor in %
    Speed(u32),
    /// Flussfaktor in %
    Flow(u32),
    Nozzle(u32),
    Bed(u32),
    Light(bool),
    /// Bauteillüfter in %
    Fan(u32),
    /// Referenzfahrt aller Achsen
    Home,
    /// Bett vermessen und das Ergebnis speichern; Wert = Bett vorher heizen auf °C (0 = nicht heizen)
    Level(u32),
    /// PID-Kalibrierung der Düse auf diese Temperatur (Ergebnis wird gespeichert)
    PidNozzle(u32),
    /// PID-Kalibrierung des Betts
    PidBed(u32),
    /// Z-Offset verschieben (mm, „Babystep“)
    ZAdjust(f64),
    /// Filament fördern (+) oder zurückziehen (−), mm
    Extrude(f64),
    MotorsOff,
}

impl Cmd {
    /// Befehle, die nur ohne laufenden Druck erlaubt sind
    pub fn needs_idle(&self) -> bool {
        matches!(self, Cmd::Home | Cmd::Level(_) | Cmd::PidNozzle(_) | Cmd::PidBed(_) | Cmd::Extrude(_) | Cmd::MotorsOff)
    }
    /// Befehle, die nur während eines Drucks Sinn ergeben
    pub fn needs_job(&self) -> bool {
        matches!(self, Cmd::Pause | Cmd::Resume | Cmd::Stop | Cmd::Speed(_))
    }
}

/// „speed:150“ → `Cmd::Speed(150)`; Werte werden auf sichere Grenzen beschnitten.
pub fn parse(action: &str) -> Option<Cmd> {
    let (name, arg) = action.split_once(':').map(|(a, b)| (a, Some(b.trim()))).unwrap_or((action, None));
    let num = || arg.and_then(|a| a.parse::<f64>().ok()).filter(|v| v.is_finite());
    Some(match name {
        "pause" => Cmd::Pause,
        "resume" => Cmd::Resume,
        "stop" => Cmd::Stop,
        "speed" => Cmd::Speed(num()?.round().clamp(10.0, 200.0) as u32),
        "flow" => Cmd::Flow(num()?.round().clamp(50.0, 150.0) as u32),
        "nozzle" => Cmd::Nozzle(num()?.round().clamp(0.0, 300.0) as u32),
        "bed" => Cmd::Bed(num()?.round().clamp(0.0, 120.0) as u32),
        "light" => Cmd::Light(num()? > 0.0),
        "fan" => Cmd::Fan(num()?.round().clamp(0.0, 100.0) as u32),
        "home" => Cmd::Home,
        "level" => Cmd::Level(match arg {
            None => 0,
            Some(_) => num()?.round().clamp(0.0, 110.0) as u32,
        }),
        "pid_nozzle" => Cmd::PidNozzle(num()?.round().clamp(150.0, 280.0) as u32),
        "pid_bed" => Cmd::PidBed(num()?.round().clamp(40.0, 110.0) as u32),
        "zoffset" => Cmd::ZAdjust((num()?.clamp(-0.2, 0.2) * 1000.0).round() / 1000.0),
        "extrude" => Cmd::Extrude(num()?.clamp(-100.0, 100.0).round()),
        "motors_off" => Cmd::MotorsOff,
        _ => return None,
    })
}

/// Lüfter-% → PWM 0–255 (ganzzahlig gerundet, 50 % → 128)
fn fan_pwm(pct: u32) -> u32 {
    (pct.min(100) * 255 + 50) / 100
}

/// G-Code für Klipper (KE, K1, Moonraker-Drucker)
pub fn klipper(cmd: &Cmd, creality: bool) -> Vec<String> {
    match cmd {
        Cmd::Speed(p) => vec![format!("M220 S{p}")],
        Cmd::Flow(p) => vec![format!("M221 S{p}")],
        Cmd::Nozzle(t) => vec![format!("M104 S{t}")],
        Cmd::Bed(t) => vec![format!("M140 S{t}")],
        // Creality-Firmware: Bauteillüfter ist Kanal P0
        Cmd::Fan(p) => vec![format!("M106{} S{}", if creality { " P0" } else { "" }, fan_pwm(*p))],
        Cmd::Home => vec!["G28".into()],
        // Wie Mainsail/Fluidd: messen, dann SAVE_CONFIG (Klipper startet danach kurz neu)
        Cmd::Level(bed) => {
            let mut v = Vec::new();
            if *bed > 0 {
                v.push(format!("M190 S{bed}"));
            }
            v.extend(["G28".to_string(), "BED_MESH_CALIBRATE".to_string()]);
            if *bed > 0 {
                v.push("M140 S0".into());
            }
            v.push("SAVE_CONFIG".into());
            v
        }
        Cmd::PidNozzle(t) => vec![format!("PID_CALIBRATE HEATER=extruder TARGET={t}"), "SAVE_CONFIG".into()],
        Cmd::PidBed(t) => vec![format!("PID_CALIBRATE HEATER=heater_bed TARGET={t}"), "SAVE_CONFIG".into()],
        Cmd::ZAdjust(d) => vec![format!("SET_GCODE_OFFSET Z_ADJUST={d:.3} MOVE=1")],
        Cmd::Extrude(mm) => vec!["M83".into(), format!("G1 E{mm:.0} F{}", if *mm >= 0.0 { 300 } else { 1200 })],
        Cmd::MotorsOff => vec!["M84".into()],
        Cmd::Pause | Cmd::Resume | Cmd::Stop | Cmd::Light(_) => vec![],
    }
}

/// G-Code für Marlin (OctoPrint)
pub fn marlin(cmd: &Cmd) -> Vec<String> {
    match cmd {
        Cmd::Level(bed) => {
            let mut v = Vec::new();
            if *bed > 0 {
                v.push(format!("M190 S{bed}"));
            }
            v.extend(["G28".to_string(), "G29".to_string()]);
            if *bed > 0 {
                v.push("M140 S0".into());
            }
            // Im EEPROM sichern
            v.push("M500".into());
            v
        }
        Cmd::PidNozzle(t) => vec![format!("M303 E0 S{t} C8 U1"), "M500".into()],
        Cmd::PidBed(t) => vec![format!("M303 E-1 S{t} C8 U1"), "M500".into()],
        Cmd::ZAdjust(d) => vec![format!("M290 Z{d:.3}")],
        Cmd::Fan(p) => vec![format!("M106 S{}", fan_pwm(*p))],
        other => klipper(other, false),
    }
}

fn unsupported() -> String {
    crate::i18n::tr("Dieser Drucker unterstützt den Befehl nicht.", "This printer does not support this command.").into()
}

/// Führt einen geprüften Befehl am Drucker aus.
pub async fn run(p: &PrinterProfile, cmd: &Cmd) -> Result<(), String> {
    match p.kind.as_str() {
        "moonraker" => match cmd {
            Cmd::Pause => moonraker::print_action(p, "pause").await,
            Cmd::Resume => moonraker::print_action(p, "resume").await,
            Cmd::Stop => moonraker::print_action(p, "cancel").await,
            Cmd::Light(_) => Err(unsupported()),
            c => moonraker::gcode(p, &klipper(c, false).join("\n")).await,
        },
        "octoprint" => match cmd {
            Cmd::Pause => octoprint::job_command(p, json!({ "command": "pause", "action": "pause" })).await,
            Cmd::Resume => octoprint::job_command(p, json!({ "command": "pause", "action": "resume" })).await,
            Cmd::Stop => octoprint::job_command(p, json!({ "command": "cancel" })).await,
            Cmd::Light(_) => Err(unsupported()),
            c => octoprint::gcode(p, &marlin(c)).await,
        },
        "prusalink" => match cmd {
            Cmd::Pause => prusalink::job_action(p, "pause").await,
            Cmd::Resume => prusalink::job_action(p, "resume").await,
            Cmd::Stop => prusalink::job_action(p, "stop").await,
            _ => Err(unsupported()),
        },
        _ => {
            let port = p.port;
            let set = |v| crate::printjob::send_set(&p.host, port, v);
            match cmd {
                Cmd::Pause => set(json!({ "pause": 1 })).await,
                Cmd::Resume => set(json!({ "pause": 0 })).await,
                Cmd::Stop => set(json!({ "stop": 1 })).await,
                Cmd::Speed(v) => set(json!({ "setFeedratePct": v })).await,
                Cmd::Flow(v) => set(json!({ "setFlowratePct": v })).await,
                Cmd::Nozzle(t) => set(json!({ "nozzleTempControl": t })).await,
                Cmd::Bed(t) => set(json!({ "bedTempControl": { "num": 0, "val": t } })).await,
                Cmd::Light(on) => set(json!({ "lightSw": if *on { 1 } else { 0 } })).await,
                c => {
                    for line in klipper(c, true) {
                        set(json!({ "gcodeCmd": line })).await?;
                    }
                    Ok(())
                }
            }
        }
    }
}

/// Lädt G-Code hoch und startet auf Wunsch. Liefert den Dateinamen am Drucker.
pub async fn upload(p: &PrinterProfile, file_name: &str, data: Vec<u8>, start: bool, progress: impl Fn(f64) + Send + Sync + 'static) -> Result<String, String> {
    let name = crate::printjob::printer_file_name(file_name);
    match p.kind.as_str() {
        "moonraker" => moonraker::upload(p, &name, data, start).await?,
        "octoprint" => octoprint::upload(p, &name, data, start).await?,
        "prusalink" => prusalink::upload(p, &name, data, start).await?,
        _ => {
            crate::printjob::upload(&p.host, None, &name, &data, progress).await?;
            if start {
                crate::printjob::start(&p.host, None, &name).await?;
            }
        }
    }
    Ok(name)
}

/// Höchsttemperaturen für die Sicherheitsprüfung des G-Codes (Düse, Bett)
pub fn temp_limits(kind: &str) -> (f64, f64) {
    match kind {
        "creality" => (300.0, 100.0),
        // Andere Drucker: großzügig, aber gegen Tippfehler wie 2150 °C geschützt
        _ => (350.0, 130.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_clamps() {
        assert_eq!(parse("speed:150"), Some(Cmd::Speed(150)));
        assert_eq!(parse("speed:999"), Some(Cmd::Speed(200)));
        assert_eq!(parse("nozzle:2150"), Some(Cmd::Nozzle(300)));
        assert_eq!(parse("bed:60"), Some(Cmd::Bed(60)));
        assert_eq!(parse("zoffset:0.5"), Some(Cmd::ZAdjust(0.2)));
        assert_eq!(parse("zoffset:-0.025"), Some(Cmd::ZAdjust(-0.025)));
        assert_eq!(parse("extrude:-40"), Some(Cmd::Extrude(-40.0)));
        assert_eq!(parse("light:1"), Some(Cmd::Light(true)));
        assert_eq!(parse("speed:schnell"), None);
        assert_eq!(parse("explode"), None);
        assert!(parse("level").unwrap().needs_idle());
        assert_eq!(parse("level"), Some(Cmd::Level(0)));
        assert_eq!(parse("level:60"), Some(Cmd::Level(60)));
        assert_eq!(parse("pid_nozzle:500"), Some(Cmd::PidNozzle(280)));
        assert_eq!(parse("pid_bed"), None);
        assert!(parse("pid_bed:60").unwrap().needs_idle());
        assert!(!parse("zoffset:0.01").unwrap().needs_idle());
    }

    #[test]
    fn translates_gcode() {
        assert_eq!(klipper(&Cmd::Level(0), true), vec!["G28", "BED_MESH_CALIBRATE", "SAVE_CONFIG"]);
        assert_eq!(klipper(&Cmd::Level(60), false), vec!["M190 S60", "G28", "BED_MESH_CALIBRATE", "M140 S0", "SAVE_CONFIG"]);
        assert_eq!(klipper(&Cmd::PidNozzle(220), true), vec!["PID_CALIBRATE HEATER=extruder TARGET=220", "SAVE_CONFIG"]);
        assert_eq!(marlin(&Cmd::PidBed(60)), vec!["M303 E-1 S60 C8 U1", "M500"]);
        assert_eq!(klipper(&Cmd::Fan(100), true), vec!["M106 P0 S255"]);
        assert_eq!(klipper(&Cmd::Fan(50), false), vec!["M106 S128"]);
        assert_eq!(klipper(&Cmd::ZAdjust(-0.02), false), vec!["SET_GCODE_OFFSET Z_ADJUST=-0.020 MOVE=1"]);
        assert_eq!(marlin(&Cmd::Level(0)), vec!["G28", "G29", "M500"]);
        assert_eq!(marlin(&Cmd::ZAdjust(0.05)), vec!["M290 Z0.050"]);
        assert_eq!(klipper(&Cmd::Extrude(50.0), false), vec!["M83", "G1 E50 F300"]);
    }
}
