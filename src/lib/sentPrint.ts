/**
 * Merkt sich den zuletzt aus Druckerwacht gestarteten Druck (G-Code-Pfad und geplante
 * Filamentwechsel), damit Dashboard und 3D-Ansicht ihn dem laufenden Druck zuordnen können.
 */
export interface SentPrint {
  name: string;
  gcodePath: string;
  /** Schichtnummern (ab 1), vor denen der Drucker für einen Filamentwechsel anhält */
  pauses?: number[];
}

const base = (n: string) => n.replace(/^.*[\\/]/, "").replace(/\.gcode$/i, "");

/** Gleiche Datei? (Pfade und Endung „.gcode“ werden ignoriert) */
export const sameFile = (a: string, b: string) => base(a) === base(b);

export function rememberSentPrint(
  name: string,
  gcodePath: string,
  pauses: number[] = [],
) {
  try {
    localStorage.setItem(
      "dw.lastSent",
      JSON.stringify({ name, gcodePath, pauses }),
    );
  } catch {
    /* egal */
  }
}

export function lastSent(): SentPrint | null {
  try {
    return JSON.parse(localStorage.getItem("dw.lastSent") ?? "null");
  } catch {
    return null;
  }
}

/** Geplante Filamentwechsel des laufenden Drucks, falls er aus Druckerwacht kam */
export function plannedPauses(fileName: string | null | undefined): number[] {
  const sent = lastSent();
  return fileName && sent && sameFile(sent.name, fileName)
    ? (sent.pauses ?? [])
    : [];
}
