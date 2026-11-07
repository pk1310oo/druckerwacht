//! Zusatzfunktionen rund um den Druck:
//! - Push-Nachrichten aufs Handy über ntfy.sh
//! - Druck-Warteschlange (G-Code-Kopien im App-Datenordner)

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

fn client(timeout_s: u64) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_s))
        .user_agent("Druckerwacht")
        .build()
        .ok()
}

// ----------------------------------------------------------------------------- ntfy

/// Gültiges ntfy-Thema: 1–64 Zeichen aus Buchstaben, Ziffern, - und _.
pub fn valid_topic(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Schickt eine Nachricht an `https://ntfy.sh/<thema>` (JSON, damit Umlaute sicher ankommen).
pub async fn push(topic: &str, title: &str, message: &str, tag: &str) -> Result<(), String> {
    if !valid_topic(topic) {
        return Err(crate::i18n::tr("Ungültiges Thema.", "Invalid topic.").into());
    }
    let body = serde_json::json!({ "topic": topic, "title": title, "message": message, "tags": [tag] });
    let c = client(10).ok_or("client")?;
    let r = c
        .post("https://ntfy.sh/")
        .json(&body)
        .send()
        .await
        .map_err(|_| crate::i18n::tr("ntfy.sh ist nicht erreichbar.", "ntfy.sh is not reachable.").to_string())?;
    if r.status().is_success() {
        Ok(())
    } else {
        Err(crate::trf!("ntfy.sh antwortet mit Fehler {}.", "ntfy.sh answered with error {}.", r.status().as_u16()))
    }
}

// ----------------------------------------------------------------------------- Warteschlange

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    /// Anzeigename (wie im Slicer)
    pub name: String,
    pub added_ms: i64,
    pub time_s: Option<f64>,
    pub filament_g: Option<f64>,
    /// Filamentwechsel vor diesen Schichten (ab 1) – bereits in die Datei eingefügt
    #[serde(default)]
    pub pauses: Vec<u32>,
}

pub struct Queue {
    dir: PathBuf,
}

impl Queue {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
    fn index(&self) -> PathBuf {
        self.dir.join("queue.json")
    }
    pub fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.gcode"))
    }
    pub fn list(&self) -> Vec<QueueItem> {
        std::fs::read_to_string(self.index()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    pub fn save(&self, items: &[QueueItem]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        std::fs::write(self.index(), serde_json::to_string(items).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }
    pub fn add(&self, item: QueueItem, gcode: &[u8]) -> Result<Vec<QueueItem>, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        std::fs::write(self.file(&item.id), gcode).map_err(|e| e.to_string())?;
        let mut items = self.list();
        items.push(item);
        self.save(&items)?;
        Ok(items)
    }
    pub fn remove(&self, id: &str) -> Result<Vec<QueueItem>, String> {
        let mut items = self.list();
        items.retain(|i| i.id != id);
        let _ = std::fs::remove_file(self.file(id));
        self.save(&items)?;
        Ok(items)
    }
    /// Verschiebt einen Eintrag um `delta` Plätze (negativ = nach vorne).
    pub fn shift(&self, id: &str, delta: i32) -> Result<Vec<QueueItem>, String> {
        let mut items = self.list();
        if let Some(i) = items.iter().position(|x| x.id == id) {
            let j = (i as i64 + delta as i64).clamp(0, items.len() as i64 - 1) as usize;
            let it = items.remove(i);
            items.insert(j, it);
            self.save(&items)?;
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics() {
        assert!(valid_topic("druckerwacht-ab12_x"));
        assert!(!valid_topic("mit leerzeichen"));
        assert!(!valid_topic(""));
    }

    #[test]
    fn queue_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dw-queue-{}", std::process::id()));
        let q = Queue::new(dir.clone());
        let item = |id: &str| QueueItem { id: id.into(), name: id.into(), added_ms: 0, time_s: None, filament_g: None, pauses: vec![] };
        q.add(item("a"), b"G1").unwrap();
        q.add(item("b"), b"G1").unwrap();
        q.add(item("c"), b"G1").unwrap();
        let ids = |v: Vec<QueueItem>| v.into_iter().map(|i| i.id).collect::<Vec<_>>().join("");
        assert_eq!(ids(q.shift("c", -5).unwrap()), "cab");
        assert_eq!(ids(q.remove("a").unwrap()), "cb");
        assert!(!q.file("a").exists() && q.file("b").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
