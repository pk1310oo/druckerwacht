use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub printer_name: String,
    pub printer_ip: String,
    pub camera_url: String,
    pub notify_finished: bool,
    pub notify_error: bool,
    pub notify_disconnect: bool,
    /// Rohe WebSocket-Nachrichten in eine Datei mitschneiden (zur Analyse)
    pub raw_log: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            printer_name: "Ender 3 V3 KE".into(),
            printer_ip: String::new(),
            camera_url: String::new(),
            notify_finished: true,
            notify_error: true,
            notify_disconnect: true,
            raw_log: false,
        }
    }
}

impl Settings {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
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

    pub fn normalized(mut self) -> Self {
        self.printer_name = self.printer_name.trim().to_string();
        if self.printer_name.is_empty() {
            self.printer_name = Settings::default().printer_name;
        }
        // Nutzer tippen gern "http://" oder ":9999" mit – das entfernen wir.
        let mut ip = self.printer_ip.trim().to_string();
        for p in ["ws://", "wss://", "http://", "https://"] {
            if let Some(rest) = ip.strip_prefix(p) {
                ip = rest.to_string();
            }
        }
        ip = ip.trim_end_matches('/').to_string();
        if let Some((h, _port)) = ip.rsplit_once(':') {
            if !h.contains(':') {
                ip = h.to_string();
            }
        }
        self.printer_ip = ip;
        self.camera_url = self.camera_url.trim().to_string();
        self
    }
}
