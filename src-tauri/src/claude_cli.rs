//! Private Abo-Ausgabe: Der KI-Designer nutzt das auf diesem Computer installierte und mit dem
//! eigenen Claude-Abo angemeldete Claude Code (`claude -p`) statt eines API-Schlüssels.
//!
//! Nur aktiv, wenn beim Bauen `DW_ABO=1` gesetzt war (eigener Build, nicht im öffentlichen Release).
//! Druckerwacht sieht dabei nie Zugangsdaten – es startet nur das Programm `claude`.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

pub fn enabled() -> bool {
    option_env!("DW_ABO") == Some("1")
}

fn tr(de: &'static str, en: &'static str) -> String {
    crate::i18n::tr(de, en).to_string()
}

/// Sucht das Programm `claude` (Programme aus dem Startmenü sehen den PATH der Shell oft nicht)
pub fn find() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut c: Vec<PathBuf> = Vec::new();
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            c.push(d.join(exe));
            if cfg!(windows) {
                c.push(d.join("claude.cmd"));
            }
        }
    }
    if let Some(h) = &home {
        c.push(h.join(".local/bin").join(exe));
        c.push(h.join(".claude/local").join(exe));
        c.push(h.join(".npm-global/bin").join(exe));
        c.push(h.join(".bun/bin").join(exe));
        if cfg!(windows) {
            c.push(h.join("AppData/Roaming/npm/claude.cmd"));
        }
    }
    c.push(PathBuf::from("/usr/local/bin/claude"));
    c.push(PathBuf::from("/opt/homebrew/bin/claude"));
    c.push(PathBuf::from("/usr/bin/claude"));
    c.into_iter().find(|p| p.is_file())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboStatus {
    pub enabled: bool,
    pub found: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboReply {
    pub text: String,
    pub session_id: String,
    pub is_error: bool,
}

/// Arbeitsordner für einen Auftrag (Bilder der Ansichten liegen dort, Claude darf nur dort lesen)
pub fn workdir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("ki-designer");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Speichert ein Ansichtsbild im Arbeitsordner (nur einfache Dateinamen)
pub fn write_image(dir: &Path, name: &str, png_base64: &str) -> Result<(), String> {
    use base64::Engine;
    if !name.ends_with(".png") || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') || name.contains("..") {
        return Err("name?".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(png_base64).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())
}

/// Eine Runde mit Claude Code: Nachricht über stdin, Antwort als JSON
pub fn run(dir: &Path, message: &str, session: Option<&str>, model: &str) -> Result<AboReply, String> {
    let claude = find().ok_or_else(|| tr("Claude Code ist auf diesem Computer nicht installiert.", "Claude Code is not installed on this computer."))?;
    let is_cmd = claude.extension().map(|e| e.eq_ignore_ascii_case("cmd")).unwrap_or(false);
    let mut cmd = if is_cmd {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&claude);
        c
    } else {
        Command::new(&claude)
    };
    cmd.args(["-p", "--output-format", "json", "--model", model, "--allowedTools", "Read"]);
    if let Some(s) = session {
        if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("session?".into());
        }
        cmd.args(["--resume", s]);
    }
    // Ein gesetzter API-Schlüssel hätte Vorrang vor dem Abo – hier bewusst nicht weitergeben
    cmd.env_remove("ANTHROPIC_API_KEY").current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("claude: {e}"))?;
    child.stdin.take().ok_or("stdin")?.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = match serde_json::from_str(stdout.trim()) {
        Ok(v) => v,
        Err(_) => {
            let err = String::from_utf8_lossy(&out.stderr);
            let msg: String = format!("{} {}", stdout.trim(), err.trim()).trim().chars().take(400).collect();
            if msg.to_lowercase().contains("login") || msg.to_lowercase().contains("auth") {
                return Err(tr("Claude Code ist nicht angemeldet – einmal im Terminal „claude“ starten und mit dem Abo einloggen.", "Claude Code is not logged in – run “claude” once in a terminal and log in with your subscription."));
            }
            return Err(if msg.is_empty() { tr("Claude Code hat nicht geantwortet.", "Claude Code did not answer.") } else { msg });
        }
    };
    Ok(AboReply {
        text: v["result"].as_str().unwrap_or_default().to_string(),
        session_id: v["session_id"].as_str().unwrap_or_default().to_string(),
        is_error: v["is_error"].as_bool().unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_names_are_safe() {
        let d = std::env::temp_dir();
        assert!(write_image(&d, "../x.png", "AA==").is_err());
        assert!(write_image(&d, "a/b.png", "AA==").is_err());
        assert!(write_image(&d, "x.exe", "AA==").is_err());
        assert!(write_image(&d, "view-1.png", "iVBORw0KGgo=").is_ok());
        let _ = std::fs::remove_file(d.join("view-1.png"));
    }

    /// Ein nachgebautes `claude`: prüft die Aufrufparameter und gibt JSON wie Claude Code zurück
    #[cfg(unix)]
    #[test]
    fn talks_to_claude_code() {
        use std::os::unix::fs::PermissionsExt;
        let bin = std::env::temp_dir().join(format!("dw-fake-claude-{}", std::process::id()));
        std::fs::create_dir_all(&bin).unwrap();
        let script = bin.join("claude");
        std::fs::write(
            &script,
            "#!/bin/sh\nmsg=$(cat)\nif [ -n \"$ANTHROPIC_API_KEY\" ]; then echo '{\"result\":\"key leaked\",\"session_id\":\"x\",\"is_error\":true}'; exit 0; fi\necho \"{\\\"result\\\":\\\"args=$* msg=$msg\\\",\\\"session_id\\\":\\\"abc-123\\\",\\\"is_error\\\":false}\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let old = std::env::var_os("PATH").unwrap_or_default();
        std::env::set_var("PATH", std::env::join_paths(std::iter::once(bin.clone()).chain(std::env::split_paths(&old))).unwrap());
        std::env::set_var("ANTHROPIC_API_KEY", "sk-should-not-be-passed");
        let r = run(&bin, "hallo", Some("abc-123"), "opus").unwrap();
        std::env::remove_var("ANTHROPIC_API_KEY");
        std::env::set_var("PATH", old);
        assert!(!r.is_error, "{}", r.text);
        assert_eq!(r.session_id, "abc-123");
        assert!(r.text.contains("-p --output-format json --model opus --allowedTools Read --resume abc-123"), "{}", r.text);
        assert!(r.text.ends_with("msg=hallo"), "{}", r.text);
        assert!(run(&bin, "x", Some("bad;id"), "opus").is_err());
        let _ = std::fs::remove_dir_all(&bin);
    }
}
