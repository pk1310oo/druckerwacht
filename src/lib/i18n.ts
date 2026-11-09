/**
 * Übersetzung: Der deutsche Text ist zugleich der Schlüssel. Fehlt eine englische
 * Übersetzung, bleibt der deutsche Text stehen – es kann also nichts kaputtgehen.
 * Platzhalter: t("Schicht {n} von {total}", { n, total })
 */
import { EN } from "../i18n/en";
import { ES } from "../i18n/es";
import { FR } from "../i18n/fr";
import { PL } from "../i18n/pl";

export type Lang = "de" | "en" | "es" | "fr" | "pl";
export const LANGS: Lang[] = ["de", "en", "es", "fr", "pl"];
const DICT: Record<Exclude<Lang, "de">, Record<string, string>> = { en: EN, es: ES, fr: FR, pl: PL };

let current: Lang = "de";

export function setLang(l: Lang) {
  current = l;
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

export function getLang(): Lang {
  return current;
}

/** Englische Zahlen-/Zeitformate (Punkt als Dezimaltrenner, 12-h-Uhr) */
export const isEn = () => current === "en";
/** Deutsch? (für „Uhr“ und Texte, die es nur auf Deutsch gibt) */
export const isDe = () => current === "de";

/** "" = Systemsprache; im Browser-Vorschaumodus lässt sich mit ?lang=en umschalten. */
export function resolveLang(setting: string): Lang {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
  if (q && (LANGS as string[]).includes(q)) return q as Lang;
  if ((LANGS as string[]).includes(setting)) return setting as Lang;
  const sys = (typeof navigator !== "undefined" ? navigator.languages?.[0] ?? navigator.language ?? "" : "").toLowerCase().slice(0, 2);
  return (LANGS as string[]).includes(sys) ? (sys as Lang) : "en";
}

export function t(de: string, vars?: Record<string, string | number>): string {
  const s = current === "de" ? de : DICT[current][de] ?? EN[de] ?? de;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Locale für Zahlen und Datum */
export const locale = () => ({ de: "de-DE", en: "en-US", es: "es-ES", fr: "fr-FR", pl: "pl-PL" })[current];

/** Dezimaltrenner für Eingabefelder: 0,4 (de) bzw. 0.4 (en). Eingaben akzeptieren beides. */
export const fmtDec = (s: string) => (current === "en" ? s : s.replace(".", ","));
