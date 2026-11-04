/**
 * NUR für die Design-Kontrolle im Browser (npm run dev → http://localhost:1420/?preview=printing).
 * Wird nie in die App gebaut und nie verwendet, wenn die App in Tauri läuft.
 * Die Werte sind erfunden und dienen ausschließlich dazu, Layout und Zustände zu prüfen.
 */
import { setState } from "../lib/store";
import type { PrinterStatus, Sample } from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/types";

const base: PrinterStatus = {
  model: "F005", hostname: "Ender-3 V3 KE", nozzleTemp: 214.6, nozzleTarget: 215, bedTemp: 59.8, bedTarget: 60,
  chamberTemp: null, state: "printing", stateCode: 1, fileName: "Halterung_Kabelkanal_v3_PLA_0.2mm",
  progress: 47, layer: 112, totalLayers: 240, elapsedS: 4920, remainingS: 5460, speedMmS: 182, speedPct: 100,
  flowPct: 100, flowMm3S: 9.4, fanPct: 100, fanAuxPct: 0, fanCasePct: 0, errorCode: 0, errorKey: 0,
  maxNozzleTemp: 300, maxBedTemp: 100,
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

export function installPreview() {
  const mode = new URLSearchParams(location.search).get("preview");
  if (!mode) return;
  const settings = {
    ...DEFAULT_SETTINGS,
    printerIp: "192.168.178.42",
    cameraUrl: new URLSearchParams(location.search).has("cam") ? "http://127.0.0.1:9/stream" : "",
  };
  const host = settings.printerIp;
  switch (mode) {
    case "printing":
      setState({ settings, connection: { kind: "connected", host, sinceMs: Date.now() }, status: base, samples: samples(20) });
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
