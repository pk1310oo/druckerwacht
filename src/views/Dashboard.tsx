import { useEffect, useState } from "react";
import { AlertTriangle, Box, Gauge, Layers, Loader2, Pause, Play, PlugZap, Printer, Square, Thermometer, WifiOff, X } from "lucide-react";
import { useStore } from "../lib/store";
import { printerControl, reconnect, thumbnailUrl } from "../lib/api";
import { DASH, fmtDuration, fmtEta, fmtNum, STATE_LABEL, STATE_TONE } from "../lib/format";
import type { PrinterStatus } from "../lib/types";
import { Badge, Card, EmptyState, Segmented, StatCard } from "../components/ui";
import { Chart, type SeriesDef } from "../components/Chart";
import { CameraFrame } from "../components/Camera";
import type { ViewId } from "../components/Shell";

const TEMP_SERIES: SeriesDef[] = [
  { key: "nozzle", label: "Düse", color: "#D97757", unit: "°C" },
  { key: "nozzleTarget", label: "Düse Soll", color: "#D97757", unit: "°C", dashed: true, hideInLegend: true },
  { key: "bed", label: "Bett", color: "#C9C7BF", unit: "°C" },
  { key: "bedTarget", label: "Bett Soll", color: "#C9C7BF", unit: "°C", dashed: true, hideInLegend: true },
];

const MOTION_SERIES: SeriesDef[] = [
  { key: "speed", label: "Geschw.", color: "#D97757", unit: "mm/s" },
  { key: "flow", label: "Flow", color: "#C9C7BF", unit: "%", scale: "pct" },
  { key: "fan", label: "Lüfter", color: "#7C7C7C", unit: "%", scale: "pct" },
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
            title="Drucker einrichten"
            text="Trage die IP-Adresse deines Ender 3 V3 KE ein oder lass das Netzwerk automatisch durchsuchen."
            actions={
              <button className="btn primary" onClick={() => go("settings")}>
                Zu den Einstellungen
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
      <Stats status={status} />

      <div className={`row-progress ${cameraUrl ? "with-camera" : ""}`}>
        <Card>{status ? <ProgressPanel s={status} /> : <WaitingPanel />}</Card>
        {cameraUrl && (
          <Card className="camera">
            <div className="chart-head">
              <span className="label">Kamera</span>
              <span className="live">
                <i /> Live
              </span>
            </div>
            <CameraFrame url={cameraUrl} />
          </Card>
        )}
      </div>

      <div className="section-head">
        <span className="label">Diagramme</span>
        <Segmented ariaLabel="Zeitraum" value={windowMin} options={WINDOWS} onChange={setWindowMin} />
      </div>
      <div className="charts">
        <Chart title="Temperatur" samples={samples} windowMin={windowMin} series={TEMP_SERIES} yUnit="°" yMinMax={50} />
        <Chart title="Geschwindigkeit" samples={samples} windowMin={windowMin} series={MOTION_SERIES} yUnit="" pctAxis yMinMax={50} />
      </div>

      {!connected && status && (
        <p className="hint" style={{ textAlign: "center" }}>
          Angezeigt werden die zuletzt empfangenen Werte.
        </p>
      )}
    </div>
  );
}

function heatMeter(temp: number | null, target: number | null, max: number) {
  if (temp == null) return { pct: 0 };
  if (target && target > 0) return { pct: (temp / target) * 100, active: temp < target - 2 };
  return { pct: (temp / max) * 100 };
}

function Stats({ status: s }: { status: PrinterStatus | null }) {
  const target = (t: number | null | undefined) =>
    t == null ? DASH : t <= 0 ? "aus" : `${fmtNum(t)} °C`;
  return (
    <div className="stats">
      <StatCard
        label="Düse"
        icon={Thermometer}
        value={s?.nozzleTemp ?? null}
        unit="°C"
        meter={heatMeter(s?.nozzleTemp ?? null, s?.nozzleTarget ?? null, s?.maxNozzleTemp ?? 300)}
        sub={
          <span>
            Soll <b className="num">{target(s?.nozzleTarget)}</b>
          </span>
        }
      />
      <StatCard
        label="Bett"
        icon={Box}
        value={s?.bedTemp ?? null}
        unit="°C"
        meter={heatMeter(s?.bedTemp ?? null, s?.bedTarget ?? null, s?.maxBedTemp ?? 100)}
        sub={
          <span>
            Soll <b className="num">{target(s?.bedTarget)}</b>
          </span>
        }
      />
      <StatCard
        label="Geschwindigkeit"
        icon={Gauge}
        value={s?.speedMmS ?? null}
        unit="mm/s"
        meter={null}
        sub={
          <>
            <span>
              Flow <b className="num">{fmtNum(s?.flowPct)}{s?.flowPct != null && " %"}</b>
            </span>
            <span>
              Lüfter <b className="num">{fmtNum(s?.fanPct)}{s?.fanPct != null && " %"}</b>
            </span>
          </>
        }
      />
      <StatCard
        label="Fortschritt"
        icon={Layers}
        value={s && isJob(s) ? s.progress : null}
        unit="%"
        meter={s && isJob(s) ? { pct: s.progress ?? 0, active: s.state === "printing" } : null}
        sub={
          <span>
            Schicht{" "}
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

function Thumbnail({ file }: { file: string | null }) {
  const url = thumbnailUrl(file);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className="thumb">
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <Box size={32} strokeWidth={1.25} />}
    </div>
  );
}

function ProgressPanel({ s }: { s: PrinterStatus }) {
  if (!isJob(s)) {
    return (
      <EmptyState
        className="progress-empty"
        icon={Printer}
        title="Kein Druck aktiv"
        text={
          s.state === "unknown"
            ? "Der Drucker ist verbunden, meldet aber keinen bekannten Zustand."
            : "Der Drucker ist bereit. Sobald ein Druck startet, erscheint er hier."
        }
      />
    );
  }
  const pct = s.progress ?? 0;
  const barClass =
    s.state === "paused" ? "paused" : s.state === "finished" ? "done" : s.state === "failed" ? "failed" : "";
  const eta =
    s.state === "printing" ? fmtEta(s.remainingS) : s.state === "paused" ? "pausiert" : s.state === "finished" ? "fertig" : DASH;

  return (
    <div className="progress">
      <Thumbnail file={s.fileName} />
      <div className="progress-body">
        <div className="progress-top">
          <div style={{ minWidth: 0 }}>
            <div className="label">Aktueller Druck</div>
            <div className="file-name" title={s.fileName ?? undefined}>
              {s.fileName ?? "Unbenannter Druck"}
            </div>
            <div className="small muted num">
              {s.preparing
                ? "Heizen und Bett-Leveling …"
                : s.usedMaterialMm != null
                  ? `Filament ${fmtNum(s.usedMaterialMm / 1000, 2)} m`
                  : "\u00A0"}
            </div>
          </div>
          <Badge tone={s.preparing ? "warning" : STATE_TONE[s.state]}>{s.preparing ? "Vorbereitung" : STATE_LABEL[s.state]}</Badge>
        </div>
        <div className="progress-bottom">
        <div className={`bar ${barClass}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <JobControls s={s} />
        <div className="times">
          <div>
            <span className="label">Verstrichen</span>
            <span className="value num">{fmtDuration(s.elapsedS)}</span>
          </div>
          <div>
            <span className="label">Restzeit</span>
            <span className="value num">{s.state === "printing" || s.state === "paused" ? fmtDuration(s.remainingS) : DASH}</span>
          </div>
          <div>
            <span className="label">Fertig um</span>
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
        title="Drucker nicht erreichbar"
        text={`${connection.reason}. Neuer Versuch in ${connection.retryInS} s.`}
        actions={
          <button className="btn sm" onClick={() => void reconnect()}>
            <PlugZap size={14} /> Jetzt verbinden
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
      title="Verbinde…"
      text={connection.kind === "connected" ? "Warte auf die ersten Daten vom Drucker." : "Verbindung zum Drucker wird aufgebaut."}
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
    const t = setTimeout(() => {
      setPending(null);
      setError("Der Drucker hat nicht reagiert. Bitte am Display prüfen.");
    }, 20_000);
    return () => clearTimeout(t);
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
      setError(typeof e === "string" ? e : "Befehl fehlgeschlagen.");
    }
  };

  const busyText = pending === "pause" ? "Pausiere …" : pending === "resume" ? "Setze fort …" : pending === "stop" ? "Breche ab …" : null;

  return (
    <div className="job-controls">
      {confirmStop ? (
        <>
          <span className="small">Druck wirklich abbrechen? Das lässt sich nicht rückgängig machen.</span>
          <button className="btn sm ghost" onClick={() => setConfirmStop(false)}>
            <X size={14} /> Nein
          </button>
          <button className="btn sm danger" onClick={() => void send("stop")}>
            <Square size={14} /> Ja, abbrechen
          </button>
        </>
      ) : (
        <>
          {s.state === "paused" ? (
            <button className="btn sm" disabled={!!pending} onClick={() => void send("resume")}>
              <Play size={14} /> Fortsetzen
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={!!pending || s.preparing}
              title={s.preparing ? "Während Heizen und Leveling nimmt der Drucker keine Pause an." : undefined}
              onClick={() => void send("pause")}
            >
              <Pause size={14} /> Pause
            </button>
          )}
          <button className="btn sm ghost" disabled={!!pending} onClick={() => setConfirmStop(true)}>
            <Square size={14} /> Abbrechen
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
        </>
      )}
    </div>
  );
}
