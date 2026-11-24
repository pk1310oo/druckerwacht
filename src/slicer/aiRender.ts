/**
 * Ansichten für den KI-Designer: rendert ein Teil aus vier Richtungen (schräg, vorne,
 * rechts, oben) in ein Bild, damit die KI die Form „sieht“. Mit Achsenkreuz und 10-mm-Raster.
 */
import * as THREE from "three";

let renderer: THREE.WebGLRenderer | null = null;
const TILE = 384;

const VIEWS: { label: string; dir: [number, number, number]; up: [number, number, number] }[] = [
  { label: "ISO (from front-left-top)", dir: [-1, -1.3, 0.9], up: [0, 0, 1] },
  { label: "FRONT (looking +Y)", dir: [0, -1, 0], up: [0, 0, 1] },
  { label: "RIGHT (looking -X)", dir: [1, 0, 0], up: [0, 0, 1] },
  { label: "TOP (looking -Z, +Y up)", dir: [0, 0, 1], up: [0, 1, 0] },
];

/** Liefert ein PNG (Base64 ohne Präfix) mit vier Ansichten der Geometrie (Bettkoordinaten) */
export function renderViews(geometry: THREE.BufferGeometry, highlight?: THREE.BufferGeometry | null): string {
  renderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(TILE, TILE, false);
  renderer.setClearColor(0xf4f4f2);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(sun);
  const mat = new THREE.MeshStandardMaterial({ color: 0xf08a24, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, mat);
  scene.add(mesh);
  let hl: THREE.Mesh | null = null;
  if (highlight) {
    hl = new THREE.Mesh(highlight, new THREE.MeshStandardMaterial({ color: 0x2f7cf6, roughness: 0.6, transparent: true, opacity: 0.75 }));
    scene.add(hl);
  }
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!.clone();
  if (highlight) {
    highlight.computeBoundingBox();
    box.union(highlight.boundingBox!);
  }
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.length() / 2, 5);

  // 10-mm-Raster auf Betthöhe und Achsenkreuz an der unteren Ecke
  const span = Math.ceil((Math.max(size.x, size.y) + 20) / 10) * 10;
  const grid = new THREE.GridHelper(span, span / 10, 0x9a9a9a, 0xcfcfcf);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(Math.round(c.x / 10) * 10, Math.round(c.y / 10) * 10, Math.min(0, box.min.z));
  scene.add(grid);
  const axes = new THREE.AxesHelper(Math.max(10, r * 0.6));
  axes.position.copy(box.min);
  (axes.material as THREE.LineBasicMaterial).depthTest = false;
  axes.renderOrder = 10;
  scene.add(axes);

  const out = document.createElement("canvas");
  out.width = TILE * 2;
  out.height = TILE * 2;
  const ctx = out.getContext("2d")!;
  VIEWS.forEach((v, i) => {
    const cam = new THREE.OrthographicCamera(-r * 1.15, r * 1.15, r * 1.15, -r * 1.15, 0.1, r * 20);
    const d = new THREE.Vector3(...v.dir).normalize();
    cam.position.copy(c).addScaledVector(d, r * 6);
    cam.up.set(...v.up);
    cam.lookAt(c);
    sun.position.copy(cam.position).add(new THREE.Vector3(-r, r, r * 2));
    renderer!.render(scene, cam);
    ctx.drawImage(renderer!.domElement, (i % 2) * TILE, Math.floor(i / 2) * TILE);
    ctx.fillStyle = "#222";
    ctx.font = "bold 15px sans-serif";
    ctx.fillText(v.label, (i % 2) * TILE + 8, Math.floor(i / 2) * TILE + 20);
  });
  ctx.strokeStyle = "#888";
  ctx.beginPath();
  ctx.moveTo(TILE, 0);
  ctx.lineTo(TILE, TILE * 2);
  ctx.moveTo(0, TILE);
  ctx.lineTo(TILE * 2, TILE);
  ctx.stroke();
  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#333";
  ctx.fillText("axes: red = +X, green = +Y, blue = +Z · grid = 10 mm", 8, TILE * 2 - 8);

  mat.dispose();
  if (hl) (hl.material as THREE.Material).dispose();
  grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
  axes.dispose();
  return out.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
