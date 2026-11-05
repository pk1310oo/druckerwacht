import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import "./effects.css";
import App from "./App";
import { init, isTauri } from "./lib/api";

if (/Mac/i.test(navigator.userAgent)) document.documentElement.classList.add("mac");

// Nur im Browser-Entwicklungsmodus: Design-Vorschau ohne Drucker (?preview=…).
// Wird im Produktions-Build vollständig entfernt.
if (import.meta.env.DEV && !isTauri) {
  void import("./dev/preview").then((m) => m.installPreview());
}

void init();

// Lichtschein auf Karten folgt der Maus (setzt nur zwei CSS-Variablen)
window.addEventListener(
  "pointermove",
  (e) => {
    const card = (e.target as HTMLElement | null)?.closest?.(".view .card") as HTMLElement | null;
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - r.left}px`);
    card.style.setProperty("--my", `${e.clientY - r.top}px`);
  },
  { passive: true },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
