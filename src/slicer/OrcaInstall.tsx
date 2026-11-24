/**
 * „OrcaSlicer installieren“: lädt den Slicer-Motor passend zum System herunter und
 * installiert ihn dort, wo Druckerwacht ihn findet. Fortschritt kommt über „orca://install“.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Loader2 } from "lucide-react";
import { isTauri } from "../lib/api";
import { t } from "../lib/i18n";

interface Progress {
  phase: "download" | "install" | "done";
  pct: number;
}

export function OrcaInstallButton({ onDone, primary = true }: { onDone: () => void; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    void listen<Progress>("orca://install", (e) => setProg(e.payload)).then((f) => (off = f));
    return () => off?.();
  }, []);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isTauri) await invoke<string>("orca_install");
      setOk(true);
      onDone();
    } catch (e) {
      setError(typeof e === "string" ? e : t("Installation fehlgeschlagen."));
    } finally {
      setBusy(false);
    }
  };
  if (ok) {
    return (
      <span className="orca-ok small">
        <Check size={14} /> {t("OrcaSlicer ist installiert.")}
      </span>
    );
  }
  return (
    <div className="orca-install">
      <button className={`btn sm${primary ? " primary" : ""}`} disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
        {busy
          ? prog?.phase === "install"
            ? t("Installiere …")
            : t("Lade … {p} %", { p: Math.round(prog?.pct ?? 0) })
          : t("OrcaSlicer jetzt installieren")}
      </button>
      {busy && prog?.phase === "download" && (
        <div className="bar">
          <i style={{ width: `${prog.pct}%` }} />
        </div>
      )}
      {busy && prog?.phase === "install" && /Windows/i.test(navigator.userAgent) && (
        <span className="hint">{t("Windows fragt gleich nach der Erlaubnis – bitte mit „Ja“ bestätigen und den Installer durchklicken.")}</span>
      )}
      {error && <span className="hint error">{error}</span>}
    </div>
  );
}
