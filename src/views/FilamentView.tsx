import { useState } from "react";
import { Check, Disc3, Pencil, Plus, Trash2, X } from "lucide-react";
import { Badge, Card, EmptyState } from "../components/ui";
import { fmtNum } from "../lib/format";
import { t } from "../lib/i18n";
import { addSpool, MATERIALS, metersFromGrams, removeSpool, setActiveSpool, updateSpool, useSpools, type Material, type Spool } from "../lib/spools";

const LOW_G = 100;

type Draft = { name: string; material: Material; color: string; weightG: string; remainingG: string; pricePerKg: string };
const NEW: Draft = { name: "", material: "PLA", color: "#d97757", weightG: "1000", remainingG: "1000", pricePerKg: "20" };

export function FilamentView() {
  const st = useSpools();
  const [adding, setAdding] = useState(false);
  const stockG = st.spools.reduce((a, s) => a + s.remainingG, 0);
  const value = st.spools.reduce((a, s) => a + (s.remainingG / 1000) * s.pricePerKg, 0);

  return (
    <div className="view">
      <div className="fil-summary">
        <Card className="fil-stat">
          <span className="label">{t("Im Lager")}</span>
          <span className="big num">
            {fmtNum(stockG / 1000, 2)}
            <span className="unit">kg</span>
          </span>
          <span className="small muted num">{t("{n} Spulen · Wert ca. {v} €", { n: st.spools.length, v: fmtNum(value, 2) })}</span>
        </Card>
        <Card className="fil-stat">
          <span className="label">{t("Verbraucht")}</span>
          <span className="big num">
            {fmtNum(st.usedG / 1000, 2)}
            <span className="unit">kg</span>
          </span>
          <span className="small muted num">{t("seit Beginn der Erfassung")}</span>
        </Card>
        <Card className="fil-stat">
          <span className="label">{t("Ausgegeben")}</span>
          <span className="big num">
            {fmtNum(st.spentEur, 2)}
            <span className="unit">€</span>
          </span>
          <span className="small muted num">{t("Materialkosten aller erfassten Drucke")}</span>
        </Card>
      </div>

      <div className="section-head">
        <span className="label">{t("Spulen")}</span>
        {!adding && (
          <button className="btn sm primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> {t("Spule hinzufügen")}
          </button>
        )}
      </div>

      {adding && (
        <Card>
          <SpoolForm
            initial={NEW}
            onCancel={() => setAdding(false)}
            onSave={(d) => {
              addSpool(d);
              setAdding(false);
            }}
          />
        </Card>
      )}

      {st.spools.length === 0 && !adding ? (
        <Card>
          <EmptyState
            icon={Disc3}
            accent
            title={t("Noch keine Spulen")}
            text={t("Trage deine Filamentspulen ein. Nach jedem Druck zieht Druckerwacht den Verbrauch von der aktiven Spule ab, zeigt die Kosten und warnt, bevor eine Spule nicht mehr reicht.")}
            actions={
              <button className="btn primary" onClick={() => setAdding(true)}>
                <Plus size={16} /> {t("Erste Spule eintragen")}
              </button>
            }
          />
        </Card>
      ) : (
        <div className="spools">
          {st.spools.map((s) => (
            <SpoolCard key={s.id} s={s} active={s.id === st.activeId} />
          ))}
        </div>
      )}
      <p className="hint" style={{ textAlign: "center" }}>
        {t("Gewicht aus der Filamentlänge bei 1,75 mm Durchmesser – eine gute Schätzung, keine Waage.")}
      </p>
    </div>
  );
}

function SpoolCard({ s, active }: { s: Spool; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const pct = s.weightG > 0 ? Math.max(0, Math.min(100, (s.remainingG / s.weightG) * 100)) : 0;
  const low = s.remainingG < LOW_G;
  const meters = metersFromGrams(s.remainingG, s.material);
  if (editing) {
    return (
      <Card className="spool-card">
        <SpoolForm
          initial={{ name: s.name, material: s.material, color: s.color, weightG: String(s.weightG), remainingG: String(Math.round(s.remainingG)), pricePerKg: String(s.pricePerKg) }}
          onCancel={() => setEditing(false)}
          onSave={(d) => {
            updateSpool(s.id, d);
            setEditing(false);
          }}
        />
      </Card>
    );
  }
  return (
    <Card className={`spool-card${active ? " active" : ""}`}>
      <div className="spool-top">
        <svg className="spool-ring" viewBox="0 0 100 100" aria-hidden style={{ ["--c" as string]: s.color }}>
          <circle cx={50} cy={50} r={42} className="sr-track" />
          <circle cx={50} cy={50} r={42} className="sr-fill" pathLength={100} strokeDasharray={`${pct} 100`} transform="rotate(-90 50 50)" />
          <circle cx={50} cy={50} r={30} className="sr-core" />
          <circle cx={50} cy={50} r={9} className="sr-hub" />
        </svg>
        <div className="spool-info">
          <div className="spool-name">{s.name || t("Unbenannte Spule")}</div>
          <div className="spool-tags">
            <Badge tone="neutral">{s.material === "Andere" ? t("Andere") : s.material}</Badge>
            {active && <Badge tone="accent">{t("Aktiv")}</Badge>}
            {low && <Badge tone="warning">{t("Fast leer")}</Badge>}
          </div>
        </div>
      </div>
      <div className="spool-nums num">
        <span className="spool-rest">
          {fmtNum(s.remainingG)} <span className="unit">g</span>
        </span>
        <span className="small muted">
          {t("von {w} g · ca. {m} m · {p} €/kg", { w: fmtNum(s.weightG), m: fmtNum(meters), p: fmtNum(s.pricePerKg, 2) })}
        </span>
      </div>
      <div className="spool-actions">
        {confirm ? (
          <>
            <span className="small">{t("Spule löschen?")}</span>
            <button className="btn sm ghost" onClick={() => setConfirm(false)}>
              {t("Nein")}
            </button>
            <button className="btn sm danger" onClick={() => removeSpool(s.id)}>
              {t("Löschen")}
            </button>
          </>
        ) : (
          <>
            {!active && (
              <button className="btn sm" onClick={() => setActiveSpool(s.id)}>
                <Check size={14} /> {t("Diese drucke ich")}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn sm ghost" aria-label={t("Bearbeiten")} title={t("Bearbeiten")} onClick={() => setEditing(true)}>
              <Pencil size={14} />
            </button>
            <button className="btn sm ghost" aria-label={t("Löschen")} title={t("Löschen")} onClick={() => setConfirm(true)}>
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

function SpoolForm({ initial, onSave, onCancel }: { initial: Draft; onSave: (s: Omit<Spool, "id" | "addedMs">) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  const num = (v: string) => Number(v.replace(",", "."));
  const ok = num(d.weightG) > 0 && num(d.remainingG) >= 0 && num(d.pricePerKg) >= 0;
  return (
    <form
      className="spool-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        onSave({ name: d.name.trim(), material: d.material, color: d.color, weightG: num(d.weightG), remainingG: Math.min(num(d.remainingG), num(d.weightG)), pricePerKg: num(d.pricePerKg) });
      }}
    >
      <label className="sf-wide">
        <span className="label">{t("Name")}</span>
        <input className="input" autoFocus value={d.name} onChange={set("name")} placeholder={t("z. B. Hyper PLA Schwarz")} />
      </label>
      <label>
        <span className="label">{t("Material")}</span>
        <select className="input" value={d.material} onChange={set("material")}>
          {MATERIALS.map((m) => (
            <option key={m} value={m}>
              {m === "Andere" ? t("Andere") : m}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">{t("Farbe")}</span>
        <input className="input color" type="color" value={d.color} onChange={set("color")} />
      </label>
      <label>
        <span className="label">{t("Spule (g)")}</span>
        <input className="input num" inputMode="decimal" value={d.weightG} onChange={set("weightG")} />
      </label>
      <label>
        <span className="label">{t("Rest (g)")}</span>
        <input className="input num" inputMode="decimal" value={d.remainingG} onChange={set("remainingG")} />
      </label>
      <label>
        <span className="label">{t("Preis (€/kg)")}</span>
        <input className="input num" inputMode="decimal" value={d.pricePerKg} onChange={set("pricePerKg")} />
      </label>
      <div className="sf-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          <X size={14} /> {t("Abbrechen")}
        </button>
        <button type="submit" className="btn primary" disabled={!ok}>
          <Check size={14} /> {t("Speichern")}
        </button>
      </div>
    </form>
  );
}
