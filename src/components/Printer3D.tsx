/**
 * Live-3D-Ansicht des Ender 3 V3 KE im Dashboard – möglichst nah am echten Gerät:
 * schwarze Alu-Profile mit Nuten, Linearschienen, Z-Spindeln, Schrittmotoren, Druckkopf
 * mit drehendem Lüfter, Filamentrolle mit Faden zum Extruder und Display mit Live-Werten.
 * Studio-Licht mit Spiegelungen und weichen Schatten.
 *
 * - Druckkopf, Querträger (Z) und Bett (Y) folgen der echten Position (curPosition)
 * - Bett und Düse glühen je nach Temperatur
 * - Das gedruckte Teil wächst mit: aus dem G-Code, wenn der Druck aus Druckerwacht kam,
 *   sonst als stilisierte Form nach Fortschritt
 * Ziehen dreht die Ansicht, das Mausrad zoomt; ohne Bedienung dreht sie sich langsam.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import bedModelUrl from "../slicer/assets/creality_ender3v3ke_buildplate_model.stl?url";
import { BED, bedTopTexture } from "../slicer/plate";
import { defaultVisible, parseGcode, type GcodePreview } from "../slicer/gcode";
import { readGcode } from "../slicer/api";
import { useStore } from "../lib/store";
import { accentHex } from "../lib/theme";
import type { PrinterStatus } from "../lib/types";

const HEAD_Y = BED.y / 2; // Der Kopf bleibt in Y stehen, das Bett fährt darunter (Bettschubser)
const CX = BED.x / 2;
const BEAM_Z = 62; // Mitte des X-Trägers über der Düsenspitze
const POST_X = 180; // Abstand der Säulen von der Mitte
const FRAME_Y = HEAD_Y + 30; // Ebene der Säulen und des X-Trägers
const SCREW_Y = HEAD_Y + 48; // Z-Spindeln hinter dem Träger
const SCREW_X = 148;
const TOP_Z = 430; // Mitte des oberen Querprofils
const SPOOL = { x: CX + 70, y: FRAME_Y, z: 562, r: 100, w: 66 };
const reduceMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Zuletzt aus Druckerwacht gesendeter Druck (für das Teil im 3D-Modell) */
export function rememberSentPrint(name: string, gcodePath: string) {
  try {
    localStorage.setItem("dw.lastSent", JSON.stringify({ name, gcodePath }));
  } catch {
    /* egal */
  }
}

function lastSent(): { name: string; gcodePath: string } | null {
  try {
    return JSON.parse(localStorage.getItem("dw.lastSent") ?? "null");
  } catch {
    return null;
  }
}

const base = (n: string) => n.replace(/^.*[\\/]/, "").replace(/\.gcode$/i, "");

/* ------------------------------------------------------------------ Bauteile */

/** Querschnitt eines Alu-Profils (z. B. 20×40) mit Nuten und Kernbohrungen */
function profileShape(w: number, h: number): THREE.Shape {
  const corners = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  const pts: THREE.Vector2[] = [];
  for (let e = 0; e < 4; e++) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[(e + 1) % 4];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    const nx = -uy, ny = ux; // nach innen (gegen den Uhrzeigersinn)
    const at = (t: number, d: number) => new THREE.Vector2(x0 + ux * t + nx * d, y0 + uy * t + ny * d);
    pts.push(at(0, 0));
    const slots = Math.max(1, Math.round(len / 20));
    for (let k = 0; k < slots; k++) {
      const t = ((k + 0.5) * len) / slots;
      // V-Nut: schmale Öffnung, innen breiter
      pts.push(at(t - 3.1, 0), at(t - 3.1, 1.6), at(t - 5, 3.2), at(t - 2.4, 5.6), at(t + 2.4, 5.6), at(t + 5, 3.2), at(t + 3.1, 1.6), at(t + 3.1, 0));
    }
  }
  const s = new THREE.Shape(pts);
  for (let ix = 0; ix < Math.round(w / 20); ix++)
    for (let iy = 0; iy < Math.round(h / 20); iy++) {
      const hole = new THREE.Path();
      hole.absarc(-w / 2 + 10 + ix * 20, -h / 2 + 10 + iy * 20, 2.1, 0, Math.PI * 2, true);
      s.holes.push(hole);
    }
  return s;
}

/** Profil der Länge `len` entlang der Z-Achse (mittig) */
function profileGeo(w: number, h: number, len: number) {
  const g = new THREE.ExtrudeGeometry(profileShape(w, h), { depth: len, bevelEnabled: false, curveSegments: 10 });
  g.translate(0, 0, -len / 2);
  return g;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

/** Gewindeschraffur für Spindeln, Wicklung für die Filamentrolle */
const stripes = (n: number, dark: string, light: string) =>
  canvasTex(8, 64, (g) => {
    for (let i = 0; i < n; i++) {
      const y = (i * 64) / n;
      const gr = g.createLinearGradient(0, y, 0, y + 64 / n);
      gr.addColorStop(0, dark);
      gr.addColorStop(0.5, light);
      gr.addColorStop(1, dark);
      g.fillStyle = gr;
      g.fillRect(0, y, 8, 64 / n);
    }
  });

const glowTexture = () =>
  canvasTex(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  });

class PrinterScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 5, 8000);
  orbit: OrbitControls;
  bed = new THREE.Group();
  gantry = new THREE.Group();
  head = new THREE.Group();
  fanBlades = new THREE.Group();
  spool = new THREE.Group();
  bedHeat: THREE.MeshBasicMaterial;
  nozzleMat: THREE.MeshStandardMaterial;
  nozzleGlow: THREE.Sprite;
  nozzleLight: THREE.PointLight;
  headLight: THREE.Mesh;
  part: THREE.Mesh;
  filament: THREE.Mesh;
  cable: THREE.Mesh;
  screenCanvas: HTMLCanvasElement;
  screenTex: THREE.CanvasTexture;
  screenKey = "";
  lastCurve = new THREE.Vector3(1e9, 0, 0);
  gcode: GcodePreview | null = null;
  gcodeName: string | null = null;
  target = new THREE.Vector3(CX, HEAD_Y, 40);
  cur = new THREE.Vector3(CX, HEAD_Y, 40);
  status: PrinterStatus | null = null;
  accent: string;
  raf = 0;
  last = performance.now();
  idleSince = performance.now();
  visible = true;
  fitted = false;
  disposed = false;
  ro: ResizeObserver;
  io: IntersectionObserver;

  constructor(private host: HTMLElement) {
    this.accent = accentHex();
    const accent = new THREE.Color(this.accent);
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(r.domElement);

    // Studio-Umgebung für Spiegelungen auf Metall und Lack
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(CX + 900, -1130, 760);
    this.orbit = new OrbitControls(this.camera, r.domElement);
    this.orbit.target.set(CX, HEAD_Y + 10, 212);
    this.orbit.enableDamping = true;
    this.orbit.enablePan = false;
    this.orbit.minDistance = 450;
    this.orbit.maxDistance = 2600;
    this.orbit.maxPolarAngle = Math.PI * 0.5;
    this.orbit.autoRotate = !reduceMotion();
    this.orbit.autoRotateSpeed = 0.45;
    this.orbit.addEventListener("start", () => (this.orbit.autoRotate = false));
    this.orbit.addEventListener("end", () => (this.idleSince = performance.now()));
    this.orbit.update();

    // Licht: Führungslicht mit Schatten, kühles Fülllicht, Akzent-Kante
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.5));
    const key = new THREE.DirectionalLight(0xfff4e8, 2.6);
    key.position.set(CX + 520, -420, 1100);
    key.target.position.set(CX, HEAD_Y, 150);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -520, right: 520, top: 520, bottom: -520, near: 200, far: 2600 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.6;
    key.shadow.radius = 4;
    this.scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.6);
    fill.position.set(CX - 700, -500, 300);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(accent, 1.1);
    rim.position.set(CX - 300, 900, 500);
    this.scene.add(rim);

    /* ---------------- Materialien */
    const anodized = new THREE.MeshPhysicalMaterial({ color: 0x1b1d20, metalness: 0.75, roughness: 0.36, clearcoat: 0.2 });
    const plastic = new THREE.MeshPhysicalMaterial({ color: 0x151619, metalness: 0.05, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4 });
    const gloss = new THREE.MeshPhysicalMaterial({ color: 0x121315, metalness: 0, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.18 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xd4d7da, metalness: 1, roughness: 0.2 });
    const alu = new THREE.MeshStandardMaterial({ color: 0xbfc4c9, metalness: 1, roughness: 0.38 });
    const motorBody = new THREE.MeshStandardMaterial({ color: 0x0f1012, metalness: 0.35, roughness: 0.5 });
    const motorCap = new THREE.MeshStandardMaterial({ color: 0x8f959b, metalness: 1, roughness: 0.32 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc8a25a, metalness: 1, roughness: 0.28 });
    const carriage = new THREE.MeshStandardMaterial({ color: 0x2a2d31, metalness: 0.8, roughness: 0.42 });
    const belt = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.8 });
    const filamentMat = new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.3 });

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      return o;
    };
    const box = (w: number, d: number, h: number, m: THREE.Material, x: number, y: number, z: number) => mesh(new THREE.BoxGeometry(w, d, h), m, x, y, z);
    const rbox = (w: number, d: number, h: number, rad: number, m: THREE.Material, x: number, y: number, z: number) =>
      mesh(new RoundedBoxGeometry(w, d, h, 3, rad), m, x, y, z);
    /** Zylinder entlang Z (axis "z"), X oder Y */
    const cyl = (rad: number, h: number, m: THREE.Material, x: number, y: number, z: number, axis: "x" | "y" | "z" = "z", seg = 32) => {
      const o = mesh(new THREE.CylinderGeometry(rad, rad, h, seg), m, x, y, z);
      if (axis === "z") o.rotation.x = Math.PI / 2;
      if (axis === "x") o.rotation.z = Math.PI / 2;
      return o;
    };
    /** NEMA-17-Schrittmotor, Welle entlang `axis` */
    const motor = (x: number, y: number, z: number, axis: "x" | "y" | "z") => {
      const g = new THREE.Group();
      g.add(rbox(42, 42, 34, 2, motorBody, 0, 0, 0));
      g.add(rbox(42.4, 42.4, 5, 1.5, motorCap, 0, 0, 19));
      g.add(rbox(42.4, 42.4, 5, 1.5, motorCap, 0, 0, -19));
      g.add(cyl(11, 2, motorCap, 0, 0, 22.5));
      g.add(cyl(2.5, 14, steel, 0, 0, 28, "z", 12));
      if (axis === "x") g.rotation.y = Math.PI / 2;
      if (axis === "y") g.rotation.x = -Math.PI / 2;
      g.position.set(x, y, z);
      return g;
    };
    const screwTex = stripes(10, "#5d6166", "#f2f4f6");

    /* ---------------- Sockel mit Füßen, Lüftungsschlitzen und Display */
    const BASE = { y0: -125, y1: 305, z0: -96, z1: -36 };
    const baseY = (BASE.y0 + BASE.y1) / 2, baseZ = (BASE.z0 + BASE.z1) / 2;
    this.scene.add(rbox(380, BASE.y1 - BASE.y0, BASE.z1 - BASE.z0, 8, plastic, CX, baseY, baseZ));
    this.scene.add(rbox(372, BASE.y1 - BASE.y0 - 8, 3, 1.5, anodized, CX, baseY, BASE.z1 + 0.6)); // Deckblech
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) this.scene.add(cyl(14, 6, rubber, CX + sx * 165, baseY + sy * 190, BASE.z0 - 3));
      for (let i = 0; i < 6; i++) this.scene.add(box(1.2, 70, 3.5, rubber, CX + sx * 190, baseY + 20, baseZ - 15 + i * 6)); // Lüftungsschlitze
    }
    // Display vorne rechts, leicht nach hinten geneigt
    this.screenCanvas = document.createElement("canvas");
    this.screenCanvas.width = 480;
    this.screenCanvas.height = 288;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Group();
    screen.add(rbox(104, 14, 68, 5, gloss, 0, 0, 0));
    const glass = mesh(
      new THREE.PlaneGeometry(90, 54),
      new THREE.MeshPhysicalMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: this.screenTex, emissiveIntensity: 0.95, roughness: 0.08, clearcoat: 1 }),
      0,
      -7.1,
      0,
    );
    glass.rotation.x = Math.PI / 2;
    screen.add(glass);
    screen.position.set(CX + 112, BASE.y0 - 9, baseZ + 4);
    screen.rotation.x = -0.32;
    this.scene.add(screen);

    // Y-Achse: zwei Linearschienen, Riemen, Motor hinten
    for (const sx of [-1, 1]) this.scene.add(box(12, 400, 6, steel, CX + sx * 62, baseY, BASE.z1 + 3));
    this.scene.add(box(6, 380, 1.6, belt, CX, baseY, BASE.z1 + 2));
    this.scene.add(motor(CX, BASE.y1 + 4, baseZ - 2, "y"));

    /* ---------------- Rahmen: zwei 20×40-Säulen, oberes 20×20-Profil, Z-Spindeln und -Motoren */
    const postLen = TOP_Z - 10 - BASE.z1;
    for (const sx of [-1, 1]) {
      const post = mesh(profileGeo(20, 40, postLen), anodized, CX + sx * POST_X, FRAME_Y, BASE.z1 + postLen / 2);
      this.scene.add(post);
      this.scene.add(rbox(36, 56, 10, 3, plastic, CX + sx * POST_X, FRAME_Y + 4, BASE.z1 + 5)); // Fußwinkel
      this.scene.add(motor(CX + sx * SCREW_X, SCREW_Y, BASE.z1 + 21, "z"));
      const screw = cyl(4, TOP_Z - 20 - (BASE.z1 + 40), new THREE.MeshStandardMaterial({ color: 0xe0e3e6, metalness: 1, roughness: 0.25, bumpMap: screwTex, bumpScale: 1.2 }), CX + sx * SCREW_X, SCREW_Y, (TOP_Z - 20 + BASE.z1 + 40) / 2, "z", 16);
      this.scene.add(screw);
      this.scene.add(cyl(10, 6, motorCap, CX + sx * SCREW_X, SCREW_Y, BASE.z1 + 44)); // Kupplung
      this.scene.add(rbox(30, 34, 14, 3, plastic, CX + sx * SCREW_X, SCREW_Y - 4, TOP_Z - 14)); // oberes Lager
      this.scene.add(rbox(28, 30, 22, 3, plastic, CX + sx * POST_X, FRAME_Y, TOP_Z - 2)); // Eckverbinder
    }
    screwTex.repeat.set(1, 40);
    const top = mesh(profileGeo(20, 20, POST_X * 2 + 20), anodized, CX, FRAME_Y, TOP_Z);
    top.rotation.y = Math.PI / 2;
    this.scene.add(top);

    // Filamentrolle auf dem Halter über dem Rahmen
    this.scene.add(rbox(10, 28, SPOOL.z - TOP_Z, 3, plastic, SPOOL.x - SPOOL.w / 2 - 10, SPOOL.y, (SPOOL.z + TOP_Z) / 2 + 4));
    this.scene.add(cyl(6, SPOOL.w + 26, plastic, SPOOL.x - 4, SPOOL.y, SPOOL.z, "x"));
    const flange = new THREE.MeshPhysicalMaterial({ color: 0x1d1e21, roughness: 0.28, metalness: 0, clearcoat: 0.6, transparent: true, opacity: 0.9 });
    const wind = stripes(16, "rgba(0,0,0,0.55)", "rgba(255,255,255,0.0)");
    wind.repeat.set(1, 30);
    for (const sx of [-1, 1]) {
      const f = cyl(SPOOL.r, 3, flange, sx * (SPOOL.w / 2 - 1.5), 0, 0, "x", 64);
      this.spool.add(f);
    }
    const coil = cyl(SPOOL.r - 18, SPOOL.w - 6, new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.4, clearcoat: 0.6, bumpMap: wind, bumpScale: 0.6 }), 0, 0, 0, "x", 64);
    this.spool.add(coil);
    this.spool.add(cyl(28, SPOOL.w - 2, new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.6 }), 0, 0, 0, "x", 32));
    this.spool.position.set(SPOOL.x, SPOOL.y, SPOOL.z);
    this.scene.add(this.spool);

    /* ---------------- Bett (fährt in Y) */
    this.scene.add(this.bed);
    const cy = BED.y / 2;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) this.bed.add(rbox(22, 30, 7, 1.5, steel, CX + sx * 62, cy + sy * 70, BASE.z1 + 9.5));
    this.bed.add(rbox(250, 250, 5, 2, carriage, CX, cy, -21));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) this.bed.add(cyl(5, 13.5, alu, CX + sx * 105, cy + sy * 105, -11.75));
    this.bed.add(box(225, 225, 1, new THREE.MeshStandardMaterial({ color: 0x8a3b1f, roughness: 0.8 }), CX, cy, -5.6)); // Heizmatte
    this.bedHeat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const heat = new THREE.Mesh(new THREE.PlaneGeometry(BED.x + 12, BED.y + 12), this.bedHeat);
    heat.position.set(CX, cy, -5.0);
    this.bed.add(heat);
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(BED.x, BED.y),
      new THREE.MeshPhysicalMaterial({ map: bedTopTexture(() => {}), roughness: 0.7, metalness: 0.15, clearcoat: 0.15 }),
    );
    sheet.position.set(CX, cy, 0.8);
    this.bed.add(sheet);
    void fetch(bedModelUrl)
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        if (this.disposed) return;
        const geo = new STLLoader().parse(buf);
        geo.computeVertexNormals();
        const body = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: 0x1c1d20, roughness: 0.45, metalness: 0.5, clearcoat: 0.3 }));
        body.position.set(CX, cy, 0);
        body.castShadow = body.receiveShadow = true;
        this.bed.add(body);
      })
      .catch(() => {});

    // Stilisierte Form, falls kein G-Code vorliegt (gedrehte Vase)
    this.part = new THREE.Mesh(
      new THREE.LatheGeometry(
        Array.from({ length: 32 }, (_, i) => new THREE.Vector2(22 + 9 * Math.sin(((Math.PI * i) / 31) * 1.1) - 4 * (i / 31) ** 2, (i / 31) * 70)),
        72,
      ),
      new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.42, clearcoat: 0.35, side: THREE.DoubleSide }),
    );
    this.part.rotation.x = Math.PI / 2;
    this.part.position.set(CX, cy, 0.8);
    this.part.scale.set(1, 0.001, 1);
    this.bed.add(this.part);

    /* ---------------- Querträger (fährt in Z) mit Linearschiene, Riemen, X-Motor */
    this.scene.add(this.gantry);
    const beamLen = POST_X * 2 - 20;
    const beam = mesh(profileGeo(20, 40, beamLen), anodized, CX, FRAME_Y, BEAM_Z);
    beam.rotation.set(0, Math.PI / 2, 0);
    beam.geometry.rotateZ(Math.PI / 2); // 40 mm hoch, 20 mm tief
    this.gantry.add(beam);
    this.gantry.add(box(beamLen - 20, 8, 12, steel, CX, FRAME_Y - 14, BEAM_Z)); // X-Linearschiene
    for (const dz of [-11, 11]) this.gantry.add(box(beamLen - 40, 1.6, 6, belt, CX, FRAME_Y + 11, BEAM_Z + dz));
    for (const sx of [-1, 1]) {
      this.gantry.add(rbox(58, 52, 66, 5, plastic, CX + sx * 168, FRAME_Y + 8, BEAM_Z)); // Z-Wagen
      this.gantry.add(cyl(9, 18, brass, CX + sx * SCREW_X, SCREW_Y, BEAM_Z - 26, "z", 6)); // Spindelmutter
    }
    this.gantry.add(motor(CX - 160, FRAME_Y + 56, BEAM_Z, "y"));

    /* ---------------- Druckkopf (fährt in X) */
    this.gantry.add(this.head);
    const h = this.head;
    h.add(box(30, 8, 24, steel, 0, FRAME_Y - HEAD_Y - 22, BEAM_Z)); // Wagen auf der Schiene
    h.add(rbox(60, 42, 70, 7, gloss, 0, -9, 51)); // Haube
    h.add(rbox(48, 4, 40, 3, plastic, 0, -30.5, 58)); // Frontblende
    // Bauteillüfter vorne (dreht sich beim Drucken)
    const fan = new THREE.Group();
    fan.add(cyl(17, 1.5, new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 }), 0, 0, 0, "y"));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(17.5, 1.6, 12, 48), anodized);
    ring.rotation.x = Math.PI / 2;
    fan.add(ring);
    for (let i = 0; i < 7; i++) {
      const blade = box(4.5, 0.8, 13, new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5 }), 0, 0, 9.5);
      const pivot = new THREE.Group();
      blade.rotation.z = 0.5;
      pivot.add(blade);
      pivot.rotation.y = (i * Math.PI * 2) / 7;
      this.fanBlades.add(pivot);
    }
    this.fanBlades.add(cyl(6, 2.2, plastic, 0, 0, 0, "y"));
    fan.add(this.fanBlades);
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const bar = box(36, 0.8, 1.2, anodized, 0, -1.4, 0); // Schutzgitter
      bar.rotation.y = a;
      fan.add(bar);
    }
    fan.position.set(0, -32.8, 58);
    h.add(fan);
    // Seitlicher Hotend-Lüfter
    const side = new THREE.Mesh(new THREE.TorusGeometry(11, 1.2, 10, 36), anodized);
    side.rotation.y = Math.PI / 2;
    side.position.set(30.3, -9, 56);
    h.add(side, cyl(10, 0.8, new THREE.MeshStandardMaterial({ color: 0x050505 }), 30.2, -9, 56, "x"));
    // Luftdüse, Heizblock, Düse
    const duct = rbox(40, 12, 9, 3, plastic, 0, -22, 14);
    duct.rotation.x = 0.45;
    h.add(duct);
    h.add(rbox(20, 15, 9, 1.2, alu, 0, 0, 12));
    h.add(cyl(4.2, 4, brass, 0, 0, 5.5, "z", 6));
    this.nozzleMat = new THREE.MeshStandardMaterial({ color: 0xc8a25a, metalness: 1, roughness: 0.25, emissive: accent, emissiveIntensity: 0 });
    const tip = mesh(new THREE.ConeGeometry(3.4, 3.6, 24), this.nozzleMat, 0, 0, 1.8);
    tip.rotation.x = -Math.PI / 2;
    h.add(tip);
    this.headLight = box(30, 1, 2.4, new THREE.MeshBasicMaterial({ color: accent }), 0, -30.6, 19);
    h.add(this.headLight);
    // Extruder oben mit Flachmotor, Hebel und Einlass
    h.add(rbox(46, 36, 30, 5, gloss, 0, -8, 100));
    h.add(cyl(18, 11, motorBody, 28.5, -8, 100, "x", 40));
    h.add(cyl(12, 1.5, motorCap, 34.6, -8, 100, "x", 40));
    h.add(rbox(8, 26, 10, 2, plastic, -20, -8, 118));
    h.add(cyl(4, 10, plastic, 6, -8, 120));
    h.add(cyl(2.4, 2, brass, 6, -8, 125.5, "z", 12));

    this.nozzleGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: accent, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.nozzleGlow.scale.set(44, 44, 1);
    this.nozzleGlow.position.set(0, 0, 1);
    h.add(this.nozzleGlow);
    this.nozzleLight = new THREE.PointLight(accent, 0, 0, 2);
    this.nozzleLight.position.set(0, -8, 6);
    h.add(this.nozzleLight);

    // Filament und Kabelstrang (Kurven werden mit dem Kopf neu gebaut)
    this.filament = new THREE.Mesh(new THREE.BufferGeometry(), filamentMat);
    this.cable = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x1f2022, roughness: 0.55, metalness: 0.2 }));
    this.scene.add(this.filament, this.cable);

    // Boden: Schatten und weicher Kontaktschatten
    const floorZ = BASE.z0 - 6;
    const shadow = mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.ShadowMaterial({ opacity: 0.32 }), CX, baseY, floorZ);
    shadow.receiveShadow = true;
    this.scene.add(shadow);
    const ao = mesh(
      new THREE.PlaneGeometry(620, 640),
      new THREE.MeshBasicMaterial({
        map: canvasTex(128, 128, (g) => {
          const gr = g.createRadialGradient(64, 64, 10, 64, 64, 64);
          gr.addColorStop(0, "rgba(0,0,0,0.55)");
          gr.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = gr;
          g.fillRect(0, 0, 128, 128);
        }),
        transparent: true,
        depthWrite: false,
      }),
      CX,
      baseY,
      floorZ + 0.3,
    );
    this.scene.add(ao);

    this.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== shadow && o !== ao && o !== heat) o.castShadow = o.receiveShadow = true;
    });
    glass.castShadow = false;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.io = new IntersectionObserver(([e]) => (this.visible = e.isIntersecting));
    this.io.observe(host);
    this.resize();
    this.drawScreen();
    const loop = (now: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.visible && !document.hidden) this.tick(dt, now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Schmale Karten: Kamera so weit zurück, dass der ganze Drucker samt Rolle hineinpasst
    if (!this.fitted) {
      this.fitted = true;
      const off = this.camera.position.clone().sub(this.orbit.target);
      off.multiplyScalar(Math.max(1, 1.3 / this.camera.aspect));
      this.camera.position.copy(this.orbit.target).add(off);
      this.orbit.update();
    }
  }

  update(s: PrinterStatus | null) {
    this.status = s;
    if (s?.position) this.target.set(s.position[0], s.position[1], s.position[2]);
    else if (s && s.state !== "printing") this.target.set(CX, HEAD_Y, 40);
    // Teil aus dem G-Code laden, wenn dieser Druck aus Druckerwacht kam
    const sent = lastSent();
    const want = s?.fileName && sent && base(sent.name) === base(s.fileName) ? sent : null;
    if (want && want.name !== this.gcodeName) {
      this.gcodeName = want.name;
      void readGcode(want.gcodePath)
        .then((text) => {
          if (this.disposed || this.gcodeName !== want.name) return;
          const p = parseGcode(text);
          for (const ty of p.types) p.setVisible(ty.id, defaultVisible(ty.id));
          this.gcode?.dispose();
          this.gcode = p;
          p.object.position.z = 0.8;
          this.bed.add(p.object);
          this.applyLayer();
        })
        .catch(() => {
          /* G-Code nicht mehr vorhanden: stilisierte Form */
        });
    } else if (!want && this.gcode) {
      this.bed.remove(this.gcode.object);
      this.gcode.dispose();
      this.gcode = null;
      this.gcodeName = null;
    }
    this.applyLayer();
  }

  /** Fortschritt des Teils: Schicht aus dem Drucker, sonst Prozent */
  applyLayer() {
    const s = this.status;
    const active = !!s && (s.state === "printing" || s.state === "paused" || s.state === "finished");
    const frac = !active ? 0 : s!.state === "finished" ? 1 : Math.max(0, Math.min(1, (s!.progress ?? 0) / 100));
    if (this.gcode) {
      const n = this.gcode.layerCount;
      const layer = s?.layer != null && s.layer > 0 ? Math.min(n - 1, s.layer - 1) : Math.round(frac * (n - 1));
      this.gcode.setMaxLayer(active ? layer : -1);
      this.part.visible = false;
    } else {
      this.part.visible = frac > 0;
      this.part.scale.set(1, Math.max(0.001, frac), 1);
    }
  }

  /** Display am Drucker: Temperaturen und Fortschritt wie auf dem echten Bildschirm */
  drawScreen() {
    const s = this.status;
    const noz = s?.nozzleTemp != null ? Math.round(s.nozzleTemp) : null;
    const bed = s?.bedTemp != null ? Math.round(s.bedTemp) : null;
    const pct = s?.state === "finished" ? 100 : Math.round(s?.progress ?? 0);
    const busy = s?.state === "printing" || s?.state === "paused";
    const key = `${noz}|${bed}|${pct}|${s?.state}|${Math.round(s?.nozzleTarget ?? 0)}|${Math.round(s?.bedTarget ?? 0)}`;
    if (key === this.screenKey) return;
    this.screenKey = key;
    const g = this.screenCanvas.getContext("2d")!;
    const W = this.screenCanvas.width, H = this.screenCanvas.height;
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#15181d");
    bg.addColorStop(1, "#0a0b0e");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(255,255,255,0.06)";
    g.fillRect(0, 0, W, 34);
    g.fillStyle = "#9aa3ad";
    g.font = "600 18px system-ui, sans-serif";
    g.fillText("Ender-3 V3 KE", 16, 23);
    g.fillStyle = s ? "#4CAF7A" : "#6b7178";
    g.beginPath();
    g.arc(W - 22, 17, 6, 0, Math.PI * 2);
    g.fill();
    // Fortschrittsring
    const rx = 110, ry = 165, rr = 70;
    g.lineWidth = 14;
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.beginPath();
    g.arc(rx, ry, rr, 0, Math.PI * 2);
    g.stroke();
    if (busy || s?.state === "finished") {
      g.strokeStyle = this.accent;
      g.lineCap = "round";
      g.beginPath();
      g.arc(rx, ry, rr, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * pct) / 100);
      g.stroke();
    }
    g.fillStyle = "#f5f4ef";
    g.textAlign = "center";
    g.font = "700 40px system-ui, sans-serif";
    g.fillText(busy || s?.state === "finished" ? `${pct}%` : "—", rx, ry + 14);
    g.textAlign = "left";
    // Temperaturen
    const row = (y: number, label: string, v: number | null, t: number | null | undefined, hot: boolean) => {
      g.fillStyle = "rgba(255,255,255,0.05)";
      g.fillRect(220, y, 240, 84);
      g.fillStyle = hot ? this.accent : "#7d858e";
      g.font = "600 17px system-ui, sans-serif";
      g.fillText(label, 236, y + 26);
      g.fillStyle = "#f5f4ef";
      g.font = "700 34px system-ui, sans-serif";
      g.fillText(v != null ? `${v}°` : "--", 236, y + 68);
      g.fillStyle = "#7d858e";
      g.font = "500 20px system-ui, sans-serif";
      g.fillText(t ? `/ ${Math.round(t)}°` : "", 330, y + 68);
    };
    row(54, "NOZZLE", noz, s?.nozzleTarget, (noz ?? 0) > 50);
    row(152, "BED", bed, s?.bedTarget, (bed ?? 0) > 40);
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.fillRect(220, 254, 240, 8);
    g.fillStyle = this.accent;
    g.fillRect(220, 254, (240 * pct) / 100, 8);
    this.screenTex.needsUpdate = true;
  }

  /** Filament von der Rolle zum Extruder und Kabelstrang zum Rahmen */
  updateCurves(force = false) {
    const inlet = new THREE.Vector3(this.cur.x + 6, HEAD_Y - 8, this.cur.z + 126);
    if (!force && inlet.distanceToSquared(this.lastCurve) < 0.6) return;
    this.lastCurve.copy(inlet);
    const exit = new THREE.Vector3(SPOOL.x - 8, SPOOL.y - (SPOOL.r - 18) * 0.86, SPOOL.z - (SPOOL.r - 18) * 0.5);
    const fil = new THREE.CatmullRomCurve3([
      exit,
      exit.clone().add(new THREE.Vector3(0, -22, -30)),
      new THREE.Vector3((exit.x + inlet.x) / 2, HEAD_Y - 52, (exit.z + inlet.z) / 2 + 10),
      inlet.clone().add(new THREE.Vector3(0, -6, 40)),
      inlet.clone().add(new THREE.Vector3(0, 0, 6)),
      inlet,
    ]);
    this.filament.geometry.dispose();
    this.filament.geometry = new THREE.TubeGeometry(fil, 80, 0.95, 8, false);
    const from = new THREE.Vector3(this.cur.x - 8, HEAD_Y + 6, this.cur.z + 112);
    const to = new THREE.Vector3(CX - 70, FRAME_Y + 2, TOP_Z - 10);
    const cab = new THREE.CatmullRomCurve3([
      from,
      from.clone().add(new THREE.Vector3(0, 10, 40)),
      new THREE.Vector3((from.x + to.x) / 2, FRAME_Y + 30, Math.max(from.z, to.z) + 40),
      to.clone().add(new THREE.Vector3(0, 8, 22)),
      to,
    ]);
    this.cable.geometry.dispose();
    this.cable.geometry = new THREE.TubeGeometry(cab, 64, 3, 10, false);
  }

  tick(dt: number, now: number) {
    const s = this.status;
    const printing = s?.state === "printing" && !s.preparing;
    const calm = reduceMotion();
    // Lebendige Bewegung zwischen den (seltenen) Positionsmeldungen
    const sway = printing && !calm ? new THREE.Vector3(Math.sin(now / 420) * 14 + Math.sin(now / 157) * 5, Math.cos(now / 610) * 9, 0) : new THREE.Vector3();
    const goal = this.target.clone().add(sway);
    goal.x = Math.max(0, Math.min(BED.x, goal.x));
    goal.y = Math.max(0, Math.min(BED.y, goal.y));
    this.cur.lerp(goal, 1 - Math.exp(-dt * (printing ? 9 : 3)));
    this.head.position.set(this.cur.x, HEAD_Y, 0);
    this.gantry.position.set(0, 0, this.cur.z);
    this.bed.position.set(0, HEAD_Y - this.cur.y, 0);
    this.updateCurves();

    // Glühen nach Temperatur
    const bedHot = s?.bedTemp != null ? Math.max(0, Math.min(1, (s.bedTemp - 30) / 40)) : 0;
    const nozHot = s?.nozzleTemp != null ? Math.max(0, Math.min(1, (s.nozzleTemp - 40) / 170)) : 0;
    const pulse = 0.85 + 0.15 * Math.sin(now / 500);
    this.bedHeat.opacity = bedHot * 0.16 * pulse;
    this.nozzleMat.emissiveIntensity = nozHot * 1.6;
    (this.nozzleGlow.material as THREE.SpriteMaterial).opacity = nozHot * 0.85 * pulse;
    this.nozzleLight.intensity = nozHot * 900 * pulse;
    (this.headLight.material as THREE.MeshBasicMaterial).color.set(printing ? this.accent : "#3a3836");

    // Lüfter dreht beim Drucken bzw. heißer Düse, Rolle wickelt beim Drucken ab
    if (!calm) {
      this.fanBlades.rotation.y += dt * (printing ? 38 : nozHot > 0.3 ? 14 : 0);
      if (printing) this.spool.rotation.x -= dt * 0.12;
    }
    this.drawScreen();

    if (!this.orbit.autoRotate && performance.now() - this.idleSince > 8000 && !calm) this.orbit.autoRotate = true;
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    this.gcode?.dispose();
    this.orbit.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export default function Printer3D() {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PrinterScene | null>(null);
  const status = useStore((s) => s.status);
  useEffect(() => {
    if (!host.current) return;
    const sc = new PrinterScene(host.current);
    sceneRef.current = sc;
    sc.update(status);
    sc.updateCurves(true);
    return () => {
      sc.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    sceneRef.current?.update(status);
  }, [status]);
  return <div className="printer3d" ref={host} />;
}
