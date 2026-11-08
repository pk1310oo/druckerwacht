/**
 * Kalibrier-Drucke, die die App selbst erzeugt.
 * Temperaturturm: gestapelte Blöcke (je 10 mm), jeder Block mit eigener Düsentemperatur.
 * Nach dem Slicen schreibt das Backend die Temperaturwechsel in den G-Code (gcode_temp_steps).
 */
import { t } from "../lib/i18n";

export const BLOCK_H = 10;
/** Ab dieser Höhe gilt die Temperatur des ersten Blocks (darunter: Profil der ersten Schicht) */
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

export interface Tower {
  name: string;
  temps: number[];
}

export function towerTemps(from: number, to: number, step = 5): number[] {
  const out: number[] = [];
  const dir = from >= to ? -1 : 1;
  for (let v = from; dir < 0 ? v >= to : v <= to; v += dir * step) out.push(v);
  return out.slice(0, 12);
}

/** Temperaturstufen (Höhe in mm, °C) – `zScale` = Skalierung des Modells in Z */
export function towerSteps(temps: number[], zScale = 1): [number, number][] {
  return temps.map((temp, i) => [i === 0 ? FIRST_Z : i * BLOCK_H * zScale, temp]);
}

export function towerName(temps: number[]) {
  return `${t("Temperaturturm")}_${temps[0]}-${temps[temps.length - 1]}`;
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
    // Außenseiten gegen den Uhrzeigersinn (von außen gesehen)
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
  tris.forEach((tri, i) => {
    tri.forEach((f, k) => dv.setFloat32(84 + i * 50 + k * 4, f, true));
  });
  return buf;
}

/**
 * Turm: Sockel 30×20 mm, darauf je Block ein 20×20-mm-Würfel mit Überhang-Nase und
 * schmaler Taille dazwischen, damit man die Blöcke sicher auseinanderhält.
 * Die Nase (Überhang zur Seite) zeigt, ab welcher Temperatur Überhänge hängen.
 */
export function towerStl(blocks: number): ArrayBuffer {
  const boxes: Box[] = [];
  const e = 0.02; // Überlappung
  for (let i = 0; i < blocks; i++) {
    const z = i * BLOCK_H;
    const top = z + BLOCK_H - 1.2;
    boxes.push([-10, -10, z, 10, 10, top]);
    // Überhang-Nase rechts (in drei Stufen nach außen)
    boxes.push([10 - e, -6, z + 3, 13, 6, top]);
    boxes.push([13 - e, -6, z + 5, 16, 6, top]);
    // Taille zum nächsten Block (oder Abschluss)
    boxes.push([-8, -8, top - e, 8, 8, z + BLOCK_H + e]);
  }
  return stl(boxes);
}
