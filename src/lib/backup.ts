/**
 * Datensicherung: Einstellungen (alle Drucker) und die Daten dieses Computers
 * (Filament-Lager, Wartung, Nachtmodus, Ansicht) in eine JSON-Datei – und zurück.
 */
import { invoke } from "@tauri-apps/api/core";
import { getState } from "./store";
import { isTauri, saveSettings } from "./api";
import { APP_VERSION } from "./update";
import { t } from "./i18n";
import type { Settings } from "./types";

const LOCAL_KEYS = (k: string) => k.startsWith("dw.") || k === "chartWindow";

interface Backup {
  app: "druckerwacht";
  version: string;
  createdMs: number;
  settings: Settings;
  local: Record<string, string>;
}

export async function exportBackup(): Promise<boolean> {
  const local: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && LOCAL_KEYS(k)) local[k] = localStorage.getItem(k) ?? "";
    }
  } catch {
    /* kein Speicher – nur Einstellungen sichern */
  }
  const data: Backup = { app: "druckerwacht", version: APP_VERSION, createdMs: Date.now(), settings: getState().settings, local };
  const text = JSON.stringify(data, null, 2);
  if (!isTauri) {
    (window as unknown as { __dwBackup: string }).__dwBackup = text;
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const day = new Date().toISOString().slice(0, 10);
  const path = await save({ title: t("Sicherung speichern"), defaultPath: `druckerwacht-sicherung-${day}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return false;
  await invoke("backup_write", { path: path.endsWith(".json") ? path : `${path}.json`, contents: text });
  return true;
}

/** Liest eine Sicherung ein und lädt die App neu. Liefert false, wenn abgebrochen. */
export async function importBackup(): Promise<boolean> {
  if (!isTauri) return false;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, title: t("Sicherung laden"), filters: [{ name: "JSON", extensions: ["json"] }] });
  if (typeof path !== "string") return false;
  let data: Backup;
  try {
    data = JSON.parse(await invoke<string>("backup_read", { path })) as Backup;
  } catch (e) {
    throw typeof e === "string" ? e : t("Das ist keine gültige Druckerwacht-Sicherung.");
  }
  if (data?.app !== "druckerwacht" || typeof data.settings !== "object") throw t("Das ist keine gültige Druckerwacht-Sicherung.");
  try {
    for (const [k, v] of Object.entries(data.local ?? {})) if (LOCAL_KEYS(k) && typeof v === "string") localStorage.setItem(k, v);
  } catch {
    /* Speicher gesperrt */
  }
  await saveSettings({ ...getState().settings, ...data.settings });
  location.reload();
  return true;
}
