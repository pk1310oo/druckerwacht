/**
 * Kleine Vorschaubilder der Füllmuster (eigene Zeichnungen, angelehnt an das jeweilige Linienbild).
 * Gezeichnet auf 48 × 48, Linienfarbe = currentColor.
 */
import type { ReactNode } from "react";

const S = 48;

function lines(angle: number, gap: number, offset = 0): string {
  // Parallele Linien unter `angle` Grad, über das ganze Feld (optional seitlich versetzt)
  const out: string[] = [];
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const nx = -dy, ny = dx;
  for (let o = -S + offset; o <= S; o += gap) {
    const cx = S / 2 + nx * o, cy = S / 2 + ny * o;
    out.push(`M${(cx - dx * S).toFixed(1)} ${(cy - dy * S).toFixed(1)}L${(cx + dx * S).toFixed(1)} ${(cy + dy * S).toFixed(1)}`);
  }
  return out.join("");
}

function zigzag(gap: number, amp: number, step: number): string {
  let d = "";
  for (let y = gap / 2; y < S; y += gap) {
    d += `M0 ${y}`;
    for (let x = 0, k = 0; x <= S; x += step, k++) d += `L${x} ${y + (k % 2 ? amp : -amp)}`;
  }
  return d;
}

function hexes(r: number, flatTop = false): string {
  let d = "";
  const w = Math.sqrt(3) * r;
  for (let row = -1; row < S / (1.5 * r) + 1; row++) {
    for (let col = -1; col < S / w + 1; col++) {
      const cx = col * w + (row % 2 ? w / 2 : 0);
      const cy = row * 1.5 * r;
      for (let i = 0; i < 6; i++) {
        const a = ((60 * i + (flatTop ? 0 : 30)) * Math.PI) / 180;
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      d += "Z";
    }
  }
  return d;
}

function wave(gap: number, amp: number, phaseShift = 0, vertical = false): string {
  let d = "";
  for (let k = 0, o = gap / 2; o < S + gap; o += gap, k++) {
    d += vertical ? `M${o} 0` : `M0 ${o}`;
    for (let t = 0; t <= S; t += 2) {
      const v = o + amp * Math.sin((t / S) * Math.PI * 2 + k * phaseShift);
      d += vertical ? `L${v.toFixed(1)} ${t}` : `L${t} ${v.toFixed(1)}`;
    }
  }
  return d;
}

function concentric(step: number): string {
  let d = "";
  for (let i = 4; i < S / 2; i += step) d += `M${i} ${i}H${S - i}V${S - i}H${i}Z`;
  return d;
}

function spiral(turns: number, square = false): string {
  let d = `M${S / 2} ${S / 2}`;
  for (let t = 0; t <= turns * Math.PI * 2; t += square ? Math.PI / 2 : 0.15) {
    const r = (t / (turns * Math.PI * 2)) * (S / 2 - 3);
    d += `L${(S / 2 + r * Math.cos(t)).toFixed(1)} ${(S / 2 + r * Math.sin(t)).toFixed(1)}`;
  }
  return d;
}

function octagram(): string {
  let d = "";
  for (let k = 0; k < 4; k++) {
    const r = 6 + k * 5.5;
    for (let i = 0; i <= 16; i++) {
      const a = (i * Math.PI) / 8;
      const rr = i % 2 ? r * 0.72 : r;
      d += `${i ? "L" : "M"}${(S / 2 + rr * Math.cos(a)).toFixed(1)} ${(S / 2 + rr * Math.sin(a)).toFixed(1)}`;
    }
  }
  return d;
}

function hilbert(order: number): string {
  const n = 2 ** order;
  const pts: [number, number][] = [];
  for (let i = 0; i < n * n; i++) {
    let t = i, x = 0, y = 0;
    for (let s = 1; s < n; s *= 2) {
      const rx = 1 & (t / 2), ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        [x, y] = [y, x];
      }
      x += s * rx; y += s * ry;
      t = Math.floor(t / 4);
    }
    pts.push([x, y]);
  }
  const c = (S - 8) / (n - 1);
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${(4 + x * c).toFixed(1)} ${(4 + y * c).toFixed(1)}`).join("");
}

function lightning(): string {
  return "M24 46V30M24 30L12 18M24 30L36 16M12 18L6 6M12 18L18 6M36 16L30 4M36 16L44 8M10 46V38L4 32M38 46V36L44 30";
}

function archimedean(): string {
  let d = "";
  for (let i = 1; i < 6; i++) d += `M${S / 2 + i * 4.2} ${S / 2}A${i * 4.2} ${i * 4.2} 0 1 1 ${S / 2 - i * 4.2} ${S / 2}`;
  return d;
}

const PATHS: Record<string, () => string> = {
  monotonic: () => lines(45, 6),
  monotonicline: () => lines(45, 6),
  rectilinear: () => lines(45, 6),
  alignedrectilinear: () => lines(0, 6),
  zigzag: () => zigzag(8, 2.5, 6),
  crosszag: () => zigzag(8, 3, 4) + lines(90, 16),
  lockedzag: () => zigzag(8, 2, 3),
  line: () => lines(0, 7),
  grid: () => lines(0, 8) + lines(90, 8),
  triangles: () => lines(0, 9) + lines(60, 9) + lines(120, 9),
  // Versetzte Linienscharen ergeben das typische Bild aus Dreiecken und Sechsecken
  "tri-hexagon": () => lines(0, 12) + lines(60, 12) + lines(120, 12, 6),
  cubic: () => lines(30, 10) + lines(90, 10) + lines(150, 10),
  adaptivecubic: () => lines(30, 7) + lines(90, 12) + lines(150, 9),
  quartercubic: () => lines(30, 12) + lines(150, 12),
  supportcubic: () => lines(30, 14) + lines(150, 14),
  lightning,
  honeycomb: () => hexes(7),
  "3dhoneycomb": () => hexes(8, true),
  "lateral-honeycomb": () => hexes(6),
  "lateral-lattice": () => lines(60, 9) + lines(120, 9),
  crosshatch: () => lines(45, 7) + lines(135, 14),
  tpmsd: () => wave(9, 3, Math.PI / 2) + wave(9, 3, Math.PI / 2, true),
  tpmsfk: () => wave(10, 4, Math.PI),
  gyroid: () => wave(8, 3.5, Math.PI / 2),
  concentric: () => concentric(5),
  spiralinset: () => spiral(4, true),
  hilbertcurve: () => hilbert(3),
  archimedeanchords: archimedean,
  octagramspiral: octagram,
};

export function hasPatternIcon(value: string) {
  return value in PATHS;
}

export function PatternIcon({ value, size = 48 }: { value: string; size?: number }): ReactNode {
  const d = (PATHS[value] ?? (() => lines(45, 6)))();
  return (
    <svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} aria-hidden className="pattern-icon">
      <defs>
        <clipPath id="pclip">
          <rect x="1" y="1" width={S - 2} height={S - 2} rx="6" />
        </clipPath>
      </defs>
      <rect x="0.5" y="0.5" width={S - 1} height={S - 1} rx="6" fill="#141414" stroke="#2A2A2A" />
      <path d={d} clipPath="url(#pclip)" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
