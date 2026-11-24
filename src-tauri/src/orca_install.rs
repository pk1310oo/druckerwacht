//! OrcaSlicer mit einem Klick installieren – an den Ort, an dem Druckerwacht ihn findet.
//!
//! - Windows: offizieller Installer (Windows fragt einmal nach Admin-Rechten)
//! - macOS: universelle .dmg → /Applications (oder ~/Applications ohne Schreibrecht)
//! - Linux: AppImage wird nach ~/Applications/OrcaSlicer entpackt (läuft so auch ohne FUSE).
//!   Neuere OrcaSlicer-Versionen brauchen glibc 2.39 (Ubuntu 24.04 / Mint 22); ältere Systeme
//!   bekommen OrcaSlicer 2.3.0, die letzte Version mit allgemeinem AppImage.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const LATEST: &str = "https://api.github.com/repos/SoftFever/OrcaSlicer/releases/latest";
/// Letzte Version mit AppImage für ältere Linux-Systeme (Ubuntu 22.04 / Mint 21)
const LINUX_LEGACY: &str = "https://github.com/SoftFever/OrcaSlicer/releases/download/v2.3.0/OrcaSlicer_Linux_AppImage_V2.3.0.AppImage";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// "download", "install", "done"
    pub phase: String,
    pub pct: f64,
}

fn emit(app: &AppHandle, phase: &str, pct: f64) {
    let _ = app.emit("orca://install", Progress { phase: phase.into(), pct });
}

fn tr(de: &'static str, en: &'static str) -> String {
    crate::i18n::tr(de, en).to_string()
}

/// glibc-Version (z. B. 2.35) – None, wenn nicht ermittelbar
#[cfg(target_os = "linux")]
fn glibc() -> Option<(u32, u32)> {
    let out = std::process::Command::new("ldd").arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?;
    let ver = first.split_whitespace().last()?;
    let (a, b) = ver.split_once('.')?;
    Some((a.parse().ok()?, b.trim_end_matches(|c: char| !c.is_ascii_digit()).parse().ok()?))
}

/// Passt der Dateiname zu diesem System?
pub fn pick_asset(name: &str, os: &str) -> bool {
    match os {
        "windows" => name.starts_with("OrcaSlicer_Windows_Installer_") && name.ends_with("_x64.exe"),
        "macos" => name.starts_with("OrcaSlicer_Mac_universal_") && name.ends_with(".dmg"),
        _ => name.starts_with("OrcaSlicer_Linux_AppImage_Ubuntu2404_V") && name.ends_with(".AppImage"),
    }
}

async fn download_url(os: &str) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    if glibc().map(|v| v < (2, 39)).unwrap_or(false) {
        return Ok(LINUX_LEGACY.into());
    }
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
        .and_then(|a| a.iter().find(|x| x["name"].as_str().map(|n| pick_asset(n, os)).unwrap_or(false)))
        .and_then(|x| x["browser_download_url"].as_str())
        .map(str::to_string)
        .ok_or_else(|| tr("Keine passende OrcaSlicer-Datei gefunden.", "No matching OrcaSlicer file found."))
}

async fn download(app: &AppHandle, url: &str, to: &Path) -> Result<(), String> {
    use std::io::Write;
    let c = reqwest::Client::builder().user_agent("Druckerwacht").timeout(std::time::Duration::from_secs(3600)).build().map_err(|e| e.to_string())?;
    let mut resp = c.get(url).send().await.and_then(|r| r.error_for_status()).map_err(|_| tr("Download fehlgeschlagen.", "Download failed."))?;
    let total = resp.content_length().unwrap_or(0) as f64;
    let mut f = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let mut got = 0f64;
    let mut last = -1i64;
    while let Some(chunk) = resp.chunk().await.map_err(|_| tr("Download abgebrochen.", "Download interrupted."))? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as f64;
        if total > 0.0 {
            let pct = (got / total * 100.0).min(100.0);
            if pct as i64 != last {
                last = pct as i64;
                emit(app, "download", pct);
            }
        }
    }
    Ok(())
}

fn run(cmd: &mut std::process::Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect())
    }
}

/// Installiert OrcaSlicer; liefert den Pfad zum Programm.
pub async fn install(app: AppHandle) -> Result<String, String> {
    let os = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    emit(&app, "download", 0.0);
    let url = download_url(os).await?;
    let tmp = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("orca-install");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let file = tmp.join(url.rsplit('/').next().unwrap_or("orca.bin"));
    download(&app, &url, &file).await?;
    emit(&app, "install", 100.0);
    let file2 = file.clone();
    let path = tauri::async_runtime::spawn_blocking(move || install_file(&file2)).await.map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&file);
    emit(&app, "done", 100.0);
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn install_file(file: &Path) -> Result<PathBuf, String> {
    // Über PowerShell starten: Windows zeigt dann die Admin-Abfrage des Installers an
    let script = format!("Start-Process -FilePath '{}' -Wait", file.display().to_string().replace('\'', "''"));
    let mut cmd = std::process::Command::new("powershell");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    run(cmd.args(["-NoProfile", "-Command", &script]))?;
    crate::slicer::find_orca("").path.map(PathBuf::from).ok_or_else(|| tr("Die Installation wurde nicht abgeschlossen.", "The installation was not completed."))
}

#[cfg(target_os = "macos")]
fn install_file(file: &Path) -> Result<PathBuf, String> {
    let mnt = file.with_extension("mnt");
    let _ = std::process::Command::new("hdiutil").args(["detach", "-quiet"]).arg(&mnt).output();
    run(std::process::Command::new("hdiutil").args(["attach", "-nobrowse", "-quiet", "-mountpoint"]).arg(&mnt).arg(file))?;
    let src = mnt.join("OrcaSlicer.app");
    let mut dest = PathBuf::from("/Applications/OrcaSlicer.app");
    let mut res = run(std::process::Command::new("ditto").arg(&src).arg(&dest));
    if res.is_err() {
        // Kein Schreibrecht in /Programme → eigener Programme-Ordner
        if let Some(home) = std::env::var_os("HOME") {
            dest = PathBuf::from(home).join("Applications/OrcaSlicer.app");
            let _ = std::fs::create_dir_all(dest.parent().unwrap());
            res = run(std::process::Command::new("ditto").arg(&src).arg(&dest));
        }
    }
    let _ = std::process::Command::new("hdiutil").args(["detach", "-quiet"]).arg(&mnt).output();
    res?;
    let _ = std::process::Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&dest).output();
    Ok(dest.join("Contents/MacOS/OrcaSlicer"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_file(file: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME?")?);
    let dir = linux_dir(&home);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    // Entpacken statt einhängen: braucht kein FUSE
    run(std::process::Command::new(file).arg("--appimage-extract").current_dir(&dir))?;
    let app_run = dir.join("squashfs-root").join("AppRun");
    if app_run.is_file() {
        Ok(app_run)
    } else {
        Err(tr("Das AppImage konnte nicht entpackt werden.", "The AppImage could not be extracted."))
    }
}

/// Ziel unter Linux: ~/Applications/OrcaSlicer (darin squashfs-root/AppRun)
pub fn linux_dir(home: &Path) -> PathBuf {
    home.join("Applications").join("OrcaSlicer")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_right_assets() {
        let names = [
            "OrcaSlicer_Windows_Installer_V2.5.2_x64.exe",
            "OrcaSlicer_Windows_Installer_V2.5.2_arm64.exe",
            "OrcaSlicer_Windows_V2.5.2_x64_portable.zip",
            "OrcaSlicer_Mac_universal_V2.5.2.dmg",
            "OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.2.AppImage",
            "OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.2.AppImage",
            "OrcaSlicer-Linux-flatpak_V2.5.2_x86_64.flatpak",
        ];
        let pick = |os| names.iter().filter(|n| pick_asset(n, os)).collect::<Vec<_>>();
        assert_eq!(pick("windows"), vec![&"OrcaSlicer_Windows_Installer_V2.5.2_x64.exe"]);
        assert_eq!(pick("macos"), vec![&"OrcaSlicer_Mac_universal_V2.5.2.dmg"]);
        assert_eq!(pick("linux"), vec![&"OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.2.AppImage"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_glibc() {
        let v = glibc().expect("ldd --version");
        assert!(v.0 == 2 && v.1 >= 17, "{v:?}");
    }
}
