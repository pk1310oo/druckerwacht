/**
 * Gemerkter Z-Offset je Drucker: nach dem Einstellen im Erste-Schicht-Test „merken“ –
 * die App wendet ihn dann bei jedem Druck automatisch an, sobald Heizen und Leveling vorbei sind.
 * (Funktioniert auf jedem Drucker gleich, ohne die Drucker-Konfiguration zu verändern.)
 */
import { useEffect, useSyncExternalStore } from "react";
import { getState } from "./store";
import { printerControl } from "./api";

const KEY = (id: string) => `dw.zoffset.${id || "p1"}`;
const APPLIED = "dw.zoffset.applied";
const subs = new Set<() => void>();

function read(id: string): number {
  try {
    const v = Number(localStorage.getItem(KEY(id)));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function setSavedZ(id: string, v: number) {
  try {
    if (Math.abs(v) < 0.0005) localStorage.removeItem(KEY(id));
    else localStorage.setItem(KEY(id), String(Math.round(v * 1000) / 1000));
  } catch {
    /* egal */
  }
  subs.forEach((f) => f());
}

export function useSavedZ(): number {
  const id = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => getState().settings.activePrinter,
  );
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => read(id),
  );
}

/** Wendet den Offset in Schritten von höchstens ±0,2 mm an (Grenze der Steuerung) */
export async function applyZ(total: number) {
  let left = Math.round(total * 1000) / 1000;
  while (Math.abs(left) > 0.0005) {
    const step = Math.max(-0.2, Math.min(0.2, left));
    await printerControl(`zoffset:${step}`);
    left = Math.round((left - step) * 1000) / 1000;
  }
}

/** Einmal in der App einhängen: wendet den gemerkten Offset zu Beginn jedes Drucks an */
export function useZOffsetAutomation() {
  useEffect(() => {
    const tick = () => {
      const st = getState();
      const s = st.status;
      const id = st.settings.activePrinter;
      const z = read(id);
      if (st.connection.kind !== "connected" || !s) return;
      // Druck vorbei → beim nächsten Druck wieder anwenden
      if (s.state !== "printing" && s.state !== "paused") {
        try {
          localStorage.removeItem(APPLIED);
        } catch {
          /* egal */
        }
        return;
      }
      if (!z || s.state !== "printing" || s.preparing) return;
      // Nur in den ersten Minuten eines Drucks – nicht mitten drin nach einem App-Neustart
      if (s.elapsedS != null && s.elapsedS > 15 * 60) return;
      if (s.layer != null && s.layer > 3) return;
      const key = `${id}|${s.fileName ?? ""}`;
      let last = "";
      try {
        last = localStorage.getItem(APPLIED) ?? "";
      } catch {
        /* egal */
      }
      if (last === key) return;
      try {
        localStorage.setItem(APPLIED, key);
      } catch {
        /* egal */
      }
      void applyZ(z).catch(() => {});
    };
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, []);
}
