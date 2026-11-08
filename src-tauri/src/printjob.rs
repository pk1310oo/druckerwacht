//! Datei an den Drucker senden und Druck starten – so wie Creality Print / OrcaSlicer es tun:
//!
//! 1. Hochladen: HTTP-POST (multipart, Feld „file“) an `http://<ip>/upload/<dateiname>`
//! 2. Starten:   WebSocket :9999 → `{"method":"set","params":{"opGcodeFile":"printprt:<pfad>"}}`
//!
//! Quelle: OrcaSlicer `src/slic3r/Utils/CrealityPrint.cpp`. Der Ablageort
//! `/usr/data/printer_data/gcodes/` ist am Ender 3 V3 KE gemessen (printFileName im Mitschnitt).
//! Orca selbst würde für den KE fälschlich `/mnt/UDISK` annehmen, weil er nicht in seiner
//! K1-Liste steht.

use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub const GCODE_DIR: &str = "/usr/data/printer_data/gcodes";
const HTTP_PORT: u16 = 80;
const WS_PORT: u16 = 9999;

/// Dateiname, den der Drucker sicher verarbeiten kann (keine Leerzeichen/Umlaute).
pub fn printer_file_name(name: &str) -> String {
    let base = name.trim_end_matches(".gcode");
    let mut s: String = base
        .chars()
        .map(|c| match c {
            'ä' => 'a',
            'ö' => 'o',
            'ü' => 'u',
            'Ä' => 'A',
            'Ö' => 'O',
            'Ü' => 'U',
            'ß' => 's',
            c if c.is_ascii_alphanumeric() || c == '-' || c == '.' => c,
            _ => '_',
        })
        .collect();
    while s.contains("__") {
        s = s.replace("__", "_");
    }
    let s = s.trim_matches('_');
    let s = if s.is_empty() { "druck" } else { s };
    format!("{s}.gcode")
}

/// Sicherheitsprüfung vor dem Senden: Ist es G-Code, und bleiben alle Soll-Temperaturen
/// (M104/M109 Düse, M140/M190 Bett) innerhalb der Grenzen des Druckers?
pub fn check_gcode(data: &[u8], max_nozzle: f64, max_bed: f64) -> Result<(), String> {
    let text = String::from_utf8_lossy(data);
    let mut moves = 0usize;
    for (i, raw) in text.lines().enumerate() {
        let line = raw.split(';').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let cmd = parts.next().unwrap_or("").to_ascii_uppercase();
        if cmd == "G0" || cmd == "G1" {
            moves += 1;
            continue;
        }
        let (limit, what) = match cmd.as_str() {
            "M104" | "M109" => (max_nozzle, crate::i18n::tr("Düse", "nozzle")),
            "M140" | "M190" => (max_bed, crate::i18n::tr("Bett", "bed")),
            _ => continue,
        };
        for p in parts {
            let Some(k) = p.chars().next() else { continue };
            let v = &p[k.len_utf8()..];
            if matches!(k, 'S' | 's' | 'R' | 'r') {
                if let Ok(t) = v.parse::<f64>() {
                    if t > limit {
                        let line_no = i + 1;
                        return Err(crate::trf!(
                            "Sicherheitsstopp: Der G-Code setzt die {what} auf {t:.0} °C (Zeile {line_no}), erlaubt sind höchstens {limit:.0} °C. Bitte die Temperatur in den Einstellungen prüfen.",
                            "Safety stop: the G-code sets the {what} to {t:.0} °C (line {line_no}), the maximum allowed is {limit:.0} °C. Please check the temperature settings."
                        ));
                    }
                }
            }
        }
    }
    if moves == 0 {
        return Err(crate::i18n::tr("Die Datei enthält keine Druckbewegungen – das ist kein gültiger G-Code.", "The file contains no print moves – this is not valid G-code.").into());
    }
    Ok(())
}

/// Fügt Pausen für einen Filamentwechsel ein: vor dem Beginn jeder Schicht in `layers`
/// (0-basiert, gezählt wie die Vorschau: das n-te `;LAYER_CHANGE`). Der Drucker hält dort mit
/// `PAUSE` an (so wie OrcaSlicer es für den KE vorsieht); weiter geht es mit „Fortsetzen“.
/// Schicht 0 wird übersprungen – vor der ersten Schicht ist noch nichts gedruckt.
pub fn insert_pauses(text: &str, layers: &[u32]) -> String {
    let mut want: Vec<u32> = layers.iter().copied().filter(|&l| l > 0).collect();
    want.sort_unstable();
    want.dedup();
    if want.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + want.len() * 80);
    let mut layer: i64 = -1;
    let mut next = 0usize;
    for line in text.split_inclusive('\n') {
        if line.starts_with(";LAYER_CHANGE") {
            layer += 1;
            if next < want.len() && layer as u32 == want[next] {
                let n = layer + 1;
                out.push_str(&format!(";DRUCKERWACHT_FILAMENT_CHANGE layer {n}\n;PAUSE_PRINT\nPAUSE\n"));
                next += 1;
            }
        }
        out.push_str(line);
    }
    out
}

/// Temperaturwechsel für Kalibrier-Türme: setzt `M104` direkt nach dem ersten Schichtwechsel,
/// dessen Höhe (`;Z:`) die Stufe erreicht. Stufen: (Höhe in mm, Düse in °C).
pub fn insert_temps(text: &str, steps: &[(f64, u32)]) -> String {
    let mut want: Vec<(f64, u32)> = steps.iter().copied().filter(|(z, t)| z.is_finite() && *z >= 0.0 && *t <= 300).collect();
    want.sort_by(|a, b| a.0.total_cmp(&b.0));
    if want.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + want.len() * 48);
    let mut next = 0usize;
    let mut after_change = false;
    for line in text.split_inclusive('\n') {
        out.push_str(line);
        if line.starts_with(";LAYER_CHANGE") {
            after_change = true;
            continue;
        }
        if after_change {
            if let Some(z) = line.strip_prefix(";Z:").and_then(|v| v.trim().parse::<f64>().ok()) {
                after_change = false;
                let mut temp = None;
                while next < want.len() && z + 1e-6 >= want[next].0 {
                    temp = Some(want[next].1);
                    next += 1;
                }
                if let Some(t) = temp {
                    out.push_str(&format!("M104 S{t} ; DRUCKERWACHT_TEMP_TOWER\n"));
                }
            }
        }
    }
    out
}

/// Lädt `data` als `file_name` hoch. `progress` erhält 0…1.
pub async fn upload(host: &str, port: Option<u16>, file_name: &str, data: &[u8], progress: impl Fn(f64)) -> Result<(), String> {
    let port = port.unwrap_or(HTTP_PORT);
    let boundary = format!("----Druckerwacht{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0));
    let head = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    );
    let tail = format!("\r\n--{boundary}--\r\n");
    let len = head.len() + data.len() + tail.len();
    let request = format!(
        "POST /upload/{file_name} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Druckerwacht\r\nAccept: */*\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
    );

    let mut stream = tokio::time::timeout(Duration::from_secs(6), TcpStream::connect((host, port)))
        .await
        .map_err(|_| crate::i18n::tr("Drucker antwortet nicht (Upload).", "Printer not responding (upload).").to_string())?
        .map_err(|_| crate::i18n::tr("Verbindung zum Drucker fehlgeschlagen (Upload).", "Connection to the printer failed (upload).").to_string())?;

    let io = |_| crate::i18n::tr("Upload unterbrochen.", "Upload interrupted.").to_string();
    stream.write_all(request.as_bytes()).await.map_err(io)?;
    stream.write_all(head.as_bytes()).await.map_err(io)?;
    let total = data.len().max(1) as f64;
    let mut sent = 0usize;
    for chunk in data.chunks(64 * 1024) {
        tokio::time::timeout(Duration::from_secs(30), stream.write_all(chunk))
            .await
            .map_err(|_| crate::i18n::tr("Upload hängt – Verbindung zu langsam?", "Upload stalled – connection too slow?").to_string())?
            .map_err(io)?;
        sent += chunk.len();
        progress(sent as f64 / total);
    }
    stream.write_all(tail.as_bytes()).await.map_err(io)?;
    stream.flush().await.map_err(io)?;

    // Antwort lesen (nur die Statuszeile ist wichtig)
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(60), async {
        let mut tmp = [0u8; 4096];
        loop {
            match stream.read(&mut tmp).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.len() > 64 * 1024 {
                        break;
                    }
                }
            }
        }
    })
    .await;
    let text = String::from_utf8_lossy(&buf);
    let code: u16 = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or(crate::i18n::tr("Der Drucker hat den Upload nicht bestätigt.", "The printer did not confirm the upload."))?;
    if (200..300).contains(&code) {
        Ok(())
    } else {
        Err(crate::trf!("Der Drucker hat den Upload abgelehnt (HTTP {code}).", "The printer rejected the upload (HTTP {code})."))
    }
}

/// Startet den Druck einer bereits hochgeladenen Datei.
pub async fn start(host: &str, port: Option<u16>, file_name: &str) -> Result<(), String> {
    let url = format!("ws://{host}:{}", port.unwrap_or(WS_PORT));
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(6), connect_async(url.as_str()))
        .await
        .map_err(|_| crate::i18n::tr("Drucker antwortet nicht (Start).", "Printer not responding (start).").to_string())?
        .map_err(|_| crate::i18n::tr("Verbindung zum Drucker fehlgeschlagen (Start).", "Connection to the printer failed (start).").to_string())?;
    let cmd = serde_json::json!({
        "method": "set",
        "params": { "opGcodeFile": format!("printprt:{GCODE_DIR}/{file_name}") }
    });
    ws.send(Message::text(cmd.to_string()))
        .await
        .map_err(|_| crate::i18n::tr("Startbefehl konnte nicht gesendet werden.", "The start command could not be sent.").to_string())?;
    // Die Firmware schließt die Verbindung oft direkt nach dem Annehmen – das ist kein Fehler.
    let _ = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
    let _ = ws.close(None).await;
    Ok(())
}

/// Schickt `{"method":"set","params":…}` über den WebSocket des Druckers.
pub async fn send_set(host: &str, port: Option<u16>, params: serde_json::Value) -> Result<(), String> {
    let url = format!("ws://{host}:{}", port.unwrap_or(WS_PORT));
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(6), connect_async(url.as_str()))
        .await
        .map_err(|_| crate::i18n::tr("Drucker antwortet nicht.", "Printer not responding.").to_string())?
        .map_err(|_| crate::i18n::tr("Verbindung zum Drucker fehlgeschlagen.", "Connection to the printer failed.").to_string())?;
    let cmd = serde_json::json!({ "method": "set", "params": params });
    ws.send(Message::text(cmd.to_string()))
        .await
        .map_err(|_| crate::i18n::tr("Befehl konnte nicht gesendet werden.", "The command could not be sent.").to_string())?;
    let _ = tokio::time::timeout(Duration::from_millis(1500), ws.next()).await;
    let _ = ws.close(None).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn control_commands() {
        // Der neue Weg: Oberfläche → control::parse → control::run → WebSocket des Druckers
        for (action, expected) in [
            ("pause", vec![r#"{"method":"set","params":{"pause":1}}"#]),
            ("resume", vec![r#"{"method":"set","params":{"pause":0}}"#]),
            ("stop", vec![r#"{"method":"set","params":{"stop":1}}"#]),
            ("speed:150", vec![r#"{"method":"set","params":{"setFeedratePct":150}}"#]),
            ("speed:999", vec![r#"{"method":"set","params":{"setFeedratePct":200}}"#]),
            ("nozzle:215", vec![r#"{"method":"set","params":{"nozzleTempControl":215}}"#]),
            ("bed:60", vec![r#"{"method":"set","params":{"bedTempControl":{"num":0,"val":60}}}"#]),
            ("light:1", vec![r#"{"method":"set","params":{"lightSw":1}}"#]),
            (
                "level",
                vec![
                    r#"{"method":"set","params":{"gcodeCmd":"G28"}}"#,
                    r#"{"method":"set","params":{"gcodeCmd":"BED_MESH_CALIBRATE"}}"#,
                    r#"{"method":"set","params":{"gcodeCmd":"SAVE_CONFIG"}}"#,
                ],
            ),
            ("fan:50", vec![r#"{"method":"set","params":{"gcodeCmd":"M106 P0 S128"}}"#]),
        ] {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = l.local_addr().unwrap().port();
            let n = expected.len();
            let srv = tokio::spawn(async move {
                let mut got = Vec::new();
                for _ in 0..n {
                    let (sock, _) = l.accept().await.unwrap();
                    let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
                    got.push(ws.next().await.unwrap().unwrap().into_text().unwrap().to_string());
                }
                got
            });
            let p = crate::settings::PrinterProfile { kind: "creality".into(), host: "127.0.0.1".into(), port: Some(port), ..Default::default() };
            let cmd = crate::adapter::control::parse(action).unwrap();
            crate::adapter::control::run(&p, &cmd).await.unwrap();
            assert_eq!(srv.await.unwrap(), expected, "{action}");
        }
    }

    #[test]
    fn gcode_temperature_guard() {
        let ok = b"M140 S60\nM104 S205 ; Duese\nG1 X10 Y10 E1\n";
        assert!(check_gcode(ok, 300.0, 100.0).is_ok());
        let hot = b"M104 S205\nM190 S120\nG1 X1\n";
        let e = check_gcode(hot, 300.0, 100.0).unwrap_err();
        assert!(e.contains("Bett") && e.contains("120") && e.contains("Zeile 2"), "{e}");
        let nozzle = b"G1 X1\nm109 s350\n";
        assert!(check_gcode(nozzle, 300.0, 100.0).unwrap_err().contains("Düse"));
        assert!(check_gcode(b"; nur Kommentar\n", 300.0, 100.0).is_err());
        // Temperaturen in Kommentaren zählen nicht
        assert!(check_gcode(b"; M104 S999\nG1 X1\n", 300.0, 100.0).is_ok());
        assert!(check_gcode("M104 \u{e4}200\nG1 X1\n".as_bytes(), 300.0, 100.0).is_ok());
    }

    /// Echter G-Code von OrcaSlicer darf nicht blockiert werden (DW_GCODE=pfad).
    #[test]
    fn real_gcode_passes_guard() {
        let Ok(path) = std::env::var("DW_GCODE") else { return };
        for p in path.split(':') {
            let data = std::fs::read(p).unwrap();
            check_gcode(&data, 300.0, 100.0).unwrap();
        }
    }

    #[test]
    fn pauses_before_layers() {
        let g = "G28\n;LAYER_CHANGE\n;Z:0.2\nG1 X1 E1\n;LAYER_CHANGE\n;Z:0.4\nG1 X2 E1\n;LAYER_CHANGE\n;Z:0.6\nG1 X3 E1\n";
        let out = insert_pauses(g, &[2, 0, 2, 9]);
        // genau eine Pause, direkt vor der dritten Schicht; Schicht 0 und unbekannte Schichten ignoriert
        assert_eq!(out.matches("\nPAUSE\n").count(), 1);
        let at = out.find("PAUSE\n;LAYER_CHANGE\n;Z:0.6").expect("Pause vor Z 0.6");
        assert!(out[..at].contains(";Z:0.4"));
        assert!(out.contains(";DRUCKERWACHT_FILAMENT_CHANGE layer 3"));
        // ohne Pausen unverändert
        assert_eq!(insert_pauses(g, &[]), g);
        assert_eq!(out.replace(";DRUCKERWACHT_FILAMENT_CHANGE layer 3\n;PAUSE_PRINT\nPAUSE\n", ""), g);
    }

    #[test]
    fn temperature_tower_steps() {
        let g = "G28\n;LAYER_CHANGE\n;Z:0.2\nG1 E1\n;LAYER_CHANGE\n;Z:5.0\nG1 E1\n;LAYER_CHANGE\n;Z:10.2\nG1 E1\n;LAYER_CHANGE\n;Z:20.0\nG1 E1\n";
        let out = insert_temps(g, &[(10.0, 220), (0.6, 230), (20.0, 215), (30.0, 999)]);
        assert!(out.contains(";Z:5.0\nM104 S230 ; DRUCKERWACHT_TEMP_TOWER\n"));
        assert!(out.contains(";Z:10.2\nM104 S220"));
        assert!(out.contains(";Z:20.0\nM104 S215"));
        assert_eq!(out.matches("M104").count(), 3);
        assert_eq!(insert_temps(g, &[]), g);
    }

    #[test]
    fn safe_names() {
        assert_eq!(printer_file_name("Würfel Test (2).gcode"), "Wurfel_Test_2.gcode");
        assert_eq!(printer_file_name("torus__1_Generic PLA_0.2mm.gcode"), "torus_1_Generic_PLA_0.2mm.gcode");
        assert_eq!(printer_file_name("???"), "druck.gcode");
    }

    /// Nachgebauter Drucker: nimmt den Upload an und prüft den Startbefehl.
    #[tokio::test]
    async fn upload_and_start_roundtrip() {
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = http.local_addr().unwrap().port();
        let ws_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_port = ws_l.local_addr().unwrap().port();

        let server = tokio::spawn(async move {
            let (mut s, _) = http.accept().await.unwrap();
            let mut req = Vec::new();
            let mut tmp = [0u8; 8192];
            loop {
                let n = s.read(&mut tmp).await.unwrap();
                req.extend_from_slice(&tmp[..n]);
                if req.ends_with(b"--\r\n") || n == 0 {
                    break;
                }
            }
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await.unwrap();
            drop(s);
            let (sock, _) = ws_l.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            let msg = ws.next().await.unwrap().unwrap().into_text().unwrap().to_string();
            (String::from_utf8_lossy(&req).to_string(), msg)
        });

        let data = b"G28\nG1 X10\n".repeat(20000);
        let last = std::sync::Arc::new(std::sync::Mutex::new(0.0));
        let l2 = last.clone();
        upload("127.0.0.1", Some(http_port), "test.gcode", &data, move |p| *l2.lock().unwrap() = p).await.unwrap();
        start("127.0.0.1", Some(ws_port), "test.gcode").await.unwrap();

        let (req, cmd) = server.await.unwrap();
        assert!(req.starts_with("POST /upload/test.gcode HTTP/1.1"));
        assert!(req.contains("name=\"file\"; filename=\"test.gcode\""));
        assert!(req.contains("G1 X10"));
        assert_eq!(*last.lock().unwrap(), 1.0);
        assert_eq!(cmd, r#"{"method":"set","params":{"opGcodeFile":"printprt:/usr/data/printer_data/gcodes/test.gcode"}}"#);
    }
}
