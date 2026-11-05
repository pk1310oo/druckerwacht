import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getState, pushSample, setState } from "./store";
import type { Connection, FoundPrinter, JobRecord, PrinterHistory, PrinterStatus, Sample, Settings } from "./types";

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
    ]);
    const [snap, settings, jobs, printerHistory] = await Promise.all([
      invoke<Snapshot>("get_snapshot"),
      invoke<Settings>("get_settings"),
      invoke<JobRecord[]>("get_jobs"),
      invoke<PrinterHistory | null>("get_printer_history"),
    ]);
    setState({ ...snap, settings, jobs, printerHistory, ready: true });
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

export async function discoverPrinters(): Promise<FoundPrinter[]> {
  if (!isTauri) return [];
  return invoke<FoundPrinter[]>("discover_printers");
}

export async function rawLogDir(): Promise<string> {
  if (!isTauri) return "";
  return invoke<string>("raw_log_dir");
}

/** Vorschaubild des aktuellen Drucks (K1/KE-Firmware, Port 80). Fehler werden im UI abgefangen. */
export function thumbnailUrl(fileName: string | null): string | null {
  const host = getState().settings.printerIp;
  if (!host || !fileName) return null;
  return `http://${host}/downloads/original/current_print_image.png?f=${encodeURIComponent(fileName)}`;
}

/** Pause, Fortsetzen oder Abbrechen des laufenden Drucks. */
export async function printerControl(action: "pause" | "resume" | "stop"): Promise<void> {
  if (!isTauri) {
    (window as unknown as { __dwLastControl: string }).__dwLastControl = action;
    return;
  }
  await invoke("printer_control", { action });
}

/**
 * Mögliche Adressen eines Verlaufs-Vorschaubilds. Der Drucker speichert sie unter
 * /usr/data/creality/userdata/history/humbnail/<id>.png; welcher Web-Pfad darauf zeigt,
 * ist nicht dokumentiert – deshalb mehrere Kandidaten, die nacheinander probiert werden.
 */
export function historyThumbCandidates(job: { thumbnail: string | null; file: string }): string[] {
  const host = getState().settings.printerIp;
  if (!host) return [];
  const out: string[] = [];
  const t = job.thumbnail ?? "";
  const m = /\/creality\/userdata\/(.+)$/.exec(t);
  if (m) out.push(`http://${host}/downloads/${m[1]}`);
  out.push(`http://${host}/downloads/humbnail/${encodeURIComponent(job.file)}.png`);
  return out;
}
