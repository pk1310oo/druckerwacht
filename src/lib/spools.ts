/**
 * Filament-Lager: Spulen mit Restmenge und Preis. Gespeichert im App-Speicher (localStorage).
 * Nach jedem Druck wird der Verbrauch von der aktiven Spule abgezogen.
 */
import { useSyncExternalStore } from "react";

export const MATERIALS = ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "PLA-CF", "Andere"] as const;
export type Material = (typeof MATERIALS)[number];

/** Dichte in g/cm³ – für Gramm aus Filamentlänge */
const DENSITY: Record<Material, number> = { PLA: 1.24, "PLA+": 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, "PLA-CF": 1.29, Andere: 1.24 };
/** Querschnitt von 1,75-mm-Filament in mm² */
const AREA = Math.PI * 0.875 ** 2;

export interface Spool {
  id: string;
  name: string;
  material: Material;
  color: string;
  /** Netto-Gewicht einer vollen Spule in g */
  weightG: number;
  remainingG: number;
  /** Preis in € pro kg */
  pricePerKg: number;
  addedMs: number;
}

interface SpoolState {
  spools: Spool[];
  activeId: string | null;
  /** Gesamtverbrauch und -kosten seit Beginn */
  usedG: number;
  spentEur: number;
}

const KEY = "dw.spools";
const empty: SpoolState = { spools: [], activeId: null, usedG: 0, spentEur: 0 };

function load(): SpoolState {
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(KEY) ?? "null") };
  } catch {
    return empty;
  }
}

let state = load();
const listeners = new Set<() => void>();

function commit(next: SpoolState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* egal */
  }
  for (const fn of listeners) fn();
}

export function useSpools(): SpoolState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => state,
  );
}

export const activeSpool = (s: SpoolState = state) => s.spools.find((x) => x.id === s.activeId) ?? null;

export function gramsFromMm(mm: number, material: Material = "PLA") {
  return ((mm * AREA) / 1000) * DENSITY[material];
}

/** Restlänge in Metern aus Gramm (für das jeweilige Material) */
export function metersFromGrams(g: number, material: Material = "PLA") {
  return g / ((AREA / 1000) * DENSITY[material]) / 1000;
}

export const costOf = (grams: number, spool: Spool | null) => (spool ? (grams / 1000) * spool.pricePerKg : null);

export function addSpool(s: Omit<Spool, "id" | "addedMs">) {
  const spool: Spool = { ...s, id: `s${Date.now()}`, addedMs: Date.now() };
  commit({ ...state, spools: [...state.spools, spool], activeId: state.activeId ?? spool.id });
  return spool;
}

export function updateSpool(id: string, patch: Partial<Spool>) {
  commit({ ...state, spools: state.spools.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}

export function removeSpool(id: string) {
  const spools = state.spools.filter((s) => s.id !== id);
  commit({ ...state, spools, activeId: state.activeId === id ? (spools[0]?.id ?? null) : state.activeId });
}

export function setActiveSpool(id: string) {
  commit({ ...state, activeId: id });
}

/** Verbrauch eines Drucks (Filamentlänge in mm) von der aktiven Spule abziehen. */
export function consume(mm: number) {
  const spool = activeSpool();
  if (!(mm > 0)) return;
  const g = gramsFromMm(mm, spool?.material);
  commit({
    ...state,
    usedG: state.usedG + g,
    spentEur: state.spentEur + (costOf(g, spool) ?? 0),
    spools: state.spools.map((s) => (s.id === spool?.id ? { ...s, remainingG: Math.max(0, s.remainingG - g) } : s)),
  });
}
