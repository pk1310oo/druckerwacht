/**
 * Creality-Fehlercodes in Klartext. Nur Codes, deren Bedeutung von Creality (Wiki/Handbuch)
 * belegt ist; alles andere bekommt einen Such-Link.
 */
import { t } from "./i18n";

export function explainError(code: number): { title: string; fix: string } | null {
  switch (code) {
    case 2111:
      return {
        title: t("Düse zu kalt zum Extrudieren (unter 170 °C)"),
        fix: t("Meist ein Wackelkontakt am Heizelement oder Thermistor oder ein starker Luftzug. Kabel am Druckkopf prüfen und neu starten."),
      };
    case 2509:
      return {
        title: t("Temperaturfühler der Düse liefert keinen Wert"),
        fix: t("Der Thermistor ist vermutlich lose oder abgerissen. Drucker ausschalten und den Stecker am Druckkopf prüfen."),
      };
    case 2515:
      return {
        title: t("Düsentemperatur über dem Grenzwert"),
        fix: t("Möglicher Kurzschluss am Thermistor. Drucker sofort ausschalten und Kabel prüfen."),
      };
    case 2564:
      return {
        title: t("Düse heizt nicht wie erwartet"),
        fix: t("Heizelement oder Kabel defekt – oft hilft nur ein neues Hotend-Kit (Creality-Support)."),
      };
    default:
      return null;
  }
}

export const errorSearchUrl = (code: number) => `https://duckduckgo.com/?q=creality+error+${code}`;
