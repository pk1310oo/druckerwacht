import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RotateCcw, Search } from "lucide-react";
import { PatternIcon, hasPatternIcon } from "./PatternIcon";
import {
  ALL_TAB,
  CATALOG,
  TABS,
  effective,
  kindOf,
  labelOf,
  scalar,
  baseValue,
  type FieldDef,
  type Group,
  type Overrides,
  type Preset,
} from "./settings";

interface Props {
  presets: Record<Group, Preset>;
  overrides: Overrides;
  onChange: (key: string, value: string | null, alsoSet?: string[]) => void;
}

const GROUP_LABEL: Record<Group, string> = { process: "Druck", filament: "Filament", machine: "Drucker" };

export function SettingsPanel({ presets, overrides, onChange }: Props) {
  const [tab, setTab] = useState(TABS[0].id);
  const [query, setQuery] = useState("");

  const tabs = [...TABS, ALL_TAB];
  const changedIn = (id: string) => {
    if (id === "all") return Object.keys(overrides).length;
    const t = TABS.find((x) => x.id === id)!;
    return t.sections.flatMap((s) => s.fields).filter((f) => f.key in overrides).length;
  };

  return (
    <div className="sp">
      <div className="sp-tabs" role="tablist">
        {tabs.map((t) => {
          const n = changedIn(t.id);
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {n > 0 && <i className="sp-dot" aria-label={`${n} geändert`} />}
            </button>
          );
        })}
      </div>
      <div className="sp-body" key={tab}>
        {tab === "all" ? (
          <AllSettings presets={presets} overrides={overrides} onChange={onChange} query={query} setQuery={setQuery} />
        ) : (
          TABS.find((t) => t.id === tab)!.sections.map((s) =>
            s.fields.length ? (
              <section key={s.title} className="sp-section">
                <div className="label">{s.title}</div>
                {s.fields.map((f) => (
                  <Field key={f.key} field={f} presets={presets} overrides={overrides} onChange={onChange} />
                ))}
              </section>
            ) : null,
          )
        )}
      </div>
    </div>
  );
}

function AllSettings({
  presets,
  overrides,
  onChange,
  query,
  setQuery,
}: Props & { query: string; setQuery: (q: string) => void }) {
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(CATALOG)
      .filter(([k, e]) => e.group !== "machine" || ["retraction_length", "retraction_speed", "z_hop", "wipe", "retract_when_changing_layer"].includes(k) || k.startsWith("retract"))
      .filter(([k, e]) => !q || k.includes(q) || e.label.toLowerCase().includes(q) || (e.labelEn ?? "").toLowerCase().includes(q) || (e.category ?? "").toLowerCase().includes(q))
      .sort(([, a], [, b]) => (a.group + (a.category ?? "") + a.label).localeCompare(b.group + (b.category ?? "") + b.label, "de"));
  }, [query]);
  const shown = entries.slice(0, 150);

  return (
    <>
      <div className="sp-search">
        <Search size={14} />
        <input className="input" placeholder="Einstellung suchen, z. B. „Brücke“ oder „retraction“" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <p className="hint" style={{ margin: "0 0 8px" }}>
        {entries.length} Einstellungen{entries.length > shown.length ? ` – die ersten ${shown.length} werden angezeigt, Suche grenzt ein.` : "."}
      </p>
      {shown.map(([k, e]) => (
        <Field
          key={k}
          field={{ key: k }}
          presets={presets}
          overrides={overrides}
          onChange={onChange}
          meta={`${GROUP_LABEL[e.group]}${e.category ? " · " + e.category : ""}`}
        />
      ))}
    </>
  );
}

function Field({
  field,
  presets,
  overrides,
  onChange,
  meta,
}: {
  field: FieldDef;
  presets: Record<Group, Preset>;
  overrides: Overrides;
  onChange: Props["onChange"];
  meta?: string;
}) {
  const { key } = field;
  const e = CATALOG[key];
  const kind = kindOf(key);
  const value = effective(key, presets, overrides);
  const changed = key in overrides && overrides[key] !== scalar(baseValue(key, presets));
  const label = labelOf(key, field);
  const unit = displayUnit(key, value);
  const set = (v: string) => onChange(key, v, field.alsoSet);

  let control: React.ReactNode;
  if (kind === "bool") {
    const on = value === "1" || value === "true";
    control = <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => set(on ? "0" : "1")} />;
  } else if (kind === "enum" && PATTERN_KEYS.has(key)) {
    control = <PatternPicker value={value} options={e!.enum!} onChange={set} label={label} />;
  } else if (kind === "enum") {
    const opts = e!.enum!;
    control = (
      <select className="input sp-select" value={value} onChange={(ev) => set(ev.target.value)} aria-label={label}>
        {!opts.some((o) => o.value === value) && <option value={value}>{value}</option>}
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (kind === "percent") {
    control = <NumInput value={value.replace("%", "")} onCommit={(v) => set(`${v}%`)} unit="%" min={e?.min} max={e?.max} label={label} />;
  } else if (kind === "number") {
    control = <NumInput value={value} onCommit={set} unit={unit} min={e?.min} max={e?.max} label={label} />;
  } else {
    control = <TextInput value={value} onCommit={set} unit={unit} label={label} />;
  }

  return (
    <div className={`sp-field ${changed ? "changed" : ""}`} title={e?.tooltip}>
      <div className="sp-label">
        <span>{label}</span>
        {meta && <span className="sp-meta">{meta}</span>}
      </div>
      <div className="sp-control">
        {control}
        <button
          className="sp-reset"
          aria-label="Auf Profilwert zurücksetzen"
          title="Auf Profilwert zurücksetzen"
          style={{ visibility: changed ? "visible" : "hidden" }}
          onClick={() => onChange(key, null, field.alsoSet)}
        >
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
}

/** Kurze Einheit für das Eingabefeld – lange Einheiten („Schichten“) stehen schon im Namen. */
function displayUnit(key: string, value: string): string | undefined {
  const u = CATALOG[key]?.unit;
  if (u && u.includes("o. %")) return value.trim().endsWith("%") ? undefined : u.split(" ")[0];
  if (u && u.length <= 5) return u;
  if (!u && /temp/.test(key)) return "°C";
  if (!u && /(angle|direction)$/.test(key)) return "°";
  return undefined;
}

function NumInput(props: { value: string; onCommit: (v: string) => void; unit?: string; min?: number; max?: number; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const n = Number(draft.replace(",", "."));
    if (draft.trim() !== "" && Number.isFinite(n)) {
      let v = n;
      if (props.min != null) v = Math.max(props.min, v);
      if (props.max != null && props.max > (props.min ?? -Infinity)) v = Math.min(props.max, v);
      props.onCommit(String(v));
    }
    setDraft(null);
  };
  return (
    <span className="sp-num">
      <input
        className="input num"
        inputMode="decimal"
        aria-label={props.label}
        value={draft ?? props.value.replace(".", ",")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(null);
        }}
      />
      {props.unit && <span className="sp-unit">{props.unit}</span>}
    </span>
  );
}

function TextInput(props: { value: string; onCommit: (v: string) => void; unit?: string; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="sp-num">
      <input
        className="input"
        aria-label={props.label}
        spellCheck={false}
        value={draft ?? props.value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft != null) props.onCommit(draft.trim());
          setDraft(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {props.unit && <span className="sp-unit">{props.unit}</span>}
    </span>
  );
}

const PATTERN_KEYS = new Set(["sparse_infill_pattern", "top_surface_pattern", "bottom_surface_pattern", "internal_solid_infill_pattern"]);

/** Auswahl eines Füllmusters mit Vorschaubild je Muster. */
function PatternPicker(props: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const toggle = () => {
    if (open) return setOpen(false);
    // Frei schwebend positionieren (der Einstellungsbereich scrollt und würde abschneiden)
    const r = ref.current!.getBoundingClientRect();
    const width = 3 * 104 + 2 * 4 + 16 + 2;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    setPos(below >= 280 || below >= above ? { left, top: r.bottom + 6, maxHeight: Math.min(420, below) } : { left, bottom: window.innerHeight - r.top + 6, maxHeight: Math.min(420, above) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const current = props.options.find((o) => o.value === props.value);
  return (
    <span className="pattern-pick" ref={ref}>
      <button className="input sp-select pattern-btn" aria-label={props.label} aria-expanded={open} onClick={toggle}>
        {hasPatternIcon(props.value) && <PatternIcon value={props.value} size={20} />}
        <span>{current?.label ?? props.value}</span>
        <ChevronDown size={12} />
      </button>
      {open && pos && (
        <div className="pattern-pop card" role="listbox" aria-label={props.label} style={pos}>
          {props.options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === props.value}
              className={o.value === props.value ? "on" : ""}
              onClick={() => {
                props.onChange(o.value);
                setOpen(false);
              }}
            >
              <PatternIcon value={o.value} size={48} />
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
