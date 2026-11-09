/**
 * Stromkosten: durchschnittliche Leistung des Druckers beim Drucken und Strompreis.
 * Gilt für diesen Computer. Richtwert Ender 3 V3 KE: etwa 120 W im Mittel
 * (Aufheizen kurz deutlich mehr, danach hält das Bett die Temperatur).
 */
import { useSyncExternalStore } from "react";

export interface Power {
  watts: number;
  /** €/kWh */
  price: number;
}

const KEY = "dw.power";
const DEFAULT: Power = { watts: 120, price: 0.35 };
const subs = new Set<() => void>();
let cache: Power | null = null;

export function getPower(): Power {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Power> | null;
    cache = { watts: Number(v?.watts) > 0 ? Number(v!.watts) : DEFAULT.watts, price: Number(v?.price) >= 0 && v?.price != null ? Number(v.price) : DEFAULT.price };
  } catch {
    cache = DEFAULT;
  }
  return cache;
}

export function setPower(p: Partial<Power>) {
  cache = { ...getPower(), ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* egal */
  }
  subs.forEach((f) => f());
}

export function usePower(): Power {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getPower,
  );
}

export const kwhOf = (durationS: number, p: Power = getPower()) => (durationS / 3600) * (p.watts / 1000);
export const powerCost = (durationS: number, p: Power = getPower()) => kwhOf(durationS, p) * p.price;
