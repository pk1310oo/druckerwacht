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

export interface Settings {
  printerName: string;
  printerIp: string;
  cameraUrl: string;
  notifyFinished: boolean;
  notifyError: boolean;
  notifyDisconnect: boolean;
  rawLog: boolean;
}

export interface JobRecord {
  file: string;
  startedMs: number;
  endedMs: number;
  durationS: number;
  result: "finished" | "failed" | "aborted";
  layers: number | null;
}

export interface FoundPrinter {
  ip: string;
  model: string | null;
  hostname: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  printerName: "Ender 3 V3 KE",
  printerIp: "",
  cameraUrl: "",
  notifyFinished: true,
  notifyError: true,
  notifyDisconnect: true,
  rawLog: false,
};
