/**
 * Wartungsplaner: zählt Druckstunden und erinnert an Pflege nach festen Intervallen.
 * Gespeichert je Drucker im Browser-Speicher dieses Computers (Stand „erledigt bei x Stunden“).
 */
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { t } from "./i18n";

export interface MaintTask {
  id: string;
  /** Intervall in Druckstunden */
  every: number;
  title: () => string;
  how: () => string;
}

export const TASKS: MaintTask[] = [
  { id: "bed", every: 15, title: () => t("Druckplatte reinigen"), how: () => t("Mit Isopropanol oder warmem Wasser und Spülmittel – Fingerfett ist der häufigste Grund, wenn die erste Schicht nicht hält.") },
  { id: "nozzle", every: 100, title: () => t("Düse prüfen und säubern"), how: () => t("Düse auf 200 °C heizen, Reste mit einer Messingbürste entfernen. Tropft oder fädelt es, einen Cold Pull machen.") },
  { id: "rails", every: 150, title: () => t("Führungen und Z-Spindel schmieren"), how: () => t("Staub abwischen, dann einen Hauch Maschinenöl auf Linearschienen bzw. Lithiumfett auf die Z-Spindel geben.") },
  { id: "belts", every: 200, title: () => t("Riemenspannung prüfen"), how: () => t("Riemen sollen beim Zupfen einen tiefen Ton geben und nicht durchhängen – sonst entstehen Verschiebungen und Wellen.") },
  { id: "fans", every: 300, title: () => t("Lüfter entstauben"), how: () => t("Bauteil- und Hotend-Lüfter mit Druckluft oder Pinsel säubern. Ein verstaubter Hotend-Lüfter führt zu verstopften Düsen.") },
  { id: "screws", every: 300, title: () => t("Schrauben und Rahmen nachziehen"), how: () => t("Rahmen, Druckkopf und Rollen auf festen Sitz prüfen – lose Teile zeigen sich als Ringe und Wackeln im Druck.") },
  { id: "nozzle-swap", every: 600, title: () => t("Düse tauschen"), how: () => t("Messingdüsen nutzen sich ab, bei abrasivem Filament (Glow, CF) deutlich schneller. Danach Z-Offset neu einstellen.") },
];

const KEY = (printer: string) => `dw.maint.${printer || "p1"}`;

function load(printer: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY(printer)) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function store(printer: string, v: Record<string, number>) {
  try {
    localStorage.setItem(KEY(printer), JSON.stringify(v));
  } catch {
    /* privat/gesperrt – dann eben nur für diese Sitzung */
  }
}

/** Druckstunden des aktiven Druckers: Zähler des Druckers, sonst Summe aus dem App-Verlauf */
export function usePrintHours(): number | null {
  const counter = useStore((s) => s.printerHistory?.totalTimeS ?? null);
  const appSum = useStore((s) => s.jobs.reduce((a, j) => a + (j.durationS || 0), 0));
  const best = Math.max(counter ?? 0, appSum);
  return best > 0 ? best / 3600 : counter == null && appSum === 0 ? null : 0;
}

export interface MaintState {
  task: MaintTask;
  /** Stunden seit der letzten Erledigung */
  since: number;
  /** 0–1+ (1 = fällig) */
  ratio: number;
}

export function useMaintenance() {
  const printer = useStore((s) => s.settings.activePrinter);
  const hours = usePrintHours();
  const [done, setDone] = useState<Record<string, number>>(() => load(printer));
  useEffect(() => setDone(load(printer)), [printer]);
  // Neue Aufgaben (oder erster Start) beginnen beim aktuellen Stand – sonst wäre alles sofort fällig
  useEffect(() => {
    if (hours == null) return;
    const missing = TASKS.filter((x) => done[x.id] == null);
    if (missing.length === 0) return;
    const next = { ...done };
    for (const x of missing) next[x.id] = hours;
    store(printer, next);
    setDone(next);
  }, [hours, done, printer]);

  const items: MaintState[] = TASKS.map((task) => {
    const since = hours == null ? 0 : Math.max(0, hours - (done[task.id] ?? hours));
    return { task, since, ratio: since / task.every };
  });
  const markDone = (id: string) => {
    if (hours == null) return;
    const next = { ...done, [id]: hours };
    store(printer, next);
    setDone(next);
  };
  return { hours, items, markDone, due: items.filter((i) => i.ratio >= 1) };
}
