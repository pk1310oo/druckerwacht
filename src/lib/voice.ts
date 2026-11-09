/**
 * Sprachansagen am Computer: Druckstart, 25/50/75 %, Pause (Farbwechsel), fertig, Fehler.
 * Nutzt die Sprachausgabe des Systems (Web Speech API); gilt nur für diesen Computer.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useStore } from "./store";
import { isEn, t } from "./i18n";
import { plannedPauses } from "./sentPrint";

const KEY = "dw.voice";
const subs = new Set<() => void>();

export const voiceSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

function read() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setVoice(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* egal */
  }
  subs.forEach((f) => f());
  if (on) say(t("Sprachansagen sind an."));
}

export function useVoice() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    read,
  );
}

export function say(text: string) {
  if (!voiceSupported()) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = isEn() ? "en-US" : "de-DE";
    const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(isEn() ? "en" : "de"));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch {
    /* keine Sprachausgabe */
  }
}

/** Dateiname zum Vorlesen: ohne Endung, Unterstriche als Pausen, nicht zu lang */
const spoken = (f: string | null) =>
  (f ?? "")
    .replace(/\.(b?gcode|gco|g)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b(PLA|PETG|ABS|ASA|TPU)\b.*$/i, "")
    .trim()
    .slice(0, 60);

/** Einmal in der App einhängen */
export function useVoiceAnnouncements() {
  const on = useVoice();
  const state = useStore((s) => (s.connection.kind === "connected" ? s.status?.state ?? null : null));
  const preparing = useStore((s) => s.status?.preparing ?? false);
  const quarter = useStore((s) => (s.status?.state === "printing" ? Math.floor((s.status.progress ?? 0) / 25) : -1));
  const file = useStore((s) => s.status?.fileName ?? null);
  const layer = useStore((s) => s.status?.layer ?? null);
  const prev = useRef<{ state: string | null; quarter: number; preparing: boolean }>({ state, quarter, preparing });

  useEffect(() => {
    const p = prev.current;
    prev.current = { state, quarter, preparing };
    if (!on || state == null || p.state == null) return;
    if (state !== p.state) {
      if (state === "printing" && p.state !== "paused") say(t("Druck gestartet: {f}", { f: spoken(file) }));
      else if (state === "printing" && p.state === "paused") say(t("Druck läuft weiter."));
      else if (state === "paused") {
        const change = plannedPauses(file).some((l) => layer != null && layer >= l - 1 && layer <= l);
        say(change ? t("Filamentwechsel. Bitte die neue Farbe laden.") : t("Druck pausiert."));
      } else if (state === "finished") say(t("Druck fertig: {f}. Die Platte kann abgenommen werden.", { f: spoken(file) }));
      else if (state === "failed") say(t("Achtung, der Drucker meldet einen Fehler."));
      else if (state === "aborted") say(t("Druck abgebrochen."));
      return;
    }
    if (state === "printing" && !preparing && p.preparing) say(t("Aufheizen fertig, der Druck beginnt."));
    if (state === "printing" && quarter > p.quarter && quarter >= 1 && quarter <= 3) say(t("{p} Prozent geschafft.", { p: quarter * 25 }));
  }, [on, state, quarter, preparing, file, layer]);
}
