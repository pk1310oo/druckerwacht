//! Update per Klick: lädt die neueste Version von GitHub und installiert sie.
//!
//! - Windows: Setup im Hintergrund (/S), danach startet Druckerwacht neu
//! - macOS: neue .app ersetzt die laufende (nach dem Beenden), Apple-Sperre wird entfernt
//! - Linux: AppImage wird ersetzt; als .deb installiert über pkexec (Passwortabfrage des Systems)

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const LATEST: &str = "https://api.github.com/repos/pk1310oo/druckerwacht/releases/latest";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: String,
    pct: f64,
}

fn emit(app: &AppHandle, phase: &str, pct: f64) {
    let _ = app.emit("update://progress", Progress { phase: phase.into(), pct });
}

fn tr(de: &'static str, en: &'static str) -> String {
    crate::i18n::tr(de, en).to_string()
}

/// Welche Datei passt zu diesem System?
pub fn pick_asset(name: &str, os: &str, appimage: bool) -> bool {
    match os {
        "windows" => name.ends_with("_x64-setup.exe"),
        "macos" => name.ends_with("_aarch64.dmg"),
        _ if appimage => name.ends_with("_amd64.AppImage"),
        _ => name.ends_with("_amd64.deb"),
    }
}

fn running_appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file())
}

async fn asset_url() -> Result<String, String> {
    let os = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    let appimage = running_appimage().is_some();
    let c = reqwest::Client::builder().user_agent("Druckerwacht").build().map_err(|e| e.to_string())?;
    let rel: serde_json::Value = c
        .get(LATEST)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| tr("GitHub ist gerade nicht erreichbar – ist der Computer online?", "GitHub can't be reached right now – is the computer online?"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    rel["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["name"].as_str().map(|n| pick_asset(n, os, appimage)).unwrap_or(false)))
        .and_then(|x| x["browser_download_url"].as_str())
        .map(str::to_string)
        .ok_or_else(|| tr("Für dieses System gibt es noch keine neue Datei.", "There is no new file for this system yet."))
}

async fn download(app: &AppHandle, url: &str, to: &Path) -> Result<(), String> {
    use std::io::Write;
    let c = reqwest::Client::builder().user_agent("Druckerwacht").timeout(std::time::Duration::from_secs(1800)).build().map_err(|e| e.to_string())?;
    let mut resp = c.get(url).send().await.and_then(|r| r.error_for_status()).map_err(|_| tr("Download fehlgeschlagen.", "Download failed."))?;
    let total = resp.content_length().unwrap_or(0) as f64;
    let mut f = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let (mut got, mut last) = (0f64, -1i64);
    while let Some(chunk) = resp.chunk().await.map_err(|_| tr("Download abgebrochen.", "Download interrupted."))? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as f64;
        if total > 0.0 && (got / total * 100.0) as i64 != last {
            last = (got / total * 100.0) as i64;
            emit(app, "download", last as f64);
        }
    }
    Ok(())
}

/// Lädt und installiert die neueste Version; die App beendet sich dabei und startet neu.
pub async fn update(app: AppHandle) -> Result<(), String> {
    emit(&app, "download", 0.0);
    let url = asset_url().await?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(url.rsplit('/').next().unwrap_or("update.bin"));
    download(&app, &url, &file).await?;
    emit(&app, "install", 100.0);
    install(&app, &file)
}

#[cfg(windows)]
fn install(app: &AppHandle, file: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Kurz warten, bis die App beendet ist, still installieren, dann neu starten
    let script = format!("ping -n 3 127.0.0.1 >nul & \"{}\" /S & start \"\" \"{}\"", file.display(), exe.display());
    std::process::Command::new("cmd")
        .arg("/C")
        .raw_arg(&script)
        .creation_flags(0x0800_0000 | 0x0000_0008) // ohne Fenster, losgelöst
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn install(app: &AppHandle, file: &Path) -> Result<(), String> {
    // …/Druckerwacht.app/Contents/MacOS/druckerwacht → …/Druckerwacht.app
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe.ancestors().find(|p| p.extension().map(|e| e == "app").unwrap_or(false)).map(Path::to_path_buf).ok_or("bundle?")?;
    let mnt = file.with_extension("mnt");
    let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
    let script = format!(
        "sleep 1; hdiutil attach -nobrowse -quiet -mountpoint {m} {f} && rm -rf {b} && ditto {m}/Druckerwacht.app {b}; hdiutil detach -quiet {m}; xattr -dr com.apple.quarantine {b}; open {b}",
        m = q(&mnt),
        f = q(file),
        b = q(&bundle)
    );
    std::process::Command::new("sh").args(["-c", &script]).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install(app: &AppHandle, file: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(target) = running_appimage() {
        // AppImage: Datei austauschen und neu starten
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        let tmp = target.with_extension("new");
        std::fs::copy(file, &tmp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        std::process::Command::new(&target).spawn().map_err(|e| e.to_string())?;
        app.exit(0);
        return Ok(());
    }
    // .deb: Das System fragt nach dem Passwort (pkexec)
    let out = std::process::Command::new("pkexec")
        .args(["apt-get", "install", "-y", "--allow-downgrades"])
        .arg(file)
        .output()
        .map_err(|_| tr("Automatisches Update geht hier nicht – bitte den Befehl von der Website nutzen.", "Automatic update isn't possible here – please use the command from the website."))?;
    if !out.status.success() {
        return Err(tr("Update abgebrochen (Passwort nicht eingegeben?).", "Update cancelled (password not entered?)."));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Nach der Installation zeigt current_exe ggf. auf „(deleted)“ – den installierten Pfad nehmen
    let exe = PathBuf::from(exe.to_string_lossy().trim_end_matches(" (deleted)"));
    std::process::Command::new(exe).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_right_files() {
        let names = ["Druckerwacht_0.16.0_aarch64.dmg", "Druckerwacht_0.16.0_amd64.AppImage", "Druckerwacht_0.16.0_amd64.deb", "Druckerwacht_0.16.0_x64-setup.exe"];
        let one = |os, ai| names.iter().filter(|n| pick_asset(n, os, ai)).cloned().collect::<Vec<_>>();
        assert_eq!(one("windows", false), vec!["Druckerwacht_0.16.0_x64-setup.exe"]);
        assert_eq!(one("macos", false), vec!["Druckerwacht_0.16.0_aarch64.dmg"]);
        assert_eq!(one("linux", false), vec!["Druckerwacht_0.16.0_amd64.deb"]);
        assert_eq!(one("linux", true), vec!["Druckerwacht_0.16.0_amd64.AppImage"]);
    }
}
