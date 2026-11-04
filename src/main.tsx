import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import App from "./App";
import { init, isTauri } from "./lib/api";

if (/Mac/i.test(navigator.userAgent)) document.documentElement.classList.add("mac");

// Nur im Browser-Entwicklungsmodus: Design-Vorschau ohne Drucker (?preview=…).
// Wird im Produktions-Build vollständig entfernt.
if (import.meta.env.DEV && !isTauri) {
  void import("./dev/preview").then((m) => m.installPreview());
}

void init();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
