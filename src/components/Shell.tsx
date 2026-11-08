import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Disc3, History, Layers3, LayoutDashboard, Settings, Video, type LucideIcon } from "lucide-react";
import { useStore } from "../lib/store";
import { connectionLabel, STATE_LABEL, STATE_TONE } from "../lib/format";
import { Badge } from "./ui";
import { t } from "../lib/i18n";
import { switchPrinter } from "../lib/api";
import { kindInfo } from "../lib/printers";
import type { Connection } from "../lib/types";

export type ViewId = "dashboard" | "slicer" | "camera" | "history" | "filament" | "settings";

const NAV: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "slicer", label: "Slicer", icon: Layers3 },
  { id: "camera", label: "Kamera", icon: Video },
  { id: "history", label: "Verlauf", icon: History },
  { id: "filament", label: "Filament", icon: Disc3 },
  { id: "settings", label: "Einstellungen", icon: Settings },
  // Übersetzt wird beim Anzeigen
];

export function Sidebar({ view, onChange }: { view: ViewId; onChange: (v: ViewId) => void }) {
  const hasCamera = useStore((s) => s.settings.cameraUrl.trim() !== "" || s.settings.localCamera.trim() !== "");
  // Gleitende Markierung neben dem aktiven Menüpunkt
  const nav = useRef<HTMLElement>(null);
  const [mark, setMark] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>(".nav-btn.active");
    setMark(el ? el.offsetTop + el.offsetHeight / 2 - 8 : null);
  }, [view, hasCamera]);
  return (
    <nav className="sidebar" ref={nav} data-tauri-drag-region aria-label={t("Navigation")}>
      <span className="nav-indicator" aria-hidden style={{ transform: `translateY(${mark ?? 0}px)`, opacity: mark == null ? 0 : 1, top: 0 }} />
      <img className="sidebar-logo" src="/logo.svg" alt="" draggable={false} />
      {NAV.filter((n) => n.id !== "camera" || hasCamera).map(({ id, label: de, icon: Icon }) => { const label = t(de); return (
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
      ); })}
    </nav>
  );
}

export function Header() {
  const name = useStore((s) => (s.settings.printers.length ? s.settings.printerName : "Druckerwacht"));
  const connection = useStore((s) => s.connection);
  const state = useStore((s) => s.status?.state ?? null);
  const preparing = useStore((s) => s.status?.preparing ?? false);

  const dot =
    connection.kind === "connected" ? "ok" : connection.kind === "reconnecting" ? "bad" : connection.kind === "connecting" ? "wait" : "";
  const host = connection.kind === "unconfigured" ? null : connection.host;

  const meta = [connectionLabel(connection)];
  if (connection.kind === "reconnecting") meta.push(t("neuer Versuch in {s} s", { s: connection.retryInS }));

  return (
    <header className="header" data-tauri-drag-region>
      <span className={`dot ${dot}`} aria-hidden />
      <PrinterSwitcher name={name} />
      {connection.kind === "connected" && state && (
        <Badge tone={preparing ? "warning" : STATE_TONE[state]}>{preparing ? t("Vorbereitung") : STATE_LABEL[state]}</Badge>
      )}
      <span className="header-spacer" data-tauri-drag-region />
      <span className="header-meta" data-tauri-drag-region>
        <span>{meta.join(" · ")}</span>
        {host && <span className="host num">· {host}</span>}
      </span>
    </header>
  );
}

const dotOf = (c: Connection) => (c.kind === "connected" ? "ok" : c.kind === "reconnecting" ? "bad" : c.kind === "connecting" ? "wait" : "");

/** Name des aktiven Druckers – mit mehreren Druckern ein Menü zum Umschalten. */
function PrinterSwitcher({ name }: { name: string }) {
  const printers = useStore((s) => s.settings.printers);
  const active = useStore((s) => s.settings.activePrinter);
  const others = useStore((s) => s.others);
  const connection = useStore((s) => s.connection);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (printers.length < 2) {
    return (
      <span className="header-title" data-tauri-drag-region>
        {name}
      </span>
    );
  }
  return (
    <span className="printer-switch" ref={box}>
      <button className="header-title switch-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {name} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="switch-menu card" role="menu">
          {printers.map((p) => {
            const o = others.find((x) => x.id === p.id);
            const conn = p.id === active ? connection : o?.connection;
            const st = o?.status;
            return (
              <button
                key={p.id}
                role="menuitemradio"
                aria-checked={p.id === active}
                className={p.id === active ? "on" : ""}
                onClick={() => {
                  setOpen(false);
                  void switchPrinter(p.id);
                }}
              >
                <span className={`dot ${conn ? dotOf(conn) : ""}`} aria-hidden />
                <span className="sw-main">
                  <span className="sw-name">{p.name}</span>
                  <span className="small muted">
                    {kindInfo(p.kind).label}
                    {st && st.state === "printing" && st.progress != null ? ` · ${Math.round(st.progress)} %` : ""}
                  </span>
                </span>
                {p.id === active && <Check size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
