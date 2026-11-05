import { useSyncExternalStore } from "react";
import type { Connection, JobRecord, PrinterHistory, PrinterStatus, Sample, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export interface AppStore {
  ready: boolean;
  connection: Connection;
  status: PrinterStatus | null;
  samples: Sample[];
  settings: Settings;
  jobs: JobRecord[];
  printerHistory: PrinterHistory | null;
}

const MAX_SAMPLES = 3600;

let state: AppStore = {
  ready: false,
  connection: { kind: "unconfigured" },
  status: null,
  samples: [],
  settings: DEFAULT_SETTINGS,
  jobs: [],
  printerHistory: null,
};
const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<AppStore>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function pushSample(s: Sample) {
  const samples = state.samples.length >= MAX_SAMPLES ? state.samples.slice(-MAX_SAMPLES + 1) : state.samples.slice();
  samples.push(s);
  setState({ samples });
}

export function useStore<T>(selector: (s: AppStore) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}
