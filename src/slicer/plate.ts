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

export type Tool = "move" | "rotate" | "layflat" | null;

export class Plate {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private models: THREE.Mesh[] = [];
  private selected: THREE.Mesh | null = null;
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
      this.orbit.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value) {
        if (this.selected) this.dropToBed(this.selected);
        this.emit();
      }
    });
    this.gizmo.addEventListener("objectChange", () => {
      if (this.selected && this.gizmo.getMode() === "translate") this.selected.position.z = this.zOffset(this.selected);
      this.updateColors();
      this.invalidate();
      this.emit();
    });
    this.gizmo.addEventListener("change", () => this.invalidate());
    this.scene.add(this.gizmo.getHelper());

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
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
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
    // Platte mit abgerundeten Ecken und 4 mm Stärke; Oberkante liegt bei z = 0
    const margin = 6; // Rand der Federstahlplatte über den Druckbereich hinaus
    const w = BED.x + margin * 2;
    const d = BED.y + margin * 2;
    const r = 10;
    const shape = new THREE.Shape();
    shape.moveTo(-margin + r, -margin);
    shape.lineTo(-margin + w - r, -margin);
    shape.quadraticCurveTo(-margin + w, -margin, -margin + w, -margin + r);
    shape.lineTo(-margin + w, -margin + d - r);
    shape.quadraticCurveTo(-margin + w, -margin + d, -margin + w - r, -margin + d);
    shape.lineTo(-margin + r, -margin + d);
    shape.quadraticCurveTo(-margin, -margin + d, -margin, -margin + d - r);
    shape.lineTo(-margin, -margin + r);
    shape.quadraticCurveTo(-margin, -margin, -margin + r, -margin);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 3, curveSegments: 12 });
    geo.translate(0, 0, -4.6);

    // UVs der Oberseite auf die Plattenfläche abbilden (Textur deckt Rand + Druckbereich ab)
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + margin) / w, (pos.getY(i) + margin) / d);

    const top = new THREE.MeshStandardMaterial({ map: plateTexture(w, d, margin), roughness: 0.82, metalness: 0.15 });
    top.map!.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const side = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.45, metalness: 0.6 });
    const bed = new THREE.Mesh(geo, [top, side]);
    bed.receiveShadow = true;
    bed.name = "bed";
    this.scene.add(bed);

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
      throw new Error("Dieses Dateiformat wird nicht unterstützt (STL, OBJ oder 3MF).");
    }
    if (!geom.attributes.position || geom.attributes.position.count < 3) throw new Error("Die Datei enthält kein Modell.");
    geom = cleanGeometry(geom);

    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: COLOR.model, roughness: 0.55, metalness: 0.05, flatShading: false }));
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
    this.emit();
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
    this.syncGizmo();
  }

  getTool() {
    return this.tool;
  }

  private syncGizmo() {
    if (this.selected && (this.tool === "move" || this.tool === "rotate") && !this.preview) {
      this.gizmo.attach(this.selected);
      this.gizmo.setMode(this.tool === "move" ? "translate" : "rotate");
      this.gizmo.showZ = this.tool !== "move";
      this.gizmo.setSpace(this.tool === "rotate" ? "world" : "world");
    } else {
      this.gizmo.detach();
    }
    this.invalidate();
  }

  select(mesh: THREE.Mesh | null) {
    this.selected = mesh;
    this.syncGizmo();
    this.updateColors();
    this.emit();
  }

  selectById(id: number) {
    this.select(this.models.find((m) => m.userData.id === id) ?? null);
  }

  selectedId(): number | null {
    return this.selected?.userData.id ?? null;
  }

  private down = { x: 0, y: 0 };
  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };
  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || this.preview) return;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return; // war ein Drehen der Ansicht
    if ((this.gizmo as unknown as { dragging: boolean }).dragging) return;
    const hit = this.pick(e);
    if (this.tool === "layflat" && hit?.face) {
      this.layFlat(hit.object as THREE.Mesh, hit.face.normal);
      return;
    }
    if (hit) this.select(hit.object as THREE.Mesh);
    else if (!(this.gizmo as unknown as { axis: string | null }).axis) this.select(null);
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
    this.emit();
  }

  setRotation(deg: [number, number, number]) {
    if (!this.selected) return;
    this.selected.rotation.set(...(deg.map(THREE.MathUtils.degToRad) as [number, number, number]), "XYZ");
    this.dropToBed(this.selected);
    this.emit();
  }

  rotateBy(axis: "x" | "y" | "z", deg: number) {
    if (!this.selected) return;
    const a = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    this.selected.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(a, THREE.MathUtils.degToRad(deg)));
    this.dropToBed(this.selected);
    this.emit();
  }

  setScale(s: [number, number, number]) {
    if (!this.selected) return;
    this.selected.scale.set(...s.map((v) => Math.max(0.001, v)) as [number, number, number]);
    this.dropToBed(this.selected);
    this.emit();
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
    this.emit();
  }

  remove(id?: number) {
    const m = id != null ? this.models.find((x) => x.userData.id === id) : this.selected;
    if (!m) return;
    this.models = this.models.filter((x) => x !== m);
    this.modelGroup.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
    if (this.selected === m) this.select(null);
    this.invalidate();
    this.emit();
  }

  clear() {
    [...this.models].forEach((m) => this.remove(m.userData.id));
  }

  duplicate() {
    const m = this.selected;
    if (!m) return;
    const c = new THREE.Mesh(m.geometry.clone(), (m.material as THREE.Material).clone());
    c.name = m.name;
    c.castShadow = true;
    c.userData.id = this.nextId++;
    c.position.copy(m.position);
    c.quaternion.copy(m.quaternion);
    c.scale.copy(m.scale);
    this.modelGroup.add(c);
    this.models.push(c);
    this.arrange();
    this.select(c);
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
    this.emit();
  }

  // ------------------------------------------------------------------ Zustand

  private updateColors() {
    for (const m of this.models) {
      const mat = m.material as THREE.MeshStandardMaterial;
      const outside = this.isOutside(m);
      mat.color.setHex(outside ? COLOR.outside : m === this.selected ? COLOR.selected : COLOR.model);
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
  exportStls(): { name: string; data: Uint8Array }[] {
    return this.models.map((m) => {
      m.updateMatrixWorld(true);
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      const data = toBinaryStl(g);
      g.dispose();
      return { name: m.name, data };
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
  if (!parts.length) throw new Error("Die Datei enthält kein Modell.");
  return parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;
}

/** Ursprung unten mittig, Normalen berechnen, nur Positionen behalten. */
function cleanGeometry(g: THREE.BufferGeometry) {
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

/** Oberfläche der Federstahlplatte: fein gekörnt, dezentes Raster, Rahmen und Maßangabe. */
function plateTexture(w: number, d: number, margin: number): THREE.CanvasTexture {
  const ppm = 10; // Pixel pro Millimeter
  const c = document.createElement("canvas");
  c.width = Math.round(w * ppm);
  c.height = Math.round(d * ppm);
  const g = c.getContext("2d")!;
  const X = (mm: number) => (mm + margin) * ppm;
  const Y = (mm: number) => c.height - (mm + margin) * ppm; // Canvas-Y zeigt nach unten

  // Grundfarbe + Körnung (PEI-Struktur)
  g.fillStyle = "#1b1b1b";
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

  // Rand außerhalb des Druckbereichs etwas dunkler
  g.fillStyle = "rgba(0,0,0,0.28)";
  g.fillRect(0, 0, c.width, margin * ppm);
  g.fillRect(0, c.height - margin * ppm, c.width, margin * ppm);
  g.fillRect(0, margin * ppm, margin * ppm, c.height - 2 * margin * ppm);
  g.fillRect(c.width - margin * ppm, margin * ppm, margin * ppm, c.height - 2 * margin * ppm);

  // Raster: 10 mm fein, 50 mm kräftiger
  for (let v = 0; v <= 220; v += 10) {
    const major = v % 50 === 0;
    g.strokeStyle = major ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.045)";
    g.lineWidth = major ? 2 : 1.5;
    g.beginPath();
    g.moveTo(X(v), Y(0));
    g.lineTo(X(v), Y(220));
    g.moveTo(X(0), Y(v));
    g.lineTo(X(220), Y(v));
    g.stroke();
  }
  // Umriss des Druckbereichs
  g.strokeStyle = "rgba(255,255,255,0.22)";
  g.lineWidth = 3;
  g.strokeRect(X(0), Y(220), 220 * ppm, 220 * ppm);

  // Beschriftung vorne rechts
  g.fillStyle = "rgba(255,255,255,0.28)";
  g.font = `600 ${3.2 * ppm}px "Inter Variable", Inter, system-ui, sans-serif`;
  g.textAlign = "right";
  g.textBaseline = "alphabetic";
  g.fillText("ENDER 3 V3 KE", X(216), Y(4));
  g.font = `500 ${2.6 * ppm}px "Inter Variable", Inter, system-ui, sans-serif`;
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.fillText("220 × 220 mm", X(216), Y(8.5));

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
