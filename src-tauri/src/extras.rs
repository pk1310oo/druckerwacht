//! Zusatzfunktionen rund um den Druck:
//! - Kamera am Drucker automatisch finden (mjpg-streamer auf Port 8080, wie beim K1/KE)
//! - Push-Nachrichten aufs Handy über ntfy.sh
//! - Druck-Warteschlange (G-Code-Kopien im App-Datenordner)
//! - Zeitraffer: pro Schicht ein Kamerabild, am Ende ein QuickTime-Video (Motion-JPEG)

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn client(timeout_s: u64) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_s))
        .user_agent("Druckerwacht")
        .build()
        .ok()
}

// ----------------------------------------------------------------------------- Kamera

/// Sucht eine Kamera am Drucker. Liefert die Stream-Adresse, wenn ein Standbild abrufbar ist.
pub async fn probe_camera(host: &str) -> Option<String> {
    let c = client(4)?;
    for port in [8080u16, 8081] {
        let snap = format!("http://{host}:{port}/?action=snapshot");
        let Ok(r) = c.get(&snap).send().await else { continue };
        let is_jpeg = r
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.starts_with("image/"))
            .unwrap_or(false);
        if r.status().is_success() && is_jpeg {
            return Some(format!("http://{host}:{port}/?action=stream"));
        }
    }
    None
}

/// Standbild-Adresse zu einer Stream-Adresse (mjpg-streamer). `None`, wenn unbekannt.
pub fn snapshot_url(stream: &str) -> Option<String> {
    stream.contains("action=stream").then(|| stream.replace("action=stream", "action=snapshot"))
}

pub async fn fetch_snapshot(url: &str) -> Option<Vec<u8>> {
    let r = client(6)?.get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let b = r.bytes().await.ok()?;
    (b.len() > 4 && b[0] == 0xFF && b[1] == 0xD8).then(|| b.to_vec())
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

/// Wie `push`, aber mit Kamerabild als Anhang (ntfy: Datei als Body, Texte als Query-Parameter,
/// damit Umlaute sicher ankommen).
pub async fn push_image(topic: &str, title: &str, message: &str, tag: &str, jpeg: Vec<u8>) -> Result<(), String> {
    if !valid_topic(topic) {
        return Err(crate::i18n::tr("Ungültiges Thema.", "Invalid topic.").into());
    }
    let c = client(30).ok_or("client")?;
    let r = c
        .put(format!("https://ntfy.sh/{topic}"))
        .query(&[("title", title), ("message", message), ("tags", tag)])
        .header("Filename", "druckerwacht.jpg")
        .body(jpeg)
        .send()
        .await
        .map_err(|_| crate::i18n::tr("ntfy.sh ist nicht erreichbar.", "ntfy.sh is not reachable.").to_string())?;
    if r.status().is_success() {
        Ok(())
    } else {
        Err(crate::trf!("ntfy.sh antwortet mit Fehler {}.", "ntfy.sh answered with error {}.", r.status().as_u16()))
    }
}

/// Gültiges JPEG (beginnt mit FF D8)?
pub fn is_jpeg(b: &[u8]) -> bool {
    b.len() > 4 && b[0] == 0xFF && b[1] == 0xD8
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

// ----------------------------------------------------------------------------- Zeitraffer

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Timelapse {
    pub id: String,
    pub name: String,
    pub created_ms: i64,
    pub frames: usize,
    pub size_bytes: u64,
    /// Letztes Bild als data:-URL (Vorschau)
    pub cover: Option<String>,
}

/// Ordnername für einen Druck: Startzeit + bereinigter Dateiname.
pub fn timelapse_key(started_ms: i64, file: &str) -> String {
    let clean: String = file
        .trim_end_matches(".gcode")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .take(60)
        .collect();
    format!("{started_ms}_{clean}")
}

/// Baut aus allen Bildern im Ordner ein Video `<ordner>.mov` und legt das letzte Bild als
/// `<ordner>.jpg` daneben. Die Einzelbilder werden danach gelöscht.
pub fn finish_timelapse(frames_dir: &Path, fps: u32) -> Result<PathBuf, String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(frames_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jpg"))
        .collect();
    files.sort();
    if files.len() < 2 {
        let _ = std::fs::remove_dir_all(frames_dir);
        return Err("zu wenige Bilder".into());
    }
    let frames: Vec<Vec<u8>> = files.iter().filter_map(|p| std::fs::read(p).ok()).collect();
    let mov = mjpeg_mov(&frames, fps).ok_or("ungültige Bilder")?;
    let out = frames_dir.with_extension("mov");
    std::fs::write(&out, mov).map_err(|e| e.to_string())?;
    if let Some(last) = frames.last() {
        let _ = std::fs::write(frames_dir.with_extension("jpg"), last);
    }
    let _ = std::fs::remove_dir_all(frames_dir);
    Ok(out)
}

pub fn list_timelapses(dir: &Path) -> Vec<Timelapse> {
    use base64::Engine;
    let mut out: Vec<Timelapse> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "mov"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_string_lossy().into_owned();
            let (ts, name) = id.split_once('_').unwrap_or(("0", &id));
            let data = std::fs::metadata(&p).ok()?;
            let cover = std::fs::read(p.with_extension("jpg"))
                .ok()
                .map(|b| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
            let frames = mov_frames(&p).unwrap_or(0);
            Some(Timelapse { id: id.clone(), name: name.replace('_', " "), created_ms: ts.parse().unwrap_or(0), frames, size_bytes: data.len(), cover })
        })
        .collect();
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    out
}

/// Breite und Höhe eines JPEG (aus dem SOF-Segment).
pub fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let m = b[i + 1];
        if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return Some((w, h));
        }
        if m == 0xD8 || m == 0x01 || (0xD0..=0xD7).contains(&m) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        i += 2 + len;
    }
    None
}

/// Schreibt ein QuickTime-Video (.mov) mit Motion-JPEG („Photo-JPEG“) – spielt in QuickTime,
/// iMovie, VLC und den meisten Schnittprogrammen. Jedes Bild ist ein eigener Abschnitt.
pub fn mjpeg_mov(frames: &[Vec<u8>], fps: u32) -> Option<Vec<u8>> {
    let (w, h) = jpeg_size(frames.first()?)?;
    let n = frames.len() as u32;
    let fps = fps.max(1);
    let be = |v: u32| v.to_be_bytes();
    let atom = |kind: &[u8], body: &[u8]| {
        let mut a = Vec::with_capacity(body.len() + 8);
        a.extend(((body.len() + 8) as u32).to_be_bytes());
        a.extend(kind);
        a.extend(body);
        a
    };
    const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
    let matrix: Vec<u8> = MATRIX.iter().flat_map(|v| v.to_be_bytes()).collect();

    let ftyp = atom(b"ftyp", &[b"qt  ".as_slice(), &be(0x200), b"qt  "].concat());
    let mut mdat_body = Vec::with_capacity(frames.iter().map(Vec::len).sum());
    let mut offsets = Vec::with_capacity(frames.len());
    let base = ftyp.len() as u32 + 8;
    for f in frames {
        offsets.push(base + mdat_body.len() as u32);
        mdat_body.extend(f);
    }
    let mdat = atom(b"mdat", &mdat_body);

    // mvhd: Zeitbasis = Bilder pro Sekunde, Dauer = Anzahl Bilder
    let mut mvhd = vec![0u8; 4];
    for v in [0, 0, fps, n, 0x0001_0000] {
        mvhd.extend(be(v));
    }
    mvhd.extend(0x0100u16.to_be_bytes());
    mvhd.extend([0u8; 10]);
    mvhd.extend(&matrix);
    mvhd.extend([0u8; 24]);
    mvhd.extend(be(2));

    let mut tkhd = vec![0, 0, 0, 3];
    for v in [0, 0, 1, 0, n, 0, 0] {
        tkhd.extend(be(v));
    }
    tkhd.extend([0u8; 8]); // Ebene, Gruppe, Lautstärke, reserviert
    tkhd.extend(&matrix);
    tkhd.extend(be(w << 16));
    tkhd.extend(be(h << 16));

    let mut mdhd = vec![0u8; 4];
    for v in [0, 0, fps, n] {
        mdhd.extend(be(v));
    }
    mdhd.extend([0u8; 4]);
    let hdlr = |class: &[u8], sub: &[u8], name: &[u8]| {
        let mut b = vec![0u8; 4];
        b.extend(class);
        b.extend(sub);
        b.extend([0u8; 12]);
        b.push(name.len() as u8);
        b.extend(name);
        atom(b"hdlr", &b)
    };
    let vmhd = atom(b"vmhd", &[0, 0, 0, 1, 0, 0x40, 0x80, 0, 0x80, 0, 0x80, 0]);
    let dref = atom(b"dref", &[vec![0u8; 4], be(1).to_vec(), atom(b"alis", &[0, 0, 0, 1])].concat());
    let dinf = atom(b"dinf", &dref);

    let mut desc = vec![0u8; 6];
    desc.extend(1u16.to_be_bytes()); // Datenreferenz
    desc.extend([0u8; 4]); // Version, Revision
    desc.extend(b"appl");
    desc.extend(be(0));
    desc.extend(be(512)); // Qualität
    desc.extend((w as u16).to_be_bytes());
    desc.extend((h as u16).to_be_bytes());
    desc.extend(be(72 << 16));
    desc.extend(be(72 << 16));
    desc.extend(be(0));
    desc.extend(1u16.to_be_bytes());
    let mut cname = [0u8; 32];
    let label = b"Photo - JPEG";
    cname[0] = label.len() as u8;
    cname[1..=label.len()].copy_from_slice(label);
    desc.extend(cname);
    desc.extend(24u16.to_be_bytes());
    desc.extend(0xFFFFu16.to_be_bytes());
    let stsd = atom(b"stsd", &[vec![0u8; 4], be(1).to_vec(), atom(b"jpeg", &desc)].concat());
    let stts = atom(b"stts", &[vec![0u8; 4], be(1).to_vec(), be(n).to_vec(), be(1).to_vec()].concat());
    let stsc = atom(b"stsc", &[vec![0u8; 4], be(1).to_vec(), be(1).to_vec(), be(1).to_vec(), be(1).to_vec()].concat());
    let mut stsz = vec![0u8; 4];
    stsz.extend(be(0));
    stsz.extend(be(n));
    for f in frames {
        stsz.extend(be(f.len() as u32));
    }
    let mut stco = vec![0u8; 4];
    stco.extend(be(n));
    for o in &offsets {
        stco.extend(be(*o));
    }
    let stbl = atom(b"stbl", &[stsd, stts, stsc, atom(b"stsz", &stsz), atom(b"stco", &stco)].concat());
    let minf = atom(b"minf", &[vmhd, hdlr(b"dhlr", b"alis", b""), dinf, stbl].concat());
    let mdia = atom(b"mdia", &[atom(b"mdhd", &mdhd), hdlr(b"mhlr", b"vide", b"Druckerwacht"), minf].concat());
    let trak = atom(b"trak", &[atom(b"tkhd", &tkhd), mdia].concat());
    let moov = atom(b"moov", &[atom(b"mvhd", &mvhd), trak].concat());
    Some([ftyp, mdat, moov].concat())
}

/// Bildanzahl eines mit `mjpeg_mov` geschriebenen Videos (aus dem stsz-Atom am Dateiende).
fn mov_frames(p: &Path) -> Option<usize> {
    let b = std::fs::read(p).ok()?;
    let i = b.windows(4).rposition(|w| w == b"stsz")?;
    Some(u32::from_be_bytes(b.get(i + 12..i + 16)?.try_into().ok()?) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_jpeg(w: u16, h: u16, extra: usize) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0, 0xFF, 0xC0, 0x00, 0x11, 0x08];
        b.extend(h.to_be_bytes());
        b.extend(w.to_be_bytes());
        b.extend(vec![0u8; 12 + extra]);
        b.extend([0xFF, 0xD9]);
        b
    }

    #[test]
    fn reads_jpeg_size() {
        assert_eq!(jpeg_size(&fake_jpeg(1280, 720, 0)), Some((1280, 720)));
        assert_eq!(jpeg_size(b"nope"), None);
    }

    #[test]
    fn builds_valid_mov() {
        let frames = vec![fake_jpeg(640, 480, 3), fake_jpeg(640, 480, 10), fake_jpeg(640, 480, 0)];
        let mov = mjpeg_mov(&frames, 30).unwrap();
        assert_eq!(&mov[4..8], b"ftyp");
        // Jeder Offset im stco zeigt auf den Anfang eines JPEG (FF D8)
        let i = mov.windows(4).rposition(|w| w == b"stco").unwrap();
        let n = u32::from_be_bytes(mov[i + 8..i + 12].try_into().unwrap()) as usize;
        assert_eq!(n, 3);
        for k in 0..n {
            let o = u32::from_be_bytes(mov[i + 12 + k * 4..i + 16 + k * 4].try_into().unwrap()) as usize;
            assert_eq!(&mov[o..o + 2], &[0xFF, 0xD8]);
        }
        let p = std::env::temp_dir().join(format!("dw-mov-{}.mov", std::process::id()));
        std::fs::write(&p, &mov).unwrap();
        assert_eq!(mov_frames(&p), Some(3));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn topics_and_urls() {
        assert!(valid_topic("druckerwacht-ab12_x"));
        assert!(!valid_topic("mit leerzeichen"));
        assert!(!valid_topic(""));
        assert_eq!(snapshot_url("http://1.2.3.4:8080/?action=stream").as_deref(), Some("http://1.2.3.4:8080/?action=snapshot"));
        assert_eq!(snapshot_url("rtsp://cam"), None);
        assert_eq!(timelapse_key(5, "Würfel Test.gcode"), "5_W_rfel_Test");
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

#[cfg(test)]
mod real_frames {
    /// Manuell: DW_TL_DIR=<ordner mit jpgs> cargo test real_timelapse -- --ignored
    #[test]
    #[ignore]
    fn real_timelapse() {
        let dir = std::path::PathBuf::from(std::env::var("DW_TL_DIR").unwrap());
        super::finish_timelapse(&dir, 30).unwrap();
    }
}
