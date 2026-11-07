import { useEffect, useMemo, useState } from "react";
import { Bug, Check, Download, ExternalLink, FolderGit2, Loader2, PlugZap, Radar, RefreshCw, Send, Wifi } from "lucide-react";
import { useStore } from "../lib/store";
import { discoverPrinters, isTauri, rawLogDir, reconnect, saveSettings } from "../lib/api";
import { connectionLabel } from "../lib/format";
import type { FoundPrinter, Settings } from "../lib/types";
import { Card, Segmented, Switch } from "../components/ui";
import { t } from "../lib/i18n";
import { THEMES, THEME_IDS } from "../lib/theme";
import { slicerInfo, type SlicerInfo } from "../slicer/api";
import { APP_VERSION, REPO_URL, checkForUpdate, openProjectLink, type UpdateInfo } from "../lib/update";
import { ntfyTest, randomTopic } from "../lib/extras";

const THEME_NAMES: Record<(typeof THEME_IDS)[number], string> = { orange: "Orange", blue: "Blau", green: "Grün", purple: "Lila", pink: "Pink", cyan: "Türkis", lime: "Limette" };

const HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?!$)|$)){4}$|^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

function validate(s: Settings) {
  const errors: Partial<Record<keyof Settings, string>> = {};
  const ip = s.printerIp.trim().replace(/^(wss?|https?):\/\//, "").replace(/[:/].*$/, "");
  if (s.printerIp.trim() && !HOST_RE.test(ip)) errors.printerIp = t("Bitte eine gültige IP-Adresse eingeben, z. B. 192.168.178.42.");
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
      setSaveError(typeof e === "string" ? e : t("Einstellungen konnten nicht gespeichert werden."));
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

      <Card className="form-section">
        <span className="label">{t("Drucker")}</span>
        <div className="field">
          <label htmlFor="name">{t("Name")}</label>
          <input id="name" className="input" value={draft.printerName} onChange={(e) => set("printerName", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ip">{t("IP-Adresse")}</label>
          <div className="field-row">
            <input
              id="ip"
              className={`input num ${errors.printerIp ? "invalid" : ""}`}
              placeholder={t("z. B. 192.168.178.42")}
              value={draft.printerIp}
              spellCheck={false}
              onChange={(e) => set("printerIp", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void onSave()}
            />
            <button className="btn" onClick={() => void onScan()} disabled={scan.running || !isTauri}>
              {scan.running ? <Loader2 size={16} className="spin" /> : <Radar size={16} />}
              {scan.running ? t("Suche…") : t("Im Netz suchen")}
            </button>
          </div>
          {errors.printerIp ? (
            <span className="hint error">{errors.printerIp}</span>
          ) : (
            <span className="hint">
              {t("Zu finden am Druckerdisplay unter Einstellungen → Netzwerk. Verbindung über Port 9999.")}
            </span>
          )}
        </div>
        {scan.results && (
          <div className="found">
            {scan.results.length === 0 ? (
              <span className="hint">
                {t("Kein Drucker gefunden. Ist er eingeschaltet und im selben WLAN? Die IP kannst du auch von Hand eintragen.")}
              </span>
            ) : (
              scan.results.map((p) => (
                <button key={p.ip} onClick={() => set("printerIp", p.ip)}>
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Wifi size={16} className="muted" />
                    <span>{p.model ?? p.hostname ?? t("Creality-Drucker")}</span>
                  </span>
                  <span className="num muted">{p.ip}</span>
                </button>
              ))
            )}
          </div>
        )}
      </Card>

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
        </div>
      </Card>

      <Card className="form-section">
        <span className="label">{t("Slicer")}</span>
        <div className="field">
          <label htmlFor="orca">{t("Pfad zu OrcaSlicer (optional)")}</label>
          <input
            id="orca"
            className="input"
            placeholder={/Mac/i.test(navigator.userAgent) ? "/Applications/OrcaSlicer.app" : t("z. B. ~/Applications/OrcaSlicer.AppImage")}
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
