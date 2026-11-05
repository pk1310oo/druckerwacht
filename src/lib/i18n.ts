/**
 * Übersetzung: Der deutsche Text ist zugleich der Schlüssel. Fehlt eine englische
 * Übersetzung, bleibt der deutsche Text stehen – es kann also nichts kaputtgehen.
 * Platzhalter: t("Schicht {n} von {total}", { n, total })
 */
import { EN } from "../i18n/en";

export type Lang = "de" | "en";

let current: Lang = "de";

export function setLang(l: Lang) {
  current = l;
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

export function getLang(): Lang {
  return current;
}

export const isEn = () => current === "en";

/** "" = Systemsprache; im Browser-Vorschaumodus lässt sich mit ?lang=en umschalten. */
export function resolveLang(setting: string): Lang {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
  if (q === "de" || q === "en") return q;
  if (setting === "de" || setting === "en") return setting;
  const sys = typeof navigator !== "undefined" ? navigator.languages?.[0] ?? navigator.language ?? "" : "";
  return /^de\b/i.test(sys) ? "de" : "en";
}

export function t(de: string, vars?: Record<string, string | number>): string {
  const s = current === "en" ? EN[de] ?? de : de;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Locale für Zahlen und Datum */
export const locale = () => (current === "en" ? "en-US" : "de-DE");

/** Dezimaltrenner für Eingabefelder: 0,4 (de) bzw. 0.4 (en). Eingaben akzeptieren beides. */
export const fmtDec = (s: string) => (current === "en" ? s : s.replace(".", ","));
