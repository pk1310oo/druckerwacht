import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import "./effects.css";
import App from "./App";
import { init, isTauri } from "./lib/api";
import { installRipple } from "./components/Fx";

if (/Mac/i.test(navigator.userAgent)) document.documentElement.classList.add("mac");

// Nur im Browser-Entwicklungsmodus: Design-Vorschau ohne Drucker (?preview=…).
// Wird im Produktions-Build vollständig entfernt.
if (import.meta.env.DEV && !isTauri) {
  void import("./dev/preview").then((m) => m.installPreview());
}

void init();

installRipple();

// Lichtschein auf Karten folgt der Maus; kleinere Karten neigen sich zusätzlich in 3D zur Maus
const TILT = ".stats > .card, .spool-card, .fil-stat";
const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
let tilted: HTMLElement | null = null;
window.addEventListener(
  "pointermove",
  (e) => {
    const card = (e.target as HTMLElement | null)?.closest?.(".view .card") as HTMLElement | null;
    if (tilted && tilted !== card) {
      tilted.style.removeProperty("--rx");
      tilted.style.removeProperty("--ry");
      tilted.classList.remove("tilting");
      tilted = null;
    }
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - r.left}px`);
    card.style.setProperty("--my", `${e.clientY - r.top}px`);
    if (!calm && document.documentElement.dataset.fx !== "calm" && card.matches(TILT)) {
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty("--rx", `${(-ny * 4).toFixed(2)}deg`);
      card.style.setProperty("--ry", `${(nx * 5).toFixed(2)}deg`);
      card.classList.add("tilting");
      tilted = card;
    }
  },
  { passive: true },
);
document.addEventListener("pointerleave", () => {
  tilted?.style.removeProperty("--rx");
  tilted?.style.removeProperty("--ry");
  tilted?.classList.remove("tilting");
  tilted = null;
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
