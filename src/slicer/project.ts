/**
 * Projektdatei (.druckerwacht): JSON mit Modellen (binäre STL, base64), Lage,
 * gemalten Bereichen sowie gewählten Profilen und geänderten Einstellungen.
 */
import { base64ToBytes, bytesToBase64 } from "./api";
import type { PaintData, ProjectModel } from "./plate";
import type { Overrides } from "./settings";

export const PROJECT_FORMAT = "druckerwacht-projekt";

export interface ProjectSettings {
  process: string;
  filament: string;
  overrides: Overrides;
}

interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: 1;
  savedAt: string;
  settings: ProjectSettings;
  models: {
    name: string;
    stl: string;
    position: number[];
    quaternion: number[];
    scale: number[];
    /** gemalte Bereiche als base64 (ein Byte je Dreieck) */
    paint?: { support?: string; seam?: string } | null;
  }[];
}

export function serializeProject(models: ProjectModel[], settings: ProjectSettings): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: 1,
    savedAt: new Date().toISOString(),
    settings,
    models: models.map((m) => ({
      name: m.name,
      stl: bytesToBase64(m.stl),
      position: m.position,
      quaternion: m.quaternion,
      scale: m.scale,
      paint: m.paint
        ? {
            support: m.paint.support ? bytesToBase64(m.paint.support) : undefined,
            seam: m.paint.seam ? bytesToBase64(m.paint.seam) : undefined,
          }
        : null,
    })),
  };
  return JSON.stringify(file);
}

const nums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Liest und prüft eine Projektdatei; wirft eine verständliche Meldung bei Problemen. */
export function parseProject(text: string): { models: ProjectModel[]; settings: ProjectSettings } {
  let f: ProjectFile;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error("Die Datei ist kein gültiges Druckerwacht-Projekt.");
  }
  if (f?.format !== PROJECT_FORMAT || !Array.isArray(f.models)) throw new Error("Die Datei ist kein gültiges Druckerwacht-Projekt.");
  if (f.version > 1) throw new Error("Das Projekt stammt aus einer neueren Druckerwacht-Version.");
  const models: ProjectModel[] = f.models.map((m, i) => {
    if (typeof m.stl !== "string" || !nums(m.position, 3) || !nums(m.quaternion, 4) || !nums(m.scale, 3)) {
      throw new Error(`Modell ${i + 1} im Projekt ist beschädigt.`);
    }
    let paint: PaintData | null = null;
    if (m.paint && typeof m.paint === "object") {
      const dec = (v: unknown) => (typeof v === "string" && v ? base64ToBytes(v) : undefined);
      const support = dec(m.paint.support);
      const seam = dec(m.paint.seam);
      if (support || seam) paint = { support, seam };
    }
    return {
      name: String(m.name ?? `Modell ${i + 1}`),
      stl: base64ToBytes(m.stl),
      position: m.position as [number, number, number],
      quaternion: m.quaternion as [number, number, number, number],
      scale: m.scale as [number, number, number],
      paint,
    };
  });
  const s = f.settings ?? ({} as ProjectSettings);
  const overrides: Overrides = {};
  for (const [k, v] of Object.entries(s.overrides ?? {})) if (typeof v === "string") overrides[k] = v;
  return {
    models,
    settings: { process: String(s.process ?? ""), filament: String(s.filament ?? ""), overrides },
  };
}
