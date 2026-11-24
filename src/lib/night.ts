/**
 * Nachtmodus: druckt zwischen 22 und 7 Uhr automatisch leise (50 %) und stellt morgens das
 * vorherige Tempo wieder her. Läuft, solange die App offen ist (auch minimiert).
 * Ändert der Nutzer nachts selbst das Tempo, bleibt es dabei – die Automatik greift pro Nacht nur einmal.
 *
 * Tiefschlaf: solange eingeschaltet (egal zu welcher Uhrzeit) langsam mit 30 % und Bauteillüfter
 * dauerhaft aus – schaltet der G-Code ihn wieder ein, wird er sofort wieder ausgemacht.
 * Beim Ausschalten kommen Tempo und Lüfter auf die vorigen Werte zurück.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getState } from "./store";
import { printerControl } from "./api";

const KEY = "dw.night";
const STATE = "dw.night.state";
export const NIGHT_FROM = 22;
export const NIGHT_TO = 7;
export const NIGHT_PCT = 50;
export const DEEP_PCT = 30;

export type NightMode = "off" | "quiet" | "deep";
const DEEP = "dw.night.deep";

const subs = new Set<() => void>();
function read(): NightMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "1" ? "quiet" : v === "2" ? "deep" : "off";
  } catch {
    return "off";
  }
}
export function setNightMode(mode: NightMode) {
  try {
    localStorage.setItem(KEY, mode === "quiet" ? "1" : mode === "deep" ? "2" : "0");
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
  const mode = useNightMode();
  useDeepSleep(mode === "deep");
  const on = mode === "quiet";
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

interface DeepApplied {
  file: string;
  prevSpeed: number;
  prevFan: number | null;
}
function loadDeep(): DeepApplied | null {
  try {
    return JSON.parse(localStorage.getItem(DEEP) ?? "null") as DeepApplied | null;
  } catch {
    return null;
  }
}
function saveDeep(a: DeepApplied | null) {
  try {
    localStorage.setItem(DEEP, JSON.stringify(a));
  } catch {
    /* egal */
  }
}

/** Tiefschlaf: langsam und ohne Bauteillüfter, solange eingeschaltet */
function useDeepSleep(on: boolean) {
  useEffect(() => {
    const printing = () => {
      const s = getState().status;
      return getState().connection.kind === "connected" && s && (s.state === "printing" || s.state === "paused") ? s : null;
    };
    if (!on) {
      // Ausgeschaltet: vorige Werte zurück, falls der Druck noch läuft
      const a = loadDeep();
      const s = printing();
      if (a && s && (s.fileName ?? "") === a.file) {
        if (Math.round(s.speedPct ?? 100) === DEEP_PCT) void printerControl(`speed:${a.prevSpeed}`).catch(() => {});
        if (a.prevFan != null && a.prevFan > 0 && !s.fanPct) void printerControl(`fan:${a.prevFan}`).catch(() => {});
      }
      if (a) saveDeep(null);
      return;
    }
    let sentFanOff = 0;
    const tick = () => {
      const s = printing();
      if (!s || s.state !== "printing" || s.preparing) return;
      const file = s.fileName ?? "";
      let a = loadDeep();
      if (!a || a.file !== file) {
        if (s.layer != null && s.layer < 2) return; // erste Schicht nicht anfassen
        a = { file, prevSpeed: s.speedPct != null ? Math.round(s.speedPct) : 100, prevFan: s.fanPct };
        saveDeep(a);
        if (a.prevSpeed > DEEP_PCT) void printerControl(`speed:${DEEP_PCT}`).catch(() => {});
      }
      // Der G-Code schaltet den Lüfter je Schicht wieder ein – sofort wieder aus
      if ((s.fanPct ?? 0) > 0 && Date.now() - sentFanOff > 5_000) {
        if (a.prevFan == null || a.prevFan === 0) saveDeep({ ...a, prevFan: s.fanPct });
        sentFanOff = Date.now();
        void printerControl("fan:0").catch(() => {});
      }
    };
    tick();
    const timer = setInterval(tick, 3_000);
    return () => clearInterval(timer);
  }, [on]);
}
