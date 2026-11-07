import { useEffect, useRef, useState } from "react";
import { Header, Sidebar, type ViewId } from "./components/Shell";
import { Dashboard } from "./views/Dashboard";
import { CameraView } from "./views/CameraView";
import { HistoryView } from "./views/HistoryView";
import { SettingsView } from "./views/SettingsView";
import { SlicerView } from "./views/SlicerView";
import { FilamentView } from "./views/FilamentView";
import { consume } from "./lib/spools";
import { useStore } from "./lib/store";
import { resolveLang, setLang } from "./lib/i18n";
import { setBackendLanguage } from "./lib/api";
import { applyTheme, resolveTheme } from "./lib/theme";
import { Intro } from "./components/Fx";

export default function App() {
  const [view, setView] = useState<ViewId>("dashboard");
  const ready = useStore((s) => s.ready);
  const hasCamera = useStore((s) => s.settings.cameraUrl.trim() !== "");
  const langSetting = useStore((s) => s.settings.language);
  const lang = resolveLang(langSetting);
  // vor dem Rendern der Kinder setzen, damit t() und die Farben sofort stimmen
  setLang(lang);
  const theme = resolveTheme(useStore((s) => s.settings.accent));
  applyTheme(theme);
  useEffect(() => {
    void setBackendLanguage(lang);
  }, [lang]);

  useFilamentTracking();

  // Kamera-Ansicht verlassen, wenn die Kamera entfernt wurde
  useEffect(() => {
    if (view === "camera" && !hasCamera) setView("dashboard");
  }, [view, hasCamera]);

  // Richtung des Ansichtswechsels (nach unten in der Seitenleiste → Inhalt gleitet von unten herein)
  const order: ViewId[] = ["dashboard", "slicer", "camera", "history", "filament", "settings"];
  const prevView = useRef(view);
  const dir = order.indexOf(view) >= order.indexOf(prevView.current) ? "down" : "up";
  useEffect(() => {
    prevView.current = view;
  }, [view]);

  return (
    <>
    {/* außerhalb des neu aufgebauten Bereichs: läuft nur beim Start, nicht beim Farb-/Sprachwechsel */}
    <Intro />
    <div className="app" key={`${lang}-${theme}`}>
      <Sidebar view={view} onChange={setView} />
      <div className="main">
        <div className="ambient" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <Header />
        <main className={`content ${view === "slicer" ? "flush" : ""}`} data-dir={dir} key={view}>
          {!ready ? null : view === "dashboard" ? (
            <Dashboard go={setView} />
          ) : view === "slicer" ? (
            <SlicerView go={setView} />
          ) : view === "camera" ? (
            <CameraView go={setView} />
          ) : view === "history" ? (
            <HistoryView />
          ) : view === "filament" ? (
            <FilamentView />
          ) : (
            <SettingsView />
          )}
        </main>
      </div>
    </div>
    </>
  );
}

/**
 * Zieht nach jedem Druck den Verbrauch von der aktiven Spule ab. Gemerkt wird die höchste
 * gemeldete Filamentlänge des Drucks – manche Drucker setzen sie am Ende auf 0 zurück.
 */
function useFilamentTracking() {
  const status = useStore((s) => s.status);
  const job = useRef<{ file: string; mm: number } | null>(null);
  useEffect(() => {
    if (!status) return;
    const active = status.state === "printing" || status.state === "paused";
    const file = status.fileName ?? "";
    if (active) {
      if (job.current?.file !== file) job.current = { file, mm: 0 };
      job.current.mm = Math.max(job.current.mm, status.usedMaterialMm ?? 0);
    } else if (job.current && ["finished", "failed", "aborted"].includes(status.state)) {
      consume(Math.max(job.current.mm, status.usedMaterialMm ?? 0));
      job.current = null;
    } else if (status.state === "idle") {
      job.current = null;
    }
  }, [status]);
}
