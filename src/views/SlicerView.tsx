import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  Copy,
  Download,
  Eye,
  FolderOpen,
  Grid3x3,
  Layers,
  LayoutGrid,
  Loader2,
  Move3d,
  RotateCw,
  Save,
  Scan,
  Send,
  SquareDashedBottom,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Plate, BED, type ModelInfo, type Tool } from "../slicer/plate";
import { parseGcode, defaultVisible, type GcodePreview } from "../slicer/gcode";
import { SettingsPanel } from "../slicer/SettingsPanel";
import {
  bytesToBase64,
  cancelSlice,
  deletePreset,
  loadPresets,
  onFileDrop,
  onSliceProgress,
  pickModels,
  readGcode,
  readModel,
  saveGcodeAs,
  savePreset,
  slice,
  slicerInfo,
  type Presets,
  type SliceResult,
  type SlicerInfo,
} from "../slicer/api";
import { buildConfig, CATALOG, groupOf, type Group, type Overrides, type Preset } from "../slicer/settings";
import { isTauri } from "../lib/api";
import { fmtDuration, fmtNum } from "../lib/format";
import { EmptyState } from "../components/ui";
import type { ViewId } from "../components/Shell";

// Die Druckplatte lebt über Ansichtswechsel hinweg weiter (WebGL-Kontext, geladene Modelle).
let plateSingleton: Plate | null = null;
const getPlate = () => (plateSingleton ??= new Plate());

const LS = "slicer.v1";
interface Persisted {
  process?: string;
  filament?: string;
  overrides?: Overrides;
}
function loadLS(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? "{}");
  } catch {
    return {};
  }
}
function saveLS(p: Persisted) {
  try {
    localStorage.setItem(LS, JSON.stringify(p));
  } catch {
    /* egal */
  }
}

type Phase =
  | { kind: "idle" }
  | { kind: "slicing"; progress: number | null }
  | { kind: "done"; result: SliceResult; stale: boolean }
  | { kind: "error"; message: string };

export function SlicerView({ go }: { go: (v: ViewId) => void }) {
  const plate = getPlate();
  const host = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<ModelInfo[]>(() => plate.list());
  const [selected, setSelected] = useState<number | null>(() => plate.selectedId());
  const [tool, setToolState] = useState<Tool>(() => plate.getTool());
  const [info, setInfo] = useState<SlicerInfo | null>(null);
  const [presets, setPresets] = useState<Presets | null>(null);
  const persisted = useMemo(loadLS, []);
  const [processName, setProcessName] = useState(persisted.process ?? "0.20mm Standard @Creality Ender3V3KE");
  const [filamentName, setFilamentName] = useState(persisted.filament ?? "Generic PLA @Creality Ender-3V3-all");
  const [overrides, setOverrides] = useState<Overrides>(persisted.overrides ?? {});
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [preview, setPreview] = useState<GcodePreview | null>(null);
  const [layer, setLayer] = useState(0);
  /** Sichtbarkeit je Linientyp (sonst Standard: alles außer Leerfahrten und Start/Ende) */
  const [vis, setVis] = useState<Record<string, boolean>>({});
  const isVisible = (id: string) => vis[id] ?? defaultVisible(id);
  const [dropHover, setDropHover] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // --------------------------------------------------------------- Einrichtung
  useEffect(() => {
    if (host.current) plate.mount(host.current);
    const off = plate.onChange(() => {
      setModels(plate.list());
      setSelected(plate.selectedId());
      setToolState(plate.getTool());
    });
    return () => {
      off();
      plate.unmount();
    };
  }, [plate]);

  const refreshPresets = useCallback(async () => {
    try {
      setPresets(await loadPresets());
    } catch {
      setPresets(null);
    }
  }, []);

  useEffect(() => {
    void slicerInfo().then(setInfo);
    void refreshPresets();
  }, [refreshPresets]);

  useEffect(() => saveLS({ process: processName, filament: filamentName, overrides }), [processName, filamentName, overrides]);

  // Änderungen an Modellen/Einstellungen machen ein Slice-Ergebnis „veraltet“
  const modelsKey = JSON.stringify(models.map((m) => [m.position, m.rotation, m.scale, m.id]));
  useEffect(() => {
    setPhase((p) => (p.kind === "done" ? { ...p, stale: true } : p));
  }, [modelsKey, processName, filamentName, overrides]);

  // --------------------------------------------------------------- Dateien
  const addPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      setLoading(true);
      setLoadError(null);
      closePreview();
      for (const p of paths) {
        try {
          const name = p.split(/[\\/]/).pop() ?? "Modell";
          await plate.addFile(name, await readModel(p));
        } catch (e) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
      setLoading(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plate],
  );

  useEffect(() => {
    let off: (() => void) | undefined;
    void onFileDrop((p) => void addPaths(p), setDropHover).then((f) => (off = f));
    return () => off?.();
  }, [addPaths]);

  const openDialog = async () => {
    if (!isTauri) {
      fileInput.current?.click();
      return;
    }
    await addPaths(await pickModels());
  };

  // Browser-Fallback (Entwicklung): klassischer Datei-Dialog
  const fileInput = useRef<HTMLInputElement>(null);
  const onBrowserFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        await plate.addFile(f.name, await f.arrayBuffer());
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  // --------------------------------------------------------------- Profile
  const allProcess = useMemo(() => [...(presets?.process ?? []), ...(presets?.userProcess ?? [])], [presets]);
  const allFilament = useMemo(() => [...(presets?.filament ?? []), ...(presets?.userFilament ?? [])], [presets]);
  const processPreset = allProcess.find((p) => p.name === processName) ?? allProcess.find((p) => p.name.includes("Standard")) ?? allProcess[0];
  const filamentPreset = allFilament.find((p) => p.name === filamentName) ?? allFilament[0];
  const active: Record<Group, Preset> | null =
    presets && processPreset && filamentPreset ? { machine: presets.machine, process: processPreset, filament: filamentPreset } : null;
  const isUser = (kind: "process" | "filament", name?: string) =>
    !!name && (kind === "process" ? presets?.userProcess : presets?.userFilament)?.some((p) => p.name === name);

  const onSetting = (key: string, value: string | null, alsoSet?: string[]) => {
    setOverrides((o) => {
      const n = { ...o };
      for (const k of [key, ...(alsoSet ?? []).filter((x) => x in CATALOG)]) {
        if (value == null) delete n[k];
        else n[k] = value;
      }
      return n;
    });
  };

  const changedCount = Object.keys(overrides).length;
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const doSavePreset = async () => {
    if (!active || !saveAs?.trim()) return;
    const name = saveAs.trim();
    try {
      for (const kind of ["process", "filament"] as const) {
        const touched = Object.keys(overrides).some((k) => groupOf(k) === kind);
        if (!touched) continue;
        const cfg = buildConfig(kind, active[kind], active, overrides) as Preset;
        const label = kind === "process" ? name : `${name} (Filament)`;
        await savePreset(kind, { ...cfg, name: label, from: "User", inherits: "" });
        if (kind === "process") setProcessName(label);
        else setFilamentName(label);
      }
      setOverrides((o) => Object.fromEntries(Object.entries(o).filter(([k]) => groupOf(k) === "machine")));
      setSaveAs(null);
      await refreshPresets();
    } catch (e) {
      setLoadError(String(e));
    }
  };

  // --------------------------------------------------------------- Slicen
  useEffect(() => {
    let off: (() => void) | undefined;
    void onSliceProgress((pct) => setPhase((p) => (p.kind === "slicing" ? { kind: "slicing", progress: pct } : p))).then((f) => (off = f));
    return () => off?.();
  }, []);

  const outside = models.some((m) => m.outside);
  const canSlice = !!active && models.length > 0 && !outside && info?.found && phase.kind !== "slicing";

  const doSlice = async () => {
    if (!active || !canSlice) return;
    closePreview();
    setPhase({ kind: "slicing", progress: null });
    try {
      const stls = plate.exportStls().map((m) => ({ name: m.name, stl: bytesToBase64(m.data) }));
      const thumbs = plate.thumbnails([96, 300]);
      const fileName = `${models[0].name}${models.length > 1 ? `_+${models.length - 1}` : ""}_${active.filament.name.split(" @")[0]}_${Math.round(Number(String(overrides.layer_height ?? active.process.layer_height ?? "0.2")) * 100) / 100}mm`;
      const result = await slice({
        models: stls,
        machine: buildConfig("machine", active.machine, active, overrides),
        process: buildConfig("process", active.process, active, overrides),
        filament: buildConfig("filament", active.filament, active, overrides),
        thumbnails: thumbs,
        fileName,
      });
      setPhase({ kind: "done", result, stale: false });
      await openPreview(result.gcodePath);
    } catch (e) {
      setPhase({ kind: "error", message: typeof e === "string" ? e : e instanceof Error ? e.message : "Slicen fehlgeschlagen." });
    }
  };

  // --------------------------------------------------------------- Vorschau
  const openPreview = async (path: string) => {
    const text = await readGcode(path);
    const p = parseGcode(text);
    for (const t of p.types) p.setVisible(t.id, isVisible(t.id));
    p.setMaxLayer(p.layerCount - 1);
    preview?.dispose();
    setPreview(p);
    setLayer(p.layerCount - 1);
    plate.showPreview(p);
  };

  // Nur Entwicklung: echten G-Code im Browser in die Vorschau laden (Design-Kontrolle)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __dwPlate: Plate }).__dwPlate = plate;
    (window as unknown as { __dwShowGcode: (t: string) => void }).__dwShowGcode = (text: string) => {
      const p = parseGcode(text);
      p.setMaxLayer(p.layerCount - 1);
      for (const t of p.types) p.setVisible(t.id, defaultVisible(t.id));
      setPreview(p);
      setLayer(Math.round(p.layerCount * 0.6));
      plate.showPreview(p);
      setPhase({ kind: "done", stale: false, result: { gcodePath: "", fileName: "x.gcode", timeS: 919, filamentMm: 1211, filamentG: 3.61, layers: p.layerCount, warnings: [] } });
    };
  }, [plate]);

  function closePreview() {
    if (!plateSingleton) return;
    plate.showPreview(null);
    setPreview((p) => {
      p?.dispose();
      return null;
    });
  }

  useEffect(() => {
    if (!preview) return;
    preview.setMaxLayer(layer);
    plate.invalidate();
  }, [layer, preview, plate]);

  const toggleType = (id: string) => {
    if (!preview) return;
    const on = !isVisible(id);
    preview.setVisible(id, on);
    setVis((v) => ({ ...v, [id]: on }));
    plate.invalidate();
  };

  // --------------------------------------------------------------- Tastatur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, select, textarea")) return;
      if (e.key === "Delete" || e.key === "Backspace") plate.remove();
      else if (e.key === "m" || e.key === "g") plate.setTool("move");
      else if (e.key === "r") plate.setTool("rotate");
      else if (e.key === "f") plate.setTool("layflat");
      else if (e.key === "a") plate.arrange();
      else if (e.key === "Escape") plate.select(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plate]);

  const sel = models.find((m) => m.id === selected) ?? null;
  const setTool = (t: Tool) => {
    closePreview();
    plate.setTool(t);
  };

  // --------------------------------------------------------------- Darstellung
  return (
    <div className="slicer">
      <div className="slicer-stage">
        <div className="slicer-toolbar">
          <button className="btn sm" onClick={() => void openDialog()}>
            <FolderOpen size={14} /> Öffnen
          </button>
          <span className="tb-sep" />
          <ToolBtn icon={Move3d} label="Verschieben (M)" on={tool === "move" && !preview} onClick={() => setTool("move")} />
          <ToolBtn icon={RotateCw} label="Drehen (R)" on={tool === "rotate" && !preview} onClick={() => setTool("rotate")} />
          <ToolBtn icon={SquareDashedBottom} label="Auf Fläche legen (F)" on={tool === "layflat" && !preview} onClick={() => setTool("layflat")} />
          <span className="tb-sep" />
          <ToolBtn icon={LayoutGrid} label="Anordnen (A)" onClick={() => plate.arrange()} disabled={!models.length} />
          <ToolBtn icon={Copy} label="Duplizieren" onClick={() => plate.duplicate()} disabled={!sel} />
          <ToolBtn icon={Trash2} label="Löschen (Entf)" onClick={() => plate.remove()} disabled={!sel} />
          <span className="tb-spacer" />
          {preview && (
            <button className="btn sm ghost" onClick={closePreview}>
              <Box size={14} /> Modelle
            </button>
          )}
          {!preview && phase.kind === "done" && !phase.stale && (
            <button className="btn sm ghost" onClick={() => void openPreview(phase.result.gcodePath)}>
              <Eye size={14} /> Vorschau
            </button>
          )}
          <ToolBtn icon={Scan} label="Ansicht zurücksetzen" onClick={() => plate.resetView()} />
          <ToolBtn icon={Grid3x3} label="Draufsicht" onClick={() => plate.topView()} />
        </div>

        <div className="slicer-canvas" ref={host}>
          {!models.length && !loading && (
            <div className="slicer-empty">
              <EmptyState
                icon={Upload}
                accent
                title="Modell hierher ziehen"
                text="STL, OBJ oder 3MF – oder über „Öffnen“ auswählen. Druckbett: 220 × 220 × 245 mm."
                actions={
                  <button className="btn primary" onClick={() => void openDialog()}>
                    <FolderOpen size={16} /> Modell öffnen
                  </button>
                }
              />
            </div>
          )}
          {loading && (
            <div className="slicer-empty">
              <EmptyState icon={Loader2} spin title="Lade Modell…" />
            </div>
          )}
          {dropHover && <div className="drop-overlay">Loslassen zum Hinzufügen</div>}

          {sel && !preview && <ObjectPanel m={sel} plate={plate} />}

          {preview && (
            <>
              <div className="layer-bar card">
                <span className="label">Schicht</span>
                <input
                  type="range"
                  min={0}
                  max={preview.layerCount - 1}
                  value={layer}
                  onChange={(e) => setLayer(Number(e.target.value))}
                  aria-label="Schicht"
                  style={{ ["--p" as string]: `${(layer / Math.max(1, preview.layerCount - 1)) * 100}%` }}
                />
                <span className="num layer-read">
                  {layer + 1} / {preview.layerCount}
                  <span className="muted"> · {fmtNum(preview.layerZ[layer] ?? 0, 2)} mm</span>
                </span>
              </div>
              <div className="preview-legend card">
                {preview.types.map((t) => {
                  const on = isVisible(t.id);
                  return (
                    <button key={t.id} className={on ? "" : "off"} onClick={() => toggleType(t.id)} aria-pressed={on}>
                      <i style={{ background: t.color }} />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {(loadError || outside) && !preview && (
            <div className="slicer-toast">
              <AlertTriangle size={14} />
              <span>{loadError ?? "Ein Modell ragt über das Druckbett hinaus (rot markiert)."}</span>
              {loadError && (
                <button className="sp-reset" aria-label="Schließen" onClick={() => setLoadError(null)}>
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          <input ref={fileInput} type="file" accept=".stl,.obj,.3mf" multiple hidden onChange={(e) => void onBrowserFiles(e.target.files)} />
        </div>
      </div>

      <aside className="slicer-side">
        {info && !info.found && <OrcaMissing go={go} />}

        <div className="side-presets">
          <PresetSelect
            label="Qualität"
            value={processPreset?.name ?? ""}
            options={allProcess}
            userNames={presets?.userProcess.map((p) => p.name) ?? []}
            onChange={setProcessName}
            onDelete={
              isUser("process", processPreset?.name)
                ? async () => {
                    await deletePreset("process", processPreset!.name);
                    setProcessName("0.20mm Standard @Creality Ender3V3KE");
                    await refreshPresets();
                  }
                : undefined
            }
          />
          <PresetSelect
            label="Filament"
            value={filamentPreset?.name ?? ""}
            options={allFilament}
            userNames={presets?.userFilament.map((p) => p.name) ?? []}
            onChange={setFilamentName}
            onDelete={
              isUser("filament", filamentPreset?.name)
                ? async () => {
                    await deletePreset("filament", filamentPreset!.name);
                    setFilamentName("Generic PLA @Creality Ender-3V3-all");
                    await refreshPresets();
                  }
                : undefined
            }
          />
        </div>

        {active ? (
          <SettingsPanel presets={active} overrides={overrides} onChange={onSetting} />
        ) : (
          <div className="sp">
            <EmptyState icon={Layers} title="Profile werden geladen…" text={isTauri ? undefined : "Nur in der App verfügbar."} />
          </div>
        )}

        <div className="side-footer">
          {changedCount > 0 && (
            <div className="changes">
              {saveAs == null ? (
                <>
                  <span className="small muted">
                    {changedCount} {changedCount === 1 ? "Änderung" : "Änderungen"}
                  </span>
                  <span style={{ display: "flex", gap: 4 }}>
                    <button className="btn sm ghost" onClick={() => setOverrides({})}>
                      Verwerfen
                    </button>
                    <button className="btn sm" onClick={() => setSaveAs("")}>
                      <Save size={14} /> Als Profil
                    </button>
                  </span>
                </>
              ) : (
                <>
                  <input
                    className="input"
                    autoFocus
                    placeholder="Name des Profils"
                    value={saveAs}
                    onChange={(e) => setSaveAs(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doSavePreset();
                      if (e.key === "Escape") setSaveAs(null);
                    }}
                  />
                  <button className="btn sm primary" disabled={!saveAs.trim()} onClick={() => void doSavePreset()}>
                    Speichern
                  </button>
                </>
              )}
            </div>
          )}

          <ResultCard phase={phase} />

          <div className="actions-row">
            {phase.kind === "slicing" ? (
              <button className="btn primary wide" onClick={() => void cancelSlice()}>
                <Loader2 size={16} className="spin" /> Slicen… {phase.progress != null ? `${Math.round(phase.progress)} %` : ""} · Abbrechen
              </button>
            ) : (
              <button className="btn primary wide" disabled={!canSlice} onClick={() => void doSlice()}>
                <Layers size={16} /> {phase.kind === "done" && !phase.stale ? "Erneut slicen" : "Slicen"}
              </button>
            )}
          </div>
          {phase.kind === "done" && !phase.stale && (
            <div className="actions-row">
              <button className="btn" onClick={() => void saveGcodeAs(phase.result.gcodePath, phase.result.fileName)}>
                <Download size={16} /> G-Code speichern
              </button>
              <button className="btn" disabled title="Kommt in der nächsten Etappe: Datei direkt an den Drucker senden und starten.">
                <Send size={16} /> Drucken
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function ToolBtn({ icon: Icon, label, on, onClick, disabled }: { icon: typeof Move3d; label: string; on?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={`tool-btn ${on ? "on" : ""}`} onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={on}>
      <Icon size={16} strokeWidth={1.75} />
    </button>
  );
}

function PresetSelect(props: {
  label: string;
  value: string;
  options: Preset[];
  userNames: string[];
  onChange: (v: string) => void;
  onDelete?: () => void;
}) {
  const sys = props.options.filter((o) => !props.userNames.includes(o.name));
  const user = props.options.filter((o) => props.userNames.includes(o.name));
  const pretty = (n: string) => n.replace(/ @Creality.*$| @Ender-3 V3 KE.*$/, "");
  return (
    <label className="preset">
      <span className="label">{props.label}</span>
      <span className="preset-row">
        <select className="input sp-select" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <optgroup label="Creality / Orca">
            {sys.map((o) => (
              <option key={o.name} value={o.name}>
                {pretty(o.name)}
              </option>
            ))}
          </optgroup>
          {user.length > 0 && (
            <optgroup label="Eigene">
              {user.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {props.onDelete && (
          <button className="tool-btn" title="Eigenes Profil löschen" aria-label="Eigenes Profil löschen" onClick={(e) => { e.preventDefault(); props.onDelete!(); }}>
            <Trash2 size={14} />
          </button>
        )}
      </span>
    </label>
  );
}

function ResultCard({ phase }: { phase: Phase }) {
  if (phase.kind === "error") {
    return (
      <div className="result error">
        <AlertTriangle size={16} />
        <span>{phase.message}</span>
      </div>
    );
  }
  if (phase.kind !== "done") return null;
  const r = phase.result;
  return (
    <div className={`result ${phase.stale ? "stale" : ""}`}>
      <div>
        <span className="label">Druckzeit</span>
        <span className="value num">{fmtDuration(r.timeS)}</span>
      </div>
      <div>
        <span className="label">Filament</span>
        <span className="value num">
          {r.filamentG != null ? `${fmtNum(r.filamentG, 1)} g` : "–"}
          {r.filamentMm != null && <span className="muted small"> · {fmtNum(r.filamentMm / 1000, 2)} m</span>}
        </span>
      </div>
      <div>
        <span className="label">Schichten</span>
        <span className="value num">{fmtNum(r.layers)}</span>
      </div>
      {phase.stale && <p className="hint">Geändert – bitte erneut slicen.</p>}
      {r.warnings.map((w) => (
        <p key={w} className="hint" style={{ color: "var(--warning)" }}>
          {w}
        </p>
      ))}
    </div>
  );
}

function ObjectPanel({ m, plate }: { m: ModelInfo; plate: Plate }) {
  const [uniform, setUniform] = useState(true);
  const f = (v: number, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString().replace(".", ",");
  const num = (s: string) => Number(s.replace(",", "."));
  return (
    <div className="object-panel card">
      <div className="op-head">
        <span className="file-name" title={m.name}>
          {m.name}
        </span>
        <span className="small muted num">{fmtNum(m.triangles)} Dreiecke</span>
      </div>
      <div className="op-grid">
        <span className="label">Größe</span>
        {(["X", "Y", "Z"] as const).map((a, i) => (
          <Cell key={a} axis={a} value={f(m.size[i])} unit="mm" onCommit={(v) => plate.setSize(i as 0 | 1 | 2, num(v), uniform)} />
        ))}
        <span className="label">Skalierung</span>
        {(["X", "Y", "Z"] as const).map((a, i) => (
          <Cell
            key={a}
            axis={a}
            value={f(m.scale[i] * 100, 0)}
            unit="%"
            onCommit={(v) => {
              const s = num(v) / 100;
              plate.setScale(uniform ? [s, s, s] : (m.scale.map((x, j) => (j === i ? s : x)) as [number, number, number]));
            }}
          />
        ))}
        <span className="label">Drehung</span>
        {(["X", "Y", "Z"] as const).map((a, i) => (
          <Cell key={a} axis={a} value={f(m.rotation[i], 0)} unit="°" onCommit={(v) => plate.setRotation(m.rotation.map((x, j) => (j === i ? num(v) : x)) as [number, number, number])} />
        ))}
        <span className="label">Position</span>
        {(["X", "Y"] as const).map((a, i) => (
          <Cell key={a} axis={a} value={f(m.position[i])} unit="mm" onCommit={(v) => plate.setPosition(i === 0 ? num(v) : m.position[0], i === 1 ? num(v) : m.position[1])} />
        ))}
        <span />
      </div>
      <label className="op-uniform">
        <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} /> Gleichmäßig skalieren
      </label>
      {m.outside && <p className="hint error">Liegt teilweise außerhalb des Druckbetts ({BED.x} × {BED.y} × {BED.z} mm).</p>}
    </div>
  );
}

function Cell({ axis, value, unit, onCommit }: { axis: string; value: string; unit: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="op-cell">
      <i className={`ax ax-${axis.toLowerCase()}`}>{axis}</i>
      <input
        className="input num"
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft != null && draft.trim() && Number.isFinite(Number(draft.replace(",", ".")))) onCommit(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(null);
        }}
        aria-label={`${axis} in ${unit}`}
      />
      <span className="sp-unit">{unit}</span>
    </span>
  );
}

function OrcaMissing({ go }: { go: (v: ViewId) => void }) {
  const mac = /Mac/i.test(navigator.userAgent);
  return (
    <div className="orca-missing">
      <AlertTriangle size={16} />
      <div>
        <div style={{ fontWeight: 600 }}>OrcaSlicer fehlt</div>
        <p className="hint">
          Der Slicer-Motor ist kostenlos: <span className="num">github.com/SoftFever/OrcaSlicer/releases</span>
          {mac ? " – die .dmg laden und OrcaSlicer in „Programme“ ziehen." : " – das AppImage laden und z. B. in ~/Applications ablegen."} Öffnen
          musst du ihn nie.
        </p>
        <button className="btn sm" onClick={() => go("settings")}>
          Pfad manuell eintragen
        </button>
      </div>
    </div>
  );
}
