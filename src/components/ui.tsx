import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { fmtNum, type Tone } from "../lib/format";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** Zahl, deren Ziffern beim Ändern wie ein Tacho rollen. */
export function AnimatedValue({ value, digits = 0, unit }: { value: number | null; digits?: number; unit?: string }) {
  return (
    <span className="big num">
      <Rolling text={fmtNum(value, digits)} />
      {unit && value != null && <span className="unit">{unit}</span>}
    </span>
  );
}

/** Jede Ziffer ist ein senkrechter Streifen 0–9, der zur neuen Ziffer gleitet. */
export function Rolling({ text }: { text: string }) {
  const chars = text.split("");
  return (
    <span className="rolling" aria-label={text}>
      {chars.map((c, i) => {
        const key = chars.length - i; // von rechts zählen, damit Stellen stabil bleiben
        if (!/\d/.test(c)) return <span key={`s${key}`} className="roll-sep" aria-hidden>{c}</span>;
        return (
          <span key={`d${key}`} className="roll-digit" aria-hidden>
            <span className="roll-strip" style={{ transform: `translateY(${-Number(c) * 10}%)` }}>
              {"0123456789".split("").map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Rundanzeige: Bogen (Temperatur, Tempo) oder Ring (Fortschritt), leuchtet beim Heizen. */
export function Gauge({ pct, target, kind = "arc", hot = false }: { pct: number; target?: number | null; kind?: "arc" | "ring"; hot?: boolean }) {
  const p = Math.max(0, Math.min(100, pct));
  const R = 26;
  const sweep = kind === "ring" ? 360 : 260;
  const start = kind === "ring" ? -90 : 140;
  const len = (2 * Math.PI * R * sweep) / 360;
  const pt = (deg: number) => [32 + R * Math.cos((deg * Math.PI) / 180), 32 + R * Math.sin((deg * Math.PI) / 180)];
  const tgt = target != null && target > 0 ? pt(start + (sweep * Math.min(100, target)) / 100) : null;
  return (
    <svg className={`gauge ${hot ? "hot" : ""}`} viewBox="0 0 64 64" aria-hidden>
      <circle cx={32} cy={32} r={R} className="g-track" strokeDasharray={`${len} 999`} transform={`rotate(${start} 32 32)`} />
      <circle cx={32} cy={32} r={R} className="g-fill" strokeDasharray={`${(len * p) / 100} 999`} transform={`rotate(${start} 32 32)`} />
      {tgt && <circle cx={tgt[0]} cy={tgt[1]} r={2.6} className="g-target" />}
      {kind === "ring" && (
        <text x={32} y={36.5} className="g-text">
          {Math.round(p)}%
        </text>
      )}
    </svg>
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function StatCard(props: {
  label: string;
  icon: LucideIcon;
  value: number | null;
  digits?: number;
  unit?: string;
  meter?: { pct: number; active?: boolean } | null;
  gauge?: { pct: number; target?: number | null; kind?: "arc" | "ring"; hot?: boolean } | null;
  sub: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <Card className={`stat ${props.gauge?.hot ? "hot" : ""}`}>
      <div className="stat-head">
        <span className="label">{props.label}</span>
        <Icon size={16} strokeWidth={1.75} />
      </div>
      <div className="stat-main">
        <AnimatedValue value={props.value} digits={props.digits} unit={props.unit} />
        {props.gauge && <Gauge {...props.gauge} />}
      </div>
      {!props.gauge && (
        <div
          className={`meter ${props.meter?.active ? "heating" : ""}`}
          style={{ visibility: props.meter ? "visible" : "hidden" }}
          aria-hidden
        >
          <i style={{ width: `${Math.max(0, Math.min(100, props.meter?.pct ?? 0))}%` }} />
        </div>
      )}
      <div className="stat-sub">{props.sub}</div>
    </Card>
  );
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? "on" : ""}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function EmptyState(props: {
  icon: LucideIcon;
  title: string;
  text?: ReactNode;
  accent?: boolean;
  spin?: boolean;
  actions?: ReactNode;
  className?: string;
}) {
  const Icon = props.icon;
  return (
    <div className={`empty ${props.className ?? ""}`}>
      <div className={`empty-icon ${props.accent ? "accent" : ""}`}>
        <Icon size={20} strokeWidth={1.75} className={props.spin ? "spin" : undefined} />
      </div>
      <div className="empty-body">
        <div style={{ fontWeight: 600 }}>{props.title}</div>
        {props.text && <p>{props.text}</p>}
        {props.actions && <div className="actions">{props.actions}</div>}
      </div>
    </div>
  );
}
