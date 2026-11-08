/**
 * Druckertypen: was die Oberfläche je Typ zeigt und wie er eingerichtet wird.
 * Gegenstück im Backend: src-tauri/src/adapter/control.rs
 */
import { useStore } from "./store";
import { t } from "./i18n";
import type { PrinterKind, PrinterProfile } from "./types";

export const KINDS: PrinterKind[] = ["creality", "moonraker", "octoprint", "prusalink"];

export interface Caps {
  /** Tempo live ändern */
  speed: boolean;
  /** Temperaturen setzen */
  temps: boolean;
  light: boolean;
  fan: boolean;
  /** Referenzfahrt, Leveling, Kalibrieren, Z-Offset, Filament fördern, Motoren aus */
  tools: boolean;
  /** Der eingebaute Slicer hat passende Profile */
  slicer: boolean;
  /** Vorschaubilder und Druckverlauf vom Drucker */
  creality: boolean;
}

export function capsOf(kind: PrinterKind | undefined): Caps {
  const k = kind ?? "creality";
  const gcode = k === "creality" || k === "moonraker" || k === "octoprint";
  return { speed: gcode, temps: gcode, light: k === "creality", fan: gcode, tools: gcode, slicer: k === "creality", creality: k === "creality" };
}

export function defaultPort(kind: PrinterKind) {
  return kind === "moonraker" ? 7125 : kind === "creality" ? 9999 : 80;
}

/** Texte zum Einrichten je Typ (beim Anzeigen übersetzt) */
export function kindInfo(kind: PrinterKind) {
  switch (kind) {
    case "moonraker":
      return {
        label: t("Klipper (Moonraker)"),
        models: t("Voron, Sovol SV06/SV07/SV08, Elegoo Neptune 4, Qidi, RatRig, Creality mit Root und alle Drucker mit Mainsail oder Fluidd"),
        keyLabel: t("API-Schlüssel (optional)"),
        hint: t("Adresse wie in Mainsail/Fluidd. Port 7125 ist Standard. Einen API-Schlüssel nur eintragen, wenn Moonraker eine Anmeldung verlangt."),
      };
    case "octoprint":
      return {
        label: "OctoPrint",
        models: t("Praktisch jeder Marlin-Drucker am Raspberry Pi: Ender 3, Prusa MK3, Anycubic, Artillery …"),
        keyLabel: t("API-Schlüssel"),
        hint: t("API-Schlüssel in OctoPrint unter Einstellungen → Application Keys bzw. API erzeugen."),
      };
    case "prusalink":
      return {
        label: "Prusa (PrusaLink)",
        models: t("Prusa MK4/MK4S, MK3.9, Core One, Mini, XL"),
        keyLabel: t("Passwort"),
        hint: t("Passwort steht am Druckerdisplay unter Einstellungen → Netzwerk → PrusaLink (Benutzer „maker“). Über PrusaLink gehen Pause, Fortsetzen, Abbrechen und Dateien senden – Temperaturen und Tempo nicht."),
      };
    default:
      return {
        label: "Creality",
        models: t("Ender 3 V3 KE, K1, K1C, K1 Max, K1 SE"),
        keyLabel: null,
        hint: t("Zu finden am Druckerdisplay unter Einstellungen → Netzwerk. Verbindung über Port 9999."),
      };
  }
}

export function hostLabel(p: Pick<PrinterProfile, "host" | "port">) {
  return p.port ? `${p.host}:${p.port}` : p.host;
}

export function newPrinterId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Typ des aktiven Druckers (primitiv – sicher für useStore) */
export function useActiveKind(): PrinterKind {
  return useStore((s) => s.settings.printers.find((p) => p.id === s.settings.activePrinter)?.kind ?? "creality");
}

export function useCaps(): Caps {
  return capsOf(useActiveKind());
}
