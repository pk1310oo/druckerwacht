import { useEffect, useState } from "react";
import { Header, Sidebar, type ViewId } from "./components/Shell";
import { Dashboard } from "./views/Dashboard";
import { CameraView } from "./views/CameraView";
import { HistoryView } from "./views/HistoryView";
import { SettingsView } from "./views/SettingsView";
import { useStore } from "./lib/store";

export default function App() {
  const [view, setView] = useState<ViewId>("dashboard");
  const ready = useStore((s) => s.ready);
  const hasCamera = useStore((s) => s.settings.cameraUrl.trim() !== "");

  // Kamera-Ansicht verlassen, wenn die Kamera entfernt wurde
  useEffect(() => {
    if (view === "camera" && !hasCamera) setView("dashboard");
  }, [view, hasCamera]);

  return (
    <div className="app">
      <Sidebar view={view} onChange={setView} />
      <div className="main">
        <Header />
        <main className="content">
          {!ready ? null : view === "dashboard" ? (
            <Dashboard go={setView} />
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
