/**
 * 3D-Druckplatte (three.js). Koordinaten wie am Drucker: Z zeigt nach oben, Bett 0…220 mm.
 * Modelle haben ihren Ursprung unten mittig, damit „auf das Bett legen“ einfach z = −min ist.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GcodePreview } from "./gcode";
import bedModelUrl from "./assets/creality_ender3v3ke_buildplate_model.stl?url";
import bedTextureSvg from "./assets/creality_ender3v3ke_buildplate_texture.svg?raw";
import { t } from "../lib/i18n";

/** OrbitControls: diese Maustaste bewegt die Ansicht nicht */
const NO_BUTTON = -1 as THREE.MOUSE;

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const BED = { x: 220, y: 220, z: 245 };

const COLOR = {
  bg: 0x0f0f0f,
  bed: 0x161616,
  gridMinor: 0x222222,
  gridMajor: 0x2e2e2e,
  edge: 0x3a3a3a,
  model: 0xc9c7bf,
  selected: 0xd97757,
  outside: 0xe05a4f,
};

export interface ModelInfo {
  id: number;
  name: string;
  size: [number, number, number];
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  triangles: number;
  outside: boolean;
}

export type Tool = "select" | "move" | "rotate" | "scale" | "layflat" | "cut" | "measure" | "paint" | null;

interface Snap {
  items: {
    id: number;
    name: string;
    geometry: THREE.BufferGeometry;
    paint: PaintData | undefined;
    p: [number, number, number];
    q: [number, number, number, number];
    s: [number, number, number];
  }[];
  key: string;
}

/** Gemalte Bereiche je Dreieck (0 = nichts, 1 = erzwingen, 2 = blockieren), getrennt für Stützen und Naht. */
export type PaintData = { support?: Uint8Array; seam?: Uint8Array };
export type PaintChannel = "support" | "seam";

export interface ProjectModel {
  name: string;
  stl: Uint8Array;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  paint: PaintData | null;
}

export interface Measure {
  points: THREE.Vector3[];
  distance: number | null;
  delta: [number, number, number] | null;
}

export class Plate {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private models: THREE.Mesh[] = [];
  /** Alle ausgewählten Modelle (Mehrfachauswahl per Rechteck oder Shift/Strg-Klick) */
  private selection = new Set<THREE.Mesh>();
  /** Das eine ausgewählte Modell – null bei keiner oder mehreren Auswahlen */
  private get selected(): THREE.Mesh | null {
    return this.selection.size === 1 ? [...this.selection][0] : null;
  }
  /** Drehpunkt für gemeinsames Verschieben/Drehen/Skalieren mehrerer Modelle */
  private pivot = new THREE.Object3D();
  private pivotStart = new THREE.Matrix4();
  private groupStart = new Map<THREE.Mesh, THREE.Matrix4>();
  private nextId = 1;
  private tool: Tool = "move";
  private raf = 0;
  private dirty = true;
  private ro: ResizeObserver;
  private listeners = new Set<() => void>();
  private host: HTMLElement | null = null;
  private preview: GcodePreview | null = null;
  private modelGroup = new THREE.Group();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(COLOR.bg);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Die Leinwand füllt per CSS immer die ganze Fläche; die Pixelgröße folgt per ResizeObserver.
    Object.assign(this.renderer.domElement.style, { display: "block", outline: "none", position: "absolute", inset: "0", width: "100%", height: "100%" });

    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.resetView();

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(BED.x / 2, BED.y / 2, 10);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.maxDistance = 1200;
    this.orbit.minDistance = 30;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.orbit.addEventListener("change", () => this.invalidate());

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      if (dragging && this.gizmo.object === this.pivot) {
        this.pivot.updateMatrixWorld(true);
        this.pivotStart.copy(this.pivot.matrixWorld).invert();
        this.groupStart.clear();
        for (const m of this.selection) {
          m.updateMatrixWorld(true);
          this.groupStart.set(m, m.matrixWorld.clone());
        }
      }
      if (!dragging) {
        for (const m of this.selection) this.dropToBed(m);
        this.placePivot();
        this.changed();
      }
    });
    this.gizmo.addEventListener("objectChange", () => {
      if (this.gizmo.object === this.pivot) this.applyGroupTransform();
      else if (this.selected && this.gizmo.getMode() === "translate") this.selected.position.z = this.zOffset(this.selected);
      this.updateColors();
      this.invalidate();
      this.emit();
    });
    this.gizmo.addEventListener("change", () => this.invalidate());
    this.scene.add(this.gizmo.getHelper());
    this.scene.add(this.pivot);

    this.buildBed();
    this.scene.add(this.modelGroup);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(BED.x / 2 - 90, BED.y / 2 - 60, 380);
    key.target.position.set(BED.x / 2, BED.y / 2, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.6;
    Object.assign(key.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 50, far: 1000 });
    this.scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(300, 300, 200);
    this.scene.add(rim);

    this.ro = new ResizeObserver(() => this.resize());
    // Vor OrbitControls ausführen (Capture), damit das Auswahlrechteck die Ansicht nicht dreht
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.onHover);
    this.loop();
  }

  // ------------------------------------------------------------------ Lebenszyklus

  mount(el: HTMLElement) {
    this.host = el;
    el.prepend(this.renderer.domElement); // zuerst, damit Hinweise und Panels darüber liegen
    this.ro.observe(el);
    this.resize();
  }

  unmount() {
    this.ro.disconnect();
    this.renderer.domElement.remove();
    this.host = null;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ Verlauf (Rückgängig/Wiederholen)

  private history: Snap[] = [{ items: [], key: "[]" }];
  private hIndex = 0;
  private restoring = false;

  /** Nach einer Änderung: Zustand merken und Oberfläche benachrichtigen. */
  private changed() {
    this.commit();
    this.emit();
  }

  private snapshot(): Snap {
    const items = this.models.map((m) => ({
      id: m.userData.id as number,
      name: m.name,
      geometry: m.geometry,
      paint: m.userData.paint as PaintData | undefined,
      p: m.position.toArray() as [number, number, number],
      q: m.quaternion.toArray() as [number, number, number, number],
      s: m.scale.toArray() as [number, number, number],
    }));
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const key = JSON.stringify(items.map((i) => [i.id, i.geometry.id, paintVersion(i.paint), ...i.p.map(r), ...i.q.map(r), ...i.s.map(r)]));
    return { items, key };
  }

  private commit() {
    if (this.restoring) return;
    const snap = this.snapshot();
    if (snap.key === this.history[this.hIndex].key) return;
    const dropped = this.history.splice(this.hIndex + 1); // „Wiederholen“-Zweig verwerfen
    this.history.push(snap);
    while (this.history.length > 60) dropped.push(this.history.shift()!);
    this.hIndex = this.history.length - 1;
    this.freeGeometries(dropped);
  }

  /** Gibt Geometrien frei, die weder im Verlauf noch auf der Platte vorkommen. */
  private freeGeometries(dropped: Snap[]) {
    if (!dropped.length) return;
    const used = new Set<THREE.BufferGeometry>(this.models.map((m) => m.geometry));
    for (const h of this.history) for (const i of h.items) used.add(i.geometry);
    for (const d of dropped) for (const i of d.items) if (!used.has(i.geometry)) i.geometry.dispose();
  }

  canUndo() {
    return this.hIndex > 0;
  }

  canRedo() {
    return this.hIndex < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo()) return;
    this.hIndex--;
    this.restore(this.history[this.hIndex]);
  }

  redo() {
    if (!this.canRedo()) return;
    this.hIndex++;
    this.restore(this.history[this.hIndex]);
  }

  private restore(snap: Snap) {
    this.restoring = true;
    const byId = new Map(this.models.map((m) => [m.userData.id as number, m]));
    const next: THREE.Mesh[] = [];
    for (const it of snap.items) {
      let m = byId.get(it.id);
      if (!m || m.geometry !== it.geometry) {
        if (m) {
          this.modelGroup.remove(m);
          (m.material as THREE.Material).dispose();
        }
        m = new THREE.Mesh(it.geometry, newModelMaterial());
        m.castShadow = true;
        m.userData.id = it.id;
        this.modelGroup.add(m);
      }
      m.name = it.name;
      if (m.userData.paint !== it.paint) {
        m.userData.paint = it.paint;
        updatePaintOverlay(m);
      }
      m.position.fromArray(it.p);
      m.quaternion.fromArray(it.q);
      m.scale.fromArray(it.s);
      m.updateMatrixWorld(true);
      next.push(m);
      byId.delete(it.id);
    }
    for (const m of byId.values()) {
      this.modelGroup.remove(m);
      (m.material as THREE.Material).dispose();
    }
    this.models = next;
    for (const m of [...this.selection]) if (!next.includes(m)) this.selection.delete(m);
    this.nextId = Math.max(this.nextId, ...next.map((m) => (m.userData.id as number) + 1));
    this.restoring = false;
    this.afterSelect();
  }

  // ------------------------------------------------------------------ Projekte

  /** Platte als Projektdaten (Modelle als binäre STL in Modellkoordinaten + Lage). */
  exportProject(): ProjectModel[] {
    return this.models.map((m) => ({
      name: m.name,
      stl: toBinaryStl(m.geometry.index ? m.geometry.toNonIndexed() : m.geometry),
      position: m.position.toArray() as [number, number, number],
      quaternion: m.quaternion.toArray() as [number, number, number, number],
      scale: m.scale.toArray() as [number, number, number],
      paint: (m.userData.paint as PaintData | undefined) ?? null,
    }));
  }

  /** Ersetzt die Platte durch ein gespeichertes Projekt (rückgängig machbar). */
  loadProject(models: ProjectModel[]) {
    for (const m of [...this.models]) {
      this.modelGroup.remove(m);
      (m.material as THREE.Material).dispose();
    }
    this.models = [];
    this.selection.clear();
    for (const pm of models) {
      const g = new STLLoader().parse(pm.stl.buffer.slice(pm.stl.byteOffset, pm.stl.byteOffset + pm.stl.byteLength) as ArrayBuffer);
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, newModelMaterial());
      m.name = pm.name;
      m.castShadow = true;
      m.userData.id = this.nextId++;
      if (pm.paint) {
        m.userData.paint = pm.paint;
        updatePaintOverlay(m);
      }
      m.position.fromArray(pm.position);
      m.quaternion.fromArray(pm.quaternion);
      m.scale.fromArray(pm.scale);
      this.modelGroup.add(m);
      this.models.push(m);
    }
    this.commit();
    this.afterSelect();
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  invalidate() {
    this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const moved = this.orbit.update();
    if ((this.dirty || moved) && this.host) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  private resize() {
    if (!this.host) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  resetView() {
    this.camera.position.set(BED.x / 2, BED.y / 2 - 300, 235);
    this.camera.lookAt(BED.x / 2, BED.y / 2, 10);
    if (this.orbit) {
      this.orbit.target.set(BED.x / 2, BED.y / 2, 10);
      this.orbit.update();
    }
    this.invalidate();
  }

  topView() {
    this.camera.position.set(BED.x / 2, BED.y / 2 - 0.01, 420);
    this.orbit.target.set(BED.x / 2, BED.y / 2, 0);
    this.orbit.update();
    this.invalidate();
  }

  // ------------------------------------------------------------------ Druckbett

  private buildBed() {
    // Originales Druckbett des Ender 3 V3 KE (Modell + Textur aus OrcaSlicer, AGPL-3.0).
    // Das Modell ist um die Bettmitte zentriert; die Oberfläche liegt bei z = 0.
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x232323, roughness: 0.6, metalness: 0.35 });
    void fetch(bedModelUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const geo = new STLLoader().parse(buf);
        geo.computeVertexNormals();
        const body = new THREE.Mesh(geo, bodyMat);
        body.position.set(BED.x / 2, BED.y / 2, -0.01);
        body.receiveShadow = true;
        body.name = "bed";
        this.scene.add(body);
        this.invalidate();
      })
      .catch(() => {
        /* Ohne Modell bleibt die Druckfläche trotzdem sichtbar */
      });

    // Druckfläche mit Körnung, Raster und den originalen Markierungen
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(BED.x, BED.y),
      new THREE.MeshStandardMaterial({ map: bedTopTexture(() => this.invalidate()), roughness: 0.85, metalness: 0.1 }),
    );
    (top.material as THREE.MeshStandardMaterial).map!.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    top.position.set(BED.x / 2, BED.y / 2, 0.01);
    top.receiveShadow = true;
    this.scene.add(top);

    // Nullpunkt-Markierung (vorne links), wie am Drucker
    const origin = new THREE.Mesh(new THREE.CircleGeometry(1.6, 24), new THREE.MeshBasicMaterial({ color: COLOR.selected }));
    origin.position.set(0, 0, 0.02);
    this.scene.add(origin);

    // Bauraum dezent andeuten
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BED.x, BED.y, BED.z)),
      new THREE.LineBasicMaterial({ color: COLOR.edge, transparent: true, opacity: 0.3 }),
    );
    box.position.set(BED.x / 2, BED.y / 2, BED.z / 2);
    this.scene.add(box);

    // Ruhiger Verlauf im Hintergrund
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#171717");
    grad.addColorStop(1, "#0b0b0b");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const bg = new THREE.CanvasTexture(c);
    bg.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = bg;
  }

  // ------------------------------------------------------------------ Modelle laden

  async addFile(name: string, data: ArrayBuffer): Promise<ModelInfo> {
    const ext = name.toLowerCase().split(".").pop();
    let geom: THREE.BufferGeometry;
    if (ext === "stl") {
      geom = new STLLoader().parse(data);
    } else if (ext === "obj") {
      geom = groupToGeometry(new OBJLoader().parse(new TextDecoder().decode(data)));
    } else if (ext === "3mf") {
      geom = groupToGeometry(new ThreeMFLoader().parse(data) as unknown as THREE.Object3D);
    } else {
      throw new Error(t("Dieses Dateiformat wird nicht unterstützt (STL, OBJ oder 3MF)."));
    }
    if (!geom.attributes.position || geom.attributes.position.count < 3) throw new Error(t("Die Datei enthält kein Modell."));
    geom = cleanGeometry(geom);

    const mesh = new THREE.Mesh(geom, newModelMaterial());
    mesh.name = name.replace(/\.(stl|obj|3mf)$/i, "");
    mesh.castShadow = true;
    mesh.userData.id = this.nextId++;
    // Viel zu große Modelle (z. B. in Zoll oder Metern exportiert) auf das Bett einpassen
    const size = new THREE.Vector3();
    geom.boundingBox!.getSize(size);
    const fit = Math.min((BED.x * 0.9) / size.x, (BED.y * 0.9) / size.y, (BED.z * 0.9) / size.z, 1);
    if (fit < 1) mesh.scale.setScalar(fit);
    if (Math.max(size.x, size.y, size.z) < 2) mesh.scale.setScalar(25.4); // vermutlich Zoll

    this.modelGroup.add(mesh);
    this.models.push(mesh);
    this.placeFree(mesh);
    this.select(mesh);
    this.changed();
    return this.info(mesh);
  }

  /** Neues Modell auf einen freien Platz setzen (sonst Mitte). */
  private placeFree(mesh: THREE.Mesh) {
    mesh.position.set(BED.x / 2, BED.y / 2, 0);
    mesh.position.z = this.zOffset(mesh);
    if (this.models.length > 1) this.arrange();
  }

  // ------------------------------------------------------------------ Auswahl & Werkzeuge

  setTool(tool: Tool) {
    this.tool = tool;
    if (tool !== "paint" && this.cursor) this.cursor.visible = false;
    if (tool !== "measure") this.clearMeasure();
    this.updateCutPlane();
    this.syncGizmo();
    this.emit();
  }

  getTool() {
    return this.tool;
  }

  private syncGizmo() {
    const transformTool = this.tool === "select" || this.tool === "move" || this.tool === "rotate" || this.tool === "scale";
    if (this.selection.size && transformTool && !this.preview) {
      const group = this.selection.size > 1;
      if (group) this.placePivot();
      this.gizmo.attach(group ? this.pivot : this.selected!);
      this.gizmo.setMode(this.tool === "rotate" ? "rotate" : this.tool === "scale" ? "scale" : "translate");
      this.gizmo.showZ = this.tool === "rotate" || this.tool === "scale";
      this.gizmo.setSpace(this.tool === "scale" && !group ? "local" : "world");
    } else {
      this.gizmo.detach();
    }
    // Wie auf dem Desktop: links auf freier Fläche zieht ein Auswahlrechteck auf,
    // gedreht wird mit rechts (Shift + rechts verschiebt), Alt + links dreht ebenfalls (Trackpad)
    this.orbit.mouseButtons = this.boxTool()
      ? { LEFT: NO_BUTTON, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : this.tool === "paint"
        ? { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
        : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.invalidate();
  }

  /** Drehpunkt in die Mitte der Auswahl (auf Bettebene) setzen. */
  private placePivot() {
    const box = new THREE.Box3();
    for (const m of this.selection) box.expandByObject(m, true);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    this.pivot.position.set(c.x, c.y, 0);
    this.pivot.quaternion.identity();
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
  }

  /** Überträgt die Bewegung des Drehpunkts auf alle ausgewählten Modelle. */
  private applyGroupTransform() {
    if (this.gizmo.getMode() === "scale") {
      // Gruppen nur gleichmäßig skalieren (sonst verzerren gedrehte Teile)
      const s = this.pivot.scale;
      const f = [s.x, s.y, s.z].reduce((a, v) => (Math.abs(v - 1) > Math.abs(a - 1) ? v : a), 1);
      s.setScalar(Math.max(0.01, f));
    }
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(this.pivotStart);
    for (const [m, start] of this.groupStart) {
      const mw = delta.clone().multiply(start);
      mw.decompose(m.position, m.quaternion, m.scale);
      if (this.gizmo.getMode() === "translate") m.position.z = this.zOffset(m);
      m.updateMatrixWorld(true);
    }
  }

  /** Auswahl ändern: ersetzen (Standard), hinzufügen oder umschalten. */
  select(mesh: THREE.Mesh | null, mode: "replace" | "add" | "toggle" = "replace") {
    if (mode === "replace") this.selection.clear();
    if (mesh) {
      if (mode === "toggle" && this.selection.has(mesh)) this.selection.delete(mesh);
      else this.selection.add(mesh);
    }
    this.afterSelect();
  }

  selectMany(meshes: THREE.Mesh[], add: boolean) {
    if (!add) this.selection.clear();
    meshes.forEach((m) => this.selection.add(m));
    this.afterSelect();
  }

  selectAll() {
    this.selectMany(this.models, false);
  }

  private afterSelect() {
    this.updateCutPlane();
    this.syncGizmo();
    this.updateColors();
    this.emit();
  }

  selectById(id: number) {
    this.select(this.models.find((m) => m.userData.id === id) ?? null);
  }

  /** Id des einen ausgewählten Modells (null bei keiner oder Mehrfachauswahl) */
  selectedId(): number | null {
    return this.selected?.userData.id ?? null;
  }

  selectedIds(): number[] {
    return [...this.selection].map((m) => m.userData.id);
  }

  /** Abmessungen der gesamten Auswahl */
  selectionSize(): [number, number, number] | null {
    if (!this.selection.size) return null;
    const box = new THREE.Box3();
    for (const m of this.selection) box.expandByObject(m, true);
    const s = box.getSize(new THREE.Vector3());
    return [s.x, s.y, s.z];
  }

  /** Auswahl gemeinsam um ihren Mittelpunkt skalieren (Faktor, z. B. 0.5 = halb so groß). */
  scaleSelection(f: number) {
    if (!this.selection.size || !(f > 0)) return;
    this.placePivot();
    const c = this.pivot.position;
    for (const m of this.selection) {
      m.position.x = c.x + (m.position.x - c.x) * f;
      m.position.y = c.y + (m.position.y - c.y) * f;
      m.scale.multiplyScalar(f);
      this.dropToBed(m);
    }
    this.placePivot();
    this.changed();
  }

  private down = { x: 0, y: 0 };
  private box: { el: HTMLDivElement; x: number; y: number; add: boolean } | null = null;

  /** Werkzeuge, in denen links ziehen auf freier Fläche ein Auswahlrechteck aufzieht */
  private boxTool() {
    return !this.preview && (this.tool === "select" || this.tool === "move" || this.tool === "rotate" || this.tool === "scale");
  }

  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || !this.host) return;
    // Alt + links dreht die Ansicht (läuft vor OrbitControls, daher hier umschalten)
    if (this.boxTool()) this.orbit.mouseButtons.LEFT = e.altKey ? THREE.MOUSE.ROTATE : NO_BUTTON;
    if (this.preview) return;
    if (this.tool === "paint") {
      this.startStroke(e);
      return;
    }
    if (e.altKey && this.boxTool()) return;
    if (!this.boxTool() && !e.shiftKey) return;
    if ((this.gizmo as unknown as { axis: string | null }).axis) return; // Griff des Gizmos
    if (this.pick(e)) return; // Klick auf ein Modell = auswählen (beim Loslassen)
    // Auswahlrechteck starten; die Ansicht bleibt dabei stehen
    this.orbit.enabled = false;
    const el = document.createElement("div");
    el.className = "select-box";
    this.host.appendChild(el);
    this.box = { el, x: e.clientX, y: e.clientY, add: e.shiftKey || e.ctrlKey || e.metaKey };
    window.addEventListener("pointermove", this.onBoxMove);
    window.addEventListener("pointerup", this.onBoxUp, { once: true });
  };

  private boxRect(e: PointerEvent) {
    const b = this.box!;
    return { x1: Math.min(b.x, e.clientX), y1: Math.min(b.y, e.clientY), x2: Math.max(b.x, e.clientX), y2: Math.max(b.y, e.clientY) };
  }

  private onBoxMove = (e: PointerEvent) => {
    if (!this.box || !this.host) return;
    const r = this.boxRect(e);
    const h = this.host.getBoundingClientRect();
    Object.assign(this.box.el.style, { left: `${r.x1 - h.left}px`, top: `${r.y1 - h.top}px`, width: `${r.x2 - r.x1}px`, height: `${r.y2 - r.y1}px` });
  };

  private onBoxUp = (e: PointerEvent) => {
    window.removeEventListener("pointermove", this.onBoxMove);
    const b = this.box;
    this.box = null;
    this.orbit.enabled = true;
    if (!b) return;
    b.el.remove();
    const r = { x1: Math.min(b.x, e.clientX), y1: Math.min(b.y, e.clientY), x2: Math.max(b.x, e.clientX), y2: Math.max(b.y, e.clientY) };
    if (r.x2 - r.x1 < 4 && r.y2 - r.y1 < 4) {
      // nur geklickt: auf leere Fläche → Auswahl aufheben, sonst Modell wählen
      const hit = this.pick(e);
      if (hit) this.select(hit.object as THREE.Mesh, b.add ? "toggle" : "replace");
      else if (!b.add) this.select(null);
      return;
    }
    // Alle Modelle, deren Umriss auf dem Bildschirm das Rechteck berührt
    const canvas = this.renderer.domElement.getBoundingClientRect();
    const hits = this.models.filter((m) => {
      const bb = new THREE.Box3().setFromObject(m, true);
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let i = 0; i < 8; i++) {
        const p = new THREE.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).project(this.camera);
        const sx = canvas.left + ((p.x + 1) / 2) * canvas.width;
        const sy = canvas.top + ((1 - p.y) / 2) * canvas.height;
        x1 = Math.min(x1, sx); y1 = Math.min(y1, sy); x2 = Math.max(x2, sx); y2 = Math.max(y2, sy);
      }
      return x2 >= r.x1 && x1 <= r.x2 && y2 >= r.y1 && y1 <= r.y2;
    });
    this.selectMany(hits, b.add);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || this.preview || this.box || this.tool === "paint") return;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return; // war ein Drehen der Ansicht
    if ((this.gizmo as unknown as { dragging: boolean }).dragging) return;
    if (this.tool === "measure") {
      this.addMeasurePoint(e);
      return;
    }
    const hit = this.pick(e);
    if (this.tool === "layflat" && hit?.face) {
      this.layFlat(hit.object as THREE.Mesh, hit.face.normal);
      return;
    }
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit) this.select(hit.object as THREE.Mesh, multi ? "toggle" : "replace");
    else if (!multi && !(this.gizmo as unknown as { axis: string | null }).axis) this.select(null);
  };

  private pick(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.intersectObjects(this.models, false)[0] ?? null;
  }

  /** Dreht das Modell so, dass die angeklickte Fläche auf dem Bett liegt. */
  private layFlat(mesh: THREE.Mesh, localNormal: THREE.Vector3) {
    const n = localNormal.clone().transformDirection(mesh.matrixWorld).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
    mesh.quaternion.premultiply(q);
    this.dropToBed(mesh);
    this.select(mesh);
    this.tool = "move";
    this.syncGizmo();
    this.changed();
  }

  // ------------------------------------------------------------------ Stützen & Naht malen

  private brush = { channel: "support" as PaintChannel, value: 1, radius: 3 };
  private stroke: { mesh: THREE.Mesh; centroids: Float32Array; normals: Float32Array } | null = null;
  private cursor: THREE.Mesh | null = null;

  setBrush(b: Partial<{ channel: PaintChannel; value: number; radius: number }>) {
    Object.assign(this.brush, b);
    this.emit();
  }

  getBrush() {
    return { ...this.brush };
  }

  /** Anzahl gemalter Dreiecke des ausgewählten Modells je Art (für Hinweise in der Oberfläche) */
  paintStats(): { supportEnforce: number; supportBlock: number; seamEnforce: number; seamBlock: number } {
    const r = { supportEnforce: 0, supportBlock: 0, seamEnforce: 0, seamBlock: 0 };
    for (const m of this.models) {
      const p = m.userData.paint as PaintData | undefined;
      p?.support?.forEach((v) => (v === 1 ? r.supportEnforce++ : v === 2 ? r.supportBlock++ : 0));
      p?.seam?.forEach((v) => (v === 1 ? r.seamEnforce++ : v === 2 ? r.seamBlock++ : 0));
    }
    return r;
  }

  /** Löscht die gemalten Bereiche einer Art am ausgewählten Modell. */
  clearPaint(channel: PaintChannel) {
    const m = this.selected;
    const p = m?.userData.paint as PaintData | undefined;
    if (!m || !p?.[channel]) return;
    m.userData.paint = { ...p, [channel]: undefined };
    updatePaintOverlay(m);
    this.changed();
  }

  private startStroke(e: PointerEvent) {
    const hit = this.pick(e);
    if (!hit) return; // auf leere Fläche: Ansicht drehen wie gewohnt
    const mesh = hit.object as THREE.Mesh;
    if (this.selected !== mesh) this.select(mesh);
    this.orbit.enabled = false;
    refineForPaint(mesh);
    // Weltkoordinaten der Dreiecksmitten und -normalen einmal je Strich berechnen
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry.attributes.position;
    const n = pos.count / 3;
    const centroids = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), t = new THREE.Vector3();
    const flip = mesh.matrixWorld.determinant() < 0 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      a.fromBufferAttribute(pos, i * 3).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i * 3 + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i * 3 + 2).applyMatrix4(mesh.matrixWorld);
      centroids.set([(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3], i * 3);
      t.subVectors(c, b).cross(a.clone().sub(b)).normalize().multiplyScalar(flip);
      normals.set([t.x, t.y, t.z], i * 3);
    }
    // Copy-on-write: der Verlauf behält die alte Fassung
    const old = (mesh.userData.paint as PaintData | undefined) ?? {};
    const ch = this.brush.channel;
    const arr = old[ch] ? new Uint8Array(old[ch]!) : new Uint8Array(n);
    mesh.userData.paint = { ...old, [ch]: arr };
    this.stroke = { mesh, centroids, normals };
    this.paintAt(hit.point);
    window.addEventListener("pointermove", this.onStrokeMove);
    window.addEventListener("pointerup", this.onStrokeEnd, { once: true });
  }

  private onStrokeMove = (e: PointerEvent) => {
    if (!this.stroke) return;
    const hit = this.pick(e);
    if (hit && hit.object === this.stroke.mesh) this.paintAt(hit.point);
  };

  private onStrokeEnd = () => {
    window.removeEventListener("pointermove", this.onStrokeMove);
    this.stroke = null;
    this.orbit.enabled = true;
    this.changed();
  };

  private paintAt(p: THREE.Vector3) {
    const s = this.stroke!;
    const arr = (s.mesh.userData.paint as PaintData)[this.brush.channel]!;
    const r2 = this.brush.radius * this.brush.radius;
    const view = new THREE.Vector3().subVectors(this.camera.position, p);
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      const dx = s.centroids[i * 3] - p.x, dy = s.centroids[i * 3 + 1] - p.y, dz = s.centroids[i * 3 + 2] - p.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      // nur zur Kamera zeigende Flächen (sonst malt man durch das Modell hindurch)
      if (s.normals[i * 3] * view.x + s.normals[i * 3 + 1] * view.y + s.normals[i * 3 + 2] * view.z < 0) continue;
      if (arr[i] !== this.brush.value) {
        arr[i] = this.brush.value;
        changed = true;
      }
    }
    if (changed) {
      (s.mesh.userData.paint as PaintData & { v?: number }).v = (paintCounter += 1);
      updatePaintOverlay(s.mesh);
      this.invalidate();
    }
  }

  /** Pinselkreis unter dem Mauszeiger (nur im Mal-Werkzeug). */
  private onHover = (e: PointerEvent) => {
    if (this.tool !== "paint" || this.preview) {
      if (this.cursor?.visible) {
        this.cursor.visible = false;
        this.invalidate();
      }
      return;
    }
    const hit = this.pick(e);
    if (!this.cursor) {
      this.cursor = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 48),
        new THREE.MeshBasicMaterial({ color: 0xf5f4ef, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }),
      );
      this.cursor.renderOrder = 20;
      this.scene.add(this.cursor);
    }
    this.cursor.visible = !!hit?.face;
    if (hit?.face) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      this.cursor.position.copy(hit.point).addScaledVector(n, 0.05);
      this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      this.cursor.scale.setScalar(this.brush.radius);
    }
    this.invalidate();
  };

  // ------------------------------------------------------------------ Spiegeln, Ausrichten

  mirror(axis: 0 | 1 | 2) {
    for (const m of this.selection) {
      m.scale.setComponent(axis, -m.scale.getComponent(axis));
      this.dropToBed(m);
    }
    this.placePivot();
    this.changed();
  }

  /**
   * Automatisch ausrichten: probiert die Ausrichtungen der größten ebenen Flächen
   * (und die sechs Achsrichtungen) und wählt die mit der größten Auflagefläche
   * und der kleinsten Überhangfläche.
   */
  autoOrient() {
    for (const m of [...this.selection]) this.autoOrientOne(m);
    this.placePivot();
    this.changed();
  }

  private autoOrientOne(m: THREE.Mesh) {
    m.updateMatrixWorld(true);
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const pos = g.attributes.position;
    const tris = pos.count / 3;
    const scaleM = new THREE.Matrix4().makeScale(m.scale.x, m.scale.y, m.scale.z);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
    // Dreiecke in Modellkoordinaten (mit Skalierung, ohne Drehung)
    const P = new Float32Array(tris * 9);
    const N = new Float32Array(tris * 3);
    const A = new Float32Array(tris);
    const buckets = new Map<string, { n: THREE.Vector3; area: number }>();
    for (let i = 0; i < tris; i++) {
      a.fromBufferAttribute(pos, i * 3).applyMatrix4(scaleM);
      b.fromBufferAttribute(pos, i * 3 + 1).applyMatrix4(scaleM);
      c.fromBufferAttribute(pos, i * 3 + 2).applyMatrix4(scaleM);
      n.subVectors(c, b).cross(t.subVectors(a, b));
      const area = n.length() / 2;
      if (area < 1e-9) continue;
      n.normalize();
      P.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], i * 9);
      N.set([n.x, n.y, n.z], i * 3);
      A[i] = area;
      const key = `${Math.round(n.x * 20)},${Math.round(n.y * 20)},${Math.round(n.z * 20)}`;
      const e = buckets.get(key);
      if (e) {
        e.n.addScaledVector(n, area);
        e.area += area;
      } else buckets.set(key, { n: n.clone().multiplyScalar(area), area });
    }
    const candidates = [...buckets.values()]
      .sort((x, y) => y.area - x.area)
      .slice(0, 24)
      .map((e) => e.n.clone().normalize());
    for (const v of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) candidates.push(new THREE.Vector3(...v));

    const down = new THREE.Vector3(0, 0, -1);
    let best: { q: THREE.Quaternion; score: number } | null = null;
    const v = new THREE.Vector3();
    for (const cand of candidates) {
      const q = new THREE.Quaternion().setFromUnitVectors(cand, down);
      let minZ = Infinity;
      for (let i = 0; i < tris * 3; i++) {
        v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyQuaternion(q);
        if (v.z < minZ) minZ = v.z;
      }
      let contact = 0, overhang = 0, height = -Infinity;
      for (let i = 0; i < tris; i++) {
        if (!A[i]) continue;
        n.set(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]).applyQuaternion(q);
        let zmax = -Infinity, zmin = Infinity;
        for (let k = 0; k < 3; k++) {
          v.set(P[i * 9 + k * 3], P[i * 9 + k * 3 + 1], P[i * 9 + k * 3 + 2]).applyQuaternion(q);
          zmax = Math.max(zmax, v.z);
          zmin = Math.min(zmin, v.z);
        }
        height = Math.max(height, zmax - minZ);
        if (zmax - minZ < 0.15 && n.z < -0.95) contact += A[i];
        else if (n.z < -0.707 && zmin - minZ > 0.3) overhang += A[i] * (-n.z);
      }
      const score = contact * 1.0 - overhang * 0.6 - height * 0.02;
      if (!best || score > best.score) best = { q, score };
    }
    if (g !== m.geometry) g.dispose();
    if (best) {
      m.quaternion.copy(best.q);
      this.dropToBed(m);
    }
  }

  // ------------------------------------------------------------------ Schneiden

  private cutHeight = 10;
  private cutPlane: THREE.Mesh | null = null;

  getCutHeight() {
    return this.cutHeight;
  }

  setCutHeight(h: number) {
    this.cutHeight = h;
    this.updateCutPlane();
    this.emit();
  }

  private updateCutPlane() {
    const m = this.selected;
    if (this.tool !== "cut" || !m) {
      if (this.cutPlane) this.cutPlane.visible = false;
      this.invalidate();
      return;
    }
    if (!this.cutPlane) {
      this.cutPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: COLOR.selected, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.scene.add(this.cutPlane);
    }
    const box = new THREE.Box3().setFromObject(m, true);
    this.cutHeight = Math.min(Math.max(this.cutHeight, 0.2), Math.max(0.2, box.max.z - 0.2));
    this.cutPlane.visible = true;
    this.cutPlane.scale.set(box.max.x - box.min.x + 20, box.max.y - box.min.y + 20, 1);
    this.cutPlane.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, this.cutHeight);
    this.invalidate();
  }

  /** Höhe des ausgewählten Modells (für den Schnitt-Regler). */
  selectedHeight() {
    if (!this.selected) return 0;
    return new THREE.Box3().setFromObject(this.selected, true).max.z;
  }

  /** Schneidet das ausgewählte Modell waagerecht bei `cutHeight`. */
  cut(keep: "both" | "upper" | "lower", flipUpper: boolean): string | null {
    const m = this.selected;
    if (!m) return null;
    m.updateMatrixWorld(true);
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()) as THREE.BufferGeometry;
    g.applyMatrix4(m.matrixWorld);
    if (m.matrixWorld.determinant() < 0) flipWinding(g);
    const { lower, upper } = splitAtZ(g, this.cutHeight);
    g.dispose();
    if (!lower || !upper) return t("An dieser Höhe gibt es nichts zu schneiden.");
    const baseName = m.name;
    const color = (m.material as THREE.MeshStandardMaterial).clone();
    // Original entfernen, ohne Zwischenschritt im Verlauf
    this.models = this.models.filter((x) => x !== m);
    this.modelGroup.remove(m);
    this.selection.delete(m);
    const add = (geom: THREE.BufferGeometry, suffix: string, flip: boolean) => {
      if (flip) geom.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
      const mesh = new THREE.Mesh(cleanGeometry(geom), color.clone());
      mesh.name = `${baseName} ${suffix}`;
      mesh.castShadow = true;
      mesh.userData.id = this.nextId++;
      this.modelGroup.add(mesh);
      this.models.push(mesh);
      mesh.position.set(BED.x / 2, BED.y / 2, 0);
      this.dropToBed(mesh);
      return mesh;
    };
    let last: THREE.Mesh | null = null;
    if (keep !== "upper") last = add(lower, t("(unten)"), false);
    if (keep !== "lower") last = add(upper, t("(oben)"), flipUpper);
    else upper.dispose();
    if (keep === "upper") lower.dispose();
    this.arrange();
    this.tool = "move";
    this.select(last);
    this.updateCutPlane();
    return null;
  }

  // ------------------------------------------------------------------ Messen

  private measurePts: THREE.Vector3[] = [];
  private measureObj = new THREE.Group();

  getMeasure(): Measure {
    const [a, b] = this.measurePts;
    if (a && b) {
      const d = b.clone().sub(a);
      return { points: this.measurePts, distance: d.length(), delta: [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)] };
    }
    return { points: this.measurePts, distance: null, delta: null };
  }

  clearMeasure() {
    this.measurePts = [];
    this.measureObj.clear();
    this.invalidate();
  }

  private addMeasurePoint(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    let p = ray.intersectObjects(this.models, false)[0]?.point ?? null;
    if (!p) {
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit)) p = hit;
    }
    if (!p) return;
    if (this.measurePts.length >= 2) this.clearMeasure();
    this.measurePts.push(p.clone());
    if (!this.measureObj.parent) this.scene.add(this.measureObj);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xf5f4ef, depthTest: false }));
    dot.renderOrder = 10;
    dot.position.copy(p);
    this.measureObj.add(dot);
    if (this.measurePts.length === 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(this.measurePts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COLOR.selected, depthTest: false }));
      line.renderOrder = 10;
      this.measureObj.add(line);
    }
    this.invalidate();
    this.emit();
  }

  // ------------------------------------------------------------------ Transformationen

  private zOffset(mesh: THREE.Mesh) {
    mesh.position.z = 0;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh, true);
    return -box.min.z;
  }

  dropToBed(mesh: THREE.Mesh) {
    mesh.position.z = this.zOffset(mesh);
    mesh.updateMatrixWorld(true);
    this.updateColors();
    this.invalidate();
  }

  setPosition(x: number, y: number) {
    if (!this.selected) return;
    this.selected.position.x = x;
    this.selected.position.y = y;
    this.dropToBed(this.selected);
    this.changed();
  }

  setRotation(deg: [number, number, number]) {
    if (!this.selected) return;
    this.selected.rotation.set(...(deg.map(THREE.MathUtils.degToRad) as [number, number, number]), "XYZ");
    this.dropToBed(this.selected);
    this.changed();
  }

  rotateBy(axis: "x" | "y" | "z", deg: number) {
    if (!this.selected) return;
    const a = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    this.selected.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(a, THREE.MathUtils.degToRad(deg)));
    this.dropToBed(this.selected);
    this.changed();
  }

  setScale(s: [number, number, number]) {
    if (!this.selected) return;
    this.selected.scale.set(...s.map((v) => Math.max(0.001, v)) as [number, number, number]);
    this.dropToBed(this.selected);
    this.changed();
  }

  /** Setzt die Größe in mm (gleichmäßig, wenn `uniform`). */
  setSize(axis: 0 | 1 | 2, mm: number, uniform: boolean) {
    if (!this.selected || !(mm > 0)) return;
    const cur = this.info(this.selected).size[axis];
    if (!cur) return;
    const f = mm / cur;
    const s = this.selected.scale;
    if (uniform) s.multiplyScalar(f);
    else s.setComponent(axis, s.getComponent(axis) * f);
    this.dropToBed(this.selected);
    this.changed();
  }

  /** Löscht das Modell mit `id` – ohne id alle ausgewählten. */
  remove(id?: number) {
    const list = id != null ? this.models.filter((x) => x.userData.id === id) : [...this.selection];
    if (!list.length) return;
    for (const m of list) {
      this.models = this.models.filter((x) => x !== m);
      this.modelGroup.remove(m);
      // Geometrie bleibt für „Rückgängig“ erhalten (wird beim Kürzen des Verlaufs freigegeben)
      (m.material as THREE.Material).dispose();
      this.selection.delete(m);
    }
    this.commit();
    this.afterSelect();
  }

  clear() {
    this.selection = new Set(this.models);
    this.remove();
  }

  duplicate() {
    const copies: THREE.Mesh[] = [];
    for (const m of this.selection) {
      const c = new THREE.Mesh(m.geometry.clone(), (m.material as THREE.Material).clone());
      c.name = m.name;
      c.castShadow = true;
      c.userData.id = this.nextId++;
      c.position.copy(m.position);
      c.quaternion.copy(m.quaternion);
      c.scale.copy(m.scale);
      if (m.userData.paint) {
        c.userData.paint = m.userData.paint; // unverändert geteilt; Malen kopiert vorher (copy-on-write)
        updatePaintOverlay(c);
      }
      this.modelGroup.add(c);
      this.models.push(c);
      copies.push(c);
    }
    if (!copies.length) return;
    this.arrange();
    this.selectMany(copies, false);
  }

  /** Einfache Regal-Anordnung, mittig auf dem Bett, 6 mm Abstand. */
  arrange() {
    const gap = 6;
    const items = this.models
      .map((m) => {
        m.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(m, true);
        return { m, b, w: b.max.x - b.min.x, d: b.max.y - b.min.y };
      })
      .sort((a, b) => b.d - a.d);
    const rows: { items: typeof items; w: number; d: number }[] = [];
    for (const it of items) {
      const row = rows.find((r) => r.w + gap + it.w <= BED.x);
      if (row) {
        row.items.push(it);
        row.w += gap + it.w;
        row.d = Math.max(row.d, it.d);
      } else rows.push({ items: [it], w: it.w, d: it.d });
    }
    const totalD = rows.reduce((s, r) => s + r.d, 0) + gap * (rows.length - 1);
    let y = BED.y / 2 + totalD / 2;
    for (const r of rows) {
      let x = BED.x / 2 - r.w / 2;
      for (const it of r.items) {
        const cx = (it.b.min.x + it.b.max.x) / 2 - it.m.position.x;
        const cy = (it.b.min.y + it.b.max.y) / 2 - it.m.position.y;
        it.m.position.x = x + it.w / 2 - cx;
        it.m.position.y = y - r.d / 2 - cy;
        x += it.w + gap;
      }
      y -= r.d + gap;
    }
    this.models.forEach((m) => this.dropToBed(m));
    this.changed();
  }

  // ------------------------------------------------------------------ Zustand

  private updateColors() {
    for (const m of this.models) {
      const mat = m.material as THREE.MeshStandardMaterial;
      const outside = this.isOutside(m);
      mat.color.setHex(outside ? COLOR.outside : this.selection.has(m) ? COLOR.selected : COLOR.model);
    }
    this.invalidate();
  }

  private isOutside(m: THREE.Mesh) {
    m.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(m, true);
    const e = 0.01;
    return b.min.x < -e || b.min.y < -e || b.max.x > BED.x + e || b.max.y > BED.y + e || b.max.z > BED.z + e;
  }

  info(m: THREE.Mesh): ModelInfo {
    m.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(m, true);
    const size = new THREE.Vector3();
    b.getSize(size);
    const r = new THREE.Euler().setFromQuaternion(m.quaternion, "XYZ");
    return {
      id: m.userData.id,
      name: m.name,
      size: [size.x, size.y, size.z],
      position: [m.position.x, m.position.y, m.position.z],
      rotation: [r.x, r.y, r.z].map((v) => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10) as [number, number, number],
      scale: [m.scale.x, m.scale.y, m.scale.z],
      triangles: (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3,
      outside: this.isOutside(m),
    };
  }

  list(): ModelInfo[] {
    return this.models.map((m) => this.info(m));
  }

  get count() {
    return this.models.length;
  }

  // ------------------------------------------------------------------ Export

  /** Jedes Modell als binäre STL in Bettkoordinaten (für Orca mit --arrange 0). */
  exportStls(): { name: string; data: Uint8Array; support?: Uint8Array; seam?: Uint8Array }[] {
    return this.models.map((m) => {
      const paint = m.userData.paint as PaintData | undefined;
      m.updateMatrixWorld(true);
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      // Gespiegelte Modelle: Dreiecksreihenfolge umdrehen, sonst zeigen die Flächen nach innen
      if (m.matrixWorld.determinant() < 0) flipWinding(g);
      const data = toBinaryStl(g);
      g.dispose();
      const used = (a?: Uint8Array) => (a && a.some((v) => v !== 0) ? a : undefined);
      return { name: m.name, data, support: used(paint?.support), seam: used(paint?.seam) };
    });
  }

  /** Vorschaubilder (PNG, transparent) für das Druckerdisplay. */
  thumbnails(sizes: number[]): { size: string; png: string }[] {
    if (!this.models.length) return [];
    const box = new THREE.Box3();
    this.models.forEach((m) => box.expandByObject(m, true));
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
    const dir = new THREE.Vector3(-0.6, -1, 0.85).normalize();
    cam.position.copy(center).addScaledVector(dir, radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05);
    cam.lookAt(center);

    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.8));
    const l = new THREE.DirectionalLight(0xffffff, 1.6);
    l.position.copy(cam.position).add(new THREE.Vector3(-100, 0, 200));
    scene.add(l);
    for (const m of this.models) {
      const c = new THREE.Mesh(m.geometry, new THREE.MeshStandardMaterial({ color: COLOR.selected, roughness: 0.5 }));
      c.matrixAutoUpdate = false;
      c.matrix.copy(m.matrixWorld);
      scene.add(c);
    }
    const out = sizes.map((s) => {
      r.setSize(s, s, false);
      r.setClearColor(0x000000, 0);
      r.render(scene, cam);
      const url = r.domElement.toDataURL("image/png");
      return { size: `${s}x${s}`, png: url.slice(url.indexOf(",") + 1) };
    });
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) ((o as THREE.Mesh).material as THREE.Material).dispose();
    });
    r.dispose();
    r.forceContextLoss();
    return out;
  }

  // ------------------------------------------------------------------ G-Code-Vorschau

  showPreview(p: GcodePreview | null) {
    if (this.preview) this.scene.remove(this.preview.object);
    this.preview = p;
    this.modelGroup.visible = !p;
    if (p) this.scene.add(p.object);
    this.syncGizmo();
    this.invalidate();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unmount();
    this.renderer.dispose();
  }
}

function groupToGeometry(root: THREE.Object3D): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return;
    const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()) as THREE.BufferGeometry;
    for (const k of Object.keys(g.attributes)) if (k !== "position") g.deleteAttribute(k);
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
  });
  if (!parts.length) throw new Error(t("Die Datei enthält kein Modell."));
  return parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;
}

/** Ursprung unten mittig, Normalen berechnen, nur Positionen behalten. */
function cleanGeometry(g: THREE.BufferGeometry) {
  // Ein Dreieck je drei Eckpunkte (nötig fürs Malen: Index = Dreiecksnummer)
  if (g.index) g = g.toNonIndexed();
  // Normalen immer neu berechnen – viele STL-Dateien enthalten nur Nullvektoren
  for (const k of Object.keys(g.attributes)) if (k !== "position") g.deleteAttribute(k);
  g.computeBoundingBox();
  const b = g.boundingBox!;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function toBinaryStl(g: THREE.BufferGeometry): Uint8Array {
  const pos = g.attributes.position;
  const tris = Math.floor(pos.count / 3);
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  let o = 84;
  for (let i = 0; i < tris; i++) {
    a.fromBufferAttribute(pos, i * 3);
    b.fromBufferAttribute(pos, i * 3 + 1);
    c.fromBufferAttribute(pos, i * 3 + 2);
    n.subVectors(c, b).cross(t.subVectors(a, b)).normalize();
    for (const v of [n, a, b, c]) {
      dv.setFloat32(o, v.x, true);
      dv.setFloat32(o + 4, v.y, true);
      dv.setFloat32(o + 8, v.z, true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

/** Druckfläche 220 × 220 mm: PEI-Körnung, dezentes Raster und die originalen KE-Markierungen. */
function bedTopTexture(onReady: () => void): THREE.CanvasTexture {
  const ppm = 10; // Pixel pro Millimeter
  const c = document.createElement("canvas");
  c.width = c.height = 220 * ppm;
  const g = c.getContext("2d")!;

  g.fillStyle = "#1c1c1c";
  g.fillRect(0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // Raster: 10 mm fein, 50 mm kräftiger (Canvas-Y zeigt nach unten → von hinten nach vorne)
  for (let v = 0; v <= 220; v += 10) {
    const major = v % 50 === 0;
    g.strokeStyle = major ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.04)";
    g.lineWidth = major ? 2 : 1.5;
    g.beginPath();
    g.moveTo(v * ppm, 0);
    g.lineTo(v * ppm, c.height);
    g.moveTo(0, c.height - v * ppm);
    g.lineTo(c.width, c.height - v * ppm);
    g.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;

  // Originale Markierungen (SVG 220 × 220, gleiche Ausrichtung wie das Bett)
  const svg = new Image();
  svg.onload = () => {
    g.globalAlpha = 0.85;
    g.drawImage(svg, 0, 0, c.width, c.height);
    g.globalAlpha = 1;
    t.needsUpdate = true;
    onReady();
  };
  svg.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(bedTextureSvg);
  return t;
}

function flipWinding(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i += 3) {
    const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1);
    p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    p.setXYZ(i + 2, x, y, z);
  }
  p.needsUpdate = true;
}

/**
 * Teilt ein (nicht indiziertes) Dreiecksnetz an der Ebene z = h und schließt beide
 * Schnittflächen mit Deckeln. Liefert null für eine Seite, wenn dort nichts liegt.
 */
export function splitAtZ(g: THREE.BufferGeometry, h: number): { lower: THREE.BufferGeometry | null; upper: THREE.BufferGeometry | null } {
  const pos = g.attributes.position;
  const lo: number[] = [];
  const up: number[] = [];
  const segs: [THREE.Vector3, THREE.Vector3][] = [];
  const eps = 1e-6;
  const V = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const lerp = (a: THREE.Vector3, b: THREE.Vector3) => {
    const t = (h - a.z) / (b.z - a.z);
    return new THREE.Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, h);
  };
  const push = (arr: number[], ...vs: THREE.Vector3[]) => vs.forEach((v) => arr.push(v.x, v.y, v.z));

  for (let i = 0; i < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      V[k].fromBufferAttribute(pos, i + k);
      if (Math.abs(V[k].z - h) < eps) V[k].z = h + eps; // Ecken genau auf der Ebene leicht anheben
    }
    const above = V.map((v) => v.z > h);
    const n = above.filter(Boolean).length;
    if (n === 0) { push(lo, V[0], V[1], V[2]); continue; }
    if (n === 3) { push(up, V[0], V[1], V[2]); continue; }
    // Die einzelne Ecke auf der anderen Seite finden, Reihenfolge (Umlaufsinn) beibehalten
    const single = n === 1 ? above.indexOf(true) : above.indexOf(false);
    const a = V[single], b = V[(single + 1) % 3], c = V[(single + 2) % 3];
    const ab = lerp(a, b), ac = lerp(a, c);
    const lonely = n === 1 ? up : lo;
    const pair = n === 1 ? lo : up;
    push(lonely, a, ab, ac);
    push(pair, ab, b, c, ab, c, ac);
    // Schnittkante – so orientiert, dass der Deckel der unteren Hälfte nach oben zeigt
    segs.push(n === 1 ? [ab, ac] : [ac, ab]);
  }
  if (!lo.length || !up.length || !segs.length) return { lower: null, upper: null };

  // Kanten zu geschlossenen Schleifen verketten
  const key = (v: THREE.Vector3) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)}`;
  const next = new Map<string, [THREE.Vector3, THREE.Vector3][]>();
  for (const s of segs) {
    const k = key(s[0]);
    if (!next.has(k)) next.set(k, []);
    next.get(k)!.push(s);
  }
  const used = new Set<[THREE.Vector3, THREE.Vector3]>();
  const loops: THREE.Vector2[][] = [];
  for (const s of segs) {
    if (used.has(s)) continue;
    const loop: THREE.Vector2[] = [];
    let cur = s;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(new THREE.Vector2(cur[0].x, cur[0].y));
      const cands = next.get(key(cur[1])) ?? [];
      cur = cands.find((c) => !used.has(c))!;
    }
    if (loop.length >= 3) loops.push(loop);
  }

  // Außenkonturen und Löcher bestimmen (Verschachtelungstiefe)
  const inside = (p: THREE.Vector2, poly: THREE.Vector2[]) => {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
    }
    return r;
  };
  const depth = loops.map((l, i) => loops.filter((o, j) => j !== i && inside(l[0], o)).length);
  const capTop: number[] = [];
  loops.forEach((outer, i) => {
    if (depth[i] % 2 === 1) return;
    const holes = loops.filter((h2, j) => depth[j] === depth[i] + 1 && inside(h2[0], outer));
    const o = THREE.ShapeUtils.isClockWise(outer) ? [...outer].reverse() : outer;
    const hs = holes.map((hh) => (THREE.ShapeUtils.isClockWise(hh) ? hh : [...hh].reverse()));
    const all = [...o, ...hs.flat()];
    for (const [x, y, z] of THREE.ShapeUtils.triangulateShape(o, hs)) {
      // Deckeldreiecke immer gegen den Uhrzeigersinn (Normale +Z), unabhängig vom Triangulierer
      const [p, q, r] = [all[x], all[y], all[z]];
      const ccw = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) > 0;
      const [b, c] = ccw ? [q, r] : [r, q];
      capTop.push(p.x, p.y, h, b.x, b.y, h, c.x, c.y, h);
    }
  });
  // Deckel: nach oben zeigend für die untere Hälfte, umgedreht für die obere
  for (let i = 0; i < capTop.length; i += 9) {
    lo.push(...capTop.slice(i, i + 9));
    up.push(...capTop.slice(i, i + 3), ...capTop.slice(i + 6, i + 9), ...capTop.slice(i + 3, i + 6));
  }
  const mk = (arr: number[]) => {
    const b = new THREE.BufferGeometry();
    b.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    return b;
  };
  return { lower: mk(lo), upper: mk(up) };
}

function newModelMaterial() {
  return new THREE.MeshStandardMaterial({ color: COLOR.model, roughness: 0.55, metalness: 0.05 });
}

let paintCounter = 0;
function paintVersion(p: PaintData | undefined): number {
  return p ? ((p as PaintData & { v?: number }).v ?? 0.5) : 0;
}

const PAINT_COLORS: Record<string, [number, number, number]> = {
  "support-1": [0.3, 0.69, 0.48], // erzwingen: grün
  "support-2": [0.88, 0.35, 0.31], // blockieren: rot
  "seam-1": [0.36, 0.55, 0.94], // Naht hier: blau
  "seam-2": [0.88, 0.64, 0.23], // Naht nicht hier: gelb
};

/** Zeigt die gemalten Dreiecke farbig über dem Modell (eigenes, leicht vorgezogenes Netz). */
function updatePaintOverlay(m: THREE.Mesh) {
  const old = m.children.find((c) => c.name === "paint") as THREE.Mesh | undefined;
  if (old) {
    m.remove(old);
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();
  }
  const p = m.userData.paint as PaintData | undefined;
  if (!p) return;
  const pos = m.geometry.attributes.position;
  const verts: number[] = [];
  const cols: number[] = [];
  const n = pos.count / 3;
  for (let i = 0; i < n; i++) {
    const key = p.seam?.[i] ? `seam-${p.seam[i]}` : p.support?.[i] ? `support-${p.support[i]}` : null;
    if (!key) continue;
    const c = PAINT_COLORS[key];
    for (let k = 0; k < 3; k++) {
      verts.push(pos.getX(i * 3 + k), pos.getY(i * 3 + k), pos.getZ(i * 3 + k));
      cols.push(c[0], c[1], c[2]);
    }
  }
  if (!verts.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  const overlay = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }),
  );
  overlay.name = "paint";
  overlay.raycast = () => {}; // nicht anklickbar
  m.add(overlay);
}

/** Feinheit beim Malen: größte Kantenlänge in mm und Obergrenze an Dreiecken. */
const PAINT_EDGE_MM = 1.5;
const PAINT_MAX_TRIS = 400_000;

/**
 * Unterteilt das Modell gleichmäßig (jedes Dreieck → 4), bis die Kanten fein genug zum Malen sind.
 * Gleichmäßig, damit keine T-Stöße entstehen – der Körper bleibt geschlossen. Bestehende
 * Bemalung wird auf die Teildreiecke übertragen.
 */
function refineForPaint(m: THREE.Mesh) {
  const scale = Math.max(Math.abs(m.scale.x), Math.abs(m.scale.y), Math.abs(m.scale.z));
  let g = m.geometry;
  let paint = m.userData.paint as PaintData | undefined;
  const maxEdge = (geo: THREE.BufferGeometry) => {
    const p = geo.attributes.position;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let mx = 0;
    for (let i = 0; i < p.count; i += 3)
      for (let k = 0; k < 3; k++) {
        a.fromBufferAttribute(p, i + k);
        b.fromBufferAttribute(p, i + ((k + 1) % 3));
        mx = Math.max(mx, a.distanceTo(b));
      }
    return mx * scale;
  };
  let changed = false;
  while (maxEdge(g) > PAINT_EDGE_MM && (g.attributes.position.count / 3) * 4 <= PAINT_MAX_TRIS) {
    const src = g.attributes.position.array as ArrayLike<number>;
    const n = src.length / 9;
    const out = new Float32Array(n * 36);
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const A = [src[o], src[o + 1], src[o + 2]], B = [src[o + 3], src[o + 4], src[o + 5]], C = [src[o + 6], src[o + 7], src[o + 8]];
      const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const AB = mid(A, B), BC = mid(B, C), CA = mid(C, A);
      const tris = [A, AB, CA, AB, B, BC, CA, BC, C, AB, BC, CA];
      for (let k = 0; k < 12; k++) out.set(tris[k], t * 36 + k * 3);
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", new THREE.BufferAttribute(out, 3));
    if (g !== m.geometry) g.dispose();
    g = ng;
    if (paint) {
      const spread = (a?: Uint8Array) => {
        if (!a) return undefined;
        const r = new Uint8Array(a.length * 4);
        for (let i = 0; i < a.length; i++) r.fill(a[i], i * 4, i * 4 + 4);
        return r;
      };
      paint = { support: spread(paint.support), seam: spread(paint.seam) };
    }
    changed = true;
  }
  if (!changed) return;
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  m.geometry = g; // alte Geometrie bleibt für „Rückgängig“ im Verlauf
  if (paint) m.userData.paint = paint;
  updatePaintOverlay(m);
}
