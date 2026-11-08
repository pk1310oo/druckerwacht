import { useEffect, useState } from "react";
import { Box, Check, CheckCircle2, CircleSlash, Clock, Download, Film, History, Layers, Printer, Ruler, Trash2, Wrench, XCircle } from "lucide-react";
import { useMaintenance } from "../lib/maintenance";
import { onTimelapse, timelapseDelete, timelapseExport, timelapseList, type Timelapse } from "../lib/extras";
import { useStore } from "../lib/store";
import { clearJobs, historyThumbCandidates } from "../lib/api";
import { fmtDateTime, fmtDuration, fmtNum } from "../lib/format";
import { Card, EmptyState, Segmented } from "../components/ui";
import type { JobRecord, PrinterJob } from "../lib/types";
import { t } from "../lib/i18n";

const RESULT: Record<JobRecord["result"], { label: string; icon: typeof CheckCircle2 }> = {
  finished: { get label() { return t("Fertig"); }, icon: CheckCircle2 },
  failed: { get label() { return t("Fehler"); }, icon: XCircle },
  aborted: { get label() { return t("Abgebrochen"); }, icon: CircleSlash },
};

type Source = "printer" | "app";

export function HistoryView() {
  const [source, setSource] = useState<Source>("printer");
  return (
    <div className="view">
      <MaintenanceCard />
      <Timelapses />
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">{t("Druckverlauf")}</span>
        <Segmented
          ariaLabel={t("Quelle")}
          value={source}
          onChange={setSource}
          options={[
            { value: "printer", label: t("Vom Drucker") },
            { value: "app", label: t("Diese App") },
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
          title={t("Noch kein Verlauf vom Drucker")}
          text={t("Der Drucker schickt seine Liste der letzten Drucke beim Verbinden oder spätestens nach dem nächsten fertigen Druck. Danach bleibt sie hier gespeichert.")}
        />
      </Card>
    );
  }
  const finished = h.jobs.filter((j) => j.finished).length;
  return (
    <>
      <div className="stats history-stats">
        <Stat icon={Layers} label={t("Drucke")} value={fmtNum(h.totalJobs ?? h.jobs.length)} sub={t("{ok} fertig · {bad} abgebrochen (letzte {n})", { ok: finished, bad: h.jobs.length - finished, n: h.jobs.length })} />
        <Stat icon={Clock} label={t("Druckzeit gesamt")} value={fmtDuration(h.totalTimeS)} sub={t("laut Drucker")} />
        <Stat
          icon={Ruler}
          label={t("Filament gesamt")}
          value={h.totalMaterialMm != null ? `${fmtNum(h.totalMaterialMm / 1000, 1)} m` : "–"}
          sub={h.totalMaterialMm != null ? `≈ ${fmtNum((h.totalMaterialMm / 1000) * 2.98, 0)} g PLA` : ""}
        />
      </div>
      <Card className="jobs">
        <div role="table" aria-label={t("Druckverlauf des Druckers")}>
          <div className="job job-head job-printer label" role="row">
            <span />
            <span>{t("Datei")}</span>
            <span className="col-date">{t("Gestartet")}</span>
            <span className="right">{t("Dauer")}</span>
            <span className="right">{t("Filament")}</span>
            <span className="right">{t("Ergebnis")}</span>
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
              <span className={`right ${j.finished ? "ok-text" : "muted"}`}>{j.finished ? t("Fertig") : t("Abgebrochen")}</span>
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
            title={t("Noch keine Drucke aufgezeichnet")}
            text={t("Jeder Druck, den die App von Anfang bis Ende mitverfolgt, landet hier – mit Dauer und Ergebnis.")}
          />
        ) : (
          <div role="table" aria-label={t("Druckverlauf dieser App")}>
            <div className="job job-head label" role="row">
              <span />
              <span>{t("Datei")}</span>
              <span className="col-date">{t("Beendet")}</span>
              <span className="right">{t("Dauer")}</span>
              <span className="right">{t("Ergebnis")}</span>
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
                    {j.layers != null && <div className="small muted num">{t("{n} Schichten", { n: fmtNum(j.layers) })}</div>}
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
                {t("Behalten")}
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  void clearJobs();
                  setConfirm(false);
                }}
              >
                <Trash2 size={14} /> {t("Wirklich leeren")}
              </button>
            </>
          ) : (
            <button className="btn sm ghost" onClick={() => setConfirm(true)}>
              <Trash2 size={14} /> {t("Verlauf leeren")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Zeitraffer-Videos der letzten Drucke (nur sichtbar, wenn es welche gibt). */
function Timelapses() {
  const [list, setList] = useState<Timelapse[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void timelapseList().then(setList);
    load();
    let off: (() => void) | undefined;
    void onTimelapse(load).then((f) => (off = f));
    return () => off?.();
  }, []);
  if (list.length === 0) return null;
  return (
    <>
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">
          <Film size={14} /> {t("Zeitraffer")}
        </span>
      </div>
      <div className="timelapses">
        {list.map((tl) => (
          <Card key={tl.id} className="tl-card">
            <div className="tl-cover">{tl.cover ? <img src={tl.cover} alt="" /> : <Film size={28} />}</div>
            <div className="tl-body">
              <div className="file-name" title={tl.name}>
                {tl.name}
              </div>
              <div className="small muted num">
                {fmtDateTime(tl.createdMs)} · {t("{n} Bilder", { n: tl.frames })} · {fmtNum(tl.frames / 30, 1)} s · {fmtNum(tl.sizeBytes / 1e6, 1)} MB
              </div>
              <div className="tl-actions">
                {confirm === tl.id ? (
                  <>
                    <button className="btn sm ghost" onClick={() => setConfirm(null)}>
                      {t("Nein")}
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={() =>
                        void timelapseDelete(tl.id).then(() => {
                          setConfirm(null);
                          setList((l) => l.filter((x) => x.id !== tl.id));
                        })
                      }
                    >
                      {t("Löschen")}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn sm" onClick={() => void timelapseExport(tl)}>
                      <Download size={14} /> {t("Video speichern")}
                    </button>
                    <button className="btn sm ghost" aria-label={t("Löschen")} onClick={() => setConfirm(tl.id)}>
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <p className="hint">{t("Die Videos sind QuickTime-Dateien (.mov) und laufen in QuickTime, iMovie und VLC. Für TikTok in iMovie oder CapCut öffnen und von dort teilen.")}</p>
    </>
  );
}

/** Wartungsplaner: Pflege nach Druckstunden */
function MaintenanceCard() {
  const { hours, items, markDone, due } = useMaintenance();
  const [open, setOpen] = useState<string | null>(null);
  if (hours == null) return null;
  return (
    <Card className="maint-card">
      <div className="chart-head">
        <span className="label">
          <Wrench size={14} /> {t("Wartung")}
        </span>
        <span className="small muted num">
          {t("{h} Druckstunden", { h: fmtNum(hours, 0) })}
          {due.length > 0 && <> · <b className="warn-text">{t("{n} fällig", { n: due.length })}</b></>}
        </span>
      </div>
      <div className="maint-list">
        {items.map(({ task, since, ratio }) => {
          const left = Math.max(0, task.every - since);
          const tone = ratio >= 1 ? "due" : ratio >= 0.8 ? "soon" : "";
          return (
            <div key={task.id} className={`maint-item ${tone}`}>
              <button className="mi-main" onClick={() => setOpen(open === task.id ? null : task.id)} aria-expanded={open === task.id}>
                <span className="mi-title">{task.title()}</span>
                <span className="small muted num">
                  {ratio >= 1 ? t("fällig seit {h} h", { h: fmtNum(since - task.every, 0) }) : t("in {h} h", { h: fmtNum(left, 0) })} · {t("alle {h} h", { h: task.every })}
                </span>
                <span className="mi-bar" aria-hidden>
                  <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                </span>
              </button>
              <button className={`btn sm${ratio >= 1 ? " primary" : " ghost"}`} onClick={() => markDone(task.id)} title={t("Als erledigt markieren")}>
                <Check size={14} /> {t("Erledigt")}
              </button>
              {open === task.id && <p className="small muted mi-how">{task.how()}</p>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
