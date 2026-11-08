import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Box, Flame, Gauge, Layers, ListOrdered, Loader2, Moon, Palette, Pause, Play, PlugZap, Printer, Square, Thermometer, WifiOff, X } from "lucide-react";
import { useStore } from "../lib/store";
import { printerControl, reconnect, thumbnailUrl } from "../lib/api";
import { DASH, fmtDuration, fmtEta, fmtNum, STATE_LABEL, STATE_TONE } from "../lib/format";
import type { PrinterStatus } from "../lib/types";
import { Badge, Card, EmptyState, Rolling, Segmented, StatCard } from "../components/ui";
import { Chart, type SeriesDef } from "../components/Chart";
import { CameraBox } from "../components/Camera";
import { useCameraSource } from "../lib/webcam";

import type { ViewId } from "../components/Shell";
import { t } from "../lib/i18n";
import { accentHex } from "../lib/theme";
import { plannedPauses, rememberSentPrint } from "../lib/sentPrint";
import { onQueueChange, queueList, queueRemove, queueShift, queueStart, type QueueItem } from "../lib/extras";
import { FleetStrip, ToolsCard } from "./Tools";
import { useCaps } from "../lib/printers";
import { errorSearchUrl, explainError } from "../lib/errors";
import { openProjectLink } from "../lib/update";
import { endsAtNight, NIGHT_FROM, NIGHT_PCT, NIGHT_TO, setNightMode, useNightMode } from "../lib/night";

const TEMP_SERIES = (): SeriesDef[] => [
  { key: "nozzle", label: t("Düse"), color: accentHex(), unit: "°C" },
  { key: "nozzleTarget", label: t("Düse Soll"), color: accentHex(), unit: "°C", dashed: true, hideInLegend: true },
  { key: "bed", label: t("Bett"), color: "#C9C7BF", unit: "°C" },
  { key: "bedTarget", label: t("Bett Soll"), color: "#C9C7BF", unit: "°C", dashed: true, hideInLegend: true },
];

const MOTION_SERIES = (): SeriesDef[] => [
  { key: "speed", label: t("Geschw."), color: accentHex(), unit: "mm/s" },
  { key: "flow", label: "Flow", color: "#C9C7BF", unit: "%", scale: "pct" },
  { key: "fan", label: t("Lüfter"), color: "#7C7C7C", unit: "%", scale: "pct" },
];

const WINDOWS = [
  { value: 5, label: "5 min" },
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
];

function loadWindow(): number {
  try {
    const v = Number(localStorage.getItem("chartWindow"));
    return [5, 15, 60].includes(v) ? v : 15;
  } catch {
    return 15;
  }
}

export function Dashboard({ go }: { go: (v: ViewId) => void }) {
  const connection = useStore((s) => s.connection);
  const status = useStore((s) => s.status);
  const samples = useStore((s) => s.samples);
  const [windowMin, setWindowMin] = useState(loadWindow);
  const camera = useCameraSource();
  const tempSeries = useMemo(TEMP_SERIES, []);
  // Kurzes grünes Leuchten, wenn ein Druck fertig wird
  const [celebrate, setCelebrate] = useState(false);
  const prevState = useRef(status?.state);
  useEffect(() => {
    const was = prevState.current;
    prevState.current = status?.state;
    if (was && was !== "finished" && status?.state === "finished") {
      setCelebrate(true);
      const timer = setTimeout(() => setCelebrate(false), 1900);
      return () => clearTimeout(timer);
    }
  }, [status?.state]);
  const motionSeries = useMemo(MOTION_SERIES, []);

  useEffect(() => {
    try {
      localStorage.setItem("chartWindow", String(windowMin));
    } catch {
      /* egal */
    }
  }, [windowMin]);

  if (connection.kind === "unconfigured") {
    return (
      <div className="view">
        <Card>
          <EmptyState
            icon={Printer}
            accent
            title={t("Drucker einrichten")}
            text={t("Druckerwacht kann Creality (KE, K1), Klipper-, OctoPrint- und Prusa-Drucker überwachen. Lass das Netzwerk durchsuchen oder trag die IP-Adresse von Hand ein.")}
            actions={
              <button className="btn primary" onClick={() => go("settings")}>
                {t("Zu den Einstellungen")}
              </button>
            }
          />
        </Card>
      </div>
    );
  }

  const connected = connection.kind === "connected";

  return (
    <div className="view">
      <FleetStrip />
      {connected && status && ((status.errorCode ?? 0) > 0 || (status.errorKey ?? 0) > 0) && <ErrorBanner s={status} />}
      <div className={`top-row${camera ? " with-cam" : ""}`}>
        <HeroCard s={status} celebrate={celebrate} />
        <Stats status={status} />
      </div>

      <ToolsCard s={status} connected={connected} />

      <QueueCard status={status} connected={connection.kind === "connected"} />

      <div className="section-head">
        <span className="label">{t("Diagramme")}</span>
        <Segmented ariaLabel={t("Zeitraum")} value={windowMin} options={WINDOWS} onChange={setWindowMin} />
      </div>
      <div className="charts">
        <Chart title={t("Temperatur")} samples={samples} windowMin={windowMin} series={tempSeries} yUnit="°" yMinMax={50} />
        <Chart title={t("Geschwindigkeit")} samples={samples} windowMin={windowMin} series={motionSeries} yUnit="" pctAxis yMinMax={50} />
      </div>

      {!connected && status && (
        <p className="hint" style={{ textAlign: "center" }}>
          {t("Angezeigt werden die zuletzt empfangenen Werte.")}
        </p>
      )}
    </div>
  );
}

/** Temperatur als Bogen: Skala bis zur Maximaltemperatur, Punkt = Solltemperatur, Glühen beim Aufheizen. */
function tempGauge(temp: number | null, target: number | null, max: number) {
  if (temp == null) return { pct: 0 };
  const heating = !!target && target > 0 && temp < target - 2;
  return { pct: (temp / max) * 100, target: target ? (target / max) * 100 : null, hot: heating || (!!target && target > 0) };
}

function heatMeter(temp: number | null, target: number | null, max: number) {
  if (temp == null) return { pct: 0 };
  if (target && target > 0) return { pct: (temp / target) * 100, active: temp < target - 2 };
  return { pct: (temp / max) * 100 };
}

function Stats({ status: s }: { status: PrinterStatus | null }) {
  const target = (v: number | null | undefined) =>
    v == null ? DASH : v <= 0 ? t("aus") : `${fmtNum(v)} °C`;
  return (
    <div className="stats">
      <StatCard
        label={t("Düse")}
        icon={Thermometer}
        value={s?.nozzleTemp ?? null}
        unit="°C"
        meter={heatMeter(s?.nozzleTemp ?? null, s?.nozzleTarget ?? null, s?.maxNozzleTemp ?? 300)}
        gauge={tempGauge(s?.nozzleTemp ?? null, s?.nozzleTarget ?? null, s?.maxNozzleTemp ?? 300)}
        sub={
          <span>
            {t("Soll")} <b className="num">{target(s?.nozzleTarget)}</b>
          </span>
        }
      />
      <StatCard
        label={t("Bett")}
        icon={Box}
        value={s?.bedTemp ?? null}
        unit="°C"
        meter={heatMeter(s?.bedTemp ?? null, s?.bedTarget ?? null, s?.maxBedTemp ?? 100)}
        gauge={tempGauge(s?.bedTemp ?? null, s?.bedTarget ?? null, s?.maxBedTemp ?? 100)}
        sub={
          <span>
            {t("Soll")} <b className="num">{target(s?.bedTarget)}</b>
          </span>
        }
      />
      <StatCard
        label={t("Geschwindigkeit")}
        icon={Gauge}
        value={s?.speedMmS ?? null}
        unit="mm/s"
        meter={null}
        gauge={{ pct: ((s?.speedMmS ?? 0) / 500) * 100, hot: (s?.speedMmS ?? 0) > 0 && s?.state === "printing" }}
        sub={
          <>
            <span>
              Flow <b className="num">{fmtNum(s?.flowPct)}{s?.flowPct != null && " %"}</b>
            </span>
            <span>
              {t("Lüfter")} <b className="num">{fmtNum(s?.fanPct)}{s?.fanPct != null && " %"}</b>
            </span>
          </>
        }
      />
      <StatCard
        label={t("Fortschritt")}
        icon={Layers}
        value={s && isJob(s) ? s.progress : null}
        unit="%"
        meter={s && isJob(s) ? { pct: s.progress ?? 0, active: s.state === "printing" } : null}
        gauge={{ pct: s && isJob(s) ? s.progress ?? 0 : 0, kind: "ring", hot: s?.state === "printing" && !s.preparing }}
        sub={
          <span>
            {t("Schicht")}{" "}
            <b className="num">
              {s && isJob(s) && s.layer != null && (s.totalLayers ?? 0) > 0
                ? `${fmtNum(s.layer)} / ${fmtNum(s.totalLayers)}`
                : DASH}
            </b>
          </span>
        }
      />
    </div>
  );
}

function isJob(s: PrinterStatus) {
  if (s.state === "printing" || s.state === "paused") return true;
  return ["finished", "failed", "aborted"].includes(s.state) && s.fileName != null;
}

function Thumbnail({ file, printing }: { file: string | null; printing: boolean }) {
  const url = thumbnailUrl(file);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className="thumb">
      {url && !failed ? (
        <img src={url} alt="" onError={() => setFailed(true)} />
      ) : printing ? (
        <PrintAnim />
      ) : (
        <Box size={32} strokeWidth={1.25} />
      )}
    </div>
  );
}

/** Kleiner Druckkopf, der Schicht für Schicht eine Vase druckt (wenn der Drucker kein Vorschaubild liefert). */
function PrintAnim() {
  const LAYERS = 10, CYCLE = 7000, HOLD = 0.12; // letzter Anteil: fertiges Teil kurz zeigen
  const [t, setT] = useState(0.55);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const t0 = performance.now() - 0.55 * CYCLE;
    const step = (now: number) => {
      setT(((now - t0) % CYCLE) / CYCLE);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  const k = Math.min(1, t / (1 - HOLD)) * LAYERS;
  const cur = Math.min(LAYERS - 1, Math.floor(k));
  const along = k >= LAYERS ? 1 : k - cur;
  const width = (i: number) => 30 + 16 * Math.sin((Math.PI * (i + 0.5)) / LAYERS);
  const y = (i: number) => 74 - i * 5;
  const rows = [];
  for (let i = 0; i <= cur; i++) {
    const w = width(i), x0 = 44 - w / 2;
    const done = i < cur ? 1 : along;
    const rtl = i % 2 === 1;
    rows.push(<rect key={i} x={rtl ? x0 + w * (1 - done) : x0} y={y(i)} width={w * done} height={4} rx={2} fill={i % 2 ? "var(--accent-deep)" : "var(--accent)"} />);
  }
  const w = width(cur), x0 = 44 - w / 2;
  const nx = cur % 2 ? x0 + w * (1 - along) : x0 + w * along;
  const ny = y(cur) - 1;
  const printing = k < LAYERS;
  return (
    <svg className="print-anim" viewBox="0 0 88 88" aria-hidden>
      <rect x={8} y={79} width={72} height={3} rx={1.5} fill="#2e2c2a" />
      {rows}
      {printing && <circle cx={nx} cy={ny + 2} r={5} fill="url(#pa-glow)" />}
      <defs>
        <radialGradient id="pa-glow">
          <stop offset="0" stopColor="#ffd2bf" stopOpacity="0.95" />
          <stop offset="1" stopColor="#ffd2bf" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform={`translate(${nx} ${ny - (printing ? 0 : 6)})`} style={{ transition: "transform 300ms" }}>
        <rect x={-9} y={-17} width={18} height={6} rx={1.5} fill="#3a3836" />
        <path d="M-5 -11 H5 L2 -1 H-2 Z" fill="#e8e6df" />
      </g>
    </svg>
  );
}

/** Große Karte „Aktueller Druck“: leuchtender Fortschrittsring mit Skala, Vorschaubild, Zeiten und Steuerung. */
function HeroCard({ s, celebrate }: { s: PrinterStatus | null; celebrate: boolean }) {
  const camera = useCameraSource();
  const job = !!s && isJob(s);
  const printing = !!s && s.state === "printing" && !s.preparing;
  const tone = !s || !job ? "idle" : s.preparing ? "prep" : s.state === "paused" ? "paused" : s.state === "finished" ? "done" : s.state === "failed" || s.state === "aborted" ? "failed" : "live";
  return (
    <Card className={`hero tone-${tone}${printing ? " is-printing" : ""}${celebrate ? " celebrate" : ""}${camera ? " with-cam" : ""}`}>
      <div className="hero-glow" aria-hidden />
      {!s ? (
        <WaitingPanel />
      ) : (
        <div className="hero-body">
          {camera ? (
            <div className="hero-cam">
              <CameraBox source={camera} />
              <span className="live hero-live">
                <i /> Live
              </span>
              <div className="hero-cam-ring">
                <HeroRing s={s} job={job} />
                <span className="hero-cam-pct num">{job ? `${Math.round(s.state === "finished" ? 100 : s.progress ?? 0)} %` : "–"}</span>
              </div>
            </div>
          ) : (
            <HeroRing s={s} job={job} />
          )}
          <HeroInfo s={s} job={job} />
        </div>
      )}
    </Card>
  );
}

const TICKS = 60;

function HeroRing({ s, job }: { s: PrinterStatus; job: boolean }) {
  const pct = job ? Math.max(0, Math.min(100, s.state === "finished" ? 100 : s.progress ?? 0)) : 0;
  const R = 92, C = 110;
  const a = (pct / 100) * Math.PI * 2 - Math.PI / 2;
  const lit = Math.round((pct / 100) * TICKS);
  return (
    <div className="hero-ring">
      <svg viewBox="0 0 220 220" aria-hidden>
        <defs>
          <linearGradient id="hero-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--ring-a)" />
            <stop offset="1" stopColor="var(--ring-b)" />
          </linearGradient>
        </defs>
        <g className="hr-ticks">
          {Array.from({ length: TICKS }, (_, i) => {
            const ang = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
            const big = i % 5 === 0;
            const r1 = 106, r2 = big ? 99 : 102;
            return (
              <line
                key={i}
                className={i < lit ? "on" : ""}
                x1={C + Math.cos(ang) * r1}
                y1={C + Math.sin(ang) * r1}
                x2={C + Math.cos(ang) * r2}
                y2={C + Math.sin(ang) * r2}
              />
            );
          })}
        </g>
        <circle className="hr-track" cx={C} cy={C} r={R} />
        {pct > 0.5 && (
          <>
            <circle className="hr-glow" cx={C} cy={C} r={R} pathLength={100} strokeDasharray={`${pct} 100`} transform={`rotate(-90 ${C} ${C})`} />
            <circle className="hr-fill" cx={C} cy={C} r={R} pathLength={100} strokeDasharray={`${pct} 100`} transform={`rotate(-90 ${C} ${C})`} />
            <circle className="hr-head" cx={C + Math.cos(a) * R} cy={C + Math.sin(a) * R} r={6} />
          </>
        )}
      </svg>
      <div className="hero-center">
        {job ? (
          <Thumbnail file={s.fileName} printing={s.state === "printing" && !s.preparing} />
        ) : (
          <div className="thumb hero-idle">
            <Printer size={40} strokeWidth={1.25} />
          </div>
        )}
      </div>
    </div>
  );
}

function HeroInfo({ s, job }: { s: PrinterStatus; job: boolean }) {
  const caps = useCaps();
  if (!job) {
    return (
      <div className="hero-info">
        <div className="label">{t("Aktueller Druck")}</div>
        <div className="hero-title">{s.state === "unknown" ? t("Unbekannter Zustand") : t("Bereit zum Drucken")}</div>
        <p className="small muted">
          {s.state === "unknown"
            ? t("Der Drucker ist verbunden, meldet aber keinen bekannten Zustand.")
            : t("Der Drucker ist bereit. Sobald ein Druck startet, erscheint er hier.")}
        </p>
      </div>
    );
  }
  const pct = s.state === "finished" ? 100 : Math.round(s.progress ?? 0);
  const barClass =
    s.state === "paused" ? "paused" : s.state === "finished" ? "done" : s.state === "failed" ? "failed" : s.preparing ? "" : "is-live";
  const eta =
    s.state === "printing" ? fmtEta(s.remainingS) : s.state === "paused" ? t("pausiert") : s.state === "finished" ? t("fertig") : DASH;
  return (
    <div className="hero-info">
      <div className="hero-top">
        <div className="label">{t("Aktueller Druck")}</div>
        <Badge tone={s.preparing ? "warning" : STATE_TONE[s.state]}>{s.preparing ? t("Vorbereitung") : STATE_LABEL[s.state]}</Badge>
      </div>
      <div className="hero-pct num">
        <Rolling text={String(pct)} />
        <span className="unit">%</span>
      </div>
      <div className="file-name" title={s.fileName ?? undefined}>
        {s.fileName ?? t("Unbenannter Druck")}
      </div>
      <div className="small muted num hero-meta">
        {s.preparing ? (
          t("Heizen und Bett-Leveling …")
        ) : (
          <>
            {s.layer != null && (s.totalLayers ?? 0) > 0 && (
              <span>
                {t("Schicht")} <b>{fmtNum(s.layer)} / {fmtNum(s.totalLayers)}</b>
              </span>
            )}
            {s.usedMaterialMm != null && (
              <span>
                Filament <b>{fmtNum(s.usedMaterialMm / 1000, 2)} m</b>
              </span>
            )}
          </>
        )}
      </div>
      <div className={`bar ${barClass}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="times">
        <div>
          <span className="label">{t("Verstrichen")}</span>
          <span className="value num">{fmtDuration(s.elapsedS)}</span>
        </div>
        <div>
          <span className="label">{t("Restzeit")}</span>
          <span className="value num">{s.state === "printing" || s.state === "paused" ? fmtDuration(s.remainingS) : DASH}</span>
        </div>
        <div>
          <span className="label">{t("Fertig um")}</span>
          <span className="value num">{eta}</span>
        </div>
      </div>
      <JobControls s={s} />
      {(s.state === "printing" || s.state === "paused") && caps.speed && <SpeedControl s={s} />}
    </div>
  );
}

/** Druckgeschwindigkeit live ändern: Faktor auf die gesliceten Geschwindigkeiten (wie M220). */
const SPEED_MODES = () => [
  { pct: 25, name: t("Flüster"), hint: t("Flüsterleise für die Nacht – der Druck dauert ein Vielfaches länger.") },
  { pct: 50, name: t("Leise"), hint: t("Deutlich ruhiger, sehr saubere Oberflächen – etwa doppelte Druckzeit.") },
  { pct: 75, name: t("Ruhig"), hint: t("Etwas leiser bei fast voller Geschwindigkeit.") },
  { pct: 100, name: t("Normal"), hint: t("So schnell wie gesliced (Wände und Füllung bis 300 mm/s).") },
  { pct: 125, name: t("Schnell"), hint: t("Mehr Tempo – am besten mit High-Speed-PLA (z. B. Hyper PLA).") },
  {
    pct: 150,
    name: t("Turbo"),
    hint: t("Volle Leistung: Druckbewegungen bis ca. 380 mm/s, Leerfahrten bis 500 mm/s (Maximum des KE). Nur mit High-Speed-PLA und Düse +10 °C, sonst wird zu wenig Material gefördert."),
  },
];

function SpeedControl({ s }: { s: PrinterStatus }) {
  const modes = useMemo(SPEED_MODES, []);
  const [pending, setPending] = useState<number | null>(null);
  /** Während Heizen/Leveling gewählt: wird gesetzt, sobald der Druck wirklich läuft */
  const [queued, setQueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = s.speedPct != null ? Math.round(s.speedPct) : null;
  const reports = s.speedPct != null; // meldet der Drucker den Faktor überhaupt?

  // Bestätigt, sobald der Drucker den neuen Wert meldet. Der Status kommt teils nur alle
  // 20 s – daher großzügig warten und vorher einmal nachsenden.
  useEffect(() => {
    if (pending == null) return;
    if (current === pending) {
      setPending(null);
      return;
    }
    const retry = setTimeout(() => void printerControl(`speed:${pending}`).catch(() => {}), 10_000);
    const timer = setTimeout(() => {
      setPending(null);
      setError(t("Der Drucker hat die neue Geschwindigkeit nicht bestätigt."));
    }, 25_000);
    return () => {
      clearTimeout(retry);
      clearTimeout(timer);
    };
  }, [pending, current]);

  const send = async (pct: number) => {
    setError(null);
    setPending(reports ? pct : null);
    try {
      await printerControl(`speed:${pct}`);
    } catch (e) {
      setPending(null);
      setError(typeof e === "string" ? e : t("Befehl fehlgeschlagen."));
    }
  };

  // Der Start-G-Code setzt das Tempo auf 100 % zurück (M220 S100). Wunsch daher erst
  // nach Heizen und Leveling abschicken – und mehr als 100 % erst ab Schicht 2:
  // Die erste Schicht bleibt beim Profil-Tempo (höchstens 50 mm/s), damit sie sicher haftet.
  const firstLayer = s.preparing || (s.layer != null && s.layer < 2);
  const holdBack = (pct: number) => s.preparing || (pct > 100 && firstLayer);
  const ready = s.state === "printing" && !s.preparing && (queued == null || !holdBack(queued));
  useEffect(() => {
    if (queued == null || !ready) return;
    const timer = setTimeout(() => {
      setQueued(null);
      void send(queued);
    }, 3000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, ready]);

  const choose = (pct: number) => {
    setError(null);
    if (holdBack(pct)) {
      setQueued(pct);
      // Läuft schon ein erhöhtes Tempo, für die erste Schicht sofort auf 100 % zurück
      if (!s.preparing && current != null && current > 100) void send(100);
      return;
    }
    setQueued(null);
    void send(pct);
  };

  const shown = queued ?? pending ?? current ?? 100;
  const active = modes.find((m) => m.pct === shown);
  const night = useNightMode();
  return (
    <div className="speed-ctl">
      <div className="speed-head">
        <span className="label">{t("Tempo")}</span>
        <button
          className={`night-toggle small${night ? " on" : ""}`}
          aria-pressed={night}
          title={t("Zwischen {a} und {b} Uhr automatisch auf {p} % (leise), morgens zurück aufs vorige Tempo. Die App muss dafür geöffnet bleiben.", { a: NIGHT_FROM, b: NIGHT_TO, p: NIGHT_PCT })}
          onClick={() => setNightMode(!night)}
        >
          <Moon size={12} /> {night ? t("Nachtmodus an") : t("Nachtmodus")}
        </button>
        <span className="header-spacer" />
        <span className="small muted num">
          {queued != null ? (
            <>
              <Loader2 size={12} className="spin" />{" "}
              {s.preparing && !(queued > 100)
                ? t("{p} % – wird nach dem Leveling gesetzt", { p: queued })
                : t("{p} % – ab Schicht 2 (erste Schicht bleibt bei höchstens 50 mm/s)", { p: queued })}
            </>
          ) : pending != null ? (
            <>
              <Loader2 size={12} className="spin" /> {t("Setze {p} % …", { p: pending })}
            </>
          ) : (
            <>
              {current != null ? `${current} %` : DASH}
              {s.speedMmS != null && s.state === "printing" ? ` · ${fmtNum(s.speedMmS)} mm/s` : ""}
            </>
          )}
        </span>
      </div>
      <div className="speed-modes" role="radiogroup" aria-label={t("Tempo")}>
        {modes.map((m) => (
          <button
            key={m.pct}
            role="radio"
            aria-checked={shown === m.pct}
            aria-label={`${m.pct} % – ${m.name}`}
            className={`speed-mode${shown === m.pct ? " on" : ""}${m.pct >= 125 ? " fast" : ""}${m.pct <= 50 ? " quiet" : ""}`}
            disabled={pending != null}
            onClick={() => choose(m.pct)}
            title={m.hint}
          >
            <span className="sm-pct num">
              {m.pct === 25 ? <Moon size={11} /> : m.pct === 150 ? <Flame size={11} /> : null}
              {m.pct}%
            </span>
            <span className="sm-name">{m.name}</span>
          </button>
        ))}
      </div>
      <div className={`speed-hint small${shown >= 125 ? " warn" : ""}`}>
        {!error && !night && endsAtNight(s.remainingS) && (
          <div className="night-hint">
            <Moon size={12} /> {t("Der Druck läuft bis in die Nacht – der Nachtmodus macht ihn ab {a} Uhr leise.", { a: NIGHT_FROM })}
          </div>
        )}
        {error ? (
          <span style={{ color: "var(--warning)" }}>
            <AlertTriangle size={12} /> {error}
          </span>
        ) : active ? (
          active.hint
        ) : (
          t("Eigene Einstellung vom Drucker-Display.")
        )}
      </div>
    </div>
  );
}

function WaitingPanel() {
  const connection = useStore((s) => s.connection);
  if (connection.kind === "reconnecting") {
    return (
      <EmptyState
        className="progress-empty"
        icon={WifiOff}
        title={t("Drucker nicht erreichbar")}
        text={t("{reason}. Neuer Versuch in {s} s.", { reason: connection.reason, s: connection.retryInS })}
        actions={
          <button className="btn sm" onClick={() => void reconnect()}>
            <PlugZap size={14} /> {t("Jetzt verbinden")}
          </button>
        }
      />
    );
  }
  return (
    <EmptyState
      className="progress-empty"
      icon={Loader2}
      spin
      title={t("Verbinde…")}
      text={connection.kind === "connected" ? t("Warte auf die ersten Daten vom Drucker.") : t("Verbindung zum Drucker wird aufgebaut.")}
    />
  );
}

/** Pause / Fortsetzen / Abbrechen – mit Rückmeldung, bis der Drucker den neuen Zustand meldet. */
function JobControls({ s }: { s: PrinterStatus }) {
  const [pending, setPending] = useState<null | "pause" | "resume" | "stop">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const active = s.state === "printing" || s.state === "paused";

  // „Wartet auf Drucker“ endet, sobald der Zustand passt – oder nach 20 s mit Hinweis
  useEffect(() => {
    if (!pending) return;
    const done =
      (pending === "pause" && s.state === "paused") ||
      (pending === "resume" && s.state === "printing") ||
      (pending === "stop" && !(s.state === "printing" || s.state === "paused"));
    if (done) {
      setPending(null);
      return;
    }
    const timer = setTimeout(() => {
      setPending(null);
      setError(t("Der Drucker hat nicht reagiert. Bitte am Display prüfen."));
    }, 20_000);
    return () => clearTimeout(timer);
  }, [pending, s.state]);

  if (!active) return null;

  const send = async (a: "pause" | "resume" | "stop") => {
    setError(null);
    setConfirmStop(false);
    setPending(a);
    try {
      await printerControl(a);
    } catch (e) {
      setPending(null);
      setError(typeof e === "string" ? e : t("Befehl fehlgeschlagen."));
    }
  };

  // Geplante Filamentwechsel (aus dem Slicer): beim Halt erklären, sonst den nächsten ankündigen
  const planned = plannedPauses(s.fileName);
  const cur = s.layer ?? 0;
  const atChange = s.state === "paused" ? planned.find((l) => cur >= l - 1 && cur <= l) : undefined;
  const nextChange = s.state === "printing" ? planned.find((l) => l > cur) : undefined;

  const busyText = pending === "pause" ? t("Pausiere …") : pending === "resume" ? t("Setze fort …") : pending === "stop" ? t("Breche ab …") : null;

  return (
    <>
      {atChange != null && (
        <div className="filament-change">
          <Palette size={18} />
          <div>
            <strong>{t("Filamentwechsel vor Schicht {n}", { n: atChange })}</strong>
            <span className="small">
              {t("Am Drucker-Display das alte Filament entladen und die neue Farbe laden, bis sie sauber aus der Düse kommt. Düsenspitze kurz säubern, dann „Fortsetzen“ drücken.")}
            </span>
          </div>
        </div>
      )}
      <div className="job-controls">
      {confirmStop ? (
        <>
          <span className="small">{t("Druck wirklich abbrechen? Das lässt sich nicht rückgängig machen.")}</span>
          <button className="btn sm ghost" onClick={() => setConfirmStop(false)}>
            <X size={14} /> {t("Nein")}
          </button>
          <button className="btn sm danger" onClick={() => void send("stop")}>
            <Square size={14} /> {t("Ja, abbrechen")}
          </button>
        </>
      ) : (
        <>
          {s.state === "paused" ? (
            <button className="btn sm" disabled={!!pending} onClick={() => void send("resume")}>
              <Play size={14} /> {t("Fortsetzen")}
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={!!pending || s.preparing}
              title={s.preparing ? t("Während Heizen und Leveling nimmt der Drucker keine Pause an.") : undefined}
              onClick={() => void send("pause")}
            >
              <Pause size={14} /> {t("Pause")}
            </button>
          )}
          <button className="btn sm ghost" disabled={!!pending} onClick={() => setConfirmStop(true)}>
            <Square size={14} /> {t("Abbrechen")}
          </button>
          {busyText && (
            <span className="small muted">
              <Loader2 size={12} className="spin" /> {busyText}
            </span>
          )}
          {error && (
            <span className="small" style={{ color: "var(--warning)" }}>
              <AlertTriangle size={12} /> {error}
            </span>
          )}
          {!busyText && !error && nextChange != null && (
            <span className="small muted">
              <Palette size={12} /> {t("Nächster Farbwechsel: Schicht {n}", { n: nextChange })}
            </span>
          )}
        </>
      )}
      </div>
    </>
  );
}

/** Warteschlange: vorgemerkte Drucke der Reihe nach starten. */
function QueueCard({ status: s, connected }: { status: PrinterStatus | null; connected: boolean }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [plateFree, setPlateFree] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fits = useCaps().slicer;
  useEffect(() => {
    void queueList().then(setItems);
    return onQueueChange(setItems);
  }, []);
  // Nach jedem Druck muss die Platte neu bestätigt werden
  useEffect(() => {
    if (s?.state === "printing") setPlateFree(false);
  }, [s?.state]);
  if (items.length === 0) return null;

  const printerFree = connected && !!s && !(s.state === "printing" || s.state === "paused") && fits;
  const start = async (it: QueueItem) => {
    setError(null);
    setBusy(it.id);
    try {
      const name = await queueStart(it.id);
      rememberSentPrint(name, "", it.pauses);
      setPlateFree(false);
    } catch (e) {
      setError(typeof e === "string" ? e : t("Start fehlgeschlagen."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="queue-card">
      <div className="chart-head">
        <span className="label">
          <ListOrdered size={14} /> {t("Warteschlange")} · {items.length}
        </span>
        {printerFree ? (
          <label className="plate-check small">
            <input type="checkbox" checked={plateFree} onChange={(e) => setPlateFree(e.target.checked)} />
            {t("Platte ist frei")}
          </label>
        ) : (
          <span className="small muted">{!fits ? t("Die vorgemerkten Drucke sind für den Ender 3 V3 KE gesliced – bitte zu diesem Drucker wechseln.") : connected ? t("Startet, sobald der aktuelle Druck fertig ist und die Platte frei ist.") : t("Drucker nicht verbunden")}</span>
        )}
      </div>
      <ol className="queue">
        {items.map((it, i) => (
          <li key={it.id} className={i === 0 ? "next" : ""}>
            <span className="q-pos num">{i + 1}</span>
            <div className="q-main">
              <span className="file-name" title={it.name}>
                {it.name}
              </span>
              <span className="small muted num">
                {it.timeS != null ? fmtDuration(it.timeS) : DASH}
                {it.filamentG != null && ` · ${fmtNum(it.filamentG, 1)} g`}
                {it.pauses.length > 0 && ` · ${t("{n} Farbwechsel", { n: it.pauses.length })}`}
              </span>
            </div>
            <div className="q-actions">
              <button className="btn sm ghost" aria-label={t("Nach oben")} disabled={i === 0} onClick={() => void queueShift(it.id, -1)}>
                <ArrowUp size={14} />
              </button>
              <button className="btn sm ghost" aria-label={t("Nach unten")} disabled={i === items.length - 1} onClick={() => void queueShift(it.id, 1)}>
                <ArrowDown size={14} />
              </button>
              <button className="btn sm ghost" aria-label={t("Entfernen")} onClick={() => void queueRemove(it.id)}>
                <X size={14} />
              </button>
              <button
                className={`btn sm${i === 0 ? " primary" : ""}`}
                disabled={!printerFree || !plateFree || busy != null}
                title={!plateFree && printerFree ? t("Erst bestätigen, dass die Platte frei ist.") : undefined}
                onClick={() => void start(it)}
              >
                {busy === it.id ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {t("Starten")}
              </button>
            </div>
          </li>
        ))}
      </ol>
      {error && (
        <span className="small" style={{ color: "var(--warning)" }}>
          <AlertTriangle size={12} /> {error}
        </span>
      )}
    </Card>
  );
}

/** Druckerfehler in Klartext (soweit von Creality belegt), sonst Such-Link */
function ErrorBanner({ s }: { s: PrinterStatus }) {
  // Je nach Firmware steckt die vierstellige Nummer in „errcode“ oder „key“
  const cands = [s.errorKey ?? 0, s.errorCode ?? 0].filter((c) => c > 0);
  const code = cands.find((c) => explainError(c)) ?? cands.find((c) => c >= 1000) ?? cands[0];
  const info = explainError(code);
  return (
    <div className="error-banner card" role="alert">
      <AlertTriangle size={20} />
      <div>
        <strong>
          {t("Druckerfehler {c}", { c: code })}
          {info && `: ${info.title}`}
        </strong>
        <span className="small">{info ? info.fix : t("Der Drucker meldet einen Fehler. Details stehen am Druckerdisplay.")}</span>
      </div>
      <button className="btn sm" onClick={() => void openProjectLink(errorSearchUrl(code)).catch(() => {})}>
        {t("Code nachschlagen")}
      </button>
    </div>
  );
}
