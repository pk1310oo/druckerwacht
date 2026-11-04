//! Slicer: OrcaSlicer läuft unsichtbar als Motor (Kommandozeile), die Oberfläche ist unsere.
//!
//! Ablauf eines Slice-Vorgangs:
//! 1. Das Frontend schickt die Modelle als fertig platzierte binäre STL (Weltkoordinaten in mm),
//!    die vollständigen Einstellungen (Profil + Änderungen) und Vorschaubilder.
//! 2. Wir schreiben alles in einen Arbeitsordner und rufen Orca mit `--arrange 0` auf
//!    (Modelle bleiben exakt dort, wo sie platziert wurden).
//! 3. Das Ergebnis-G-Code bekommt unsere Vorschaubilder (Format wie Orca: 96x96 + 300x300 PNG),
//!    die der Drucker auf dem Display anzeigt. Statistik (Zeit, Filament) wird ausgelesen.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

const SLICE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
pub struct SlicerState {
    /// PID des laufenden Orca-Prozesses (zum Abbrechen)
    running: Mutex<Option<u32>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerInfo {
    found: bool,
    path: Option<String>,
    /// Pfade, die automatisch geprüft wurden (für die Hilfe-Anzeige)
    searched: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presets {
    machine: Value,
    process: Vec<Value>,
    filament: Vec<Value>,
    user_process: Vec<Value>,
    user_filament: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceModel {
    name: String,
    /// binäre STL, base64
    stl: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceJob {
    models: Vec<SliceModel>,
    machine: Map<String, Value>,
    process: Map<String, Value>,
    filament: Map<String, Value>,
    /// PNG base64, je Größe (z. B. "96x96" → ...)
    thumbnails: Vec<Thumbnail>,
    file_name: String,
}

#[derive(Deserialize)]
pub struct Thumbnail {
    size: String,
    png: String,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SliceResult {
    gcode_path: String,
    file_name: String,
    time_s: Option<f64>,
    filament_mm: Option<f64>,
    filament_g: Option<f64>,
    layers: Option<i64>,
    warnings: Vec<String>,
}

fn candidates(custom: &str) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if !custom.trim().is_empty() {
        let p = PathBuf::from(custom.trim());
        // Auf dem Mac darf auch die .app gewählt werden
        if p.extension().map(|e| e == "app").unwrap_or(false) {
            v.push(p.join("Contents/MacOS/OrcaSlicer"));
        }
        v.push(p);
    }
    if cfg!(target_os = "macos") {
        v.push("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer".into());
        if let Some(home) = std::env::var_os("HOME") {
            v.push(PathBuf::from(home).join("Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"));
        }
    } else {
        if let Some(paths) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&paths) {
                v.push(dir.join("orca-slicer"));
                v.push(dir.join("OrcaSlicer"));
            }
        }
        v.push("/opt/OrcaSlicer/AppRun".into());
        v.push("/usr/bin/orca-slicer".into());
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for dir in [home.join("Applications"), home.join("Downloads"), home.join("AppImages"), home.join(".local/bin")] {
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    for e in rd.flatten() {
                        let name = e.file_name().to_string_lossy().to_lowercase();
                        if name.starts_with("orcaslicer") && name.ends_with(".appimage") {
                            v.push(e.path());
                        }
                    }
                }
            }
        }
    }
    v
}

impl SlicerInfo {
    pub fn path_buf(&self) -> Option<PathBuf> {
        self.path.as_ref().map(PathBuf::from)
    }
}

pub fn find_orca(custom: &str) -> SlicerInfo {
    let list = candidates(custom);
    let found = list.iter().find(|p| p.is_file()).cloned();
    SlicerInfo {
        found: found.is_some(),
        path: found.map(|p| p.to_string_lossy().into_owned()),
        searched: list.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
    }
}

fn read_dir_json(dir: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect();
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    out
}

pub fn load_presets(app: &AppHandle) -> Result<Presets, String> {
    let res = app
        .path()
        .resolve("resources/profiles", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let user = user_preset_dir(app)?;
    let machine = read_dir_json(&res.join("machine"))
        .into_iter()
        .next()
        .ok_or("Druckerprofil fehlt in der App.")?;
    Ok(Presets {
        machine,
        process: read_dir_json(&res.join("process")),
        filament: read_dir_json(&res.join("filament")),
        user_process: read_dir_json(&user.join("process")),
        user_filament: read_dir_json(&user.join("filament")),
    })
}

fn user_preset_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("presets"))
}

fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.@()".contains(c) { c } else { '_' })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "Unbenannt".into() } else { s }
}

pub fn save_user_preset(app: &AppHandle, kind: &str, preset: Value) -> Result<(), String> {
    if kind != "process" && kind != "filament" {
        return Err("Unbekannter Profiltyp.".into());
    }
    let name = preset["name"].as_str().ok_or("Profil braucht einen Namen.")?;
    let dir = user_preset_dir(app)?.join(kind);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", safe_name(name))), data).map_err(|e| e.to_string())
}

pub fn delete_user_preset(app: &AppHandle, kind: &str, name: &str) -> Result<(), String> {
    if kind != "process" && kind != "filament" {
        return Err("Unbekannter Profiltyp.".into());
    }
    let path = user_preset_dir(app)?.join(kind).join(format!("{}.json", safe_name(name)));
    std::fs::remove_file(path).map_err(|_| "Profil konnte nicht gelöscht werden.".to_string())
}

fn b64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|_| "Ungültige Daten vom Frontend.".to_string())
}

/// Fügt Orca-kompatible Vorschaubilder direkt nach dem Kopfblock ein.
fn inject_thumbnails(gcode: &str, thumbs: &[Thumbnail]) -> String {
    if thumbs.is_empty() || gcode.contains("; thumbnail begin") {
        return gcode.to_string();
    }
    let mut block = String::from("\n; THUMBNAIL_BLOCK_START\n");
    for t in thumbs {
        let data = t.png.trim();
        block.push_str(";\n");
        block.push_str(&format!("; thumbnail begin {} {}\n", t.size, data.len()));
        for chunk in data.as_bytes().chunks(78) {
            block.push_str("; ");
            block.push_str(std::str::from_utf8(chunk).unwrap_or(""));
            block.push('\n');
        }
        block.push_str("; thumbnail end\n");
    }
    block.push_str("; THUMBNAIL_BLOCK_END\n");
    match gcode.find("; HEADER_BLOCK_END") {
        Some(i) => {
            let end = gcode[i..].find('\n').map(|n| i + n + 1).unwrap_or(gcode.len());
            format!("{}{}{}", &gcode[..end], block, &gcode[end..])
        }
        None => format!("{block}{gcode}"),
    }
}

/// "1d 2h 3m 4s" → Sekunden
fn parse_duration(s: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut num = String::new();
    let mut any = false;
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
        } else if let Ok(n) = num.parse::<f64>() {
            let mult = match c {
                'd' => 86400.0,
                'h' => 3600.0,
                'm' => 60.0,
                's' => 1.0,
                _ => continue,
            };
            total += n * mult;
            any = true;
            num.clear();
        }
    }
    any.then_some(total)
}

fn stat(gcode: &str, prefix: &str) -> Option<String> {
    gcode
        .lines()
        .rev()
        .take(3000)
        .find_map(|l| l.strip_prefix(prefix).map(|v| v.trim().to_string()))
}

fn first_num(s: &str) -> Option<f64> {
    s.split(|c: char| c == ',' || c.is_whitespace())
        .filter_map(|p| p.trim().parse::<f64>().ok())
        .reduce(|a, b| a + b)
}

pub async fn slice(app: AppHandle, orca: PathBuf, job: SliceJob) -> Result<SliceResult, String> {
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("slice");
    let datadir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("orca-data");
    let app_progress = app.clone();
    let app_pid = app.clone();
    let res = run_orca(
        &orca,
        &base,
        &datadir,
        &job,
        move |pct| {
            let _ = app_progress.emit("slicer://progress", pct);
        },
        move |pid| {
            *app_pid.state::<SlicerState>().running.lock().unwrap_or_else(|e| e.into_inner()) = pid;
        },
    )
    .await;
    res
}

/// Kern des Slice-Vorgangs – ohne Tauri, damit er sich direkt testen lässt.
pub async fn run_orca(
    orca: &Path,
    base: &Path,
    datadir: &Path,
    job: &SliceJob,
    on_progress: impl Fn(f64) + Send + 'static,
    on_pid: impl Fn(Option<u32>),
) -> Result<SliceResult, String> {
    let _ = std::fs::remove_dir_all(base);
    let input = base.join("in");
    let output = base.join("out");
    for d in [&input, &output, &datadir.to_path_buf()] {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    if job.models.is_empty() {
        return Err("Keine Modelle auf der Druckplatte.".into());
    }

    let write_json = |name: &str, map: &Map<String, Value>| -> Result<PathBuf, String> {
        let p = input.join(name);
        std::fs::write(&p, serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(p)
    };
    let machine = write_json("machine.json", &job.machine)?;
    let process = write_json("process.json", &job.process)?;
    let filament = write_json("filament.json", &job.filament)?;

    let mut model_paths = Vec::new();
    for (i, m) in job.models.iter().enumerate() {
        let p = input.join(format!("{:02}_{}.stl", i + 1, safe_name(&m.name)));
        std::fs::write(&p, b64(&m.stl)?).map_err(|e| e.to_string())?;
        model_paths.push(p);
    }

    let mut cmd = tokio::process::Command::new(orca);
    cmd.arg("--datadir")
        .arg(datadir)
        .arg("--arrange")
        .arg("0")
        .arg("--slice")
        .arg("0")
        .arg("--load-settings")
        .arg(format!("{};{}", machine.display(), process.display()))
        .arg("--load-filaments")
        .arg(filament.display().to_string())
        .arg("--outputdir")
        .arg(&output)
        .args(&model_paths)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|_| "OrcaSlicer konnte nicht gestartet werden. Ist der Pfad in den Einstellungen richtig?".to_string())?;
    on_pid(child.id());

    // Fortschritt aus der Orca-Ausgabe weiterreichen
    let stdout = child.stdout.take();
    let reader = tokio::spawn(async move {
        let mut tail = Vec::new();
        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(pct) = progress_of(&line) {
                    on_progress(pct);
                }
                tail.push(line);
                if tail.len() > 60 {
                    tail.remove(0);
                }
            }
        }
        tail
    });

    let status = tokio::time::timeout(SLICE_TIMEOUT, child.wait()).await;
    on_pid(None);
    let log_tail = reader.await.unwrap_or_default();
    let status = match status {
        Err(_) => {
            let _ = child.kill().await;
            return Err("Slicen hat zu lange gedauert und wurde abgebrochen.".into());
        }
        Ok(Err(e)) => return Err(format!("OrcaSlicer ist abgestürzt ({e}).")),
        Ok(Ok(s)) => s,
    };

    let result_json: Value = std::fs::read_to_string(output.join("result.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let gcode_file = output.join("plate_1.gcode");
    if !gcode_file.is_file() {
        if status.code().is_none() {
            return Err("Slicen abgebrochen.".into());
        }
        let msg = result_json["error_string"]
            .as_str()
            .filter(|s| !s.is_empty() && *s != "Success.")
            .map(str::to_string)
            .or_else(|| log_tail.iter().rev().find(|l| l.to_lowercase().contains("error")).cloned())
            .unwrap_or_else(|| "Unbekannter Fehler".into());
        return Err(format!("OrcaSlicer konnte nicht slicen: {msg}"));
    }

    let warnings: Vec<String> = result_json["sliced_plates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["warning_message"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let gcode = std::fs::read_to_string(&gcode_file).map_err(|e| e.to_string())?;
    let gcode = inject_thumbnails(&gcode, &job.thumbnails);

    let file_name = format!("{}.gcode", safe_name(job.file_name.trim_end_matches(".gcode")));
    let final_path = base.join(&file_name);
    std::fs::write(&final_path, &gcode).map_err(|e| e.to_string())?;

    Ok(SliceResult {
        gcode_path: final_path.to_string_lossy().into_owned(),
        file_name,
        time_s: stat(&gcode, "; estimated printing time (normal mode) =").and_then(|s| parse_duration(&s)),
        filament_mm: stat(&gcode, "; filament used [mm] =").and_then(|s| first_num(&s)),
        filament_g: stat(&gcode, "; total filament used [g] =")
            .or_else(|| stat(&gcode, "; filament used [g] ="))
            .and_then(|s| first_num(&s)),
        layers: stat(&gcode, "; total layers count =").and_then(|s| s.parse().ok()),
        warnings,
    })
}

fn progress_of(line: &str) -> Option<f64> {
    // Orca schreibt u. a. "... @ 45%" bzw. "progress 45"
    let l = line.to_lowercase();
    if !(l.contains('%') || l.contains("progress")) {
        return None;
    }
    let digits: String = l
        .rsplit(|c: char| !c.is_ascii_digit() && c != '.')
        .find(|p| !p.is_empty())?
        .to_string();
    digits.parse::<f64>().ok().filter(|p| (0.0..=100.0).contains(p))
}

pub fn cancel(app: &AppHandle) {
    let state = app.state::<SlicerState>();
    let pid = state.running.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Echter Ende-zu-Ende-Test mit OrcaSlicer. Läuft nur, wenn ORCA_BIN und DW_JOB gesetzt sind:
    /// DW_JOB ist ein von der Oberfläche exportierter Auftrag (Modelle, Profile, Vorschaubilder).
    #[tokio::test]
    async fn real_orca_slice() {
        let (Ok(orca), Ok(job)) = (std::env::var("ORCA_BIN"), std::env::var("DW_JOB")) else { return };
        let job: SliceJob = serde_json::from_str(&std::fs::read_to_string(job).unwrap()).unwrap();
        let tmp = std::env::temp_dir().join("dw-slice-test");
        let r = run_orca(Path::new(&orca), &tmp.join("work"), &tmp.join("data"), &job, |_| {}, |_| {}).await.unwrap();
        println!("ERGEBNIS {r:?}");
        let g = std::fs::read_to_string(&r.gcode_path).unwrap();
        assert!(g.contains("; thumbnail begin 300x300"), "Vorschaubild fehlt");
        assert!(r.time_s.unwrap() > 0.0 && r.filament_g.unwrap() > 0.0 && r.layers.unwrap() > 0);
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("15m 19s"), Some(919.0));
        assert_eq!(parse_duration("1d 2h 3m 4s"), Some(93784.0));
        assert_eq!(parse_duration("abc"), None);
    }

    #[test]
    fn thumbnails_after_header() {
        let g = "; HEADER_BLOCK_START\n; x\n; HEADER_BLOCK_END\n\nG28\n";
        let out = inject_thumbnails(g, &[Thumbnail { size: "96x96".into(), png: "QUJD".into() }]);
        assert!(out.contains("; HEADER_BLOCK_END\n\n; THUMBNAIL_BLOCK_START"));
        assert!(out.contains("; thumbnail begin 96x96 4\n; QUJD\n; thumbnail end"));
        assert!(out.ends_with("G28\n"));
    }
}
