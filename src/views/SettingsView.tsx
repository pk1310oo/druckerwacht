import { useEffect, useMemo, useState } from "react";
import { Bug, Check, Copy, Download, ExternalLink, FolderGit2, KeyRound, Loader2, Pencil, PlugZap, Plus, Radar, RefreshCw, Search, Send, Smartphone, Trash2, Wifi } from "lucide-react";
import { useStore } from "../lib/store";
import { discoverPrinters, isTauri, onRemoteChange, rawLogDir, reconnect, remoteInfo, remoteNewToken, saveSettings, type RemoteInfo } from "../lib/api";
import { Qr } from "../components/Qr";
import { connectionLabel } from "../lib/format";
import type { FoundPrinter, PrinterKind, PrinterProfile, Settings } from "../lib/types";
import { KINDS, defaultPort, hostLabel, kindInfo, newPrinterId } from "../lib/printers";
import { Card, Segmented, Switch } from "../components/ui";
import { t } from "../lib/i18n";
import { THEMES, THEME_IDS } from "../lib/theme";
import { slicerInfo, type SlicerInfo } from "../slicer/api";
import { APP_VERSION, REPO_URL, checkForUpdate, openProjectLink, type UpdateInfo } from "../lib/update";
import { cameraProbe, ntfyTest, randomTopic } from "../lib/extras";
import { setFxLevel, useFxLevel, type FxLevel } from "../lib/fx";
import { listWebcams, type Webcam } from "../lib/webcam";
import { WebcamFrame } from "../components/Camera";

const THEME_NAMES: Record<(typeof THEME_IDS)[number], string> = { orange: "Orange", blue: "Blau", green: "Grün", purple: "Lila", pink: "Pink", cyan: "Türkis", lime: "Limette" };

const HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?!$)|$)){4}$|^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

/** Fehler je Feld; Drucker unter `printer:<id>` bzw. `key:<id>` */
function validate(s: Settings) {
  const errors: Record<string, string> = {};
  for (const p of s.printers) {
    const ip = p.host.trim().replace(/^(wss?|https?):\/\//, "").replace(/[:/].*$/, "");
    if (!ip) errors[`printer:${p.id}`] = t("Bitte die Adresse des Druckers eintragen.");
    else if (!HOST_RE.test(ip)) errors[`printer:${p.id}`] = t("Bitte eine gültige IP-Adresse eingeben, z. B. 192.168.178.42.");
    if (p.kind === "octoprint" && !p.key.trim()) errors[`key:${p.id}`] = t("OctoPrint braucht einen API-Schlüssel.");
  }
  if (s.cameraUrl.trim() && !/^https?:\/\/.+/i.test(s.cameraUrl.trim()))
    errors.cameraUrl = t("Die Adresse muss mit http:// oder https:// beginnen.");
  return errors;
}

export function SettingsView() {
  const saved = useStore((s) => s.settings);
  const connection = useStore((s) => s.connection);
  const [draft, setDraft] = useState<Settings>(saved);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [logDir, setLogDir] = useState("");
  const [orca, setOrca] = useState<SlicerInfo | null>(null);
  useEffect(() => {
    void slicerInfo().then(setOrca);
  }, [saved.orcaPath]);

  useEffect(() => setDraft(saved), [saved]);
  useEffect(() => {
    void rawLogDir().then(setLogDir);
  }, []);
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(t);
  }, [justSaved]);

  const errors = useMemo(() => validate(draft), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function onSave() {
    if (Object.keys(errors).length) return;
    setBusy(true);
    setSaveError(null);
    try {
      await saveSettings(draft);
      setJustSaved(true);
    } catch (e) {
      setSaveError(typeof e === "string" ? e : t("Einstellungen konnten nicht gespeichert werden."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view settings">
      <Card className="form-section">
        <span className="label">{t("Darstellung")}</span>
        <div className="toggle-row" style={{ borderTop: 0, paddingTop: 0 }}>
          <div>
            <div>{t("Akzentfarbe")}</div>
            <div className="hint">{t("Farbe der Knöpfe, Balken, Diagramme und Effekte.")}</div>
          </div>
          <div className="accent-swatches" role="radiogroup" aria-label={t("Akzentfarbe")}>
            {THEME_IDS.map((id) => (
              <button
                key={id}
                role="radio"
                aria-checked={saved.accent === id}
                aria-label={t(THEME_NAMES[id])}
                title={t(THEME_NAMES[id])}
                className={`accent-swatch ${saved.accent === id ? "on" : ""}`}
                style={{ ["--sw" as string]: THEMES[id].accent }}
                onClick={() => void saveSettings({ ...saved, accent: id })}
              />
            ))}
          </div>
        </div>
        <EffectsRow />
      </Card>

      <Card className="form-section">
        <span className="label">{t("Sprache")}</span>
        <div className="toggle-row" style={{ borderTop: 0, paddingTop: 0 }}>
          <div>
            <div>{t("Sprache der App")}</div>
            <div className="hint">{t("„System“ folgt der Sprache deines Computers.")}</div>
          </div>
          <Segmented
            ariaLabel={t("Sprache")}
            value={saved.language}
            options={[
              { value: "", label: t("System") },
              { value: "de", label: "Deutsch" },
              { value: "en", label: "English" },
            ]}
            onChange={(language) => void saveSettings({ ...saved, language })}
          />
        </div>
      </Card>

      <PrintersCard
        draft={draft}
        errors={errors}
        onChange={(printers, activePrinter) => setDraft((d) => ({ ...d, printers, activePrinter: activePrinter ?? d.activePrinter }))}
      />

      <Card className="form-section">
        <span className="label">{t("Kamera")}</span>
        <div className="field">
          <label htmlFor="webcam">{t("Webcam am Computer")}</label>
          <WebcamPicker value={draft.localCamera} onChange={(v) => set("localCamera", v)} />
          <span className="hint">{t("Für eine Webcam, die per USB an diesem Computer steckt. Hat Vorrang vor der Stream-Adresse.")}</span>
        </div>
        <div className="field">
          <label htmlFor="cam">{t("Stream-Adresse (optional)")}</label>
          <input
            id="cam"
            className={`input ${errors.cameraUrl ? "invalid" : ""}`}
            placeholder={t("z. B. http://192.168.178.42:8080/?action=stream")}
            value={draft.cameraUrl}
            spellCheck={false}
            onChange={(e) => set("cameraUrl", e.target.value)}
          />
          {errors.cameraUrl ? (
            <span className="hint error">{errors.cameraUrl}</span>
          ) : (
            <span className="hint">
              {t("Eine Creality-Nebula-Kamera am Drucker wird nach dem Verbinden automatisch gefunden (normale Webcams erkennt der KE nicht – die bitte oben am Computer einstecken).")}
            </span>
          )}
          <CameraSearch onFound={(url) => set("cameraUrl", url)} />
        </div>
        <div>
          <ToggleRow
            label={t("Zeitraffer aufnehmen")}
            hint={t("Pro Schicht ein Bild – nach dem Druck entsteht daraus ein Video (unter Verlauf).")}
            on={draft.timelapse}
            set={(v) => set("timelapse", v)}
          />
        </div>
      </Card>

      <RemoteCard />

      <Card className="form-section">
        <span className="label">{t("Aufs Handy")}</span>
        <div className="field">
          <label htmlFor="ntfy">{t("ntfy-Thema (optional)")}</label>
          <div className="row-input">
            <input
              id="ntfy"
              className="input"
              placeholder="druckerwacht-…"
              value={draft.ntfyTopic}
              spellCheck={false}
              onChange={(e) => set("ntfyTopic", e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
            />
            {!draft.ntfyTopic && (
              <button type="button" className="btn" onClick={() => set("ntfyTopic", randomTopic())}>
                {t("Thema erzeugen")}
              </button>
            )}
            {draft.ntfyTopic && <NtfyTest topic={draft.ntfyTopic} />}
          </div>
          <span className="hint">
            {t("1. Die kostenlose App „ntfy“ aufs Handy laden. 2. Dort dieses Thema abonnieren. 3. Speichern – ab jetzt kommen alle Benachrichtigungen auch aufs Handy, auch unterwegs. Das Thema wirkt wie ein Passwort: nicht weitergeben.")}
          </span>
          {(draft.localCamera || draft.cameraUrl) && (
            <span className="hint">📷 {t("Mit Kamera kommt bei Pause, Druckende und Fehlern ein Foto vom Druck mit.")}</span>
          )}
        </div>
      </Card>

      <Card className="form-section">
        <span className="label">{t("Slicer")}</span>
        <div className="field">
          <label htmlFor="orca">{t("Pfad zu OrcaSlicer (optional)")}</label>
          <input
            id="orca"
            className="input"
            placeholder={/Mac/i.test(navigator.userAgent) ? "/Applications/OrcaSlicer.app" : /Windows/i.test(navigator.userAgent) ? "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe" : t("z. B. ~/Applications/OrcaSlicer.AppImage")}
            value={draft.orcaPath}
            spellCheck={false}
            onChange={(e) => set("orcaPath", e.target.value)}
          />
          <span className="hint">
            {orca?.found ? t("Gefunden: {path}", { path: orca.path ?? "" }) : t("Leer lassen – die App sucht OrcaSlicer automatisch an den üblichen Orten.")}
          </span>
        </div>
      </Card>

      <Card className="form-section">
        <span className="label">{t("Benachrichtigungen")}</span>
        <div>
          <ToggleRow label={t("Druck fertig")} hint={t("Wenn ein Druck erfolgreich beendet wurde.")} on={draft.notifyFinished} set={(v) => set("notifyFinished", v)} />
          <ToggleRow label={t("Fehler")} hint={t("Druckerfehler, fehlgeschlagene oder abgebrochene Drucke.")} on={draft.notifyError} set={(v) => set("notifyError", v)} />
          <ToggleRow label={t("Verbindung verloren")} hint={t("Wenn der Drucker länger als 20 Sekunden nicht erreichbar ist.")} on={draft.notifyDisconnect} set={(v) => set("notifyDisconnect", v)} />
        </div>
      </Card>

      <Card className="form-section">
        <span className="label">{t("Diagnose")}</span>
        <div>
          <ToggleRow
            label={t("Rohdaten mitschneiden")}
            hint={t("Speichert alle Nachrichten des Druckers als Datei – hilfreich, um die Auswertung zu verbessern.")}
            on={draft.rawLog}
            set={(v) => set("rawLog", v)}
          />
          {logDir && (
            <div className="toggle-row" style={{ display: "block" }}>
              <code className="path">{logDir}</code>
            </div>
          )}
          <div className="toggle-row">
            <div>
              <div>{t("Verbindung")}</div>
              <div className="hint">{connectionLabel(connection)}</div>
            </div>
            <button className="btn sm" onClick={() => void reconnect()} disabled={connection.kind === "unconfigured"}>
              <PlugZap size={14} /> {t("Neu verbinden")}
            </button>
          </div>
        </div>
      </Card>

      <AboutCard />

      <div className="save-bar">
        {justSaved && (
          <span className="saved">
            <Check size={14} /> {t("Gespeichert")}
          </span>
        )}
        {saveError && <span className="hint error">{saveError}</span>}
        <button className="btn ghost" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
          {t("Verwerfen")}
        </button>
        <button className="btn primary" disabled={!dirty || busy || Object.keys(errors).length > 0} onClick={() => void onSave()}>
          {t("Speichern")}
        </button>
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, on, set }: { label: string; hint: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <div>
        <div>{label}</div>
        <div className="hint">{hint}</div>
      </div>
      <Switch on={on} onChange={set} label={label} />
    </div>
  );
}

function AboutCard() {
  const [check, setCheck] = useState<{ running: boolean; info: UpdateInfo | null; done: boolean }>({ running: false, info: null, done: false });
  const run = async () => {
    setCheck({ running: true, info: null, done: false });
    setCheck({ running: false, info: await checkForUpdate(), done: true });
  };
  useEffect(() => {
    void run();
  }, []);
  const open = (url: string) => void openProjectLink(url).catch(() => {});

  let status: React.ReactNode;
  if (check.running) status = t("Suche nach neuer Version …");
  else if (check.info?.newer)
    status = (
      <span style={{ color: "var(--accent)" }}>
        {t("Version {v} ist verfügbar.", { v: check.info.latest })}
      </span>
    );
  else if (check.info) status = t("Du hast die neueste Version.");
  else if (check.done) status = t("Neue Versionen konnten gerade nicht geprüft werden (offline?).");

  return (
    <Card className="form-section">
      <span className="label">{t("Über Druckerwacht")}</span>
      <div>
        <div className="toggle-row">
          <div>
            <div>
              Version <span className="num">{APP_VERSION}</span> <span className="badge-beta">Beta</span>
            </div>
            <div className="hint">{status}</div>
          </div>
          {check.info?.newer ? (
            <button className="btn sm primary" onClick={() => open(check.info!.url)}>
              <Download size={14} /> {t("Herunterladen")}
            </button>
          ) : (
            <button className="btn sm" onClick={() => void run()} disabled={check.running}>
              <RefreshCw size={14} className={check.running ? "spin" : undefined} /> {t("Prüfen")}
            </button>
          )}
        </div>
        <div className="toggle-row">
          <div>
            <div>Open Source</div>
            <div className="hint">{t("Kostenlos unter der AGPL-3.0. Entwickelt von pk1310oo. Slicer-Motor: OrcaSlicer.")}</div>
          </div>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="btn sm ghost" onClick={() => open(`${REPO_URL}/issues`)}>
              <Bug size={14} /> {t("Fehler melden")}
            </button>
            <button className="btn sm ghost" onClick={() => open(REPO_URL)}>
              <FolderGit2 size={14} /> GitHub <ExternalLink size={12} />
            </button>
          </span>
        </div>
        <div className="toggle-row" style={{ display: "block" }}>
          <div className="hint">
            {t("Beta: Druckerwacht ist kein offizielles Creality-Produkt und nutzt eine undokumentierte Schnittstelle. Lass laufende Drucke nicht unbeaufsichtigt und prüfe Befehle im Zweifel am Druckerdisplay. Nutzung auf eigene Verantwortung.")}
          </div>
        </div>
      </div>
    </Card>
  );
}

function CameraSearch({ onFound }: { onFound: (url: string) => void }) {
  const [state, setState] = useState<"idle" | "busy" | "none" | "found">("idle");
  return (
    <div className="row-input">
      <button
        type="button"
        className="btn sm"
        disabled={state === "busy"}
        onClick={() => {
          setState("busy");
          void cameraProbe().then((url) => {
            if (url) onFound(url);
            setState(url ? "found" : "none");
          });
        }}
      >
        {state === "busy" ? <Loader2 size={14} className="spin" /> : <Search size={14} />} {t("Kamera am Drucker suchen")}
      </button>
      {state === "found" && <span className="hint">{t("Gefunden – zum Übernehmen speichern.")}</span>}
      {state === "none" && <span className="hint">{t("Keine Kamera gefunden. Ist sie per USB am Drucker eingesteckt?")}</span>}
    </div>
  );
}

function NtfyTest({ topic }: { topic: string }) {
  const [state, setState] = useState<"idle" | "busy" | "ok" | string>("idle");
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={state === "busy"}
        onClick={() => {
          setState("busy");
          ntfyTest(topic)
            .then(() => setState("ok"))
            .catch((e) => setState(typeof e === "string" ? e : t("Senden fehlgeschlagen.")));
        }}
      >
        {state === "busy" ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {t("Test senden")}
      </button>
      {state === "ok" && <span className="hint">{t("Gesendet – kam es an?")}</span>}
      {state !== "idle" && state !== "busy" && state !== "ok" && <span className="hint error">{state}</span>}
    </>
  );
}

/** Effekte voll oder dezent – gilt nur für diesen Computer. */
function EffectsRow() {
  const fx = useFxLevel();
  return (
    <div className="toggle-row">
      <div>
        <div>{t("Effekte")}</div>
        <div className="hint">{t("„Dezent“ schaltet Neon-Hintergrund, Glas-Unschärfe und 3D-Karten ab – für ältere oder langsame Rechner.")}</div>
      </div>
      <Segmented<FxLevel>
        ariaLabel={t("Effekte")}
        value={fx}
        options={[
          { value: "full", label: t("Voll") },
          { value: "calm", label: t("Dezent") },
        ]}
        onChange={setFxLevel}
      />
    </div>
  );
}

function WebcamPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [cams, setCams] = useState<Webcam[]>([]);
  const [state, setState] = useState<"idle" | "busy" | "denied" | "none" | "unsupported">("idle");
  const search = (ask: boolean) => {
    setState("busy");
    listWebcams(ask)
      .then((c) => {
        setCams(c);
        setState(c.length ? "idle" : "none");
      })
      .catch((e: Error) => setState(e?.name === "NotAllowedError" ? "denied" : e?.name === "Unsupported" ? "unsupported" : "none"));
  };
  // Beim Öffnen still nachsehen (ohne Fehlermeldung, ohne Kamerafreigabe)
  useEffect(() => {
    listWebcams(false).then(setCams).catch(() => {});
  }, []);
  const known = cams.some((c) => c.deviceId === value);
  return (
    <>
      <div className="row-input" style={{ marginTop: 0 }}>
        <select id="webcam" className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("Keine – Stream-Adresse nutzen")}</option>
          {cams.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label}
            </option>
          ))}
          {value && !known && <option value={value}>{t("Gespeicherte Webcam")}</option>}
        </select>
        <button type="button" className="btn" disabled={state === "busy"} onClick={() => search(true)}>
          {state === "busy" ? <Loader2 size={14} className="spin" /> : <Search size={14} />} {t("Webcams suchen")}
        </button>
      </div>
      {state === "denied" && <span className="hint error">{t("Kamerazugriff wurde abgelehnt. Mac: Systemeinstellungen → Datenschutz & Sicherheit → Kamera → Druckerwacht erlauben.")}</span>}
      {state === "none" && <span className="hint error">{t("Keine Webcam gefunden. Ist sie eingesteckt?")}</span>}
      {state === "unsupported" && <span className="hint error">{t("Diese Version kann hier nicht auf Webcams zugreifen. Bitte Druckerwacht einmal neu starten.")}</span>}
      {value && (
        <div className="webcam-preview">
          <WebcamFrame deviceId={value} />
        </div>
      )}
    </>
  );
}

/** Liste aller Drucker: hinzufügen, bearbeiten, entfernen, im Netz suchen. */
function PrintersCard({ draft, errors, onChange }: { draft: Settings; errors: Record<string, string>; onChange: (p: PrinterProfile[], active?: string) => void }) {
  const others = useStore((s) => s.others);
  const connection = useStore((s) => s.connection);
  const savedActive = useStore((s) => s.settings.activePrinter);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [scan, setScan] = useState<{ running: boolean; results: FoundPrinter[] | null }>({ running: false, results: null });
  const printers = draft.printers;

  const update = (id: string, patch: Partial<PrinterProfile>) => onChange(printers.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const add = (init: Partial<PrinterProfile> = {}) => {
    const p: PrinterProfile = { id: newPrinterId(), name: t("Drucker {n}", { n: printers.length + 1 }), kind: "creality", host: "", port: null, key: "", ...init };
    onChange([...printers, p], printers.length === 0 ? p.id : undefined);
    setEditing(p.id);
  };
  const remove = (id: string) => {
    const rest = printers.filter((p) => p.id !== id);
    onChange(rest, draft.activePrinter === id ? rest[0]?.id ?? "" : undefined);
    setConfirmDel(null);
    if (editing === id) setEditing(null);
  };
  const onScan = async () => {
    setScan({ running: true, results: null });
    try {
      setScan({ running: false, results: await discoverPrinters() });
    } catch {
      setScan({ running: false, results: [] });
    }
  };
  const take = (f: FoundPrinter) => {
    const name = f.hostname || f.model || kindInfo(f.kind).label;
    const target = editing ? printers.find((p) => p.id === editing) : undefined;
    if (target && !target.host) update(target.id, { kind: f.kind, host: f.ip, port: f.port, name: target.name.startsWith(t("Drucker")) ? name : target.name });
    else add({ kind: f.kind, host: f.ip, port: f.port, name });
  };
  const statusDot = (id: string) => {
    if (id !== savedActive) {
      const c = others.find((o) => o.id === id)?.connection;
      return c?.kind === "connected" ? "ok" : c?.kind === "reconnecting" ? "bad" : c ? "wait" : "";
    }
    return connection.kind === "connected" ? "ok" : connection.kind === "reconnecting" ? "bad" : connection.kind === "connecting" ? "wait" : "";
  };

  return (
    <Card className="form-section">
      <span className="label">{t("Drucker")}</span>
      <div className="printer-list">
        {printers.length === 0 && <span className="hint">{t("Noch kein Drucker eingerichtet. Lass das Netzwerk durchsuchen oder füge ihn von Hand hinzu.")}</span>}
        {printers.map((p) => {
          const info = kindInfo(p.kind);
          const open = editing === p.id;
          const err = errors[`printer:${p.id}`];
          return (
            <div key={p.id} className={`printer-item${open ? " open" : ""}${err ? " invalid" : ""}`}>
              <div className="printer-row">
                <span className={`dot ${statusDot(p.id)}`} aria-hidden />
                <div className="pr-main">
                  <span className="pr-name">{p.name || t("Ohne Namen")}</span>
                  <span className="small muted num">
                    {info.label} · {p.host ? hostLabel(p) : t("keine Adresse")}
                  </span>
                </div>
                {draft.activePrinter === p.id ? (
                  <span className="badge accent">{t("Aktiv")}</span>
                ) : (
                  <button className="btn sm ghost" onClick={() => onChange(printers, p.id)}>
                    {t("Aktiv setzen")}
                  </button>
                )}
                <button className="btn sm ghost" aria-label={t("Bearbeiten")} title={t("Bearbeiten")} onClick={() => setEditing(open ? null : p.id)}>
                  <Pencil size={14} />
                </button>
                {confirmDel === p.id ? (
                  <button className="btn sm danger" onClick={() => remove(p.id)}>
                    {t("Wirklich entfernen")}
                  </button>
                ) : (
                  <button className="btn sm ghost" aria-label={t("Entfernen")} title={t("Entfernen")} onClick={() => setConfirmDel(p.id)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {open && (
                <div className="printer-edit">
                  <div className="field">
                    <label htmlFor={`n-${p.id}`}>{t("Name")}</label>
                    <input id={`n-${p.id}`} className="input" value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor={`k-${p.id}`}>{t("Druckertyp")}</label>
                    <select id={`k-${p.id}`} className="input" value={p.kind} onChange={(e) => update(p.id, { kind: e.target.value as PrinterKind, port: null })}>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {kindInfo(k).label}
                        </option>
                      ))}
                    </select>
                    <span className="hint">{info.models}</span>
                  </div>
                  <div className="field-grid">
                    <div className="field">
                      <label htmlFor={`h-${p.id}`}>{t("IP-Adresse")}</label>
                      <input
                        id={`h-${p.id}`}
                        className={`input num ${err ? "invalid" : ""}`}
                        placeholder={t("z. B. 192.168.178.42")}
                        value={p.host}
                        spellCheck={false}
                        onChange={(e) => update(p.id, { host: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`p-${p.id}`}>Port</label>
                      <input
                        id={`p-${p.id}`}
                        className="input num"
                        inputMode="numeric"
                        placeholder={String(defaultPort(p.kind))}
                        value={p.port ?? ""}
                        onChange={(e) => {
                          const v = Number(e.target.value.replace(/\D/g, ""));
                          update(p.id, { port: v > 0 && v < 65536 ? v : null });
                        }}
                      />
                    </div>
                  </div>
                  {err && <span className="hint error">{err}</span>}
                  {info.keyLabel && (
                    <div className="field">
                      <label htmlFor={`key-${p.id}`}>{info.keyLabel}</label>
                      <input
                        id={`key-${p.id}`}
                        className={`input ${errors[`key:${p.id}`] ? "invalid" : ""}`}
                        type="password"
                        autoComplete="off"
                        value={p.key}
                        spellCheck={false}
                        onChange={(e) => update(p.id, { key: e.target.value })}
                      />
                      {errors[`key:${p.id}`] && <span className="hint error">{errors[`key:${p.id}`]}</span>}
                    </div>
                  )}
                  <span className="hint">{info.hint}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="row-input">
        <button className="btn" onClick={() => void onScan()} disabled={scan.running || !isTauri}>
          {scan.running ? <Loader2 size={16} className="spin" /> : <Radar size={16} />}
          {scan.running ? t("Suche…") : t("Im Netz suchen")}
        </button>
        <button className="btn ghost" onClick={() => add()}>
          <Plus size={16} /> {t("Drucker hinzufügen")}
        </button>
      </div>
      {scan.results && (
        <div className="found">
          {scan.results.length === 0 ? (
            <span className="hint">{t("Kein Drucker gefunden. Ist er eingeschaltet und im selben WLAN? Die IP kannst du auch von Hand eintragen.")}</span>
          ) : (
            scan.results.map((f) => {
              const known = printers.some((p) => p.host === f.ip && p.kind === f.kind);
              return (
                <button key={`${f.ip}-${f.kind}`} disabled={known} onClick={() => take(f)}>
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Wifi size={16} className="muted" />
                    <span>
                      {f.hostname ?? f.model ?? kindInfo(f.kind).label}
                      <span className="small muted"> · {kindInfo(f.kind).label}</span>
                    </span>
                  </span>
                  <span className="num muted">{known ? t("schon eingerichtet") : f.port ? `${f.ip}:${f.port}` : f.ip}</span>
                </button>
              );
            })
          )}
        </div>
      )}
      <span className="hint">{t("Alle Drucker werden gleichzeitig überwacht – Benachrichtigungen kommen von jedem. Im Dashboard steht der aktive Drucker, die anderen laufen in der Leiste darüber mit.")}</span>
    </Card>
  );
}

/** Handy im WLAN: Live-Status aller Drucker im Handy-Browser, per QR-Code verbunden. */
function RemoteCard() {
  const saved = useStore((s) => s.settings);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => void remoteInfo().then(setInfo);
  useEffect(() => {
    refresh();
    let off: (() => void) | undefined;
    void onRemoteChange(refresh).then((f) => (off = f));
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.remoteEnabled, saved.remoteToken]);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await saveSettings({ ...saved, remoteEnabled: on });
    } finally {
      setBusy(false);
      setTimeout(refresh, 400);
    }
  };
  const copy = () => {
    if (!info?.url) return;
    void navigator.clipboard?.writeText(info.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <Card className="form-section">
      <span className="label">{t("Handy im WLAN")}</span>
      <div>
        <div className="toggle-row" style={{ borderTop: 0, paddingTop: 0 }}>
          <div>
            <div>{t("Live-Status aufs Handy")}</div>
            <div className="hint">{t("Zeigt alle Drucker im Handy-Browser – mit Pause, Fortsetzen, Abbrechen, Tempo und Licht. Keine App nötig, nur im eigenen WLAN erreichbar.")}</div>
          </div>
          <Switch on={saved.remoteEnabled} onChange={(v) => !busy && void toggle(v)} label={t("Live-Status aufs Handy")} />
        </div>
        {saved.remoteEnabled && (
          <div className="remote-box">
            {info?.error ? (
              <span className="hint error">{info.error}</span>
            ) : info?.url ? (
              <>
                <Qr text={info.url} />
                <div className="remote-text">
                  <strong>
                    <Smartphone size={15} /> {t("Mit der Handykamera scannen")}
                  </strong>
                  <span className="hint">{t("Handy und Computer müssen im selben WLAN sein. Tipp: Auf dem Handy „Zum Home-Bildschirm“ wählen – dann wirkt es wie eine App.")}</span>
                  <code className="path">{info.url}</code>
                  <span className="row-input" style={{ marginTop: 0 }}>
                    <button className="btn sm" onClick={copy}>
                      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("Kopiert") : t("Link kopieren")}
                    </button>
                    <button
                      className="btn sm ghost"
                      title={t("Alte QR-Codes und Links funktionieren danach nicht mehr.")}
                      onClick={() => void remoteNewToken().then(() => setTimeout(refresh, 300))}
                    >
                      <KeyRound size={14} /> {t("Neuer Schlüssel")}
                    </button>
                  </span>
                  <span className="hint">{t("Windows fragt beim ersten Mal, ob Druckerwacht im privaten Netzwerk erreichbar sein darf – bitte erlauben.")}</span>
                </div>
              </>
            ) : (
              <span className="hint">{isTauri ? t("Kein Heimnetz gefunden – ist der Computer im WLAN?") : "…"}</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
