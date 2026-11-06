import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Box, Gauge, Layers, Loader2, Palette, Pause, Play, PlugZap, Printer, Square, Thermometer, WifiOff, X } from "lucide-react";
import { useStore } from "../lib/store";
import { printerControl, reconnect, thumbnailUrl } from "../lib/api";
import { DASH, fmtDuration, fmtEta, fmtNum, STATE_LABEL, STATE_TONE } from "../lib/format";
import type { PrinterStatus } from "../lib/types";
import { Badge, Card, EmptyState, Segmented, StatCard } from "../components/ui";
import { Chart, type SeriesDef } from "../components/Chart";
import { CameraFrame } from "../components/Camera";
import { Confetti } from "../components/Fx";

const Printer3D = lazy(() => import("../components/Printer3D"));
import type { ViewId } from "../components/Shell";
import { t } from "../lib/i18n";
import { accentHex } from "../lib/theme";
import { plannedPauses } from "../lib/sentPrint";

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
  const cameraUrl = useStore((s) => s.settings.cameraUrl.trim());
  const [windowMin, setWindowMin] = useState(loadWindow);
  const tempSeries = useMemo(TEMP_SERIES, []);
  // Kurzes grünes Leuchten, wenn ein Druck fertig wird
  const [celebrate, setCelebrate] = useState(false);
  const [confetti, setConfetti] = useState(0);
  const prevState = useRef(status?.state);
  useEffect(() => {
    const was = prevState.current;
    prevState.current = status?.state;
    if (was && was !== "finished" && status?.state === "finished") {
      setCelebrate(true);
      setConfetti((n) => n + 1);
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
            text={t("Trage die IP-Adresse deines Ender 3 V3 KE ein oder lass das Netzwerk automatisch durchsuchen.")}
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
      <Confetti fire={confetti} />
      <div className="top-row">
        <Card className="printer-card">
          <div className="chart-head">
            <span className="label">{t("Drucker live")}</span>
            <span className="small muted">{t("Ziehen zum Drehen")}</span>
          </div>
          <Suspense fallback={null}>
            <Printer3D />
          </Suspense>
        </Card>
        <Stats status={status} />
      </div>

      <div className={`row-progress ${cameraUrl ? "with-camera" : ""}`}>
        <Card className={celebrate ? "celebrate" : ""}>{status ? <ProgressPanel s={status} /> : <WaitingPanel />}</Card>
        {cameraUrl && (
          <Card className="camera">
            <div className="chart-head">
              <span className="label">{t("Kamera")}</span>
              <span className="live">
                <i /> Live
              </span>
            </div>
            <CameraFrame url={cameraUrl} />
          </Card>
        )}
      </div>

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

function ProgressPanel({ s }: { s: PrinterStatus }) {
  if (!isJob(s)) {
    return (
      <EmptyState
        className="progress-empty"
        icon={Printer}
        title={t("Kein Druck aktiv")}
        text={
          s.state === "unknown"
            ? t("Der Drucker ist verbunden, meldet aber keinen bekannten Zustand.")
            : t("Der Drucker ist bereit. Sobald ein Druck startet, erscheint er hier.")
        }
      />
    );
  }
  const pct = s.progress ?? 0;
  const barClass =
    s.state === "paused" ? "paused" : s.state === "finished" ? "done" : s.state === "failed" ? "failed" : s.preparing ? "" : "is-live";
  const eta =
    s.state === "printing" ? fmtEta(s.remainingS) : s.state === "paused" ? t("pausiert") : s.state === "finished" ? t("fertig") : DASH;

  return (
    <div className="progress">
      <div className="thumb-ring">
        <svg viewBox="0 0 144 144" aria-hidden>
          <rect x={3} y={3} width={138} height={138} rx={16} className="tr-track" pathLength={100} />
          <rect x={3} y={3} width={138} height={138} rx={16} className={`tr-fill ${barClass}`} pathLength={100} strokeDasharray={`${pct} 100`} />
        </svg>
        <Thumbnail file={s.fileName} printing={s.state === "printing" && !s.preparing} />
      </div>
      <div className="progress-body">
        <div className="progress-top">
          <div style={{ minWidth: 0 }}>
            <div className="label">{t("Aktueller Druck")}</div>
            <div className="file-name" title={s.fileName ?? undefined}>
              {s.fileName ?? t("Unbenannter Druck")}
            </div>
            <div className="small muted num">
              {s.preparing
                ? t("Heizen und Bett-Leveling …")
                : s.usedMaterialMm != null
                  ? `Filament ${fmtNum(s.usedMaterialMm / 1000, 2)} m`
                  : "\u00A0"}
            </div>
          </div>
          <Badge tone={s.preparing ? "warning" : STATE_TONE[s.state]}>{s.preparing ? t("Vorbereitung") : STATE_LABEL[s.state]}</Badge>
        </div>
        <div className="progress-bottom">
        <div className={`bar ${barClass}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <JobControls s={s} />
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
        </div>
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
