/**
 * Nachtmodus: druckt zwischen 22 und 7 Uhr automatisch leise (50 %) und stellt morgens das
 * vorherige Tempo wieder her. Läuft, solange die App offen ist (auch minimiert).
 * Ändert der Nutzer nachts selbst das Tempo, bleibt es dabei – die Automatik greift pro Nacht nur einmal.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getState } from "./store";
import { printerControl } from "./api";

const KEY = "dw.night";
const STATE = "dw.night.state";
export const NIGHT_FROM = 22;
export const NIGHT_TO = 7;
export const NIGHT_PCT = 50;

const subs = new Set<() => void>();
function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
export function setNightMode(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* egal */
  }
  subs.forEach((f) => f());
}
export function useNightMode() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    read,
  );
}

export const isNight = (d = new Date()) => d.getHours() >= NIGHT_FROM || d.getHours() < NIGHT_TO;

/** Endet ein Druck mit dieser Restzeit in der Nacht? */
export function endsAtNight(remainingS: number | null | undefined) {
  if (remainingS == null) return false;
  return isNight(new Date(Date.now() + remainingS * 1000));
}

interface Applied {
  file: string;
  /** Datum der Nacht (Abend), damit es pro Nacht nur einmal greift */
  night: string;
  prev: number;
  restored?: boolean;
}

function nightId(d = new Date()) {
  const x = new Date(d);
  if (x.getHours() < NIGHT_TO) x.setDate(x.getDate() - 1);
  return x.toDateString();
}

function loadApplied(): Applied | null {
  try {
    return JSON.parse(localStorage.getItem(STATE) ?? "null") as Applied | null;
  } catch {
    return null;
  }
}
function saveApplied(a: Applied | null) {
  try {
    localStorage.setItem(STATE, JSON.stringify(a));
  } catch {
    /* egal */
  }
}

/** Einmal in der App einhängen (App.tsx) */
export function useNightAutomation() {
  const on = useNightMode();
  useEffect(() => {
    if (!on) return;
    const tick = () => {
      const s = getState().status;
      if (getState().connection.kind !== "connected" || !s || s.state !== "printing" || s.preparing) return;
      if (s.layer != null && s.layer < 2) return; // erste Schicht nicht anfassen
      const file = s.fileName ?? "";
      const cur = s.speedPct != null ? Math.round(s.speedPct) : 100;
      const a = loadApplied();
      if (isNight()) {
        const id = nightId();
        if (a && a.file === file && a.night === id) return; // diese Nacht schon erledigt
        if (cur <= NIGHT_PCT) {
          saveApplied({ file, night: id, prev: cur, restored: true });
          return;
        }
        saveApplied({ file, night: id, prev: cur });
        void printerControl(`speed:${NIGHT_PCT}`).catch(() => saveApplied(a));
      } else if (a && !a.restored && a.file === file) {
        saveApplied({ ...a, restored: true });
        // Nur zurückstellen, wenn niemand nachts selbst etwas geändert hat
        if (cur === NIGHT_PCT) void printerControl(`speed:${a.prev}`).catch(() => {});
      }
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [on]);
}
