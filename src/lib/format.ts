import type { Connection, PrintState } from "./types";
import { isDe, locale, t } from "./i18n";

export const DASH = "–";

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 5400 → "1 h 30 min", 300 → "5 min", 42 → "< 1 min" */
export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return DASH;
  if (s < 60) return "< 1 min";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

/** Voraussichtliches Ende als Uhrzeit, bei anderem Tag mit Wochentag. */
export function fmtEta(remainingS: number | null | undefined): string {
  if (remainingS == null || !Number.isFinite(remainingS)) return DASH;
  const end = new Date(Date.now() + remainingS * 1000);
  const sameDay = end.toDateString() === new Date().toDateString();
  const time = fmtClock(end.getTime());
  const suffix = isDe() ? " Uhr" : "";
  return sameDay ? `${time}${suffix}` : `${end.toLocaleDateString(locale(), { weekday: "short" })} ${time}${suffix}`;
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(locale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Bezeichnungen werden beim Zugriff übersetzt (Getter), damit die Sprache sofort wirkt. */
export const STATE_LABEL: Record<PrintState, string> = {
  get idle() { return t("Bereit"); },
  get printing() { return t("Druckt"); },
  get paused() { return t("Pausiert"); },
  get finished() { return t("Fertig"); },
  get failed() { return t("Fehler"); },
  get aborted() { return t("Abgebrochen"); },
  get unknown() { return t("Unbekannt"); },
};

export const STATE_TONE: Record<PrintState, Tone> = {
  idle: "neutral",
  printing: "accent",
  paused: "warning",
  finished: "success",
  failed: "danger",
  aborted: "warning",
  unknown: "neutral",
};

export function connectionLabel(c: Connection): string {
  switch (c.kind) {
    case "unconfigured":
      return t("Nicht eingerichtet");
    case "connecting":
      return t("Verbinde…");
    case "connected":
      return t("Verbunden");
    case "reconnecting":
      return t("Getrennt");
  }
}
