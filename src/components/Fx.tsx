/**
 * Effekte: Start-Intro und Konfetti.
 * Beide entfallen bei „Bewegung reduzieren“ im System.
 */
import { useEffect, useRef, useState } from "react";
import { accentHex } from "../lib/theme";
import { fxLevel } from "../lib/fx";

const reduceMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Kurze Logo-Animation beim Start der App: Düse senkt sich, drei Schichten werden „gedruckt“. */
export function Intro() {
  const [phase, setPhase] = useState<"show" | "leave" | "gone">(() => {
    const q = new URLSearchParams(location.search);
    // In der Browser-Vorschau (Screenshots) nur auf Wunsch
    if (reduceMotion() || (q.has("preview") && !q.has("intro"))) return "gone";
    return "show";
  });
  useEffect(() => {
    if (phase !== "show") return;
    const a = setTimeout(() => setPhase("leave"), 1900);
    const b = setTimeout(() => setPhase("gone"), 2500);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [phase]);
  if (phase === "gone") return null;
  return (
    <div className={`intro ${phase}`} aria-hidden>
      <svg viewBox="0 0 120 120" className="intro-logo">
        <g className="intro-nozzle">
          <path d="M44 22h32v12l-8 12H52l-8-12z" fill="#F5F4EF" />
          <rect x="56.5" y="46" width="7" height="9" rx="2" fill="#F5F4EF" />
        </g>
        <rect className="intro-layer l1" x="26" y="92" width="68" height="10" rx="5" />
        <rect className="intro-layer l2" x="26" y="78" width="68" height="10" rx="5" />
        <rect className="intro-layer l3" x="26" y="64" width="68" height="10" rx="5" />
      </svg>
      <div className="intro-word">Druckerwacht</div>
    </div>
  );
}

/** Konfetti-Explosion, z. B. wenn ein Druck fertig ist. Zeigt sich, solange `fire` hochzählt. */
export function Confetti({ fire }: { fire: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!fire || reduceMotion()) return;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr;
    cv.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = [accentHex(), "#4CAF7A", "#F5F4EF", "#E0A43A"];
    const parts = Array.from({ length: 160 }, () => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const v = 7 + Math.random() * 9;
      return {
        x: innerWidth / 2 + (Math.random() - 0.5) * 200,
        y: innerHeight * 0.55,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        w: 6 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        c: colors[Math.floor(Math.random() * colors.length)],
      };
    });
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = (now - t0) / 2600;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.28;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - k * k);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        ctx.restore();
      }
      if (k < 1) raf = requestAnimationFrame(step);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [fire]);
  return <canvas ref={canvas} className="confetti" aria-hidden />;
}

/**
 * Lebender Hintergrund: Neon-Gitterboden mit Tiefe, aufsteigende Glutfunken und Parallax
 * zur Maus. Beim Drucken lebhafter. Pausiert, wenn das Fenster nicht sichtbar ist.
 */
export function BackgroundFx({ printing, off = false }: { printing: boolean; off?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef(printing);
  live.current = printing;
  const hidden = useRef(off);
  hidden.current = off;
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const calm = reduceMotion();
    let w = 0, h = 0;
    const resize = () => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w;
      cv.height = h;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    const onMove = (e: PointerEvent) => {
      mouse.tx = e.clientX / innerWidth;
      mouse.ty = e.clientY / innerHeight;
    };
    addEventListener("pointermove", onMove, { passive: true });

    const rgb = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim().split(/\s+/).map(Number);
    const col = (a: number) => `rgba(${rgb[0] ?? 217},${rgb[1] ?? 119},${rgb[2] ?? 87},${a})`;
    type P = { x: number; y: number; v: number; r: number; s: number; ph: number };
    const spawn = (anyY: boolean): P => ({ x: Math.random(), y: anyY ? Math.random() : 1.05, v: 0.02 + Math.random() * 0.05, r: 0.6 + Math.random() * 1.8, s: Math.random() * 2 - 1, ph: Math.random() * 6.28 });
    const parts: P[] = Array.from({ length: 140 }, () => spawn(true));

    let raf = 0, last = performance.now(), off = 0;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const boost = live.current ? 1.8 : 1;
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      ctx.clearRect(0, 0, w, h);

      // Gitterboden: Fluchtpunkt folgt leicht der Maus
      const horizon = h * (0.62 + (mouse.y - 0.5) * 0.04);
      const vx = w * (0.5 + (mouse.x - 0.5) * 0.12);
      off = (off + dt * 0.35 * boost) % 1;
      ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const t = (i + off) / 14; // 0 = Horizont, 1 = vorne
        const y = horizon + (h - horizon) * t * t;
        ctx.strokeStyle = col(0.03 + 0.26 * t * t);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      for (let i = -14; i <= 14; i++) {
        const xb = vx + i * w * 0.09;
        const g = ctx.createLinearGradient(0, horizon, 0, h);
        g.addColorStop(0, col(0));
        g.addColorStop(1, col(0.24));
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(vx + i * 6, horizon);
        ctx.lineTo(xb + (xb - vx) * 1.6, h);
        ctx.stroke();
      }
      // Horizont-Glühen
      const hg = ctx.createRadialGradient(vx, horizon, 0, vx, horizon, w * 0.45);
      hg.addColorStop(0, col(0.22 * boost));
      hg.addColorStop(1, col(0));
      ctx.fillStyle = hg;
      ctx.fillRect(0, 0, w, h); // ganze Fläche – sonst entstehen harte Kanten am Rechteckrand

      // Glutfunken
      const n = live.current ? parts.length : 80;
      for (let i = 0; i < n; i++) {
        const p = parts[i];
        p.y -= p.v * dt * boost;
        p.ph += dt * 2;
        if (p.y < -0.05) Object.assign(p, spawn(false));
        const x = (p.x + Math.sin(p.ph) * 0.004 * p.s - (mouse.x - 0.5) * 0.02 * p.r) * w;
        const y = p.y * h;
        const a = (0.4 + 0.5 * Math.sin(p.ph * 1.7) ** 2) * Math.min(1, p.y * 3);
        ctx.fillStyle = col(a);
        ctx.shadowColor = col(0.9);
        ctx.shadowBlur = 6 * p.r;
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      if (!calm) raf = requestAnimationFrame(loop);
    };
    const loop = (now: number) => {
      if (document.hidden || hidden.current) {
        if (hidden.current) ctx.clearRect(0, 0, w, h);
        last = now;
        raf = requestAnimationFrame(loop);
        return;
      }
      draw(now);
    };
    raf = requestAnimationFrame(calm ? draw : loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("pointermove", onMove);
    };
  }, []);
  return <canvas ref={canvas} className="bg-fx" aria-hidden />;
}

/** Dünner leuchtender Fortschrittsbalken über die ganze Fensterbreite (in jeder Ansicht). */
export function TopBeam({ pct, tone }: { pct: number | null; tone: "live" | "paused" | "done" | null }) {
  if (pct == null || tone == null) return null;
  return (
    <div className={`top-beam ${tone}`} aria-hidden>
      <i style={{ width: `${Math.max(1, Math.min(100, pct))}%` }} />
    </div>
  );
}

/** Wellen-Effekt beim Klick auf Knöpfe (einmal global einrichten). */
export function installRipple() {
  if (reduceMotion()) return;
  addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.(".btn, .speed-mode, .accent-swatch, .seg button") as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled || fxLevel() === "calm") return;
      const r = el.getBoundingClientRect();
      const s = document.createElement("span");
      const d = Math.max(r.width, r.height) * 2.2;
      s.className = "ripple";
      s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
      el.appendChild(s);
      setTimeout(() => s.remove(), 650);
    },
    { passive: true },
  );
}
