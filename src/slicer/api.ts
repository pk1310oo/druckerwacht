import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { demo, isTauri } from "../lib/api";
import type { Preset } from "./settings";
import { t } from "../lib/i18n";

export interface SlicerInfo {
  found: boolean;
  path: string | null;
  searched: string[];
}

export interface Presets {
  machine: Preset;
  process: Preset[];
  filament: Preset[];
  userProcess: Preset[];
  userFilament: Preset[];
}

export interface SliceResult {
  gcodePath: string;
  fileName: string;
  timeS: number | null;
  filamentMm: number | null;
  filamentG: number | null;
  layers: number | null;
  warnings: string[];
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function slicerInfo(): Promise<SlicerInfo> {
  if (!isTauri) {
    const dev = (window as unknown as { __dwOrca?: string }).__dwOrca;
    return { found: !!dev, path: dev ?? null, searched: [] };
  }
  return invoke<SlicerInfo>("slicer_info");
}

export async function loadPresets(): Promise<Presets | null> {
  if (!isTauri) return (window as unknown as { __dwPresets?: Presets }).__dwPresets ?? null;
  return invoke<Presets>("slicer_presets");
}

export async function savePreset(kind: "process" | "filament", preset: Preset) {
  await invoke("slicer_save_preset", { kind, preset });
}

export async function deletePreset(kind: "process" | "filament", name: string) {
  await invoke("slicer_delete_preset", { kind, name });
}

export async function slice(job: {
  models: { name: string; stl: string; support?: string; seam?: string }[];
  machine: Record<string, unknown>;
  process: Record<string, unknown>;
  filament: Record<string, unknown>;
  thumbnails: { size: string; png: string }[];
  fileName: string;
}): Promise<SliceResult> {
  if (!isTauri) {
    // Browser-Entwicklung: Auftrag zur Kontrolle ablegen statt zu slicen
    (window as unknown as { __dwLastJob: unknown }).__dwLastJob = job;
    const d = demo()?.slice as ((j: unknown) => Promise<SliceResult>) | undefined;
    if (d) return d(job);
    throw t("Slicen ist nur in der App möglich.");
  }
  return invoke<SliceResult>("slicer_slice", { job });
}

export async function cancelSlice() {
  if (isTauri) await invoke("slicer_cancel");
}

export async function readGcode(path: string): Promise<string> {
  const d = demo()?.gcode as ((p: string) => Promise<string>) | undefined;
  if (d) return d(path);
  return invoke<string>("read_gcode", { path });
}

export async function readModel(path: string): Promise<ArrayBuffer> {
  const b64 = await invoke<string>("read_model_file", { path });
  return base64ToBytes(b64).buffer as ArrayBuffer;
}

export async function pickModels(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: true,
    title: t("Modell öffnen"),
    filters: [{ name: t("3D-Modelle"), extensions: ["stl", "STL", "obj", "OBJ", "3mf", "3MF"] }],
  });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

export async function saveGcodeAs(from: string, suggested: string, pauses: number[] = []): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const to = await save({ title: t("G-Code speichern"), defaultPath: suggested, filters: [{ name: "G-Code", extensions: ["gcode"] }] });
  if (!to) return false;
  await invoke("export_gcode", { from, to, pauses });
  return true;
}

/** Browser-Demo: Fortschritt kommt als DOM-Ereignis */
function demoEvents(name: string, fn: (pct: number) => void) {
  const h = (e: Event) => fn((e as CustomEvent<number>).detail);
  window.addEventListener(name, h);
  return () => window.removeEventListener(name, h);
}

export async function onSliceProgress(fn: (pct: number) => void) {
  if (!isTauri) return demoEvents("dw-demo-slice", fn);
  return listen<number>("slicer://progress", (e) => fn(e.payload));
}

/** Dateien, die per Drag & Drop auf das Fenster gezogen werden (Tauri liefert Pfade). */
export async function onFileDrop(fn: (paths: string[]) => void, hover: (on: boolean) => void) {
  if (!isTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") hover(true);
    else if (p.type === "leave") hover(false);
    else if (p.type === "drop") {
      hover(false);
      fn(p.paths.filter((x) => /\.(stl|obj|3mf|druckerwacht)$/i.test(x)));
    }
  });
}

/** G-Code an den Drucker senden; mit `start` wird der Druck sofort gestartet. Liefert den Dateinamen am Drucker. */
export async function printerSend(path: string, start: boolean, pauses: number[] = []): Promise<string> {
  if (!isTauri) {
    const d = demo()?.send as ((p: string, s: boolean) => Promise<string>) | undefined;
    if (d) return d(path, start);
    throw t("Drucken ist nur in der App möglich.");
  }
  return invoke<string>("printer_send", { path, start, pauses });
}

export async function onUploadProgress(fn: (pct: number) => void) {
  if (!isTauri) return demoEvents("dw-demo-upload", fn);
  return listen<number>("printer://upload", (e) => fn(e.payload));
}

/** Projekt speichern: fragt nach dem Ort; liefert false, wenn abgebrochen. */
export async function saveProjectAs(contents: string, suggested: string): Promise<boolean> {
  if (!isTauri) {
    (window as unknown as { __dwLastProject: string }).__dwLastProject = contents;
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ title: t("Projekt speichern"), defaultPath: suggested, filters: [{ name: t("Druckerwacht-Projekt"), extensions: ["druckerwacht"] }] });
  if (!path) return false;
  await invoke("save_project", { path: path.endsWith(".druckerwacht") ? path : `${path}.druckerwacht`, contents });
  return true;
}

export async function pickProject(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, title: t("Projekt öffnen"), filters: [{ name: t("Druckerwacht-Projekt"), extensions: ["druckerwacht"] }] });
  return typeof res === "string" ? res : null;
}

export async function readProject(path: string): Promise<string> {
  return invoke<string>("read_project", { path });
}
