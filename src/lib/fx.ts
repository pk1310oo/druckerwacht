/**
 * Effekt-Stufe dieses Computers: „voll“ (Neon-Hintergrund, 3D-Karten, Korn, Funken) oder
 * „dezent“ für schwächere Rechner. Gespeichert pro Gerät, nicht in den Druckereinstellungen.
 */
import { useSyncExternalStore } from "react";

export type FxLevel = "full" | "calm";
const KEY = "dw.effects";
const listeners = new Set<() => void>();

function read(): FxLevel {
  try {
    return localStorage.getItem(KEY) === "calm" ? "calm" : "full";
  } catch {
    return "full";
  }
}

let level = read();
document.documentElement.dataset.fx = level;

export function setFxLevel(l: FxLevel) {
  level = l;
  document.documentElement.dataset.fx = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* egal */
  }
  for (const fn of listeners) fn();
}

export const fxLevel = () => level;

export function useFxLevel(): FxLevel {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => level,
  );
}
