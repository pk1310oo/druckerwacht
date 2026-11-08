export type PrintState = "idle" | "printing" | "paused" | "finished" | "failed" | "aborted" | "unknown";

export interface PrinterStatus {
  model: string | null;
  hostname: string | null;
  nozzleTemp: number | null;
  nozzleTarget: number | null;
  bedTemp: number | null;
  bedTarget: number | null;
  chamberTemp: number | null;
  state: PrintState;
  stateCode: number | null;
  preparing: boolean;
  fileName: string | null;
  progress: number | null;
  layer: number | null;
  totalLayers: number | null;
  elapsedS: number | null;
  remainingS: number | null;
  speedMmS: number | null;
  speedPct: number | null;
  flowPct: number | null;
  flowMm3S: number | null;
  fanPct: number | null;
  fanAuxPct: number | null;
  fanCasePct: number | null;
  errorCode: number | null;
  errorKey: number | null;
  maxNozzleTemp: number | null;
  maxBedTemp: number | null;
  usedMaterialMm: number | null;
  /** Druckkopf [X, Y, Z] in mm */
  position: [number, number, number] | null;
}

export type Connection =
  | { kind: "unconfigured" }
  | { kind: "connecting"; host: string; attempt: number }
  | { kind: "connected"; host: string; sinceMs: number }
  | { kind: "reconnecting"; host: string; attempt: number; retryInS: number; reason: string };

export interface Sample {
  t: number;
  nozzle: number | null;
  nozzleTarget: number | null;
  bed: number | null;
  bedTarget: number | null;
  speed: number | null;
  flow: number | null;
  fan: number | null;
}

/** Druckertypen mit eigener Anbindung (siehe src-tauri/src/adapter) */
export type PrinterKind = "creality" | "moonraker" | "octoprint" | "prusalink";

export interface PrinterProfile {
  id: string;
  name: string;
  kind: PrinterKind;
  /** IP-Adresse oder Hostname */
  host: string;
  /** Nur wenn abweichend vom Standard des Typs */
  port: number | null;
  /** API-Schlüssel (OctoPrint, optional Moonraker) bzw. Passwort (PrusaLink) */
  key: string;
}

/** Weitere eingerichtete Drucker, die im Hintergrund mitlaufen */
export interface OtherPrinter {
  id: string;
  name: string;
  kind: PrinterKind;
  connection: Connection;
  status: PrinterStatus | null;
}

export interface Settings {
  /** Name des aktiven Druckers (vom Backend aus `printers` abgeleitet) */
  printerName: string;
  /** Adresse des aktiven Druckers (vom Backend aus `printers` abgeleitet) */
  printerIp: string;
  printers: PrinterProfile[];
  /** ID des Druckers, der im Dashboard und Slicer gezeigt wird */
  activePrinter: string;
  cameraUrl: string;
  notifyFinished: boolean;
  notifyError: boolean;
  notifyDisconnect: boolean;
  rawLog: boolean;
  orcaPath: string;
  /** "" = wie das System, "de" oder "en" */
  language: "" | "de" | "en";
  /** Farbthema der Akzentfarbe */
  accent: "orange" | "blue" | "green" | "purple" | "pink" | "cyan" | "lime";
  /** Thema für Push-Nachrichten aufs Handy (ntfy.sh), leer = aus */
  ntfyTopic: string;
  /** Zeitraffer aufnehmen, wenn eine Kamera eingerichtet ist */
  timelapse: boolean;
  /** Webcam am Computer (Geräte-ID, leer = keine) */
  localCamera: string;
}

export interface JobRecord {
  file: string;
  startedMs: number;
  endedMs: number;
  durationS: number;
  result: "finished" | "failed" | "aborted";
  layers: number | null;
}

export interface PrinterJob {
  id: number;
  file: string;
  startedS: number;
  durationS: number;
  materialMm: number;
  finished: boolean;
  thumbnail: string | null;
}

export interface PrinterHistory {
  totalJobs: number | null;
  totalTimeS: number | null;
  totalMaterialMm: number | null;
  jobs: PrinterJob[];
}

export interface FoundPrinter {
  ip: string;
  model: string | null;
  hostname: string | null;
  kind: PrinterKind;
  port: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  printerName: "Ender 3 V3 KE",
  printerIp: "",
  printers: [],
  activePrinter: "",
  cameraUrl: "",
  notifyFinished: true,
  notifyError: true,
  notifyDisconnect: true,
  rawLog: false,
  orcaPath: "",
  language: "",
  accent: "orange",
  ntfyTopic: "",
  timelapse: true,
  localCamera: "",
};
