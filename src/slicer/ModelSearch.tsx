/**
 * Modelle finden: Suche auf Printables, Thingiverse oder MakerWorld im Browser öffnen.
 * Danach schaut die App im Download-Ordner nach neuen Dateien (STL, 3MF, OBJ oder ZIP)
 * und bietet an, sie direkt auf die Platte zu legen.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Globe, X } from "lucide-react";
import { isTauri } from "../lib/api";
import { openProjectLink } from "../lib/update";
import { t } from "../lib/i18n";

interface RecentModel {
  path: string;
  name: string;
  modifiedMs: number;
}

const SITES = [
  { name: "Printables", url: (q: string) => `https://www.printables.com/search/models?q=${encodeURIComponent(q)}` },
  { name: "Thingiverse", url: (q: string) => `https://www.thingiverse.com/search?q=${encodeURIComponent(q)}` },
  { name: "MakerWorld", url: (q: string) => `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(q)}` },
];

/** Menü mit Suchfeld */
export function ModelSearchMenu({ onSearch }: { onSearch: () => void }) {
  const [q, setQ] = useState("");
  const go = (url: string) => {
    void openProjectLink(url).catch(() => {});
    onSearch();
  };
  return (
    <span className="tool-menu card calib-menu model-search">
      <span className="small muted">{t("Modell suchen – Download im Browser, dann landet es hier auf der Platte:")}</span>
      <input
        className="input"
        autoFocus
        placeholder={t("z. B. Kabelhalter, Benchy, Vase …")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && q.trim() && go(SITES[0].url(q.trim()))}
      />
      {SITES.map((s) => (
        <button key={s.name} className="btn sm ghost" disabled={!q.trim()} onClick={() => go(s.url(q.trim()))}>
          <Globe size={14} /> {s.name}
        </button>
      ))}
    </span>
  );
}

/** Beobachtet den Download-Ordner, solange `since` gesetzt ist (höchstens 20 Minuten) */
export function DownloadWatcher({ since, onStop, onAdd }: { since: number | null; onStop: () => void; onAdd: (paths: string[]) => Promise<void> }) {
  const [found, setFound] = useState<RecentModel[]>([]);
  const [taken, setTaken] = useState<string[]>([]);
  useEffect(() => {
    setFound([]);
    setTaken([]);
    if (since == null || !isTauri) return;
    const poll = () => void invoke<RecentModel[]>("recent_models", { sinceMs: since }).then(setFound).catch(() => {});
    poll();
    const timer = setInterval(poll, 3000);
    const stop = setTimeout(onStop, 20 * 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since]);
  if (since == null) return null;
  const fresh = found.filter((f) => !taken.includes(f.path));
  const add = async (f: RecentModel) => {
    setTaken((x) => [...x, f.path]);
    const paths = /\.zip$/i.test(f.name) ? await invoke<string[]>("unzip_models", { path: f.path }) : [f.path];
    await onAdd(paths);
  };
  return (
    <div className="dl-watch card">
      <div className="dl-head">
        <span className="small">
          <Download size={13} /> {fresh.length ? t("Neu heruntergeladen:") : t("Warte auf deinen Download …")}
        </span>
        <button className="btn sm ghost" aria-label={t("Schließen")} onClick={onStop}>
          <X size={13} />
        </button>
      </div>
      {fresh.map((f) => (
        <div key={f.path} className="dl-item">
          <span className="file-name small" title={f.name}>
            {f.name}
          </span>
          <button className="btn sm primary" onClick={() => void add(f)}>
            {t("Auf die Platte")}
          </button>
        </div>
      ))}
    </div>
  );
}
