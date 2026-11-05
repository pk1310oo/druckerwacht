/**
 * Farbthemen: Die Akzentfarbe der ganzen App (Knöpfe, Balken, Diagramme, Effekte).
 * Orange ist der Standard; die übrigen Farben sind so gewählt, dass sie sich von
 * Erfolg (Grün), Warnung (Gelb) und Fehler (Rot) unterscheiden.
 */
export type ThemeId = "orange" | "blue" | "green" | "purple" | "pink";

interface Theme {
  accent: string;
  hover: string;
  light: string;
  deep: string;
  deepDark: string;
}

export const THEMES: Record<ThemeId, Theme> = {
  orange: { accent: "#d97757", hover: "#e68a6b", light: "#ffd2bf", deep: "#b85e40", deepDark: "#8c3d26" },
  blue: { accent: "#5b8def", hover: "#7aa4f5", light: "#cfe0ff", deep: "#3f6fcf", deepDark: "#24427e" },
  green: { accent: "#2fb59a", hover: "#4cc9ae", light: "#c4f2e6", deep: "#1f8f78", deepDark: "#145548" },
  purple: { accent: "#9b7cf0", hover: "#b096f5", light: "#e3d8ff", deep: "#7a5bd6", deepDark: "#46348a" },
  pink: { accent: "#e06c9f", hover: "#ea88b3", light: "#ffd6e8", deep: "#c04e83", deepDark: "#7a2c50" },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

export function resolveTheme(id: string | undefined): ThemeId {
  return id && id in THEMES ? (id as ThemeId) : "orange";
}

/** Setzt die CSS-Variablen der Akzentfarbe auf dem Dokument. */
export function applyTheme(id: ThemeId) {
  const t = THEMES[id];
  const s = document.documentElement.style;
  s.setProperty("--accent", t.accent);
  s.setProperty("--accent-hover", t.hover);
  s.setProperty("--accent-light", t.light);
  s.setProperty("--accent-deep", t.deep);
  s.setProperty("--accent-rgb", rgb(t.accent));
  s.setProperty("--accent-deep-rgb", rgb(t.deepDark));
}

/** Aktuelle Akzentfarbe als Hex (für Canvas/Diagramme). */
export function accentHex(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d97757";
}
