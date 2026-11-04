import { History, LayoutDashboard, Settings, Video, type LucideIcon } from "lucide-react";
import { useStore } from "../lib/store";
import { connectionLabel, STATE_LABEL, STATE_TONE } from "../lib/format";
import { Badge } from "./ui";

export type ViewId = "dashboard" | "camera" | "history" | "settings";

const NAV: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "camera", label: "Kamera", icon: Video },
  { id: "history", label: "Verlauf", icon: History },
  { id: "settings", label: "Einstellungen", icon: Settings },
];

export function Sidebar({ view, onChange }: { view: ViewId; onChange: (v: ViewId) => void }) {
  const hasCamera = useStore((s) => s.settings.cameraUrl.trim() !== "");
  return (
    <nav className="sidebar" data-tauri-drag-region aria-label="Navigation">
      <img className="sidebar-logo" src="/logo.svg" alt="" draggable={false} />
      {NAV.filter((n) => n.id !== "camera" || hasCamera).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={`nav-btn ${view === id ? "active" : ""}`}
          onClick={() => onChange(id)}
          aria-label={label}
          aria-current={view === id ? "page" : undefined}
        >
          <Icon size={20} strokeWidth={1.75} />
          <span className="nav-tip">{label}</span>
        </button>
      ))}
    </nav>
  );
}

export function Header() {
  const name = useStore((s) => s.settings.printerName);
  const connection = useStore((s) => s.connection);
  const state = useStore((s) => s.status?.state ?? null);

  const dot =
    connection.kind === "connected" ? "ok" : connection.kind === "reconnecting" ? "bad" : connection.kind === "connecting" ? "wait" : "";
  const host = connection.kind === "unconfigured" ? null : connection.host;

  const meta = [connectionLabel(connection)];
  if (connection.kind === "reconnecting") meta.push(`neuer Versuch in ${connection.retryInS} s`);

  return (
    <header className="header" data-tauri-drag-region>
      <span className={`dot ${dot}`} aria-hidden />
      <span className="header-title" data-tauri-drag-region>
        {name}
      </span>
      {connection.kind === "connected" && state && <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>}
      <span className="header-spacer" data-tauri-drag-region />
      <span className="header-meta" data-tauri-drag-region>
        <span>{meta.join(" · ")}</span>
        {host && <span className="host num">· {host}</span>}
      </span>
    </header>
  );
}
