/**
 * G-Code-Vorschau: liest den von Orca erzeugten G-Code und baut pro Linientyp
 * ein Liniennetz, das sich Schicht für Schicht ein- und ausblenden lässt.
 */
import * as THREE from "three";

export interface FeatureType {
  id: string;
  label: string;
  color: string;
  count: number;
}

const TYPES: Record<string, { label: string; color: string }> = {
  "Outer wall": { label: "Außenwand", color: "#E68A6B" },
  "Inner wall": { label: "Innenwand", color: "#D9A757" },
  "Overhang wall": { label: "Überhang", color: "#6FA8DC" },
  "Sparse infill": { label: "Füllung", color: "#A0533C" },
  "Internal solid infill": { label: "Massive Füllung", color: "#C25E44" },
  "Top surface": { label: "Oberfläche", color: "#F2B8A0" },
  "Bottom surface": { label: "Unterseite", color: "#8C7B6B" },
  "Bridge": { label: "Brücke", color: "#5B8DEF" },
  "Internal Bridge": { label: "Brücke innen", color: "#4A74C9" },
  "Gap infill": { label: "Lückenfüllung", color: "#F5F4EF" },
  "Skirt": { label: "Skirt", color: "#4CAF7A" },
  "Brim": { label: "Brim", color: "#4CAF7A" },
  "Support": { label: "Stützen", color: "#8A8A8A" },
  "Support interface": { label: "Stützkontakt", color: "#B5B5B5" },
  "Support transition": { label: "Stützübergang", color: "#9A9A9A" },
  "Prime tower": { label: "Reinigungsturm", color: "#7C7C7C" },
  "Ironing": { label: "Bügeln", color: "#F5D0C0" },
  "Custom": { label: "Start/Ende", color: "#555555" },
  Travel: { label: "Leerfahrt", color: "#3D6E9E" },
};

export interface GcodePreview {
  object: THREE.Group;
  layerCount: number;
  layerZ: number[];
  types: FeatureType[];
  setMaxLayer(layer: number): void;
  setVisible(type: string, visible: boolean): void;
  dispose(): void;
}

interface Bucket {
  pos: number[];
  /** Anzahl Punkte am Ende jeder Schicht */
  ends: number[];
}

export function parseGcode(text: string): GcodePreview {
  const buckets = new Map<string, Bucket>();
  const layerZ: number[] = [];
  let layer = -1;
  let type = "Custom";
  let x = 0, y = 0, z = 0;
  let absPos = true;
  let absE = false;

  const bucket = (t: string) => {
    let b = buckets.get(t);
    if (!b) {
      b = { pos: [], ends: [] };
      buckets.set(t, b);
    }
    return b;
  };
  const closeLayer = () => {
    for (const b of buckets.values()) {
      while (b.ends.length <= layer) b.ends.push(b.pos.length / 3);
    }
  };

  let lastE = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 59 /* ; */) {
      if (line.startsWith(";LAYER_CHANGE")) {
        closeLayer();
        layer++;
      } else if (line.startsWith(";Z:")) {
        layerZ[layer] = parseFloat(line.slice(3));
      } else if (line.startsWith(";TYPE:")) {
        type = line.slice(6).trim();
      }
      continue;
    }
    if (c0 !== 71 /* G */ && c0 !== 77 /* M */) continue;
    const cmd = line.split(";")[0].trim();
    if (cmd === "G90") absPos = true;
    else if (cmd === "G91") absPos = false;
    else if (cmd === "M82") absE = true;
    else if (cmd === "M83") absE = false;
    else if (cmd.startsWith("G92")) {
      const e = /E(-?[\d.]+)/.exec(cmd);
      if (e) lastE = parseFloat(e[1]);
      continue;
    }
    const isMove = cmd.startsWith("G1 ") || cmd.startsWith("G0 ") || cmd.startsWith("G2 ") || cmd.startsWith("G3 ");
    if (!isMove) continue;

    let nx = x, ny = y, nz = z, de = 0;
    for (const part of cmd.split(" ")) {
      const v = parseFloat(part.slice(1));
      if (Number.isNaN(v)) continue;
      switch (part.charCodeAt(0)) {
        case 88: nx = absPos ? v : x + v; break; // X
        case 89: ny = absPos ? v : y + v; break; // Y
        case 90: nz = absPos ? v : z + v; break; // Z
        case 69: // E
          if (absE) { de = v - lastE; lastE = v; } else de = v;
          break;
      }
    }
    const movedXY = nx !== x || ny !== y;
    if (movedXY && layer >= 0) {
      const t = de > 0 ? type : "Travel";
      const b = bucket(t);
      while (b.ends.length < layer) b.ends.push(b.pos.length / 3);
      b.pos.push(x, y, z, nx, ny, nz);
    }
    x = nx; y = ny; z = nz;
  }
  layer = Math.max(layer, 0);
  closeLayer();
  const layerCount = layer + 1;

  const group = new THREE.Group();
  const objects = new Map<string, { obj: THREE.LineSegments; ends: number[] }>();
  const types: FeatureType[] = [];
  for (const [t, b] of buckets) {
    if (!b.pos.length) continue;
    const meta = TYPES[t] ?? { label: t, color: "#A3A3A3" };
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: meta.color, transparent: t === "Travel", opacity: t === "Travel" ? 0.35 : 1 });
    const obj = new THREE.LineSegments(g, mat);
    obj.frustumCulled = false;
    obj.visible = t !== "Travel" && t !== "Custom";
    group.add(obj);
    objects.set(t, { obj, ends: b.ends });
    types.push({ id: t, label: meta.label, color: meta.color, count: b.pos.length / 6 });
  }
  const order = Object.keys(TYPES);
  types.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

  return {
    object: group,
    layerCount,
    layerZ,
    types,
    setMaxLayer(l: number) {
      for (const { obj, ends } of objects.values()) {
        const end = ends[Math.min(l, ends.length - 1)] ?? 0;
        obj.geometry.setDrawRange(0, end);
      }
    },
    setVisible(t: string, v: boolean) {
      const o = objects.get(t);
      if (o) o.obj.visible = v;
    },
    dispose() {
      for (const { obj } of objects.values()) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    },
  };
}

export function defaultVisible(type: string) {
  return type !== "Travel" && type !== "Custom";
}
