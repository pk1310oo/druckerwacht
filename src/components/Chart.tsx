import { locale, t } from "../lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { LineChart } from "lucide-react";
import type { Sample } from "../lib/types";
import { fmtNum } from "../lib/format";
import { Card } from "./ui";

export interface SeriesDef {
  key: keyof Omit<Sample, "t">;
  label: string;
  color: string;
  unit: string;
  dashed?: boolean;
  /** "y" = linke Achse, "pct" = rechte Achse */
  scale?: "y" | "pct";
  digits?: number;
  /** In der Legende ausblenden (z. B. Soll-Werte, die neben dem Ist-Wert stehen) */
  hideInLegend?: boolean;
}

const AXIS = "#A3A3A3";
const GRID = "rgba(255,255,255,0.05)";

interface Props {
  title: string;
  samples: Sample[];
  windowMin: number;
  series: SeriesDef[];
  yUnit: string;
  pctAxis?: boolean;
  yMinMax?: number;
}

export function Chart({ title, samples, windowMin, series, yUnit, pctAxis, yMinMax = 10 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const windowRef = useRef(windowMin);
  windowRef.current = windowMin;

  const data = useMemo<uPlot.AlignedData>(() => {
    const from = Date.now() - windowMin * 60_000;
    const rows = samples.filter((s) => s.t >= from);
    return [rows.map((s) => s.t / 1000), ...series.map((d) => rows.map((s) => s[d.key]))] as uPlot.AlignedData;
  }, [samples, windowMin, series]);

  // Plot einmal anlegen
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const font = "12px Inter Variable, Inter, system-ui, sans-serif";
    const axisBase = {
      stroke: AXIS,
      font,
      grid: { stroke: GRID, width: 1 },
      ticks: { show: false },
      gap: 8,
    };
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: el.clientHeight,
      legend: { show: false },
      padding: [8, pctAxis ? 0 : 8, 0, 0],
      cursor: {
        points: { size: 6, fill: (u, i) => (u.series[i].stroke as () => string)?.() ?? "#fff" },
        drag: { x: false, y: false },
      },
      scales: {
        // Feste Zeitachse: immer das gewählte Fenster, rechts endet „jetzt“
        x: {
          time: true,
          range: (_u, min, max) => {
            const end = max ?? Date.now() / 1000;
            return [Math.min(min ?? end, end - windowRef.current * 60), end];
          },
        },
        y: { range: (_u, _min, max) => [0, niceMax(Math.max(yMinMax, max ?? 0))] },
        pct: { range: (_u, _min, max) => [0, Math.max(100, niceMax(max ?? 0))] },
      },
      axes: [
        {
          ...axisBase,
          grid: { show: false },
          values: (_u, ticks) =>
            ticks.map((t) => new Date(t * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })),
          space: 64,
        },
        { ...axisBase, scale: "y", size: 48, values: (_u, t) => t.map((v) => `${v}${yUnit}`), space: 40 },
        ...(pctAxis
          ? [{ ...axisBase, scale: "pct", side: 1, size: 48, grid: { show: false }, values: (_u: uPlot, t: number[]) => t.map((v) => `${v} %`), space: 40 }]
          : []),
      ],
      series: [
        {},
        ...series.map((d, i) => ({
          label: d.label,
          stroke: d.color,
          // Farbverlauf unter der ersten Kurve
          fill: i === 0 && !d.dashed ? (u: uPlot) => {
            const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
            g.addColorStop(0, d.color + "38");
            g.addColorStop(1, d.color + "00");
            return g;
          } : undefined,
          width: d.dashed ? 1.25 : 2,
          dash: d.dashed ? [5, 5] : undefined,
          scale: d.scale ?? "y",
          spanGaps: false,
          points: { show: false },
        })),
      ],
      hooks: {
        setCursor: [(u) => setHoverIdx(u.cursor.idx ?? null)],
      },
    };
    plot.current = new uPlot(opts, data, el);

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) plot.current?.setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // Bewusst nur einmal: Daten kommen über setData
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    plot.current?.setData(data, true);
  }, [data]);

  const count = data[0].length;
  const idx = hoverIdx != null && hoverIdx < count ? hoverIdx : count - 1;

  return (
    <Card className="chart-card">
      <div className="chart-head">
        <span className="label">{title}</span>
        <div className="legend">
          {series.map((d, i) =>
            d.hideInLegend ? null : (
              <span key={d.key}>
                <i className={`swatch ${d.dashed ? "dashed" : ""}`} style={{ background: d.color, borderColor: d.color }} />
                {d.label}
                <b className="num">
                  {idx >= 0 ? fmtNum(data[i + 1][idx] as number | null, d.digits ?? 0) : "–"}
                  {idx >= 0 && data[i + 1][idx] != null ? ` ${d.unit}` : ""}
                </b>
              </span>
            ),
          )}
        </div>
      </div>
      <div className="chart-box">
        <div ref={box} className="chart-plot" style={{ opacity: count < 2 ? 0 : 1 }} />
        {count < 2 && (
          <div className="chart-empty">
            <LineChart size={20} strokeWidth={1.5} />
            <span>{t("Noch keine Messwerte")}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 10;
  const step = v > 200 ? 50 : v > 50 ? 25 : 10;
  return Math.ceil((v * 1.1) / step) * step;
}
