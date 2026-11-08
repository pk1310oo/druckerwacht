use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Druckertypen mit eigener Anbindung
pub const KINDS: [&str; 4] = ["creality", "moonraker", "octoprint", "prusalink"];

/// Ein gespeicherter Drucker.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PrinterProfile {
    pub id: String,
    pub name: String,
    /// "creality" (KE, K1-Familie), "moonraker" (Klipper), "octoprint", "prusalink"
    pub kind: String,
    pub host: String,
    /// Port, falls abweichend vom Standard des Typs
    pub port: Option<u16>,
    /// API-Schlüssel (OctoPrint, optional Moonraker) bzw. Passwort (PrusaLink)
    pub key: String,
}

impl PrinterProfile {
    pub fn default_port(&self) -> u16 {
        match self.kind.as_str() {
            "moonraker" => 7125,
            "octoprint" | "prusalink" => 80,
            _ => 9999,
        }
    }
    pub fn port(&self) -> u16 {
        self.port.unwrap_or_else(|| self.default_port())
    }
}

/// „http://192.168.1.5:7125/“ → ("192.168.1.5", Some(7125))
pub fn clean_host(raw: &str) -> (String, Option<u16>) {
    let mut h = raw.trim().to_string();
    for p in ["ws://", "wss://", "http://", "https://"] {
        if let Some(rest) = h.strip_prefix(p) {
            h = rest.to_string();
        }
    }
    if let Some((before, _path)) = h.split_once('/') {
        h = before.to_string();
    }
    if let Some((host, port)) = h.rsplit_once(':') {
        if !host.contains(':') {
            return (host.to_string(), port.parse().ok());
        }
    }
    (h, None)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Name des aktiven Druckers (abgeleitet aus `printers`, für ältere Teile der App)
    pub printer_name: String,
    /// Adresse des aktiven Druckers (abgeleitet aus `printers`)
    pub printer_ip: String,
    /// Alle gespeicherten Drucker
    pub printers: Vec<PrinterProfile>,
    /// ID des Druckers, der im Dashboard und Slicer gezeigt wird
    pub active_printer: String,
    pub camera_url: String,
    pub notify_finished: bool,
    pub notify_error: bool,
    pub notify_disconnect: bool,
    /// Rohe WebSocket-Nachrichten in eine Datei mitschneiden (zur Analyse)
    pub raw_log: bool,
    /// Pfad zu OrcaSlicer (leer = automatisch suchen)
    pub orca_path: String,
    /// Sprache der Oberfläche: "" = wie das System, "de" oder "en"
    pub language: String,
    /// Farbthema (Akzentfarbe): orange, blue, green, purple, pink, cyan, lime
    pub accent: String,
    /// Thema für Push-Nachrichten aufs Handy über ntfy.sh (leer = aus)
    pub ntfy_topic: String,
    /// Zeitraffer aufnehmen, wenn eine Kamera eingerichtet ist
    pub timelapse: bool,
    /// Webcam am Computer (Geräte-ID des Browsers; leer = keine)
    pub local_camera: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            printer_name: "Ender 3 V3 KE".into(),
            printer_ip: String::new(),
            printers: Vec::new(),
            active_printer: String::new(),
            camera_url: String::new(),
            notify_finished: true,
            notify_error: true,
            notify_disconnect: true,
            raw_log: false,
            orca_path: String::new(),
            language: String::new(),
            accent: "orange".into(),
            ntfy_topic: String::new(),
            timelapse: true,
            local_camera: String::new(),
        }
    }
}

impl Settings {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Self>(&s).ok())
            .unwrap_or_default()
            .migrated()
            .normalized()
    }

    /// Übernahme aus Versionen bis 0.11: der einzelne KE wird zum ersten Eintrag der Druckerliste.
    /// Nur beim Laden – sonst käme ein gerade gelöschter Drucker beim Speichern zurück.
    fn migrated(mut self) -> Self {
        if self.printers.is_empty() && !self.printer_ip.trim().is_empty() {
            self.printers.push(PrinterProfile {
                id: "p1".into(),
                name: self.printer_name.clone(),
                kind: "creality".into(),
                host: self.printer_ip.clone(),
                port: None,
                key: String::new(),
            });
        }
        self
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let data = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    /// Der aktive Drucker (falls einer eingerichtet ist)
    pub fn active(&self) -> Option<&PrinterProfile> {
        self.printers.iter().find(|p| p.id == self.active_printer)
    }

    pub fn normalized(mut self) -> Self {
        if !matches!(self.language.as_str(), "" | "de" | "en") {
            self.language.clear();
        }
        if !matches!(self.accent.as_str(), "orange" | "blue" | "green" | "purple" | "pink" | "cyan" | "lime") {
            self.accent = "orange".into();
        }
        self.printer_name = self.printer_name.trim().to_string();
        if self.printer_name.is_empty() {
            self.printer_name = Settings::default().printer_name;
        }
        let mut n = 0;
        let mut seen = std::collections::HashSet::new();
        for p in &mut self.printers {
            n += 1;
            if !KINDS.contains(&p.kind.as_str()) {
                p.kind = "creality".into();
            }
            let (host, port) = clean_host(&p.host);
            p.host = host;
            if p.port.is_none() {
                p.port = port;
            }
            if p.port == Some(p.default_port()) {
                p.port = None;
            }
            p.name = p.name.trim().chars().take(60).collect();
            if p.name.is_empty() {
                p.name = format!("Drucker {n}");
            }
            p.key = p.key.trim().to_string();
            if p.id.trim().is_empty() || !seen.insert(p.id.clone()) {
                p.id = format!("p{}", chrono::Utc::now().timestamp_millis() + n as i64);
                seen.insert(p.id.clone());
            }
        }
        if !self.printers.iter().any(|p| p.id == self.active_printer) {
            self.active_printer = self.printers.first().map(|p| p.id.clone()).unwrap_or_default();
        }
        match self.active().map(|a| (a.name.clone(), a.host.clone())) {
            Some((name, host)) => {
                self.printer_name = name;
                self.printer_ip = host;
            }
            None => self.printer_ip.clear(),
        }
        self.camera_url = self.camera_url.trim().to_string();
        self.orca_path = self.orca_path.trim().to_string();
        self.ntfy_topic = self.ntfy_topic.trim().to_string();
        self.local_camera = self.local_camera.trim().chars().take(256).collect();
        if !self.ntfy_topic.is_empty() && !crate::extras::valid_topic(&self.ntfy_topic) {
            self.ntfy_topic.clear();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_single_printer() {
        let s = Settings { printer_ip: "http://192.168.1.20:9999/".into(), printer_name: "Mein KE".into(), ..Default::default() }.migrated().normalized();
        assert_eq!(s.printers.len(), 1);
        assert_eq!(s.printers[0].kind, "creality");
        assert_eq!(s.printers[0].host, "192.168.1.20");
        assert_eq!(s.printers[0].port, None); // Standardport fällt weg
        assert_eq!(s.active_printer, "p1");
        assert_eq!(s.printer_ip, "192.168.1.20");
        // Alle Drucker gelöscht: der alte Eintrag darf beim Speichern nicht zurückkommen
        let empty = Settings { printers: vec![], ..s }.normalized();
        assert!(empty.printers.is_empty() && empty.printer_ip.is_empty());
    }

    #[test]
    fn loads_old_settings_file() {
        let dir = std::env::temp_dir().join(format!("dw-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"printerName":"Werkstatt-KE","printerIp":"192.168.178.42","accent":"blue"}"#).unwrap();
        let s = Settings::load(&path);
        assert_eq!(s.printers.len(), 1);
        assert_eq!(s.printers[0].name, "Werkstatt-KE");
        assert_eq!(s.active().map(|p| p.host.as_str()), Some("192.168.178.42"));
        assert_eq!(s.accent, "blue");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cleans_profiles_and_active() {
        let s = Settings {
            printers: vec![
                PrinterProfile { id: "a".into(), name: " Voron ".into(), kind: "moonraker".into(), host: "http://voron.local:7126/".into(), ..Default::default() },
                PrinterProfile { id: "a".into(), name: "".into(), kind: "quatsch".into(), host: "10.0.0.9".into(), ..Default::default() },
            ],
            active_printer: "gibtsnicht".into(),
            ..Default::default()
        }
        .normalized();
        assert_eq!(s.printers[0].host, "voron.local");
        assert_eq!(s.printers[0].port, Some(7126));
        assert_eq!(s.printers[0].name, "Voron");
        assert_eq!(s.printers[1].kind, "creality");
        assert_ne!(s.printers[1].id, "a"); // doppelte ID ersetzt
        assert_eq!(s.printers[1].name, "Drucker 2");
        assert_eq!(s.active_printer, "a");
        assert_eq!(s.printer_name, "Voron");
        assert_eq!(clean_host("drucker:abc"), ("drucker".into(), None));
    }
}
