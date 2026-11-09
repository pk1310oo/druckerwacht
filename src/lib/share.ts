/**
 * Teilen-Karte: ein Bild (1080×1350, Instagram-Hochformat) vom fertigen Druck mit Dauer,
 * Filament, Kosten und Datum – zum Posten oder Verschicken.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";
import { accentHex } from "./theme";
import { fmtDuration, fmtNum } from "./format";
import { locale, t } from "./i18n";

export interface ShareData {
  file: string;
  durationS: number | null;
  /** Filament in Gramm */
  grams: number | null;
  /** Kosten in € (Filament + Strom) */
  cost: number | null;
  endedMs: number | null;
  printer: string;
  ok: boolean;
}

const W = 1080;
const H = 1350;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/(?<=[ _-])/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (ctx.measureText(cur + w).width > maxW && cur) {
      lines.push(cur.trim());
      cur = w;
    } else cur += w;
  }
  if (cur) lines.push(cur.trim());
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{2}$/, "") + "…";
  }
  return lines;
}

export function drawShareCard(d: ShareData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d")!;
  const accent = accentHex();
  // Hintergrund mit Leuchten
  x.fillStyle = "#0e0e0e";
  x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(W / 2, 430, 40, W / 2, 430, 700);
  glow.addColorStop(0, accent + "55");
  glow.addColorStop(1, "transparent");
  x.fillStyle = glow;
  x.fillRect(0, 0, W, H);
  // Gitterboden
  x.strokeStyle = accent + "22";
  x.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    const y = 980 + i * i * 3.2;
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(W, y);
    x.stroke();
  }
  for (let i = -10; i <= 10; i++) {
    x.beginPath();
    x.moveTo(W / 2 + i * 40, 980);
    x.lineTo(W / 2 + i * 220, H);
    x.stroke();
  }
  // Fortschrittsring 100 %
  const cx = W / 2, cy = 400, r = 210;
  x.lineWidth = 26;
  x.strokeStyle = "#232323";
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.stroke();
  x.shadowColor = accent;
  x.shadowBlur = 40;
  x.strokeStyle = d.ok ? accent : "#e05a4f";
  x.beginPath();
  x.arc(cx, cy, r, -Math.PI / 2, Math.PI * 1.5);
  x.stroke();
  x.shadowBlur = 0;
  // Haken bzw. Kreuz
  x.lineCap = "round";
  x.lineWidth = 30;
  x.strokeStyle = "#f5f4ef";
  x.beginPath();
  if (d.ok) {
    x.moveTo(cx - 85, cy + 5);
    x.lineTo(cx - 20, cy + 70);
    x.lineTo(cx + 95, cy - 65);
  } else {
    x.moveTo(cx - 70, cy - 70);
    x.lineTo(cx + 70, cy + 70);
    x.moveTo(cx + 70, cy - 70);
    x.lineTo(cx - 70, cy + 70);
  }
  x.stroke();
  // Texte
  const font = "Inter, -apple-system, 'Segoe UI', Roboto, sans-serif";
  x.textAlign = "center";
  x.fillStyle = accent;
  x.font = `600 34px ${font}`;
  x.fillText((d.ok ? t("Fertig gedruckt") : t("Druck beendet")).toUpperCase(), cx, 700);
  x.fillStyle = "#f5f4ef";
  x.font = `700 64px ${font}`;
  const name = d.file.replace(/\.(b?gcode|gco|g)$/i, "").replace(/_/g, " ");
  wrap(x, name, W - 140, 2).forEach((l, i) => x.fillText(l, cx, 790 + i * 76));
  // Kennzahlen
  const stats: [string, string][] = [
    [t("Dauer"), fmtDuration(d.durationS)],
    [t("Filament"), d.grams != null ? `${fmtNum(d.grams, 0)} g` : "–"],
    [t("Kosten"), d.cost != null ? `${fmtNum(d.cost, 2)} €` : "–"],
  ];
  stats.forEach(([k, v], i) => {
    const sx = 200 + i * 340;
    x.fillStyle = "#a3a3a3";
    x.font = `500 28px ${font}`;
    x.fillText(k.toUpperCase(), sx, 1010);
    x.fillStyle = "#f5f4ef";
    x.font = `700 52px ${font}`;
    x.fillText(v, sx, 1075);
  });
  // Fußzeile
  x.fillStyle = "#a3a3a3";
  x.font = `500 30px ${font}`;
  const date = d.endedMs ? new Date(d.endedMs).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" }) : "";
  x.fillText([d.printer, date].filter(Boolean).join(" · "), cx, 1200);
  x.fillStyle = accent;
  x.font = `700 36px ${font}`;
  x.fillText("Druckerwacht", cx, 1275);
  return c;
}

/** Bild speichern; liefert false, wenn abgebrochen */
export async function saveShareCard(d: ShareData): Promise<boolean> {
  const url = drawShareCard(d).toDataURL("image/png");
  const base = d.file.replace(/\.(b?gcode|gco|g)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "druck";
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.png`;
    a.click();
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ title: t("Bild speichern"), defaultPath: `${base}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (!path) return false;
  await invoke("save_png", { path: /\.png$/i.test(path) ? path : `${path}.png`, data: url });
  return true;
}
