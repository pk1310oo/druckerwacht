/**
 * Filament-Assistent: bewährte Startwerte je Materialart (Richtwerte – die Angabe auf der
 * Spule hat Vorrang). Setzt Düse, Bett und Bauteillüfter.
 */
import { t } from "../lib/i18n";

export interface Material {
  id: string;
  name: string;
  nozzle: number;
  bed: number;
  /** Bauteillüfter in % (min/max) */
  fan: [number, number];
  note: () => string;
}

export const MATERIALS: Material[] = [
  { id: "pla", name: "PLA", nozzle: 210, bed: 60, fan: [100, 100], note: () => t("Der Allrounder – leicht zu drucken.") },
  { id: "pla+", name: "PLA+ / PLA Pro", nozzle: 215, bed: 60, fan: [100, 100], note: () => t("Etwas zäher als PLA, gern 5 °C wärmer.") },
  { id: "hspla", name: "High-Speed PLA", nozzle: 220, bed: 60, fan: [100, 100], note: () => t("Für Turbo-Tempo (z. B. Hyper PLA) – fließt bei Hitze besser.") },
  { id: "silk", name: "Silk PLA", nozzle: 220, bed: 60, fan: [80, 100], note: () => t("Glänzend – langsamer drucken, sonst wird es matt.") },
  { id: "petg", name: "PETG", nozzle: 240, bed: 75, fan: [30, 50], note: () => t("Wenig Lüfter, Bett nicht zu nah – PETG klebt sehr stark.") },
  { id: "tpu", name: "TPU 95A", nozzle: 225, bed: 45, fan: [80, 100], note: () => t("Flexibel – sehr langsam drucken, Rückzug klein halten.") },
  { id: "abs", name: "ABS", nozzle: 250, bed: 100, fan: [0, 20], note: () => t("Braucht Wärme und keine Zugluft – am besten mit Einhausung.") },
  { id: "asa", name: "ASA", nozzle: 255, bed: 100, fan: [10, 30], note: () => t("Wie ABS, aber UV-fest – ideal für draußen.") },
];
