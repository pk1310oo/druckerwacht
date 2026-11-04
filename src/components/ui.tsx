import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useAnimatedNumber } from "../lib/useAnimatedNumber";
import { fmtNum, type Tone } from "../lib/format";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** Zahl, die weich zum neuen Wert gleitet. */
export function AnimatedValue({ value, digits = 0, unit }: { value: number | null; digits?: number; unit?: string }) {
  const v = useAnimatedNumber(value);
  return (
    <span className="big num">
      {fmtNum(v, digits)}
      {unit && v != null && <span className="unit">{unit}</span>}
    </span>
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
  sub: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <Card className="stat">
      <div className="stat-head">
        <span className="label">{props.label}</span>
        <Icon size={16} strokeWidth={1.75} />
      </div>
      <AnimatedValue value={props.value} digits={props.digits} unit={props.unit} />
      <div
        className={`meter ${props.meter?.active ? "heating" : ""}`}
        style={{ visibility: props.meter ? "visible" : "hidden" }}
        aria-hidden
      >
        <i style={{ width: `${Math.max(0, Math.min(100, props.meter?.pct ?? 0))}%` }} />
      </div>
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
