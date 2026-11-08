/**
 * NUR für die Design-Kontrolle im Browser (npm run dev → http://localhost:1420/?preview=printing).
 * Wird nie in die App gebaut und nie verwendet, wenn die App in Tauri läuft.
 * Die Werte sind erfunden und dienen ausschließlich dazu, Layout und Zustände zu prüfen.
 */
import { getState, pushSample, setState } from "../lib/store";
import type { PrinterStatus, Sample } from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/types";

const base: PrinterStatus = {
  model: "F005", hostname: "Ender-3 V3 KE", nozzleTemp: 214.6, nozzleTarget: 215, bedTemp: 59.8, bedTarget: 60,
  chamberTemp: null, state: "printing", stateCode: 1, fileName: "Halterung_Kabelkanal_v3_PLA_0.2mm",
  progress: 47, layer: 112, totalLayers: 240, elapsedS: 4920, remainingS: 5460, speedMmS: 182, speedPct: 100,
  flowPct: 100, flowMm3S: 9.4, fanPct: 100, fanAuxPct: 0, fanCasePct: 0, errorCode: 0, errorKey: 0,
  maxNozzleTemp: 300, maxBedTemp: 100, preparing: false, usedMaterialMm: 4210, position: [118, 104, 22.4],
};

function samples(minutes: number): Sample[] {
  const now = Date.now();
  const out: Sample[] = [];
  for (let i = minutes * 60; i >= 0; i--) {
    const t = now - i * 1000;
    const k = (minutes * 60 - i) / 60;
    const warm = Math.min(1, k / 3);
    out.push({
      t,
      nozzle: 25 + 190 * warm + Math.sin(i / 7) * 0.8,
      nozzleTarget: 215,
      bed: 25 + 35 * Math.min(1, k / 2) + Math.sin(i / 13) * 0.3,
      bedTarget: 60,
      speed: k < 3 ? 0 : 150 + 45 * Math.sin(i / 23) + 20 * Math.sin(i / 5),
      flow: 100,
      fan: k < 4 ? 0 : 100,
    });
  }
  return out;
}

/** Aufheizen in der Vorbereitung: Bett zuerst, dann Düse – endet bei den Werten oben in den Karten. */
function heating(): Sample[] {
  const now = Date.now();
  const out: Sample[] = [];
  const n = 240;
  for (let i = n; i >= 0; i--) {
    const k = (n - i) / n;
    out.push({
      t: now - i * 1000,
      nozzle: 25 + 143.4 * Math.max(0, (k - 0.35) / 0.65) + Math.sin(i / 5) * 0.3,
      nozzleTarget: 215,
      bed: 25 + 33.9 * Math.min(1, k / 0.8),
      bedTarget: 60,
      speed: 0,
      flow: 100,
      fan: 0,
    });
  }
  return out;
}

export function installPreview() {
  // Für Demo-Aufnahmen (scripts/video/): Zugriff auf den Zustand
  (window as unknown as { __dwStore: unknown }).__dwStore = { getState, setState, pushSample };
  if (new URLSearchParams(location.search).has("orca")) (window as unknown as { __dwOrca: string }).__dwOrca = "/Applications/OrcaSlicer.app";
  const mode = new URLSearchParams(location.search).get("preview");
  if (!mode) return;
  const fleet = new URLSearchParams(location.search).has("fleet");
  const settings = {
    ...DEFAULT_SETTINGS,
    printerIp: "192.168.178.42",
    activePrinter: "p1",
    printers: [
      { id: "p1", name: "Ender 3 V3 KE", kind: "creality" as const, host: "192.168.178.42", port: null, key: "" },
      ...(fleet
        ? [
            { id: "p2", name: "Voron 2.4", kind: "moonraker" as const, host: "voron.local", port: null, key: "" },
            { id: "p3", name: "Prusa MK4", kind: "prusalink" as const, host: "192.168.178.57", port: null, key: "geheim" },
          ]
        : []),
    ],
    cameraUrl: new URLSearchParams(location.search).has("cam") ? "http://127.0.0.1:9/stream" : "",
  };
  const host = settings.printerIp;
  if (fleet)
    setState({
      others: [
        { id: "p2", name: "Voron 2.4", kind: "moonraker", connection: { kind: "connected", host: "voron.local", sinceMs: Date.now() }, status: { ...base, progress: 63, remainingS: 2280, state: "printing" } },
        { id: "p3", name: "Prusa MK4", kind: "prusalink", connection: { kind: "connected", host: "192.168.178.57", sinceMs: Date.now() }, status: { ...base, state: "idle", nozzleTemp: 24.8, bedTemp: 23.9 } },
      ],
    });
  switch (mode) {
    case "printing":
      setState({ settings, connection: { kind: "connected", host, sinceMs: Date.now() }, status: base, samples: samples(20) });
      break;
    case "paused":
      setState({ settings, connection: { kind: "connected", host, sinceMs: Date.now() }, status: { ...base, state: "paused", stateCode: 5 }, samples: samples(20) });
      break;
    case "preparing":
      setState({
        settings,
        connection: { kind: "connected", host, sinceMs: Date.now() },
        status: { ...base, preparing: true, progress: 0, layer: 0, elapsedS: 0, remainingS: 5460, nozzleTemp: 168.4, bedTemp: 58.9, speedMmS: 0, fanPct: 0, usedMaterialMm: null },
        samples: heating(),
      });
      break;
    case "idle":
      setState({
        settings,
        connection: { kind: "connected", host, sinceMs: Date.now() },
        status: { ...base, state: "idle", stateCode: 0, nozzleTarget: 0, bedTarget: 0, nozzleTemp: 26.1, bedTemp: 24.9, speedMmS: 0, fanPct: 0, progress: 0, fileName: null },
        samples: [],
      });
      break;
    case "connecting":
      setState({ settings, connection: { kind: "connecting", host, attempt: 1 }, status: null, samples: [] });
      break;
    case "reconnecting":
      setState({ settings, connection: { kind: "reconnecting", host, attempt: 3, retryInS: 8, reason: "Drucker antwortet nicht" }, status: null, samples: [] });
      break;
    case "history":
      setState({
        printerHistory: {
          totalJobs: 50,
          totalTimeS: 144225,
          totalMaterialMm: 240194,
          jobs: [
            { id: 1793803870, file: "1st_Layer_test.stl_PLA_5m18s", startedS: 1793803870, durationS: 305, materialMm: 803.9, finished: true, thumbnail: "/usr/data/creality/userdata/history/humbnail/1793803870.png" },
            { id: 1793737074, file: "Halterung_Kabelkanal_v3", startedS: 1793737074, durationS: 7020, materialMm: 9120, finished: true, thumbnail: null },
            { id: 1793600000, file: "Benchy_PETG", startedS: 1793600000, durationS: 1900, materialMm: 2300, finished: false, thumbnail: null },
          ],
        },
      });
      setState({
        settings,
        connection: { kind: "connected", host, sinceMs: Date.now() },
        jobs: [
          { file: "Halterung_Kabelkanal_v3_PLA_0.2mm", startedMs: Date.now() - 9e6, endedMs: Date.now() - 2e6, durationS: 7000, result: "finished", layers: 240 },
          { file: "Benchy_PETG", startedMs: Date.now() - 9e7, endedMs: Date.now() - 8.6e7, durationS: 3900, result: "aborted", layers: 160 },
          { file: "Schublade_Organizer_gross", startedMs: Date.now() - 2e8, endedMs: Date.now() - 1.7e8, durationS: 30200, result: "failed", layers: null },
        ],
      });
      break;
    default:
      setState({ settings: DEFAULT_SETTINGS });
  }
}

// Slicer-Profile für die Browser-Vorschau (nur Entwicklung)
const files = import.meta.glob("../../src-tauri/resources/profiles/**/*.json", { eager: true, import: "default" }) as Record<string, Record<string, unknown> & { name: string }>;
const pick = (kind: string) => Object.entries(files).filter(([p]) => p.includes(`/${kind}/`)).map(([, v]) => v);
(window as unknown as { __dwPresets: unknown }).__dwPresets = {
  machine: pick("machine")[0],
  process: pick("process"),
  filament: pick("filament"),
  userProcess: [],
  userFilament: [],
};
