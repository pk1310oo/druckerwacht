/**
 * Live-3D-Ansicht des Ender 3 V3 KE im Dashboard.
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
import bedModelUrl from "../slicer/assets/creality_ender3v3ke_buildplate_model.stl?url";
import { BED, bedTopTexture } from "../slicer/plate";
import { defaultVisible, parseGcode, type GcodePreview } from "../slicer/gcode";
import { readGcode } from "../slicer/api";
import { useStore } from "../lib/store";
import { accentHex } from "../lib/theme";
import type { PrinterStatus } from "../lib/types";

const HEAD_Y = BED.y / 2; // Der Kopf bleibt in Y stehen, das Bett fährt darunter (Bettschubser)
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

class PrinterScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  orbit: OrbitControls;
  bed = new THREE.Group();
  gantry = new THREE.Group();
  head = new THREE.Group();
  bedHeat: THREE.MeshBasicMaterial;
  nozzleMat: THREE.MeshStandardMaterial;
  nozzleGlow: THREE.Sprite;
  headLight: THREE.Mesh;
  part: THREE.Mesh;
  gcode: GcodePreview | null = null;
  gcodeName: string | null = null;
  target = new THREE.Vector3(BED.x / 2, HEAD_Y, 40);
  cur = new THREE.Vector3(BED.x / 2, HEAD_Y, 40);
  status: PrinterStatus | null = null;
  raf = 0;
  last = performance.now();
  idleSince = performance.now();
  disposed = false;

  constructor(private host: HTMLElement) {
    const accent = new THREE.Color(accentHex());
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(BED.x / 2 + 560, -660, 390);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(BED.x / 2, BED.y / 2 + 20, 120);
    this.orbit.enableDamping = true;
    this.orbit.enablePan = false;
    this.orbit.minDistance = 380;
    this.orbit.maxDistance = 1400;
    this.orbit.maxPolarAngle = Math.PI * 0.62;
    this.orbit.autoRotate = !reduceMotion();
    this.orbit.autoRotateSpeed = 0.5;
    this.orbit.addEventListener("start", () => (this.orbit.autoRotate = false));
    this.orbit.addEventListener("end", () => (this.idleSince = performance.now()));
    this.orbit.update();

    // Licht
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(400, -500, 700);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(accent, 0.45);
    rim.position.set(-500, 400, 300);
    this.scene.add(rim);

    const dark = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.45, metalness: 0.3 });
    const darker = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6, metalness: 0.2 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.3, metalness: 0.9 });
    const box = (w: number, d: number, h: number, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m);
      mesh.position.set(x, y, z);
      return mesh;
    };

    // Rahmen: Sockel, Y-Schiene, zwei Säulen, oberer Träger
    const cx = BED.x / 2;
    this.scene.add(box(360, 420, 46, darker, cx, HEAD_Y, -60));
    this.scene.add(box(40, 400, 10, metal, cx, HEAD_Y, -32));
    for (const sx of [-1, 1]) {
      this.scene.add(box(34, 40, 420, dark, cx + sx * 176, HEAD_Y + 26, 150));
      this.scene.add(box(4, 4, 400, metal, cx + sx * 160, HEAD_Y + 12, 150)); // Z-Spindel
    }
    this.scene.add(box(386, 40, 30, dark, cx, HEAD_Y + 26, 372));
    // Display vorne rechts
    const screen = box(70, 6, 44, new THREE.MeshStandardMaterial({ color: 0x0b0b0b, emissive: accent, emissiveIntensity: 0.25 }), cx + 140, HEAD_Y - 214, -52);
    screen.rotation.x = -0.5;
    this.scene.add(screen);

    // Bett (fährt in Y)
    this.scene.add(this.bed);
    this.bed.add(box(250, 250, 8, darker, cx, BED.y / 2, -14));
    this.bedHeat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, depthWrite: false });
    const heat = new THREE.Mesh(new THREE.PlaneGeometry(BED.x + 30, BED.y + 30), this.bedHeat);
    heat.position.set(cx, BED.y / 2, -9.5);
    this.bed.add(heat);
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(BED.x, BED.y),
      new THREE.MeshStandardMaterial({ map: bedTopTexture(() => {}), roughness: 0.85, metalness: 0.1 }),
    );
    top.position.set(cx, BED.y / 2, 0.01);
    this.bed.add(top);
    void fetch(bedModelUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (this.disposed) return;
        const geo = new STLLoader().parse(buf);
        geo.computeVertexNormals();
        const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x232323, roughness: 0.6, metalness: 0.35 }));
        body.position.set(cx, BED.y / 2, -0.01);
        this.bed.add(body);
      })
      .catch(() => {});

    // Stilisierte Form, falls kein G-Code vorliegt (gedrehte Vase)
    this.part = new THREE.Mesh(
      new THREE.LatheGeometry(
        Array.from({ length: 24 }, (_, i) => new THREE.Vector2(22 + 9 * Math.sin((Math.PI * i) / 23 * 1.1) - 4 * (i / 23) ** 2, (i / 23) * 70)),
        48,
      ),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }),
    );
    this.part.rotation.x = Math.PI / 2;
    this.part.position.set(cx, BED.y / 2, 0);
    this.part.scale.set(1, 0.001, 1);
    this.bed.add(this.part);

    // Querträger (fährt in Z) mit Druckkopf (fährt in X)
    this.scene.add(this.gantry);
    this.gantry.add(box(372, 26, 26, dark, cx, HEAD_Y + 26, 0));
    this.gantry.add(this.head);
    this.head.add(box(56, 52, 72, new THREE.MeshStandardMaterial({ color: 0x242424, roughness: 0.45, metalness: 0.4 }), 0, 6, 44));
    this.head.add(box(34, 4, 34, new THREE.MeshStandardMaterial({ color: 0x111111 }), 0, -21, 52)); // Lüfter
    this.headLight = box(40, 2, 4, new THREE.MeshBasicMaterial({ color: accent }), 0, -21, 74);
    this.head.add(this.headLight);
    this.nozzleMat = new THREE.MeshStandardMaterial({ color: 0xc9a46a, metalness: 0.9, roughness: 0.3, emissive: accent, emissiveIntensity: 0 });
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(4, 9, 16), this.nozzleMat);
    nozzle.rotation.x = -Math.PI / 2;
    nozzle.position.set(0, 0, 4.5);
    this.head.add(nozzle);
    const glowTex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, "rgba(255,255,255,1)");
      r.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    this.nozzleGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: accent, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.nozzleGlow.scale.set(40, 40, 1);
    this.nozzleGlow.position.set(0, 0, 1);
    this.head.add(this.nozzleGlow);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    this.resize();
    const loop = (now: number) => {
      if (this.disposed) return ro.disconnect();
      this.tick(Math.min(0.1, (now - this.last) / 1000), now);
      this.last = now;
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
  }

  update(s: PrinterStatus | null) {
    this.status = s;
    if (s?.position) this.target.set(s.position[0], s.position[1], s.position[2]);
    else if (s && s.state !== "printing") this.target.set(BED.x / 2, HEAD_Y, 40);
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

  tick(dt: number, now: number) {
    const s = this.status;
    const printing = s?.state === "printing" && !s.preparing;
    // Lebendige Bewegung zwischen den (seltenen) Positionsmeldungen
    const sway = printing && !reduceMotion() ? new THREE.Vector3(Math.sin(now / 420) * 14 + Math.sin(now / 157) * 5, Math.cos(now / 610) * 9, 0) : new THREE.Vector3();
    const goal = this.target.clone().add(sway);
    goal.x = Math.max(0, Math.min(BED.x, goal.x));
    goal.y = Math.max(0, Math.min(BED.y, goal.y));
    this.cur.lerp(goal, 1 - Math.exp(-dt * (printing ? 9 : 3)));
    this.head.position.set(this.cur.x, HEAD_Y, 0);
    this.gantry.position.set(0, 0, this.cur.z);
    this.bed.position.set(0, HEAD_Y - this.cur.y, 0);

    // Glühen nach Temperatur
    const bedHot = s?.bedTemp != null ? Math.max(0, Math.min(1, (s.bedTemp - 30) / 40)) : 0;
    const nozHot = s?.nozzleTemp != null ? Math.max(0, Math.min(1, (s.nozzleTemp - 40) / 170)) : 0;
    const pulse = 0.85 + 0.15 * Math.sin(now / 500);
    this.bedHeat.opacity = bedHot * 0.22 * pulse;
    this.nozzleMat.emissiveIntensity = nozHot * 1.4;
    (this.nozzleGlow.material as THREE.SpriteMaterial).opacity = nozHot * 0.85 * pulse;
    (this.headLight.material as THREE.MeshBasicMaterial).color.setHSL(0, 0, 0).set(printing ? accentHex() : "#3a3836");

    if (!this.orbit.autoRotate && performance.now() - this.idleSince > 8000 && !reduceMotion()) this.orbit.autoRotate = true;
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.gcode?.dispose();
    this.orbit.dispose();
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
