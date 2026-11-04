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
  /** je Segment: x0 y0 z0 x1 y1 z1 Breite Höhe */
  seg: number[];
  /** Anzahl Segmente am Ende jeder Schicht */
  ends: number[];
}

const F = 8;
/** Ab so vielen Bahnen wird aus Speichergründen auf einfache Linien umgeschaltet. */
const TUBE_LIMIT = 1_500_000;

export function parseGcode(text: string): GcodePreview {
  const buckets = new Map<string, Bucket>();
  const layerZ: number[] = [];
  let layer = -1;
  let type = "Custom";
  let x = 0, y = 0, z = 0;
  let width = 0.45, height = 0.2;
  let absPos = true;
  let absE = false;

  const bucket = (t: string) => {
    let b = buckets.get(t);
    if (!b) {
      b = { seg: [], ends: [] };
      buckets.set(t, b);
    }
    return b;
  };
  const closeLayer = () => {
    for (const b of buckets.values()) {
      while (b.ends.length <= layer) b.ends.push(b.seg.length / F);
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
      } else if (line.startsWith(";WIDTH:")) {
        const w = parseFloat(line.slice(7));
        if (w > 0 && w < 5) width = w;
      } else if (line.startsWith(";HEIGHT:")) {
        const h = parseFloat(line.slice(8));
        if (h > 0 && h < 5) height = h;
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
      while (b.ends.length < layer) b.ends.push(b.seg.length / F);
      b.seg.push(x, y, z, nx, ny, nz, width, height);
    }
    x = nx; y = ny; z = nz;
  }
  layer = Math.max(layer, 0);
  closeLayer();
  const layerCount = layer + 1;

  let extrusions = 0;
  for (const [t, b] of buckets) if (t !== "Travel") extrusions += b.seg.length / F;
  const tubes = extrusions <= TUBE_LIMIT;

  const group = new THREE.Group();
  const objects = new Map<string, { obj: THREE.InstancedMesh | THREE.LineSegments; ends: number[] }>();
  const types: FeatureType[] = [];
  // Ein Strang = achteckiges Rohr, längs der X-Achse von -0,5 bis 0,5, Durchmesser 1
  const tubeGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, true).rotateZ(-Math.PI / 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), dir = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);

  for (const [t, b] of buckets) {
    const n = b.seg.length / F;
    if (!n) continue;
    const meta = TYPES[t] ?? { label: t, color: "#A3A3A3" };
    let obj: THREE.InstancedMesh | THREE.LineSegments;
    if (tubes && t !== "Travel") {
      const mesh = new THREE.InstancedMesh(tubeGeo, new THREE.MeshStandardMaterial({ color: meta.color, roughness: 0.55, metalness: 0.0 }), n);
      const s = b.seg;
      for (let i = 0; i < n; i++) {
        const o = i * F;
        dir.set(s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]);
        const len = dir.length();
        if (len < 1e-6) {
          m4.makeScale(0, 0, 0);
        } else {
          dir.divideScalar(len);
          q.setFromUnitVectors(X, dir);
          const w = s[o + 6], h = s[o + 7];
          // Strangmitte liegt eine halbe Schichthöhe unter der Düse; etwas länger, damit Ecken geschlossen wirken
          pos.set((s[o] + s[o + 3]) / 2, (s[o + 1] + s[o + 4]) / 2, (s[o + 2] + s[o + 5]) / 2 - h / 2);
          scl.set(len + w * 0.5, w, h);
          m4.compose(pos, q, scl);
        }
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      obj = mesh;
    } else {
      const arr = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) arr[i * 6 + k] = b.seg[i * F + k];
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      obj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: meta.color, transparent: t === "Travel", opacity: t === "Travel" ? 0.35 : 1 }));
    }
    obj.frustumCulled = false;
    obj.visible = defaultVisible(t);
    group.add(obj);
    objects.set(t, { obj, ends: b.ends });
    types.push({ id: t, label: meta.label, color: meta.color, count: n });
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
        if (obj instanceof THREE.InstancedMesh) obj.count = end;
        else obj.geometry.setDrawRange(0, end * 2);
      }
    },
    setVisible(t: string, v: boolean) {
      const o = objects.get(t);
      if (o) o.obj.visible = v;
    },
    dispose() {
      for (const { obj } of objects.values()) {
        if (obj instanceof THREE.InstancedMesh) obj.dispose();
        else obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
      tubeGeo.dispose();
    },
  };
}

export function defaultVisible(type: string) {
  return type !== "Travel" && type !== "Custom";
}
