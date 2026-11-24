/**
 * Nachtmodus: druckt zwischen 22 und 7 Uhr automatisch leise (50 %) und stellt morgens das
 * vorherige Tempo wieder her. Läuft, solange die App offen ist (auch minimiert).
 * Ändert der Nutzer nachts selbst das Tempo, bleibt es dabei – die Automatik greift pro Nacht nur einmal.
 *
 * Tiefschlaf (eigene Tempo-Stufe unter „Flüster“): 20 % und ALLE steuerbaren Lüfter aus
 * (Bauteil-, Zusatz- und Gehäuselüfter). Schaltet der G-Code einen wieder ein, macht die App ihn
 * sofort wieder aus. Gilt, bis eine andere Tempo-Stufe gewählt wird – dann kommen die Lüfter zurück.
 * Der Kühlkörper-Lüfter am Hotend läuft immer weiter (nicht abschaltbar, schützt die Düse).
 */
import { useEffect, useSyncExternalStore } from "react";
import { getState } from "./store";
import { printerControl } from "./api";
import type { PrinterStatus } from "./types";

const KEY = "dw.night";
const STATE = "dw.night.state";
export const NIGHT_FROM = 22;
export const NIGHT_TO = 7;
export const NIGHT_PCT = 50;
export const DEEP_PCT = 20;
const DEEP_KEY = "dw.deep";
const DEEP = "dw.deep.state";

const subs = new Set<() => void>();
const readKey = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const writeKey = (k: string, on: boolean) => {
  try {
    localStorage.setItem(k, on ? "1" : "0");
  } catch {
    /* egal */
  }
  subs.forEach((f) => f());
};
const read = () => readKey(KEY);
export const setNightMode = (on: boolean) => writeKey(KEY, on);
export const setDeepSleep = (on: boolean) => writeKey(DEEP_KEY, on);
export function useDeepSleepMode() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => readKey(DEEP_KEY),
  );
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
  const deep = useDeepSleepMode();
  useDeepSleep(deep);
  const on = useNightMode() && !deep;
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

type FanKey = "fan" | "fan_aux" | "fan_case";
const FANS: [FanKey, (s: PrinterStatus) => number | null][] = [
  ["fan", (s) => s.fanPct],
  ["fan_aux", (s) => s.fanAuxPct],
  ["fan_case", (s) => s.fanCasePct],
];

interface DeepApplied {
  file: string;
  /** Lüfterwerte vor dem Tiefschlaf (zum Zurückstellen) */
  prev: Partial<Record<FanKey, number>>;
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

/** Tiefschlaf: 20 % und alle steuerbaren Lüfter aus, solange die Stufe gewählt ist */
function useDeepSleep(on: boolean) {
  useEffect(() => {
    const job = () => {
      const s = getState().status;
      return getState().connection.kind === "connected" && s && (s.state === "printing" || s.state === "paused") ? s : null;
    };
    if (!on) {
      // Andere Stufe gewählt: Lüfter wieder auf die vorigen Werte
      const a = loadDeep();
      const s = job();
      if (a && s && (s.fileName ?? "") === a.file) {
        for (const [k, get] of FANS) {
          const prev = a.prev[k];
          if (prev && !get(s)) void printerControl(`${k}:${prev}`).catch(() => {});
        }
      }
      if (a) saveDeep(null);
      return;
    }
    const lastOff: Partial<Record<FanKey, number>> = {};
    const tick = () => {
      const s = job();
      if (!s || s.state !== "printing") return;
      const file = s.fileName ?? "";
      let a = loadDeep();
      if (!a || a.file !== file) {
        a = { file, prev: {} };
        saveDeep(a);
        // Neuer Druck im Tiefschlaf: Tempo wieder auf 20 % (der Start-G-Code setzt 100 %)
        if (!s.preparing && Math.round(s.speedPct ?? 100) !== DEEP_PCT) void printerControl(`speed:${DEEP_PCT}`).catch(() => {});
        else if (s.preparing) a.file = ""; // nach dem Heizen/Leveling erneut prüfen
        saveDeep(a);
      }
      // Jeder Lüfter, den der Drucker meldet und der läuft, wird ausgeschaltet
      for (const [k, get] of FANS) {
        const v = get(s);
        if (v == null || v <= 0) continue;
        if (!a.prev[k] || v > (a.prev[k] ?? 0)) {
          a.prev[k] = Math.round(v);
          saveDeep(a);
        }
        if (Date.now() - (lastOff[k] ?? 0) > 5_000) {
          lastOff[k] = Date.now();
          void printerControl(`${k}:0`).catch(() => {});
        }
      }
    };
    tick();
    const timer = setInterval(tick, 3_000);
    return () => clearInterval(timer);
  }, [on]);
}
