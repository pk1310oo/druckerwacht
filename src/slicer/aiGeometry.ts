/**
 * Bausteine für den KI-Designer: Die KI beschreibt Anbauten und Ausschnitte als kleine
 * Liste von Bauschritten (Quader, Zylinder, Rohr entlang Punkten, Bogen, Profil, Text …).
 * Hier werden sie mit Manifold exakt mit dem Teil verrechnet und geprüft, ob alles
 * wirklich fest verbunden ist (keine schwebenden Stücke).
 *
 * Alle Maße in mm, Bettkoordinaten: X nach rechts, Y nach hinten, Z nach oben, Bett bei Z = 0.
 * Die Meldungen sind englisch, weil sie an die KI zurückgehen.
 */
import * as THREE from "three";
import { manifold, textGeometry, toGeometry, toManifold, type Solid, type Wasm } from "./design";

export type V3 = [number, number, number];
export type Shape =
  | { type: "box"; center: V3; size: V3; rotate?: V3; round?: number }
  | { type: "cylinder"; from: V3; to: V3; radius: number; radius2?: number }
  | { type: "sphere"; center: V3; radius: number }
  | { type: "tube"; points: V3[]; radius: number }
  | { type: "ring"; center: V3; axis: V3; start?: V3; radius: number; thickness: number; degrees?: number }
  | { type: "extrude"; origin: V3; axis: V3; xdir?: V3; polygon: [number, number][]; height: number }
  | { type: "text"; text: string; at: V3; normal: V3; up?: V3; size: number; depth: number };
export interface Op {
  op: "add" | "cut";
  shape: Shape;
}

export interface OpReport {
  index: number;
  op: "add" | "cut";
  type: string;
  /** Anbau: überlappt mit dem Teil (mm³); Ausschnitt: entferntes Volumen (mm³) */
  volumeEffect: number;
  ok: boolean;
  problem?: string;
}

export interface Evaluation {
  ops: OpReport[];
  volumeBefore: number;
  volumeAfter: number;
  piecesBefore: number;
  piecesAfter: number;
  bbox: { min: V3; max: V3 };
  problems: string[];
}

const SEG = 48;
const r2 = (v: number) => Math.round(v * 100) / 100;
const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

// ------------------------------------------------------------------ Eingabe prüfen

class OpError extends Error {}

function num(v: unknown, what: string, min = -1000, max = 1000): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new OpError(`${what} must be a number between ${min} and ${max}`);
  return v;
}
function vec(v: unknown, what: string): V3 {
  if (!Array.isArray(v) || v.length !== 3) throw new OpError(`${what} must be [x, y, z]`);
  return [num(v[0], `${what}[0]`), num(v[1], `${what}[1]`), num(v[2], `${what}[2]`)];
}
function dir(v: unknown, what: string): V3 {
  const d = vec(v, what);
  if (Math.hypot(...d) < 1e-6) throw new OpError(`${what} must not be zero`);
  return d;
}
const opt = <T>(v: unknown, f: (v: unknown) => T): T | undefined => (v == null ? undefined : f(v));

/** Prüft die Bauschritte der KI und liefert eine verständliche Fehlermeldung */
export function parseOps(input: unknown): Op[] {
  if (!Array.isArray(input) || !input.length) throw new OpError("operations must be a non-empty array");
  if (input.length > 60) throw new OpError("at most 60 operations");
  return input.map((raw, i) => {
    const w = `operations[${i}]`;
    const o = raw as Record<string, unknown>;
    if (o?.op !== "add" && o?.op !== "cut") throw new OpError(`${w}.op must be "add" or "cut"`);
    const s = o.shape as Record<string, unknown>;
    if (!s || typeof s !== "object") throw new OpError(`${w}.shape missing`);
    const p = `${w}.shape`;
    let shape: Shape;
    switch (s.type) {
      case "box":
        shape = { type: "box", center: vec(s.center, `${p}.center`), size: vec(s.size, `${p}.size`), rotate: opt(s.rotate, (v) => vec(v, `${p}.rotate`)), round: opt(s.round, (v) => num(v, `${p}.round`, 0, 100)) };
        if (shape.size.some((x) => x < 0.05 || x > 600)) throw new OpError(`${p}.size values must be 0.05–600 mm`);
        break;
      case "cylinder":
        shape = { type: "cylinder", from: vec(s.from, `${p}.from`), to: vec(s.to, `${p}.to`), radius: num(s.radius, `${p}.radius`, 0.05, 300), radius2: opt(s.radius2, (v) => num(v, `${p}.radius2`, 0, 300)) };
        if (v3(shape.from).distanceTo(v3(shape.to)) < 0.05) throw new OpError(`${p}: from and to are the same point`);
        break;
      case "sphere":
        shape = { type: "sphere", center: vec(s.center, `${p}.center`), radius: num(s.radius, `${p}.radius`, 0.05, 300) };
        break;
      case "tube": {
        if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length > 400) throw new OpError(`${p}.points must have 2–400 points`);
        shape = { type: "tube", points: s.points.map((q, j) => vec(q, `${p}.points[${j}]`)), radius: num(s.radius, `${p}.radius`, 0.1, 100) };
        break;
      }
      case "ring":
        shape = {
          type: "ring",
          center: vec(s.center, `${p}.center`),
          axis: dir(s.axis, `${p}.axis`),
          start: opt(s.start, (v) => dir(v, `${p}.start`)),
          radius: num(s.radius, `${p}.radius`, 0.1, 300),
          thickness: num(s.thickness, `${p}.thickness`, 0.1, 100),
          degrees: opt(s.degrees, (v) => num(v, `${p}.degrees`, 1, 360)),
        };
        if (shape.thickness / 2 >= shape.radius) throw new OpError(`${p}: thickness/2 must be smaller than radius`);
        break;
      case "extrude": {
        if (!Array.isArray(s.polygon) || s.polygon.length < 3 || s.polygon.length > 400) throw new OpError(`${p}.polygon must have 3–400 points`);
        const poly = s.polygon.map((q, j) => {
          if (!Array.isArray(q) || q.length !== 2) throw new OpError(`${p}.polygon[${j}] must be [u, v]`);
          return [num(q[0], `${p}.polygon[${j}][0]`), num(q[1], `${p}.polygon[${j}][1]`)] as [number, number];
        });
        shape = { type: "extrude", origin: vec(s.origin, `${p}.origin`), axis: dir(s.axis, `${p}.axis`), xdir: opt(s.xdir, (v) => dir(v, `${p}.xdir`)), polygon: poly, height: num(s.height, `${p}.height`, 0.05, 600) };
        break;
      }
      case "text":
        if (typeof s.text !== "string" || !s.text.trim() || s.text.length > 60) throw new OpError(`${p}.text must be 1–60 characters`);
        shape = {
          type: "text",
          text: s.text,
          at: vec(s.at, `${p}.at`),
          normal: dir(s.normal, `${p}.normal`),
          up: opt(s.up, (v) => dir(v, `${p}.up`)),
          size: num(s.size, `${p}.size`, 1, 200),
          depth: num(s.depth, `${p}.depth`, 0.2, 50),
        };
        break;
      default:
        throw new OpError(`${p}.type must be one of box, cylinder, sphere, tube, ring, extrude, text`);
    }
    return { op: o.op, shape };
  });
}

// ------------------------------------------------------------------ Körper bauen

/** Koordinatensystem mit lokaler Z-Achse = `z`; X folgt möglichst `xHint` bzw. Y folgt `yHint` */
function basis(zIn: V3, xHint?: V3, yHint?: V3): THREE.Matrix4 {
  const z = v3(zIn).normalize();
  let x: THREE.Vector3;
  if (yHint) {
    const y = v3(yHint).addScaledVector(z, -v3(yHint).dot(z));
    x = y.lengthSq() > 1e-8 ? y.normalize().cross(z) : new THREE.Vector3();
  } else if (xHint) {
    x = v3(xHint).addScaledVector(z, -v3(xHint).dot(z));
  } else x = new THREE.Vector3();
  if (x.lengthSq() < 1e-8) {
    // Kein brauchbarer Hinweis: irgendeine Senkrechte
    x = Math.abs(z.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(z) : new THREE.Vector3(1, 0, 0).addScaledVector(z, -z.x);
  }
  x.normalize();
  const y = z.clone().cross(x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z);
}

type Mat4 = Parameters<Solid["transform"]>[0];
const place = (m: THREE.Matrix4, at: V3) => m.clone().setPosition(v3(at)).elements as unknown as Mat4;

/** Baut einen Körper; alle Zwischenstände werden über `keep` freigegeben */
async function build(wasm: Wasm, op: Op, keep: { delete(): void }[]): Promise<Solid> {
  const M = wasm.Manifold;
  const k = <T extends { delete(): void }>(x: T) => (keep.push(x), x);
  const s = op.shape;
  switch (s.type) {
    case "box": {
      let b: Solid;
      const r = Math.min(s.round ?? 0, Math.min(...s.size) / 2 - 0.01);
      if (r > 0.05) {
        const pts: Solid[] = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(k(M.sphere(r, 24).translate([sx * (s.size[0] / 2 - r), sy * (s.size[1] / 2 - r), sz * (s.size[2] / 2 - r)])));
        b = k(M.hull(pts));
      } else b = k(M.cube(s.size, true));
      if (s.rotate) b = k(b.rotate(s.rotate));
      return k(b.translate(s.center));
    }
    case "cylinder": {
      const len = v3(s.from).distanceTo(v3(s.to));
      const c = k(M.cylinder(len, s.radius, s.radius2 ?? s.radius, SEG));
      const d = v3(s.to).sub(v3(s.from));
      return k(c.transform(place(basis(d.toArray() as V3), s.from)));
    }
    case "sphere":
      return k(k(M.sphere(s.radius, SEG)).translate(s.center));
    case "tube": {
      const balls = s.points.map((p) => k(k(M.sphere(s.radius, 32)).translate(p)));
      const parts = balls.slice(1).map((b, i) => k(M.hull([balls[i], b])));
      return parts.length > 1 ? k(M.union(parts)) : parts[0];
    }
    case "ring": {
      const deg = s.degrees ?? 360;
      const cs = k(k(wasm.CrossSection.circle(s.thickness / 2, 32)).translate([s.radius, 0]));
      let ring = k(M.revolve(cs, 96, deg));
      if (deg < 360) {
        // Runde Enden (z. B. Hakenspitze)
        const a = (deg * Math.PI) / 180;
        const caps = [k(k(M.sphere(s.thickness / 2, 32)).translate([s.radius, 0, 0])), k(k(M.sphere(s.thickness / 2, 32)).translate([s.radius * Math.cos(a), s.radius * Math.sin(a), 0]))];
        ring = k(M.union([ring, ...caps]));
      }
      return k(ring.transform(place(basis(s.axis, s.start), s.center)));
    }
    case "extrude": {
      const cs = k(wasm.CrossSection.ofPolygons([s.polygon], "NonZero"));
      if (cs.isEmpty()) throw new OpError("extrude polygon has no area");
      const e = k(M.extrude(cs, s.height));
      return k(e.transform(place(basis(s.axis, s.xdir), s.origin)));
    }
    case "text": {
      // Anbau: steht 0,3 mm im Teil und ragt `depth` heraus; Gravur: `depth` tief, 1 mm über der Fläche
      const below = op.op === "add" ? 0.3 : s.depth;
      const above = op.op === "add" ? s.depth : 1;
      const g = await textGeometry(s.text, s.size, below + above);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -below);
      const n = v3(s.normal);
      const up: V3 = s.up ?? (Math.abs(n.normalize().z) > 0.7 ? [0, 1, 0] : [0, 0, 1]);
      g.applyMatrix4(basis(s.normal, undefined, up).setPosition(v3(s.at)));
      try {
        return k(toManifold(wasm, g, "text could not be built"));
      } finally {
        g.dispose();
      }
    }
  }
}

const pieces = (m: Solid) => {
  const parts = m.decompose();
  const n = parts.length;
  parts.forEach((p) => p.delete());
  return n;
};

/**
 * Wendet die Bauschritte auf das Teil an (Bettkoordinaten) und prüft das Ergebnis.
 * `geometry` ist null, wenn nichts übrig bliebe.
 */
export async function evaluate(part: THREE.BufferGeometry, ops: Op[]): Promise<{ geometry: THREE.BufferGeometry | null; report: Evaluation }> {
  const wasm = await manifold();
  const keep: { delete(): void }[] = [];
  try {
    const base = toManifold(wasm, part, "the part is not a closed solid");
    keep.push(base);
    const volumeBefore = base.volume();
    const piecesBefore = pieces(base);
    const minZ = base.boundingBox().min[2];
    let cur = base;
    const reports: OpReport[] = [];
    const problems: string[] = [];
    for (const [index, op] of ops.entries()) {
      let shape: Solid;
      try {
        shape = await build(wasm, op, keep);
      } catch (e) {
        throw new OpError(`operations[${index}]: ${e instanceof Error ? e.message : String(e)}`);
      }
      const before = cur.volume();
      const sv = shape.volume();
      const next = op.op === "add" ? cur.add(shape) : cur.subtract(shape);
      keep.push(next);
      const after = next.volume();
      const rep: OpReport = { index, op: op.op, type: op.shape.type, volumeEffect: 0, ok: true };
      if (op.op === "add") {
        rep.volumeEffect = r2(before + sv - after);
        if (rep.volumeEffect < 0.05) {
          rep.ok = false;
          rep.problem = "does not overlap the existing part – it would float or only touch. Move it so it sinks at least 0.5–1 mm into the surface.";
        }
        if (shape.boundingBox().min[2] < minZ - 0.01) {
          rep.ok = false;
          rep.problem = `${rep.problem ? rep.problem + " Also it" : "It"} goes below the bed (z < ${r2(minZ)}).`;
        }
      } else {
        rep.volumeEffect = r2(before - after);
        if (rep.volumeEffect < 0.05) {
          rep.ok = false;
          rep.problem = "removes nothing – the cut shape does not intersect the part.";
        }
      }
      if (!rep.ok) problems.push(`operations[${index}] (${op.op} ${op.shape.type}) ${rep.problem}`);
      reports.push(rep);
      cur = next;
    }
    if (cur.isEmpty()) return { geometry: null, report: { ops: reports, volumeBefore: r2(volumeBefore), volumeAfter: 0, piecesBefore, piecesAfter: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] }, problems: [...problems, "nothing of the part would remain"] } };
    const piecesAfter = pieces(cur);
    if (piecesAfter > piecesBefore) problems.push(`the result has ${piecesAfter} separate pieces (before: ${piecesBefore}) – something is not connected`);
    const bb = cur.boundingBox();
    const report: Evaluation = {
      ops: reports,
      volumeBefore: r2(volumeBefore),
      volumeAfter: r2(cur.volume()),
      piecesBefore,
      piecesAfter,
      bbox: { min: bb.min.map(r2) as V3, max: bb.max.map(r2) as V3 },
      problems,
    };
    return { geometry: toGeometry(cur), report };
  } finally {
    for (const x of keep) {
      try {
        x.delete();
      } catch {
        /* schon frei */
      }
    }
  }
}

/** Umriss des Teils in Höhe z (vereinfachte Polygone) */
export async function sliceOutline(part: THREE.BufferGeometry, z: number): Promise<[number, number][][]> {
  const wasm = await manifold();
  const base = toManifold(wasm, part, "the part is not a closed solid");
  try {
    const cs = base.slice(z);
    const simple = cs.simplify(0.15);
    const polys = simple.toPolygons();
    cs.delete();
    simple.delete();
    return polys.slice(0, 20).map((poly) => {
      const step = Math.max(1, Math.ceil(poly.length / 120));
      return poly.filter((_, i) => i % step === 0).map(([x, y]) => [r2(x), r2(y)] as [number, number]);
    });
  } finally {
    base.delete();
  }
}

export { OpError };
