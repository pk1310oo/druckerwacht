import { useEffect, useState } from "react";
import { Header, Sidebar, type ViewId } from "./components/Shell";
import { Dashboard } from "./views/Dashboard";
import { CameraView } from "./views/CameraView";
import { HistoryView } from "./views/HistoryView";
import { SettingsView } from "./views/SettingsView";
import { SlicerView } from "./views/SlicerView";
import { useStore } from "./lib/store";
import { resolveLang, setLang } from "./lib/i18n";
import { setBackendLanguage } from "./lib/api";

export default function App() {
  const [view, setView] = useState<ViewId>("dashboard");
  const ready = useStore((s) => s.ready);
  const hasCamera = useStore((s) => s.settings.cameraUrl.trim() !== "");
  const langSetting = useStore((s) => s.settings.language);
  const lang = resolveLang(langSetting);
  // vor dem Rendern der Kinder setzen, damit t() sofort die richtige Sprache liefert
  setLang(lang);
  useEffect(() => {
    void setBackendLanguage(lang);
  }, [lang]);

  // Kamera-Ansicht verlassen, wenn die Kamera entfernt wurde
  useEffect(() => {
    if (view === "camera" && !hasCamera) setView("dashboard");
  }, [view, hasCamera]);

  return (
    <div className="app" key={lang}>
      <Sidebar view={view} onChange={setView} />
      <div className="main">
        <Header />
        <main className={`content ${view === "slicer" ? "flush" : ""}`}>
          {!ready ? null : view === "dashboard" ? (
            <Dashboard go={setView} />
          ) : view === "slicer" ? (
            <SlicerView go={setView} />
          ) : view === "camera" ? (
            <CameraView go={setView} />
          ) : view === "history" ? (
            <HistoryView />
          ) : (
            <SettingsView />
          )}
        </main>
      </div>
    </div>
  );
}
