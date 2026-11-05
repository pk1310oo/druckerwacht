import { useEffect, useState } from "react";
import { Box, CheckCircle2, CircleSlash, Clock, History, Layers, Printer, Ruler, Trash2, XCircle } from "lucide-react";
import { useStore } from "../lib/store";
import { clearJobs, historyThumbCandidates } from "../lib/api";
import { fmtDateTime, fmtDuration, fmtNum } from "../lib/format";
import { Card, EmptyState, Segmented } from "../components/ui";
import type { JobRecord, PrinterJob } from "../lib/types";

const RESULT: Record<JobRecord["result"], { label: string; icon: typeof CheckCircle2 }> = {
  finished: { label: "Fertig", icon: CheckCircle2 },
  failed: { label: "Fehler", icon: XCircle },
  aborted: { label: "Abgebrochen", icon: CircleSlash },
};

type Source = "printer" | "app";

export function HistoryView() {
  const [source, setSource] = useState<Source>("printer");
  return (
    <div className="view">
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">Druckverlauf</span>
        <Segmented
          ariaLabel="Quelle"
          value={source}
          onChange={setSource}
          options={[
            { value: "printer", label: "Vom Drucker" },
            { value: "app", label: "Diese App" },
          ]}
        />
      </div>
      {source === "printer" ? <PrinterHistoryList /> : <AppHistory />}
    </div>
  );
}

function PrinterHistoryList() {
  const h = useStore((s) => s.printerHistory);
  if (!h || !h.jobs.length) {
    return (
      <Card>
        <EmptyState
          icon={Printer}
          title="Noch kein Verlauf vom Drucker"
          text="Der Drucker schickt seine Liste der letzten Drucke beim Verbinden oder spätestens nach dem nächsten fertigen Druck. Danach bleibt sie hier gespeichert."
        />
      </Card>
    );
  }
  const finished = h.jobs.filter((j) => j.finished).length;
  return (
    <>
      <div className="stats history-stats">
        <Stat icon={Layers} label="Drucke" value={fmtNum(h.totalJobs ?? h.jobs.length)} sub={`${finished} fertig · ${h.jobs.length - finished} abgebrochen (letzte ${h.jobs.length})`} />
        <Stat icon={Clock} label="Druckzeit gesamt" value={fmtDuration(h.totalTimeS)} sub="laut Drucker" />
        <Stat
          icon={Ruler}
          label="Filament gesamt"
          value={h.totalMaterialMm != null ? `${fmtNum(h.totalMaterialMm / 1000, 1)} m` : "–"}
          sub={h.totalMaterialMm != null ? `≈ ${fmtNum((h.totalMaterialMm / 1000) * 2.98, 0)} g PLA` : ""}
        />
      </div>
      <Card className="jobs">
        <div role="table" aria-label="Druckverlauf des Druckers">
          <div className="job job-head job-printer label" role="row">
            <span />
            <span>Datei</span>
            <span className="col-date">Gestartet</span>
            <span className="right">Dauer</span>
            <span className="right">Filament</span>
            <span className="right">Ergebnis</span>
          </div>
          {h.jobs.map((j) => (
            <div className="job job-printer" role="row" key={`${j.id}-${j.startedS}`}>
              <HistoryThumb job={j} />
              <span style={{ minWidth: 0 }}>
                <div className="file-name" title={j.file}>
                  {j.file}
                </div>
              </span>
              <span className="col-date muted num">{j.startedS ? fmtDateTime(j.startedS * 1000) : "–"}</span>
              <span className="right num">{fmtDuration(j.durationS)}</span>
              <span className="right num muted">{fmtNum(j.materialMm / 1000, 2)} m</span>
              <span className={`right ${j.finished ? "ok-text" : "muted"}`}>{j.finished ? "Fertig" : "Abgebrochen"}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Clock; label: string; value: string; sub: string }) {
  return (
    <Card className="stat">
      <div className="stat-head">
        <span className="label">{label}</span>
        <Icon size={16} strokeWidth={1.75} />
      </div>
      <span className="big num">{value}</span>
      <div className="stat-sub">{sub}</div>
    </Card>
  );
}

/** Vorschaubild vom Drucker – probiert die möglichen Adressen nacheinander, sonst Platzhalter. */
function HistoryThumb({ job }: { job: PrinterJob }) {
  const candidates = historyThumbCandidates(job);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [job.id]);
  const src = candidates[i];
  return (
    <span className="job-thumb">
      {src ? <img src={src} alt="" loading="lazy" onError={() => setI((n) => n + 1)} /> : <Box size={16} strokeWidth={1.5} />}
    </span>
  );
}

function AppHistory() {
  const jobs = useStore((s) => s.jobs);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Card className="jobs">
        {jobs.length === 0 ? (
          <EmptyState
            icon={History}
            title="Noch keine Drucke aufgezeichnet"
            text="Jeder Druck, den die App von Anfang bis Ende mitverfolgt, landet hier – mit Dauer und Ergebnis."
          />
        ) : (
          <div role="table" aria-label="Druckverlauf dieser App">
            <div className="job job-head label" role="row">
              <span />
              <span>Datei</span>
              <span className="col-date">Beendet</span>
              <span className="right">Dauer</span>
              <span className="right">Ergebnis</span>
            </div>
            {jobs.map((j) => {
              const r = RESULT[j.result] ?? RESULT.aborted;
              const Icon = r.icon;
              return (
                <div className="job" role="row" key={`${j.startedMs}-${j.file}`}>
                  <span className={`job-icon ${j.result}`}>
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div className="file-name" title={j.file}>
                      {j.file}
                    </div>
                    {j.layers != null && <div className="small muted num">{fmtNum(j.layers)} Schichten</div>}
                  </span>
                  <span className="col-date muted num">{fmtDateTime(j.endedMs)}</span>
                  <span className="right num">{fmtDuration(j.durationS)}</span>
                  <span className="right muted">{r.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {jobs.length > 0 && (
        <div className="save-bar">
          {confirm ? (
            <>
              <button className="btn sm ghost" onClick={() => setConfirm(false)}>
                Behalten
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  void clearJobs();
                  setConfirm(false);
                }}
              >
                <Trash2 size={14} /> Wirklich leeren
              </button>
            </>
          ) : (
            <button className="btn sm ghost" onClick={() => setConfirm(true)}>
              <Trash2 size={14} /> Verlauf leeren
            </button>
          )}
        </div>
      )}
    </>
  );
}
