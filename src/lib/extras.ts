/**
 * Zusatzfunktionen: Warteschlange, Zeitraffer, Handy-Benachrichtigung (ntfy), Kamerasuche.
 * Im Browser (Vorschau) arbeiten Warteschlange und Zeitraffer mit Beispieldaten im Speicher.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./api";
import { t } from "./i18n";

export interface QueueItem {
  id: string;
  name: string;
  addedMs: number;
  timeS: number | null;
  filamentG: number | null;
  /** Filamentwechsel vor diesen Schichten (ab 1) */
  pauses: number[];
}

export interface Timelapse {
  id: string;
  name: string;
  createdMs: number;
  frames: number;
  sizeBytes: number;
  cover: string | null;
}

// ----------------------------------------------------------------------------- Vorschau-Daten
let demoQueue: QueueItem[] = [];

function demoSet(q: QueueItem[]) {
  demoQueue = q;
  return [...q];
}

// ----------------------------------------------------------------------------- Warteschlange
const queueListeners = new Set<(q: QueueItem[]) => void>();

/** Benachrichtigt alle Ansichten, wenn sich die Warteschlange ändert. */
export function onQueueChange(fn: (q: QueueItem[]) => void) {
  queueListeners.add(fn);
  return () => void queueListeners.delete(fn);
}

function emitQueue(q: QueueItem[]) {
  for (const fn of queueListeners) fn(q);
  return q;
}

export async function queueList(): Promise<QueueItem[]> {
  if (!isTauri) return [...demoQueue];
  return invoke<QueueItem[]>("queue_list");
}

export async function queueAdd(job: { path: string; name: string; timeS: number | null; filamentG: number | null; pauses: number[] }) {
  if (!isTauri) {
    const item: QueueItem = { id: `q${Date.now()}`, name: job.name.replace(/\.gcode$/i, ""), addedMs: Date.now(), timeS: job.timeS, filamentG: job.filamentG, pauses: job.pauses.filter((l) => l > 0).map((l) => l + 1) };
    return emitQueue(demoSet([...demoQueue, item]));
  }
  return emitQueue(await invoke<QueueItem[]>("queue_add", { ...job }));
}

export async function queueRemove(id: string) {
  if (!isTauri) return emitQueue(demoSet(demoQueue.filter((q) => q.id !== id)));
  return emitQueue(await invoke<QueueItem[]>("queue_remove", { id }));
}

export async function queueShift(id: string, delta: number) {
  if (!isTauri) {
    const q = [...demoQueue];
    const i = q.findIndex((x) => x.id === id);
    if (i < 0) return q;
    const [it] = q.splice(i, 1);
    q.splice(Math.max(0, Math.min(q.length, i + delta)), 0, it);
    return emitQueue(demoSet(q));
  }
  return emitQueue(await invoke<QueueItem[]>("queue_shift", { id, delta }));
}

/** Startet einen Eintrag; liefert den Dateinamen am Drucker. */
export async function queueStart(id: string): Promise<string> {
  if (!isTauri) {
    const it = demoQueue.find((q) => q.id === id);
    emitQueue(demoSet(demoQueue.filter((q) => q.id !== id)));
    return `${it?.name ?? "druck"}.gcode`;
  }
  const name = await invoke<string>("queue_start", { id });
  emitQueue(await queueList());
  return name;
}

// ----------------------------------------------------------------------------- Zeitraffer
export async function timelapseList(): Promise<Timelapse[]> {
  if (!isTauri) return (window as unknown as { __dwTimelapses?: Timelapse[] }).__dwTimelapses ?? [];
  return invoke<Timelapse[]>("timelapse_list");
}

export async function timelapseExport(tl: Timelapse): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const to = await save({ title: t("Zeitraffer speichern"), defaultPath: `${tl.name}.mov`, filters: [{ name: "Video", extensions: ["mov"] }] });
  if (!to) return false;
  await invoke("timelapse_export", { id: tl.id, to });
  return true;
}

export async function timelapseDelete(id: string) {
  if (isTauri) await invoke("timelapse_delete", { id });
}

export async function onTimelapse(fn: () => void) {
  if (!isTauri) return () => {};
  return listen("printer://timelapse", fn);
}

// ----------------------------------------------------------------------------- Handy & Kamera
export async function ntfyTest(topic: string) {
  if (!isTauri) return;
  await invoke("ntfy_test", { topic });
}

/** Zufälliges, schwer zu erratendes Thema (ntfy-Themen sind öffentlich lesbar). */
export function randomTopic() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return `druckerwacht-${Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10)}`;
}

export async function cameraProbe(): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("camera_probe");
}
