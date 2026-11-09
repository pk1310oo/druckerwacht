/**
 * Werkzeug-Karte im Dashboard (Referenzfahrt, Leveling, Kalibrieren, Vorheizen, Filament,
 * Z-Offset, Lüfter, Licht), Datei-Senden und die Leiste mit den weiteren Druckern.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, CircleOff, Crosshair, FileUp, Fan, Flame, Grid3x3,
  Home, Lightbulb, Loader2, Minus, Plus, Power, SlidersHorizontal, Snowflake, Thermometer, Wrench, X,
} from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri, printerControl, sendGcodeFile, switchPrinter, type ControlAction } from "../lib/api";
import { DASH, fmtDuration, fmtNum, STATE_LABEL, STATE_TONE } from "../lib/format";
import { capsOf, useCaps } from "../lib/printers";
import { useMaintenance } from "../lib/maintenance";
import { setSavedZ, useSavedZ } from "../lib/zoffset";
import { getState } from "../lib/store";
import type { PrinterStatus } from "../lib/types";
import { Badge, Card } from "../components/ui";
import { t } from "../lib/i18n";

type Feedback = { kind: "busy" | "ok" | "error"; text: string } | null;

/** Schickt einen Befehl und meldet das Ergebnis in einer gemeinsamen Zeile */
function useSender() {
  const [fb, setFb] = useState<Feedback>(null);
  useEffect(() => {
    if (fb?.kind !== "ok") return;
    const timer = setTimeout(() => setFb(null), 4000);
    return () => clearTimeout(timer);
  }, [fb]);
  const send = async (action: ControlAction, done: string) => {
    setFb({ kind: "busy", text: t("Sende …") });
    try {
      await printerControl(action);
      setFb({ kind: "ok", text: done });
      return true;
    } catch (e) {
      setFb({ kind: "error", text: typeof e === "string" ? e : t("Befehl fehlgeschlagen.") });
      return false;
    }
  };
  return { fb, setFb, send };
}

const PRESETS = [
  { name: "PLA", nozzle: 210, bed: 60 },
  { name: "PETG", nozzle: 240, bed: 80 },
  { name: "ABS", nozzle: 250, bed: 100 },
  { name: "TPU", nozzle: 230, bed: 50 },
];

export function ToolsCard({ s, connected }: { s: PrinterStatus | null; connected: boolean }) {
  const caps = useCaps();
  const { fb, send } = useSender();
  const [calibrate, setCalibrate] = useState(false);
  const [upload, setUpload] = useState(false);
  const file = s?.fileName ?? "";
  const [zSum, setZSum] = useState(0);
  useEffect(() => setZSum(0), [file]);
  const { due } = useMaintenance();
  const savedZ = useSavedZ();
  const fmtZ = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);

  if (!connected || !s) return null;
  const running = s.state === "printing" || s.state === "paused";
  const hot = (s.nozzleTemp ?? 0) >= 170;
  const nozT = Math.round(s.nozzleTarget ?? 0);
  const bedT = Math.round(s.bedTarget ?? 0);
  const maxNoz = s.maxNozzleTemp ?? 300;
  const maxBed = s.maxBedTemp ?? 100;

  return (
    <Card className="tools-card">
      <div className="chart-head">
        <span className="label">
          <Wrench size={14} /> {t("Werkzeuge")}
          <AiChip />
        </span>
        <span className="tools-head-actions">
          <button className="btn sm ghost" disabled={running} onClick={() => setUpload(true)} title={running ? t("Das geht nur, wenn gerade nicht gedruckt wird.") : undefined}>
            <FileUp size={14} /> {t("G-Code senden")}
          </button>
          {caps.tools && (
            <button className="btn sm" disabled={running} onClick={() => setCalibrate(true)} title={running ? t("Das geht nur, wenn gerade nicht gedruckt wird.") : undefined}>
              <SlidersHorizontal size={14} /> {t("Kalibrieren")}
            </button>
          )}
        </span>
      </div>

      {!caps.temps && !caps.tools ? (
        <p className="small muted">{t("Über PrusaLink lassen sich Temperaturen und Achsen nicht steuern – dafür bitte das Druckerdisplay nutzen.")}</p>
      ) : running ? (
        <div className="tools-grid">
          {caps.tools && (
            <ToolGroup icon={Crosshair} title={t("Z-Offset (erste Schicht)")} sub={zSum === 0 ? t("näher ans Bett = minus") : t("{v} mm in diesem Druck", { v: (zSum > 0 ? "+" : "") + zSum.toFixed(2) })}>
              {[-0.05, -0.01, 0.01, 0.05].map((d) => (
                <button
                  key={d}
                  className="btn sm tool-chip num"
                  onClick={async () => {
                    if (await send(`zoffset:${d}`, t("Z-Offset {v} mm", { v: (d > 0 ? "+" : "") + d.toFixed(2) }))) setZSum((z) => Math.round((z + d) * 1000) / 1000);
                  }}
                >
                  {d > 0 ? "+" : "−"}
                  {Math.abs(d).toFixed(2)}
                </button>
              ))}
              {zSum !== 0 && (
                <button
                  className="btn sm tool-chip accent"
                  title={t("Wird bei jedem Druck automatisch angewendet, sobald Heizen und Leveling vorbei sind.")}
                  onClick={() => {
                    setSavedZ(getState().settings.activePrinter, savedZ + zSum);
                    setZSum(0);
                  }}
                >
                  {t("Merken")}
                </button>
              )}
              {savedZ !== 0 && (
                <span className="small muted z-saved">
                  {t("Gemerkt: {v} mm, wird bei jedem Druck angewendet", { v: fmtZ(savedZ) })}
                  <button className="link" onClick={() => setSavedZ(getState().settings.activePrinter, 0)}>
                    {t("vergessen")}
                  </button>
                </span>
              )}
            </ToolGroup>
          )}
          {caps.temps && (
            <ToolGroup icon={Thermometer} title={t("Düse")} sub={t("Soll {v} °C", { v: nozT })}>
              <button className="btn sm tool-chip" aria-label={t("Düse 5 °C kälter")} disabled={nozT <= 0} onClick={() => void send(`nozzle:${Math.max(0, nozT - 5)}`, t("Düse → {v} °C", { v: Math.max(0, nozT - 5) }))}>
                <Minus size={13} /> 5°
              </button>
              <button className="btn sm tool-chip" aria-label={t("Düse 5 °C wärmer")} disabled={nozT + 5 > maxNoz} onClick={() => void send(`nozzle:${nozT + 5}`, t("Düse → {v} °C", { v: nozT + 5 }))}>
                <Plus size={13} /> 5°
              </button>
            </ToolGroup>
          )}
          {caps.temps && (
            <ToolGroup icon={Flame} title={t("Bett")} sub={t("Soll {v} °C", { v: bedT })}>
              <button className="btn sm tool-chip" aria-label={t("Bett 5 °C kälter")} disabled={bedT <= 0} onClick={() => void send(`bed:${Math.max(0, bedT - 5)}`, t("Bett → {v} °C", { v: Math.max(0, bedT - 5) }))}>
                <Minus size={13} /> 5°
              </button>
              <button className="btn sm tool-chip" aria-label={t("Bett 5 °C wärmer")} disabled={bedT + 5 > maxBed} onClick={() => void send(`bed:${bedT + 5}`, t("Bett → {v} °C", { v: bedT + 5 }))}>
                <Plus size={13} /> 5°
              </button>
            </ToolGroup>
          )}
          <FanLight s={s} send={send} />
        </div>
      ) : (
        <div className="tools-grid">
          {caps.tools && (
            <ToolGroup icon={Home} title={t("Achsen")} sub={t("Referenzfahrt und Leveling")}>
              <button className="btn sm tool-chip" onClick={() => void send("home", t("Referenzfahrt läuft"))}>
                <Home size={13} /> {t("Home")}
              </button>
              <button className="btn sm tool-chip accent" onClick={() => setCalibrate(true)}>
                <Grid3x3 size={13} /> {t("Bett leveln")}
              </button>
              <button className="btn sm tool-chip" aria-label={t("Motoren aus")} title={t("Motoren aus – Achsen lassen sich von Hand bewegen")} onClick={() => void send("motors_off", t("Motoren aus"))}>
                <Power size={13} />
              </button>
            </ToolGroup>
          )}
          {caps.temps && (
            <ToolGroup icon={Thermometer} title={t("Vorheizen")} sub={nozT > 0 || bedT > 0 ? t("Düse {n} °C · Bett {b} °C", { n: nozT, b: bedT }) : t("Heizungen aus")}>
              {PRESETS.filter((p) => p.nozzle <= maxNoz && p.bed <= maxBed).map((p) => (
                <button
                  key={p.name}
                  className={`btn sm tool-chip${nozT === p.nozzle && bedT === p.bed ? " on" : ""}`}
                  title={`${p.nozzle} °C / ${p.bed} °C`}
                  onClick={async () => {
                    if (await send(`nozzle:${p.nozzle}`, t("{m} wird vorgeheizt", { m: p.name }))) await send(`bed:${p.bed}`, t("{m} wird vorgeheizt", { m: p.name }));
                  }}
                >
                  {p.name}
                </button>
              ))}
              <button
                className="btn sm tool-chip"
                aria-label={t("Heizungen aus")}
                title={t("Heizungen aus")}
                disabled={nozT === 0 && bedT === 0}
                onClick={async () => {
                  if (await send("nozzle:0", t("Heizungen aus"))) await send("bed:0", t("Heizungen aus"));
                }}
              >
                <Snowflake size={13} />
              </button>
            </ToolGroup>
          )}
          {caps.tools && (
            <ToolGroup icon={ArrowDownToLine} title={t("Filament")} sub={hot ? t("50 mm fördern oder zurückziehen") : t("Düse erst heizen (ab 170 °C)")}>
              <button className="btn sm tool-chip" disabled={!hot} onClick={() => void send("extrude:50", t("Fördere 50 mm"))}>
                <ArrowDownToLine size={13} /> {t("Laden")}
              </button>
              <button className="btn sm tool-chip" disabled={!hot} onClick={() => void send("extrude:-50", t("Ziehe 50 mm zurück"))}>
                <ArrowUpFromLine size={13} /> {t("Entladen")}
              </button>
            </ToolGroup>
          )}
          <FanLight s={s} send={send} />
        </div>
      )}

      {!running && due.length > 0 && (
        <div className="maint-hint small">
          <Wrench size={12} /> {t("Wartung fällig: {list} – abhaken unter Verlauf.", { list: due.map((d) => d.task.title()).join(", ") })}
        </div>
      )}
      <div className={`tools-fb small ${fb?.kind ?? "quiet"}`} aria-live="polite">
        {fb?.kind === "busy" && <Loader2 size={12} className="spin" />}
        {fb?.kind === "ok" && <Check size={12} />}
        {fb?.kind === "error" && <AlertTriangle size={12} />}
        {fb?.text ?? ""}
      </div>

      {/* Über body rendern: die Karte kippt in 3D und wäre sonst Bezugsrahmen für position: fixed */}
      {calibrate && createPortal(<CalibrateDialog s={s} onClose={() => setCalibrate(false)} />, document.body)}
      {upload && createPortal(<UploadDialog onClose={() => setUpload(false)} />, document.body)}
    </Card>
  );
}

function FanLight({ s, send }: { s: PrinterStatus; send: (a: ControlAction, done: string) => Promise<boolean> }) {
  const caps = useCaps();
  if (!caps.fan && !caps.light) return null;
  const fan = Math.round(s.fanPct ?? 0);
  return (
    <ToolGroup icon={Fan} title={caps.fan ? t("Lüfter") : t("Licht")} sub={caps.fan ? `${fmtNum(s.fanPct)}${s.fanPct != null ? " %" : ""}` : ""}>
      {caps.fan &&
        [0, 50, 100].map((v) => (
          <button key={v} className={`btn sm tool-chip num${Math.abs(fan - v) < 3 ? " on" : ""}`} onClick={() => void send(`fan:${v}`, t("Lüfter {v} %", { v }))}>
            {v === 0 ? <CircleOff size={13} /> : `${v}%`}
          </button>
        ))}
      {caps.light && (
        <>
          <button className="btn sm tool-chip" aria-label={t("Licht an")} title={t("Licht an")} onClick={() => void send("light:1", t("Licht an"))}>
            <Lightbulb size={13} />
          </button>
          <button className="btn sm tool-chip" aria-label={t("Licht aus")} title={t("Licht aus")} onClick={() => void send("light:0", t("Licht aus"))}>
            <Lightbulb size={13} style={{ opacity: 0.4 }} />
          </button>
        </>
      )}
    </ToolGroup>
  );
}

function ToolGroup({ icon: Icon, title, sub, children }: { icon: typeof Home; title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="tool-group">
      <div className="tg-head">
        <Icon size={14} />
        <span className="tg-title">{title}</span>
        <span className="tg-sub small muted num">{sub}</span>
      </div>
      <div className="tg-actions">{children}</div>
    </div>
  );
}

/** Kalibrieren: Bett-Leveling, PID Düse, PID Bett – jeweils mit Speichern im Drucker. */
function CalibrateDialog({ s, onClose }: { s: PrinterStatus; onClose: () => void }) {
  const { fb, send } = useSender();
  const [bed, setBed] = useState(60);
  const [heat, setHeat] = useState(true);
  const [pidNoz, setPidNoz] = useState(220);
  const [pidBed, setPidBed] = useState(60);
  const [started, setStarted] = useState<string | null>(null);
  const maxBed = s.maxBedTemp ?? 100;
  const busy = fb?.kind === "busy";
  const run = async (action: ControlAction, name: string) => {
    if (await send(action, t("{n} gestartet", { n: name }))) setStarted(name);
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v) || lo));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card calib" role="dialog" aria-modal="true" aria-labelledby="calib-title">
        <div className="modal-head">
          <strong id="calib-title">{t("Kalibrieren")}</strong>
          <button className="btn sm ghost" aria-label={t("Schließen")} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {started ? (
          <div className="calib-running">
            <Loader2 size={28} className="spin" />
            <strong>{t("{n} läuft", { n: started })}</strong>
            <p className="small muted">
              {t("Der Drucker arbeitet jetzt selbstständig – das dauert ein paar Minuten. Zum Schluss speichert er das Ergebnis und startet seine Software kurz neu; die Verbindung kommt von selbst zurück. Bitte so lange nichts am Drucker anfassen.")}
            </p>
            <div className="modal-actions">
              <button className="btn primary" onClick={onClose}>
                {t("Verstanden")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="calib-item">
              <div className="ci-icon">
                <Grid3x3 size={18} />
              </div>
              <div className="ci-main">
                <strong>{t("Bett-Leveling")}</strong>
                <span className="small muted">{t("Misst das Bett an vielen Punkten aus und speichert das Höhenprofil. Vorher das Bett säubern und die Düse von Filamentresten befreien.")}</span>
                <label className="plate-check small">
                  <input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} />
                  {t("Bett vorher heizen auf")}
                  <input className="input num mini" type="number" value={bed} min={40} max={maxBed} onChange={(e) => setBed(clamp(Number(e.target.value), 40, maxBed))} disabled={!heat} /> °C
                </label>
              </div>
              <button className="btn sm primary" disabled={busy} onClick={() => void run(heat ? `level:${bed}` : "level", t("Bett-Leveling"))}>
                {t("Starten")}
              </button>
            </div>
            <div className="calib-item">
              <div className="ci-icon">
                <Thermometer size={18} />
              </div>
              <div className="ci-main">
                <strong>{t("PID-Kalibrierung Düse")}</strong>
                <span className="small muted">{t("Stellt die Temperaturregelung neu ein – hilft, wenn die Düsentemperatur schwankt (nach Düsen- oder Heizblock-Tausch).")}</span>
                <label className="plate-check small">
                  {t("Zieltemperatur")}
                  <input className="input num mini" type="number" value={pidNoz} min={150} max={280} onChange={(e) => setPidNoz(clamp(Number(e.target.value), 150, 280))} /> °C
                </label>
              </div>
              <button className="btn sm" disabled={busy} onClick={() => void run(`pid_nozzle:${pidNoz}`, t("PID-Kalibrierung Düse"))}>
                {t("Starten")}
              </button>
            </div>
            <div className="calib-item">
              <div className="ci-icon">
                <Flame size={18} />
              </div>
              <div className="ci-main">
                <strong>{t("PID-Kalibrierung Bett")}</strong>
                <span className="small muted">{t("Dasselbe für das Heizbett – für gleichmäßige Haftung der ersten Schicht.")}</span>
                <label className="plate-check small">
                  {t("Zieltemperatur")}
                  <input className="input num mini" type="number" value={pidBed} min={40} max={maxBed} onChange={(e) => setPidBed(clamp(Number(e.target.value), 40, maxBed))} /> °C
                </label>
              </div>
              <button className="btn sm" disabled={busy} onClick={() => void run(`pid_bed:${pidBed}`, t("PID-Kalibrierung Bett"))}>
                {t("Starten")}
              </button>
            </div>
            {fb?.kind === "error" && (
              <span className="small" style={{ color: "var(--warning)" }}>
                <AlertTriangle size={12} /> {fb.text}
              </span>
            )}
            <p className="small muted">{t("Tipp: Den Z-Offset für die erste Schicht stellst du während des Drucks in der Werkzeug-Karte nach.")}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** Fertige G-Code-Datei vom Computer an den Drucker schicken. */
function UploadDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [plate, setPlate] = useState(false);
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string }>({ kind: "idle" });
  const name = path?.split(/[\\/]/).pop() ?? "";
  const pick = async () => {
    if (!isTauri) {
      setPath("demo/Benchy.gcode");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({ multiple: false, filters: [{ name: "G-Code", extensions: ["gcode", "gco", "g", "bgcode"] }] });
    if (typeof p === "string") setPath(p);
  };
  useEffect(() => {
    void pick();
  }, []);
  const go = async (start: boolean) => {
    if (!path) return;
    setState({ kind: "busy" });
    try {
      const n = await sendGcodeFile(path, start);
      setState({ kind: "done", text: start ? t("{f} wird gedruckt.", { f: n }) : t("{f} liegt jetzt auf dem Drucker.", { f: n }) });
    } catch (e) {
      setState({ kind: "error", text: typeof e === "string" ? e : t("Senden fehlgeschlagen.") });
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && state.kind !== "busy" && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="up-title">
        <div className="modal-head">
          <strong id="up-title">{t("G-Code an den Drucker senden")}</strong>
          <button className="btn sm ghost" aria-label={t("Schließen")} disabled={state.kind === "busy"} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-facts">
          <div>
            <span className="label">{t("Datei")}</span>
            <span className="file-name">{name || DASH}</span>
          </div>
        </div>
        {state.kind === "done" ? (
          <>
            <div className="modal-ok">
              <Check size={16} /> {state.text}
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={onClose}>
                {t("Fertig")}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="plate-check">
              <input type="checkbox" checked={plate} onChange={(e) => setPlate(e.target.checked)} />
              {t("Die Druckplatte ist frei und sauber")}
            </label>
            {state.kind === "error" && (
              <span className="small" style={{ color: "var(--warning)" }}>
                <AlertTriangle size={12} /> {state.text}
              </span>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => void pick()} disabled={state.kind === "busy"}>
                {t("Andere Datei…")}
              </button>
              <button className="btn" disabled={!path || state.kind === "busy"} onClick={() => void go(false)}>
                {t("Nur hochladen")}
              </button>
              <button className="btn primary" disabled={!path || !plate || state.kind === "busy"} onClick={() => void go(true)}>
                {state.kind === "busy" ? <Loader2 size={14} className="spin" /> : <FileUp size={14} />} {t("Hochladen und drucken")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Weitere Drucker: kompakte Kacheln, Klick schaltet um. */
export function FleetStrip() {
  const others = useStore((s) => s.others);
  if (others.length === 0) return null;
  return (
    <div className="fleet" role="list" aria-label={t("Weitere Drucker")}>
      {others.map((o) => {
        const st = o.status;
        const job = !!st && (st.state === "printing" || st.state === "paused");
        const conn = o.connection.kind;
        const pct = job ? Math.round(st!.progress ?? 0) : null;
        return (
          <button key={o.id} role="listitem" className={`fleet-tile card${job ? " busy" : ""}`} onClick={() => void switchPrinter(o.id)} title={t("Im Dashboard zeigen")}>
            <div className="ft-head">
              <span className={`dot ${conn === "connected" ? "ok" : conn === "reconnecting" ? "bad" : "wait"}`} aria-hidden />
              <span className="ft-name">{o.name}</span>
              {conn === "connected" && st ? (
                <Badge tone={STATE_TONE[st.state]}>{STATE_LABEL[st.state]}</Badge>
              ) : (
                <span className="small muted">{conn === "reconnecting" ? t("nicht erreichbar") : t("verbinde…")}</span>
              )}
            </div>
            {job ? (
              <>
                <div className="bar is-live">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <div className="small muted num ft-meta">
                  <span>{pct} %</span>
                  <span>{t("noch {d}", { d: fmtDuration(st!.remainingS) })}</span>
                </div>
              </>
            ) : (
              <div className="small muted num ft-meta">
                <span>
                  {t("Düse")} {fmtNum(st?.nozzleTemp)} °C
                </span>
                <span>
                  {t("Bett")} {fmtNum(st?.bedTemp)} °C
                </span>
                {!capsOf(o.kind).temps && <span />}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Zustand des KI-Fehlerwächters (nur wenn eingeschaltet) */
function AiChip() {
  const ai = useStore((s) => s.ai);
  const on = useStore((s) => s.settings.aiEnabled);
  if (!on || !ai || ai.state === "off" || ai.state === "") return null;
  const map: Record<string, [string, string]> = {
    nomodel: [t("KI: Modell fehlt"), "warn"],
    nocamera: [t("KI: keine Kamera"), "warn"],
    idle: [t("KI bereit"), ""],
    watching: [t("KI wacht"), "ok"],
    warning: [t("KI: genauer hinsehen"), "warn"],
    failing: [t("KI: Fehler erkannt"), "bad"],
  };
  const [label, tone] = map[ai.state] ?? ["", ""];
  if (!label) return null;
  return (
    <span className={`ai-chip ${tone}`} title={ai.state === "watching" ? t("Letzte Bewertung: {s}", { s: ai.score.toFixed(2) }) : undefined}>
      <i /> {label}
    </span>
  );
}
