import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getState, pushSample, setState } from "./store";
import type { AiStatus, Connection, FoundPrinter, JobRecord, OtherPrinter, PrinterHistory, PrinterStatus, Sample, Settings } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Snapshot {
  connection: Connection;
  status: PrinterStatus | null;
  samples: Sample[];
}

export async function init() {
  if (!isTauri) {
    setState({ ready: true });
    return;
  }
  try {
    await Promise.all([
      listen<Connection>("printer://connection", (e) => setState({ connection: e.payload })),
      listen<PrinterStatus | null>("printer://status", (e) => setState({ status: e.payload })),
      listen<Sample>("printer://sample", (e) => pushSample(e.payload)),
      listen("printer://jobs", () => void refreshJobs()),
      listen<PrinterHistory>("printer://history", (e) => setState({ printerHistory: e.payload })),
      listen<Settings>("settings://changed", (e) => setState({ settings: e.payload })),
      listen<OtherPrinter[]>("printers://others", (e) => setState({ others: e.payload })),
      listen<AiStatus>("ai://status", (e) => setState({ ai: e.payload })),
    ]);
    const [snap, settings, jobs, printerHistory, others] = await Promise.all([
      invoke<Snapshot>("get_snapshot"),
      invoke<Settings>("get_settings"),
      invoke<JobRecord[]>("get_jobs"),
      invoke<PrinterHistory | null>("get_printer_history"),
      invoke<OtherPrinter[]>("get_others"),
    ]);
    setState({ ...snap, settings, jobs, printerHistory, others, ready: true });
    void invoke<AiStatus>("ai_status").then((ai) => setState({ ai })).catch(() => {});
    void ensureNotificationPermission();
  } catch (err) {
    console.error("Initialisierung fehlgeschlagen", err);
    setState({ ready: true });
  }
}

async function ensureNotificationPermission() {
  try {
    const n = await import("@tauri-apps/plugin-notification");
    if (!(await n.isPermissionGranted())) await n.requestPermission();
  } catch {
    /* Benachrichtigungen sind optional */
  }
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  if (!isTauri) {
    setState({ settings });
    return settings;
  }
  const saved = await invoke<Settings>("save_settings", { settings });
  setState({ settings: saved });
  return saved;
}

export async function reconnect() {
  if (isTauri) await invoke("reconnect");
}

export async function refreshJobs() {
  if (!isTauri) return;
  setState({ jobs: await invoke<JobRecord[]>("get_jobs") });
}

export async function clearJobs() {
  if (isTauri) await invoke("clear_jobs");
  setState({ jobs: [] });
}

/** Nur Browser-Entwicklung: Demo-Drucker für Videoaufnahmen (siehe scripts/video/). In der App nie aktiv. */
export const demo = () => (isTauri ? undefined : (window as unknown as { __dwDemo?: Record<string, (...a: never[]) => unknown> }).__dwDemo);

export async function discoverPrinters(): Promise<FoundPrinter[]> {
  if (!isTauri) return ((await demo()?.discover?.()) as FoundPrinter[] | undefined) ?? [];
  return invoke<FoundPrinter[]>("discover_printers");
}

export async function rawLogDir(): Promise<string> {
  if (!isTauri) return "";
  return invoke<string>("raw_log_dir");
}

/** Typ des aktiven Druckers */
export function activeKind() {
  const s = getState().settings;
  return s.printers.find((p) => p.id === s.activePrinter)?.kind ?? "creality";
}

/** Vorschaubild des aktuellen Drucks (K1/KE-Firmware, Port 80). Fehler werden im UI abgefangen. */
export function thumbnailUrl(fileName: string | null): string | null {
  const host = getState().settings.printerIp;
  if (!host || !fileName || activeKind() !== "creality") return null;
  return `http://${host}/downloads/original/current_print_image.png?f=${encodeURIComponent(fileName)}`;
}

/**
 * Befehle an den aktiven Drucker. Das Backend prüft Grenzen und ob der Befehl gerade erlaubt ist
 * (z. B. Leveling nur ohne laufenden Druck) und übersetzt ihn für den Druckertyp.
 */
export type ControlAction =
  | "pause" | "resume" | "stop" | "home" | "level" | "motors_off"
  | `speed:${number}` | `flow:${number}` | `nozzle:${number}` | `bed:${number}` | `light:${0 | 1}` | `fan:${number}`
  | `zoffset:${number}` | `extrude:${number}` | `level:${number}` | `pid_nozzle:${number}` | `pid_bed:${number}`;

export async function printerControl(action: ControlAction): Promise<void> {
  if (!isTauri) {
    (window as unknown as { __dwLastControl: string }).__dwLastControl = action;
    (demo()?.control as ((a: string) => void) | undefined)?.(action);
    return;
  }
  await invoke("printer_control", { action });
}

/** Fertige G-Code-Datei vom Computer an den aktiven Drucker schicken (und auf Wunsch starten). */
export async function sendGcodeFile(path: string, start: boolean): Promise<string> {
  if (!isTauri) return path.split(/[\\/]/).pop() ?? path;
  return invoke<string>("printer_send_file", { path, start });
}

/** Anderen gespeicherten Drucker im Dashboard und Slicer zeigen. */
export async function switchPrinter(id: string) {
  const s = getState().settings;
  if (s.activePrinter === id || !s.printers.some((p) => p.id === id)) return;
  await saveSettings({ ...s, activePrinter: id });
}

/**
 * Mögliche Adressen eines Verlaufs-Vorschaubilds. Der Drucker speichert sie unter
 * /usr/data/creality/userdata/history/humbnail/<id>.png; welcher Web-Pfad darauf zeigt,
 * ist nicht dokumentiert – deshalb mehrere Kandidaten, die nacheinander probiert werden.
 */
export function historyThumbCandidates(job: { thumbnail: string | null; file: string }): string[] {
  const host = getState().settings.printerIp;
  if (!host || activeKind() !== "creality") return [];
  const out: string[] = [];
  const t = job.thumbnail ?? "";
  const m = /\/creality\/userdata\/(.+)$/.exec(t);
  if (m) out.push(`http://${host}/downloads/${m[1]}`);
  out.push(`http://${host}/downloads/humbnail/${encodeURIComponent(job.file)}.png`);
  return out;
}

/** Teilt dem Backend die Sprache für Meldungen und Benachrichtigungen mit. */
export async function setBackendLanguage(lang: string) {
  if (isTauri) await invoke("set_ui_language", { lang }).catch(() => {});
}

export interface RemoteInfo {
  enabled: boolean;
  running: boolean;
  url: string | null;
  error: string | null;
}

/** Handy-Seite im WLAN: Adresse für den QR-Code und Zustand des kleinen Webservers */
export async function remoteInfo(): Promise<RemoteInfo> {
  if (!isTauri) {
    const s = getState().settings;
    return { enabled: s.remoteEnabled, running: s.remoteEnabled, url: "http://192.168.178.20:8787/?k=0123456789abcdef0123456789abcdef", error: null };
  }
  return invoke<RemoteInfo>("remote_info");
}

export async function remoteNewToken() {
  if (!isTauri) return;
  setState({ settings: await invoke<Settings>("remote_new_token") });
}

export async function onRemoteChange(fn: () => void) {
  if (!isTauri) return () => {};
  return listen("remote://changed", fn);
}

/** Namen der gespeicherten Kopien früherer Drucke */
export async function reprintNames(): Promise<string[]> {
  if (!isTauri) return ["Halterung_Kabelkanal_v3_PLA_0.2mm.gcode"];
  return invoke<string[]>("reprint_names");
}

export async function reprint(name: string): Promise<string> {
  if (!isTauri) return name;
  return invoke<string>("reprint", { name });
}

/** Passt ein Dateiname aus dem Verlauf zu einer gespeicherten Kopie? */
export function findCopy(file: string, names: string[]): string | undefined {
  const norm = (n: string) => n.split(/[\\/]/).pop()!.replace(/\.(b?gcode|gco|g)$/i, "").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  const f = norm(file);
  return names.find((n) => norm(n) === f);
}

/** KI-Modell (~200 MB) einmalig herunterladen – Fortschritt kommt über „ai://status“ */
export async function aiDownload() {
  if (!isTauri) {
    setState({ ai: { state: "idle", model: true, downloadPct: null, score: 0, ewm: 0, frames: 0, lastMs: 0 } });
    return;
  }
  await invoke("ai_download");
}
