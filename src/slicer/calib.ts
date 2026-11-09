/**
 * Kalibrier-Drucke, die die App selbst erzeugt.
 * - Temperatur-, Fluss- und Tempo-Turm: gestapelte Blöcke, jeder mit eigenem Wert
 * - Rückzugs-Test: zwei schlanke Säulen, zwischen denen Fäden entstehen – Rückzug steigt nach oben
 * - Erste Schicht: fünf flache Felder zum Einstellen des Z-Offsets
 * Nach dem Slicen schreibt das Backend die Werte je Höhe in den G-Code (gcode_calib).
 */
import { t } from "../lib/i18n";

export type CalibKind = "temp" | "flow" | "speed" | "retract" | "firstlayer";

export interface Tower {
  kind: CalibKind;
  name: string;
  values: number[];
  /** Höhe eines Abschnitts in mm */
  blockH: number;
  /** Höhe, ab der der erste Abschnitt beginnt (Sockel) */
  base: number;
}

/** Ab dieser Höhe gilt der Wert des ersten Blocks (darunter: Profil der ersten Schicht) */
const FIRST_Z = 0.6;

export interface TowerPreset {
  material: string;
  from: number;
  to: number;
}

export const TOWER_PRESETS: TowerPreset[] = [
  { material: "PLA", from: 230, to: 190 },
  { material: "PETG", from: 260, to: 225 },
  { material: "ABS/ASA", from: 265, to: 235 },
  { material: "TPU", from: 240, to: 210 },
];

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const dir = from >= to ? -1 : 1;
  for (let v = from; dir < 0 ? v >= to - 1e-9 : v <= to + 1e-9; v += dir * step) out.push(Math.round(v * 100) / 100);
  return out.slice(0, 12);
}

export function unitOf(kind: CalibKind) {
  return kind === "temp" ? "°C" : kind === "retract" ? "mm" : kind === "firstlayer" ? "" : "%";
}

export function calibTitle(kind: CalibKind) {
  switch (kind) {
    case "temp":
      return t("Temperaturturm");
    case "flow":
      return t("Fluss-Turm");
    case "speed":
      return t("Tempo-Turm");
    case "retract":
      return t("Rückzugs-Test");
    default:
      return t("Erste-Schicht-Test");
  }
}

export function calibHelp(kind: CalibKind) {
  switch (kind) {
    case "temp":
      return t("Block 1 ist unten. Nach dem Druck den saubersten Block suchen (Fäden, Überhang-Nase, Oberfläche) – dessen Temperatur ins Filamentprofil übernehmen.");
    case "flow":
      return t("Block 1 ist unten. Den Block mit der glattesten Oberseite suchen: keine Lücken zwischen den Linien, aber auch keine Wülste.");
    case "speed":
      return t("Tempo steigt nach oben. Der höchste Block, der noch sauber aussieht (keine Lücken, keine Wellen), zeigt dein Maximum für dieses Filament.");
    case "retract":
      return t("Rückzug steigt nach oben. Ab dem Abschnitt, in dem keine Fäden mehr zwischen den Säulen hängen, passt der Wert – lieber den kleinsten fadenfreien nehmen.");
    default:
      return t("Während des Drucks die Felder beobachten und den Z-Offset in der Werkzeug-Karte nachstellen: Linien sollen sich leicht platt gedrückt berühren, ohne Lücken und ohne Riefen.");
  }
}

export function makeTower(kind: CalibKind, values: number[]): Tower {
  const label = calibTitle(kind);
  const u = unitOf(kind);
  const name = values.length ? `${label}_${values[0]}-${values[values.length - 1]}${u === "%" ? "pct" : u === "°C" ? "C" : u}` : label;
  if (kind === "retract") return { kind, name, values, blockH: 5, base: 1 };
  if (kind === "firstlayer") return { kind, name, values: [], blockH: 0, base: 0 };
  return { kind, name, values, blockH: 10, base: 0 };
}

/** Stufen (Höhe in mm, Wert) – `zScale` = Skalierung des Modells in Z */
export function towerSteps(tw: Tower, zScale = 1): [number, number][] {
  return tw.values.map((v, i) => [i === 0 ? Math.max(FIRST_Z, tw.base) : (tw.base + i * tw.blockH) * zScale, v]);
}

type Box = [number, number, number, number, number, number];

/** Binäres STL aus Quadern (überlappend, damit der Slicer sie zu einem Körper verbindet) */
function stl(boxes: Box[]): ArrayBuffer {
  const tris: number[][] = [];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const faces: [number, number, number, number, number[]][] = [
      [0, 3, 2, 1, [0, 0, -1]],
      [4, 5, 6, 7, [0, 0, 1]],
      [0, 1, 5, 4, [0, -1, 0]],
      [2, 3, 7, 6, [0, 1, 0]],
      [1, 2, 6, 5, [1, 0, 0]],
      [3, 0, 4, 7, [-1, 0, 0]],
    ];
    for (const [a, b, c, d, n] of faces) {
      tris.push([...n, ...v[a], ...v[b], ...v[c]]);
      tris.push([...n, ...v[a], ...v[c], ...v[d]]);
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((tri, i) => tri.forEach((f, k) => dv.setFloat32(84 + i * 50 + k * 4, f, true)));
  return buf;
}

/** Modell zum Kalibrier-Druck */
export function calibStl(tw: Tower): ArrayBuffer {
  const boxes: Box[] = [];
  const e = 0.02;
  const n = tw.values.length;
  if (tw.kind === "firstlayer") {
    // Fünf Felder 30×30 mm (Ecken und Mitte eines 150-mm-Quadrats), je eine Schicht hoch
    for (const [x, y] of [[-60, -60], [30, -60], [-15, -15], [-60, 30], [30, 30]]) boxes.push([x, y, 0, x + 30, y + 30, 0.2]);
    return stl(boxes);
  }
  if (tw.kind === "retract") {
    const top = tw.base + n * tw.blockH;
    boxes.push([-25, -6, 0, 25, 6, tw.base + e]);
    boxes.push([-22, -4, tw.base - e, -14, 4, top]);
    boxes.push([14, -4, tw.base - e, 22, 4, top]);
    // kleine Kerben je Abschnitt, damit man die Stufen zählen kann
    for (let i = 1; i < n; i++) {
      const z = tw.base + i * tw.blockH;
      boxes.push([-22.8, -1, z - 0.4, -21.98, 1, z + 0.4]);
    }
    return stl(boxes);
  }
  for (let i = 0; i < n; i++) {
    const z = i * tw.blockH;
    const top = z + tw.blockH - 1.2;
    boxes.push([-10, -10, z, 10, 10, top]);
    if (tw.kind === "temp") {
      // Überhang-Nase (in zwei Stufen nach außen)
      boxes.push([10 - e, -6, z + 3, 13, 6, top]);
      boxes.push([13 - e, -6, z + 5, 16, 6, top]);
    }
    boxes.push([-8, -8, top - e, 8, 8, z + tw.blockH + e]);
  }
  return stl(boxes);
}
