/**
 * Designer auf dem Bett: einfache Formen (Würfel, Zylinder, Kugel, Kegel, Text) als
 * „Anbau“ oder „Loch“ und das Zusammenfügen zu einem druckbaren Teil.
 * Die Rechnung (Vereinigen/Abziehen) übernimmt Manifold (Apache-2.0), dieselbe Bibliothek
 * wie in OrcaSlicer und Blender.
 */
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type ShapeKind = "box" | "cylinder" | "sphere" | "cone" | "text";
/** „part“ = normales Modell, „add“ = wird angebaut, „hole“ = wird abgezogen */
export type Role = "part" | "add" | "hole";

/** Form erzeugen; Unterseite liegt bei z = 0, mittig in x/y. Maße in mm. */
export async function shapeGeometry(kind: ShapeKind, text = "Text"): Promise<THREE.BufferGeometry> {
  let g: THREE.BufferGeometry;
  switch (kind) {
    case "box":
      g = new THREE.BoxGeometry(20, 20, 20);
      break;
    case "cylinder":
      g = new THREE.CylinderGeometry(10, 10, 20, 64).rotateX(Math.PI / 2);
      break;
    case "sphere":
      g = new THREE.SphereGeometry(10, 48, 32);
      break;
    case "cone":
      g = new THREE.CylinderGeometry(0, 10, 20, 64).rotateX(Math.PI / 2);
      break;
    default: {
      const [{ FontLoader }, { TextGeometry }, font] = await Promise.all([
        import("three/examples/jsm/loaders/FontLoader.js"),
        import("three/examples/jsm/geometries/TextGeometry.js"),
        import("../assets/fonts/droid_sans_bold.typeface.json"),
      ]);
      const f = new FontLoader().parse(font.default as never);
      g = new TextGeometry(text.trim() || "Text", { font: f, size: 10, depth: 2, curveSegments: 6, bevelEnabled: false });
    }
  }
  g.computeBoundingBox();
  const b = g.boundingBox!;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  return g;
}

type Wasm = Awaited<ReturnType<typeof loadManifold>>;
let wasmPromise: Promise<Wasm> | null = null;

async function loadManifold() {
  const [{ default: Module }, { default: wasmUrl }] = await Promise.all([import("manifold-3d"), import("manifold-3d/manifold.wasm?url")]);
  const wasm = await Module({ locateFile: () => wasmUrl });
  wasm.setup();
  return wasm;
}

function manifold(): Promise<Wasm> {
  wasmPromise ??= loadManifold();
  return wasmPromise;
}

/** Fehler mit verständlicher Meldung */
export class DesignError extends Error {}

/**
 * Fügt Teile zusammen: alle „part“/„add“ werden vereinigt, alle „hole“ abgezogen.
 * Die Geometrien müssen bereits in Bettkoordinaten vorliegen. Ergebnis ebenfalls in Bettkoordinaten.
 */
export async function combine(items: { geometry: THREE.BufferGeometry; role: Role }[], messages: { notClosed: string; empty: string }): Promise<THREE.BufferGeometry> {
  const wasm = await manifold();
  const toManifold = (geom: THREE.BufferGeometry) => {
    // Nur Positionen, gleiche Punkte zusammenführen – sonst gilt das Netz nicht als geschlossen
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", (geom.index ? geom.toNonIndexed() : geom).getAttribute("position").clone());
    const merged = mergeVertices(g, 1e-4);
    g.dispose();
    const pos = merged.getAttribute("position").array as Float32Array;
    const idx = merged.getIndex()!.array;
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(pos), triVerts: new Uint32Array(idx) });
    merged.dispose();
    mesh.merge();
    try {
      return new wasm.Manifold(mesh);
    } catch {
      throw new DesignError(messages.notClosed);
    }
  };
  const created: { delete(): void }[] = [];
  try {
    const solids = items.filter((i) => i.role !== "hole").map((i) => toManifold(i.geometry));
    const holes = items.filter((i) => i.role === "hole").map((i) => toManifold(i.geometry));
    created.push(...solids, ...holes);
    if (!solids.length) throw new DesignError(messages.empty);
    let result = solids.length > 1 ? wasm.Manifold.union(solids) : solids[0];
    if (result !== solids[0]) created.push(result);
    if (holes.length) {
      const h = holes.length > 1 ? wasm.Manifold.union(holes) : holes[0];
      if (h !== holes[0]) created.push(h);
      result = result.subtract(h);
      created.push(result);
    }
    if (result.isEmpty()) throw new DesignError(messages.empty);
    const out = result.getMesh();
    const geo = new THREE.BufferGeometry();
    const n = out.numProp;
    const vp = out.vertProperties;
    const positions = new Float32Array((vp.length / n) * 3);
    for (let i = 0, j = 0; i < vp.length; i += n, j += 3) {
      positions[j] = vp[i];
      positions[j + 1] = vp[i + 1];
      positions[j + 2] = vp[i + 2];
    }
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(out.triVerts), 1));
    const flat = geo.toNonIndexed();
    geo.dispose();
    flat.computeVertexNormals();
    return flat;
  } finally {
    for (const c of created) {
      try {
        c.delete();
      } catch {
        /* schon freigegeben */
      }
    }
  }
}
