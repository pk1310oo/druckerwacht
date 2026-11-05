import { useEffect, useMemo, useState } from "react";
import { Bug, Check, Download, ExternalLink, FolderGit2, Loader2, PlugZap, Radar, RefreshCw, Wifi } from "lucide-react";
import { useStore } from "../lib/store";
import { discoverPrinters, isTauri, rawLogDir, reconnect, saveSettings } from "../lib/api";
import { connectionLabel } from "../lib/format";
import type { FoundPrinter, Settings } from "../lib/types";
import { Card, Switch } from "../components/ui";
import { slicerInfo, type SlicerInfo } from "../slicer/api";
import { APP_VERSION, REPO_URL, checkForUpdate, openProjectLink, type UpdateInfo } from "../lib/update";

const HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?!$)|$)){4}$|^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

function validate(s: Settings) {
  const errors: Partial<Record<keyof Settings, string>> = {};
  const ip = s.printerIp.trim().replace(/^(wss?|https?):\/\//, "").replace(/[:/].*$/, "");
  if (s.printerIp.trim() && !HOST_RE.test(ip)) errors.printerIp = "Bitte eine gültige IP-Adresse eingeben, z. B. 192.168.178.42.";
  if (s.cameraUrl.trim() && !/^https?:\/\/.+/i.test(s.cameraUrl.trim()))
    errors.cameraUrl = "Die Adresse muss mit http:// oder https:// beginnen.";
  return errors;
}

export function SettingsView() {
  const saved = useStore((s) => s.settings);
  const connection = useStore((s) => s.connection);
  const [draft, setDraft] = useState<Settings>(saved);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scan, setScan] = useState<{ running: boolean; results: FoundPrinter[] | null }>({ running: false, results: null });
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
      setSaveError(typeof e === "string" ? e : "Einstellungen konnten nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  async function onScan() {
    setScan({ running: true, results: null });
    try {
      setScan({ running: false, results: await discoverPrinters() });
    } catch {
      setScan({ running: false, results: [] });
    }
  }

  return (
    <div className="view settings">
      <Card className="form-section">
        <span className="label">Drucker</span>
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" className="input" value={draft.printerName} onChange={(e) => set("printerName", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ip">IP-Adresse</label>
          <div className="field-row">
            <input
              id="ip"
              className={`input num ${errors.printerIp ? "invalid" : ""}`}
              placeholder="z. B. 192.168.178.42"
              value={draft.printerIp}
              spellCheck={false}
              onChange={(e) => set("printerIp", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void onSave()}
            />
            <button className="btn" onClick={() => void onScan()} disabled={scan.running || !isTauri}>
              {scan.running ? <Loader2 size={16} className="spin" /> : <Radar size={16} />}
              {scan.running ? "Suche…" : "Im Netz suchen"}
            </button>
          </div>
          {errors.printerIp ? (
            <span className="hint error">{errors.printerIp}</span>
          ) : (
            <span className="hint">
              Zu finden am Druckerdisplay unter Einstellungen → Netzwerk. Verbindung über Port 9999.
            </span>
          )}
        </div>
        {scan.results && (
          <div className="found">
            {scan.results.length === 0 ? (
              <span className="hint">
                Kein Drucker gefunden. Ist er eingeschaltet und im selben WLAN? Die IP kannst du auch von Hand eintragen.
              </span>
            ) : (
              scan.results.map((p) => (
                <button key={p.ip} onClick={() => set("printerIp", p.ip)}>
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Wifi size={16} className="muted" />
                    <span>{p.model ?? p.hostname ?? "Creality-Drucker"}</span>
                  </span>
                  <span className="num muted">{p.ip}</span>
                </button>
              ))
            )}
          </div>
        )}
      </Card>

      <Card className="form-section">
        <span className="label">Kamera</span>
        <div className="field">
          <label htmlFor="cam">Stream-Adresse (optional)</label>
          <input
            id="cam"
            className={`input ${errors.cameraUrl ? "invalid" : ""}`}
            placeholder="z. B. http://192.168.178.42:8080/?action=stream"
            value={draft.cameraUrl}
            spellCheck={false}
            onChange={(e) => set("cameraUrl", e.target.value)}
          />
          {errors.cameraUrl ? (
            <span className="hint error">{errors.cameraUrl}</span>
          ) : (
            <span className="hint">MJPEG-Stream oder Einzelbild, z. B. Nebula-Kamera oder USB-Webcam. Leer lassen, um die Kamera auszublenden.</span>
          )}
        </div>
      </Card>

      <Card className="form-section">
        <span className="label">Slicer</span>
        <div className="field">
          <label htmlFor="orca">Pfad zu OrcaSlicer (optional)</label>
          <input
            id="orca"
            className="input"
            placeholder={/Mac/i.test(navigator.userAgent) ? "/Applications/OrcaSlicer.app" : "z. B. ~/Applications/OrcaSlicer.AppImage"}
            value={draft.orcaPath}
            spellCheck={false}
            onChange={(e) => set("orcaPath", e.target.value)}
          />
          <span className="hint">
            {orca?.found ? `Gefunden: ${orca.path}` : "Leer lassen – die App sucht OrcaSlicer automatisch an den üblichen Orten."}
          </span>
        </div>
      </Card>

      <Card className="form-section">
        <span className="label">Benachrichtigungen</span>
        <div>
          <ToggleRow label="Druck fertig" hint="Wenn ein Druck erfolgreich beendet wurde." on={draft.notifyFinished} set={(v) => set("notifyFinished", v)} />
          <ToggleRow label="Fehler" hint="Druckerfehler, fehlgeschlagene oder abgebrochene Drucke." on={draft.notifyError} set={(v) => set("notifyError", v)} />
          <ToggleRow label="Verbindung verloren" hint="Wenn der Drucker länger als 20 Sekunden nicht erreichbar ist." on={draft.notifyDisconnect} set={(v) => set("notifyDisconnect", v)} />
        </div>
      </Card>

      <Card className="form-section">
        <span className="label">Diagnose</span>
        <div>
          <ToggleRow
            label="Rohdaten mitschneiden"
            hint="Speichert alle Nachrichten des Druckers als Datei – hilfreich, um die Auswertung zu verbessern."
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
              <div>Verbindung</div>
              <div className="hint">{connectionLabel(connection)}</div>
            </div>
            <button className="btn sm" onClick={() => void reconnect()} disabled={connection.kind === "unconfigured"}>
              <PlugZap size={14} /> Neu verbinden
            </button>
          </div>
        </div>
      </Card>

      <AboutCard />

      <div className="save-bar">
        {justSaved && (
          <span className="saved">
            <Check size={14} /> Gespeichert
          </span>
        )}
        {saveError && <span className="hint error">{saveError}</span>}
        <button className="btn ghost" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
          Verwerfen
        </button>
        <button className="btn primary" disabled={!dirty || busy || Object.keys(errors).length > 0} onClick={() => void onSave()}>
          Speichern
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
  if (check.running) status = "Suche nach neuer Version …";
  else if (check.info?.newer)
    status = (
      <span style={{ color: "var(--accent)" }}>
        Version {check.info.latest} ist verfügbar.
      </span>
    );
  else if (check.info) status = "Du hast die neueste Version.";
  else if (check.done) status = "Neue Versionen konnten gerade nicht geprüft werden (offline?).";

  return (
    <Card className="form-section">
      <span className="label">Über Druckerwacht</span>
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
              <Download size={14} /> Herunterladen
            </button>
          ) : (
            <button className="btn sm" onClick={() => void run()} disabled={check.running}>
              <RefreshCw size={14} className={check.running ? "spin" : undefined} /> Prüfen
            </button>
          )}
        </div>
        <div className="toggle-row">
          <div>
            <div>Open Source</div>
            <div className="hint">Kostenlos unter der AGPL-3.0. Entwickelt von pk1310oo. Slicer-Motor: OrcaSlicer.</div>
          </div>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="btn sm ghost" onClick={() => open(`${REPO_URL}/issues`)}>
              <Bug size={14} /> Fehler melden
            </button>
            <button className="btn sm ghost" onClick={() => open(REPO_URL)}>
              <FolderGit2 size={14} /> GitHub <ExternalLink size={12} />
            </button>
          </span>
        </div>
        <div className="toggle-row" style={{ display: "block" }}>
          <div className="hint">
            Beta: Druckerwacht ist kein offizielles Creality-Produkt und nutzt eine undokumentierte Schnittstelle. Lass laufende Drucke
            nicht unbeaufsichtigt und prüfe Befehle im Zweifel am Druckerdisplay. Nutzung auf eigene Verantwortung.
          </div>
        </div>
      </div>
    </Card>
  );
}
