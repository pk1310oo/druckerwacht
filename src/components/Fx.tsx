/**
 * Effekte: Start-Intro und Konfetti.
 * Beide entfallen bei „Bewegung reduzieren“ im System.
 */
import { useEffect, useRef, useState } from "react";
import { accentHex } from "../lib/theme";

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
