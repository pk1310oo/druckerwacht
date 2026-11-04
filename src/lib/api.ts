import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getState, pushSample, setState } from "./store";
import type { Connection, FoundPrinter, JobRecord, PrinterStatus, Sample, Settings } from "./types";

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
    ]);
    const [snap, settings, jobs] = await Promise.all([
      invoke<Snapshot>("get_snapshot"),
      invoke<Settings>("get_settings"),
      invoke<JobRecord[]>("get_jobs"),
    ]);
    setState({ ...snap, settings, jobs, ready: true });
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
