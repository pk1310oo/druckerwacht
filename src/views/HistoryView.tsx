import { useState } from "react";
import { CheckCircle2, CircleSlash, History, Trash2, XCircle } from "lucide-react";
import { useStore } from "../lib/store";
import { clearJobs } from "../lib/api";
import { fmtDateTime, fmtDuration, fmtNum } from "../lib/format";
import { Card, EmptyState } from "../components/ui";
import type { JobRecord } from "../lib/types";

const RESULT: Record<JobRecord["result"], { label: string; icon: typeof CheckCircle2 }> = {
  finished: { label: "Fertig", icon: CheckCircle2 },
  failed: { label: "Fehler", icon: XCircle },
  aborted: { label: "Abgebrochen", icon: CircleSlash },
};

export function HistoryView() {
  const jobs = useStore((s) => s.jobs);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="view">
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">Druckverlauf</span>
        {jobs.length > 0 &&
          (confirm ? (
            <span style={{ display: "flex", gap: 8 }}>
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
            </span>
          ) : (
            <button className="btn sm ghost" onClick={() => setConfirm(true)}>
              <Trash2 size={14} /> Verlauf leeren
            </button>
          ))}
      </div>
      <Card className="jobs" >
        {jobs.length === 0 ? (
          <EmptyState
            icon={History}
            title="Noch keine Drucke aufgezeichnet"
            text="Jeder Druck, den die App von Anfang bis Ende mitverfolgt, landet hier – mit Dauer und Ergebnis."
          />
        ) : (
          <div role="table" aria-label="Druckverlauf">
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
    </div>
  );
}
