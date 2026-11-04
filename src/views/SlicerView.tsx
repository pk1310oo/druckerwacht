import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  Check,
  Copy,
  FlipHorizontal2,
  Plus,
  Printer,
  Ruler,
  Scaling,
  Scissors,
  SquareDashedMousePointer,
  Thermometer,
  Wand2,
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
  onUploadProgress,
  pickModels,
  printerSend,
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
import { buildConfig, CATALOG, effective, groupOf, type Group, type Overrides, type Preset } from "../slicer/settings";
import { isTauri } from "../lib/api";
import { fmtDuration, fmtNum } from "../lib/format";
import { EmptyState } from "../components/ui";
import { useStore } from "../lib/store";
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
  const connection = useStore((st) => st.connection);
  const status = useStore((st) => st.status);
  const printerName = useStore((st) => st.settings.printerName);
  const [models, setModels] = useState<ModelInfo[]>(() => plate.list());
  const [selected, setSelected] = useState<number | null>(() => plate.selectedId());
  const [selectedIds, setSelectedIds] = useState<number[]>(() => plate.selectedIds());
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
      setSelectedIds(plate.selectedIds());
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

  // Mitgesetzte Bett-Temperaturen anderer Platten-Typen zählen nicht als eigene Änderung
  const changedCount = Object.keys(overrides).filter((k) => !HIDDEN_ALIASES.has(k)).length;
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") plate.selectAll();
      else if (e.key === "Delete" || e.key === "Backspace") plate.remove();
      else if (e.key === "v") plate.setTool("select");
      else if (e.key === "m" || e.key === "g") plate.setTool("move");
      else if (e.key === "r") plate.setTool("rotate");
      else if (e.key === "f") plate.setTool("layflat");
      else if (e.key === "s") plate.setTool("scale");
      else if (e.key === "c") plate.setTool("cut");
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

  const busy = status?.state === "printing" || status?.state === "paused";
  const [printOpen, setPrintOpen] = useState(false);
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const measure = plate.getMeasure();
  const bedType = overrides.curr_bed_type ?? "Cool Plate";

  // --------------------------------------------------------------- Darstellung
  return (
    <div className="slicer">
      {/* Leiste oben: Drucker, Düse, Druckbett, Filament, Qualität */}
      <div className="slicer-top">
        <div className="top-field">
          <span className="label">Drucker</span>
          <span className="top-static">
            <Printer size={14} /> Ender 3 V3 KE
          </span>
        </div>
        <div className="top-field">
          <span className="label">Düse Ø</span>
          <span className="top-static num">0,4 mm</span>
        </div>
        <TempField
          label="Düse °C"
          value={active ? effective("nozzle_temperature", active, overrides) : ""}
          max={300}
          onCommit={(v) => onSetting("nozzle_temperature", v, ["nozzle_temperature_initial_layer"])}
        />
        <TempField
          label="Bett °C"
          value={active ? effective("cool_plate_temp", active, overrides) : ""}
          max={110}
          onCommit={(v) => onSetting("cool_plate_temp", v, BED_TEMP_KEYS)}
        />
        <div className="top-field">
          <span className="label">Druckbett</span>
          <select className="input sp-select" value={bedType} aria-label="Druckbett" onChange={(e) => onSetting("curr_bed_type", e.target.value === "Cool Plate" ? null : e.target.value)}>
            {BED_TYPES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
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
      </div>

      <div className="slicer-stage">
        <div className="slicer-canvas" ref={host}>
          {/* Werkzeugleiste über der Platte */}
          <div className="plate-tools card" role="toolbar" aria-label="Werkzeuge">
            <ToolBtn icon={Plus} label="Hinzufügen" onClick={() => void openDialog()} />
            <span className="tb-sep" />
            <ToolBtn icon={SquareDashedMousePointer} label="Auswählen – Rechteck ziehen (V)" on={tool === "select" && !preview} onClick={() => setTool("select")} />
            <ToolBtn icon={Wand2} label="Automatisch ausrichten" onClick={() => plate.autoOrient()} disabled={!selectedIds.length || !!preview} />
            <ToolBtn icon={LayoutGrid} label="Anordnen (A)" onClick={() => plate.arrange()} disabled={!models.length || !!preview} />
            <span className="tb-sep" />
            <ToolBtn icon={Move3d} label="Verschieben (M)" on={tool === "move" && !preview} onClick={() => setTool("move")} />
            <ToolBtn icon={RotateCw} label="Drehen (R)" on={tool === "rotate" && !preview} onClick={() => setTool("rotate")} />
            <ToolBtn icon={Scaling} label="Skalieren (S)" on={tool === "scale" && !preview} onClick={() => setTool("scale")} />
            <span className="tool-wrap">
              <ToolBtn icon={FlipHorizontal2} label="Spiegeln" on={mirrorOpen} onClick={() => setMirrorOpen((o) => !o)} disabled={!selectedIds.length || !!preview} />
              {mirrorOpen && selectedIds.length > 0 && (
                <span className="tool-menu card">
                  {(["X", "Y", "Z"] as const).map((a, i) => (
                    <button
                      key={a}
                      className="btn sm ghost"
                      onClick={() => {
                        plate.mirror(i as 0 | 1 | 2);
                        setMirrorOpen(false);
                      }}
                    >
                      <i className={`ax ax-${a.toLowerCase()}`}>{a}</i> spiegeln
                    </button>
                  ))}
                </span>
              )}
            </span>
            <ToolBtn icon={SquareDashedBottom} label="Auf Fläche legen (F)" on={tool === "layflat" && !preview} onClick={() => setTool("layflat")} />
            <ToolBtn icon={Scissors} label="Schneiden (C)" on={tool === "cut" && !preview} onClick={() => setTool("cut")} disabled={!sel} />
            <ToolBtn icon={Ruler} label="Messen" on={tool === "measure" && !preview} onClick={() => setTool("measure")} />
            <span className="tb-sep" />
            <ToolBtn icon={Copy} label="Duplizieren" onClick={() => plate.duplicate()} disabled={!selectedIds.length || !!preview} />
            <ToolBtn icon={Trash2} label="Löschen (Entf)" onClick={() => plate.remove()} disabled={!selectedIds.length || !!preview} />
          </div>

          <div className="view-tools card">
            {preview ? (
              <button className="btn sm ghost" onClick={closePreview}>
                <Box size={14} /> Modelle
              </button>
            ) : (
              phase.kind === "done" &&
              !phase.stale && (
                <button className="btn sm ghost" onClick={() => void openPreview(phase.result.gcodePath)}>
                  <Eye size={14} /> Vorschau
                </button>
              )
            )}
            <ToolBtn icon={Scan} label="Ansicht zurücksetzen" onClick={() => plate.resetView()} />
            <ToolBtn icon={Grid3x3} label="Draufsicht" onClick={() => plate.topView()} />
          </div>

          {!models.length && !loading && !preview && (
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

          {tool === "cut" && sel && !preview && <CutPanel plate={plate} onError={setLoadError} />}
          {tool === "measure" && !preview && (
            <div className="tool-panel card">
              <span className="label">Messen</span>
              {measure.distance == null ? (
                <span className="hint">
                  {measure.points.length === 0 ? "Ersten Punkt auf Modell oder Druckbett anklicken." : "Zweiten Punkt anklicken."}
                </span>
              ) : (
                <>
                  <span className="big num">
                    {fmtNum(measure.distance, 2)}
                    <span className="unit">mm</span>
                  </span>
                  <span className="small muted num">
                    ΔX {fmtNum(measure.delta![0], 2)} · ΔY {fmtNum(measure.delta![1], 2)} · ΔZ {fmtNum(measure.delta![2], 2)} mm
                  </span>
                  <span className="hint">Weiter klicken für eine neue Messung.</span>
                </>
              )}
            </div>
          )}
          {sel && !preview && tool !== "cut" && tool !== "measure" && <ObjectPanel m={sel} plate={plate} />}
          {selectedIds.length > 1 && !preview && tool !== "measure" && <GroupPanel count={selectedIds.length} plate={plate} />}
          {tool === "select" && !preview && selectedIds.length <= 1 && (
            <div className="hint-chip">Rechteck aufziehen, um mehrere Teile zu wählen · Ansicht drehen mit rechter Maustaste</div>
          )}

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
              <button className="btn" onClick={() => setPrintOpen(true)}>
                <Send size={16} /> Drucken
              </button>
            </div>
          )}
        </div>
      </aside>

      {printOpen && phase.kind === "done" && (
        <PrintDialog
          result={phase.result}
          printerName={printerName}
          host={connection.kind === "unconfigured" ? null : connection.host}
          connected={connection.kind === "connected"}
          busy={busy}
          onClose={() => setPrintOpen(false)}
          onStarted={() => {
            setPrintOpen(false);
            go("dashboard");
          }}
          go={go}
        />
      )}
    </div>
  );
}

const HIDDEN_ALIASES = new Set(
  ["hot_plate_temp", "textured_plate_temp", "eng_plate_temp", "supertack_plate_temp", "textured_cool_plate_temp"].flatMap((k) => [k, `${k}_initial_layer`]),
);

/** Alle Bett-Temperaturen (jeder Druckbett-Typ, erste und weitere Schichten) */
const BED_TEMP_KEYS = ["hot_plate_temp", "textured_plate_temp", "eng_plate_temp", "supertack_plate_temp", "textured_cool_plate_temp"]
  .flatMap((k) => [k, `${k}_initial_layer`])
  .concat(["cool_plate_temp_initial_layer"]);

/** Schnellfeld für eine Temperatur – gilt für alle Schichten und bleibt gespeichert. */
function TempField({ label, value, max, onCommit }: { label: string; value: string; max: number; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const n = Math.round(Number(draft.replace(",", ".")));
    if (Number.isFinite(n) && n >= 0 && n <= max) onCommit(String(n));
    setDraft(null);
  };
  return (
    <div className="top-field">
      <span className="label">{label}</span>
      <span className="sp-num temp-field">
        <Thermometer size={14} />
        <input
          className="input num"
          inputMode="numeric"
          aria-label={`${label.replace(" °C", "")}-Temperatur`}
          value={draft ?? value}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setDraft(null);
          }}
        />
        <span className="sp-unit">°C</span>
      </span>
    </div>
  );
}

const BED_TYPES = [
  { value: "Cool Plate", label: "Glatte PEI-Platte" },
  { value: "Textured PEI Plate", label: "Texturierte PEI-Platte" },
  { value: "High Temp Plate", label: "Hochtemperatur-Platte" },
  { value: "Engineering Plate", label: "Engineering-Platte" },
  { value: "Textured Cool Plate", label: "Texturierte Cool Plate" },
  { value: "Supertack Plate", label: "Supertack-Platte" },
];

/** Gemeinsame Bearbeitung mehrerer ausgewählter Teile */
function GroupPanel({ count, plate }: { count: number; plate: Plate }) {
  const size = plate.selectionSize();
  const [pct, setPct] = useState<string | null>(null);
  const apply = () => {
    if (pct == null) return;
    const v = Number(pct.replace(",", "."));
    if (Number.isFinite(v) && v > 0 && v !== 100) plate.scaleSelection(v / 100);
    setPct(null);
  };
  return (
    <div className="object-panel card">
      <div className="op-head">
        <span className="file-name">{count} Teile ausgewählt</span>
        {size && (
          <span className="small muted num">
            {fmtNum(size[0], 1)} × {fmtNum(size[1], 1)} × {fmtNum(size[2], 1)} mm
          </span>
        )}
      </div>
      <div className="group-row">
        <span className="label">Skalieren</span>
        <span className="sp-num">
          <input
            className="input num"
            aria-label="Auswahl skalieren in Prozent"
            value={pct ?? "100"}
            onChange={(e) => setPct(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="sp-unit">%</span>
        </span>
        <span className="group-quick">
          {[50, 75, 150, 200].map((v) => (
            <button key={v} className="btn sm ghost num" onClick={() => plate.scaleSelection(v / 100)}>
              {v} %
            </button>
          ))}
        </span>
      </div>
      <div className="group-row">
        <button className="btn sm" onClick={() => plate.arrange()}>
          <LayoutGrid size={14} /> Anordnen
        </button>
        <button className="btn sm" onClick={() => plate.duplicate()}>
          <Copy size={14} /> Duplizieren
        </button>
        <button className="btn sm" onClick={() => plate.remove()}>
          <Trash2 size={14} /> Löschen
        </button>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Am Griff ziehen bewegt, dreht oder skaliert alle gemeinsam. Shift/Strg-Klick nimmt Teile hinzu oder heraus.
      </p>
    </div>
  );
}

function CutPanel({ plate, onError }: { plate: Plate; onError: (m: string | null) => void }) {
  const height = plate.selectedHeight();
  const [h, setH] = useState(() => Math.round((height / 2) * 10) / 10);
  const [keep, setKeep] = useState<"both" | "upper" | "lower">("both");
  const [flip, setFlip] = useState(true);
  useEffect(() => plate.setCutHeight(h), [h, plate]);
  return (
    <div className="tool-panel card">
      <span className="label">Schneiden</span>
      <div className="cut-row">
        <input type="range" min={0.2} max={Math.max(0.2, height - 0.2)} step={0.1} value={h} onChange={(e) => setH(Number(e.target.value))} aria-label="Schnitthöhe" />
        <span className="sp-num">
          <input
            className="input num"
            value={String(h).replace(".", ",")}
            onChange={(e) => {
              const v = Number(e.target.value.replace(",", "."));
              if (Number.isFinite(v)) setH(Math.min(Math.max(v, 0.2), height - 0.2));
            }}
            aria-label="Schnitthöhe in mm"
          />
          <span className="sp-unit">mm</span>
        </span>
      </div>
      <div className="seg" role="radiogroup" aria-label="Behalten">
        {(
          [
            ["both", "Beide Teile"],
            ["upper", "Nur oben"],
            ["lower", "Nur unten"],
          ] as const
        ).map(([v, l]) => (
          <button key={v} role="radio" aria-checked={keep === v} className={keep === v ? "on" : ""} onClick={() => setKeep(v)}>
            {l}
          </button>
        ))}
      </div>
      <label className="op-uniform">
        <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} disabled={keep === "lower"} /> Oberes Teil umdrehen (Schnittfläche aufs Bett)
      </label>
      <button
        className="btn primary"
        onClick={() => {
          onError(plate.cut(keep, flip));
        }}
      >
        <Scissors size={16} /> Schneiden
      </button>
    </div>
  );
}

function PrintDialog(props: {
  result: SliceResult;
  printerName: string;
  host: string | null;
  connected: boolean;
  busy: boolean;
  onClose: () => void;
  onStarted: () => void;
  go: (v: ViewId) => void;
}) {
  const [plateFree, setPlateFree] = useState(false);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "uploading"; pct: number; start: boolean } | { kind: "done"; start: boolean; name: string } | { kind: "error"; msg: string }>({ kind: "idle" });

  useEffect(() => {
    let off: (() => void) | undefined;
    void onUploadProgress((pct) => setState((s) => (s.kind === "uploading" ? { ...s, pct } : s))).then((f) => (off = f));
    return () => off?.();
  }, []);

  useEffect(() => {
    if (state.kind === "done" && state.start) {
      const t = setTimeout(props.onStarted, 1200);
      return () => clearTimeout(t);
    }
  }, [state, props.onStarted]);

  const send = async (start: boolean) => {
    setState({ kind: "uploading", pct: 0, start });
    try {
      const name = await printerSend(props.result.gcodePath, start);
      setState({ kind: "done", start, name });
    } catch (e) {
      setState({ kind: "error", msg: typeof e === "string" ? e : "Senden fehlgeschlagen." });
    }
  };

  const working = state.kind === "uploading";
  const blocker = !props.host
    ? "Keine Drucker-IP eingetragen."
    : !props.connected
      ? "Der Drucker ist gerade nicht verbunden."
      : props.busy
        ? "Der Drucker druckt gerade. Bitte warten, bis der aktuelle Druck fertig ist."
        : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !working && props.onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="print-title">
        <div className="modal-head">
          <span id="print-title" style={{ fontWeight: 600 }}>
            An Drucker senden
          </span>
          <button className="sp-reset" aria-label="Schließen" onClick={props.onClose} disabled={working}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-facts">
          <div>
            <span className="label">Datei</span>
            <span className="file-name" title={props.result.fileName}>
              {props.result.fileName}
            </span>
          </div>
          <div>
            <span className="label">Drucker</span>
            <span>
              {props.printerName}
              {props.host && <span className="muted num"> · {props.host}</span>}
            </span>
          </div>
          <div>
            <span className="label">Druckzeit</span>
            <span className="num">{fmtDuration(props.result.timeS)}</span>
          </div>
          <div>
            <span className="label">Filament</span>
            <span className="num">{props.result.filamentG != null ? `${fmtNum(props.result.filamentG, 1)} g` : "–"}</span>
          </div>
        </div>

        {state.kind === "uploading" && (
          <div className="modal-progress">
            <div className="bar">
              <i style={{ width: `${state.pct}%` }} />
            </div>
            <span className="small muted num">
              {state.pct < 100 ? `Übertrage … ${state.pct} %` : state.start ? "Starte Druck …" : "Abschließen …"}
            </span>
          </div>
        )}
        {state.kind === "done" && (
          <div className="modal-ok">
            <Check size={16} /> {state.start ? "Druck gestartet – zum Dashboard …" : `Auf dem Drucker gespeichert als „${state.name}“.`}
          </div>
        )}
        {state.kind === "error" && (
          <div className="result error">
            <AlertTriangle size={16} />
            <span>{state.msg}</span>
          </div>
        )}
        {blocker && state.kind !== "done" && (
          <div className="result error" style={{ color: "var(--warning)", borderColor: "rgba(224,164,58,0.35)", background: "rgba(224,164,58,0.08)" }}>
            <AlertTriangle size={16} />
            <span>
              {blocker}{" "}
              {!props.host && (
                <button className="link" onClick={() => props.go("settings")}>
                  Zu den Einstellungen
                </button>
              )}
            </span>
          </div>
        )}

        {state.kind !== "done" && (
          <>
            <label className="op-uniform plate-check">
              <input type="checkbox" checked={plateFree} onChange={(e) => setPlateFree(e.target.checked)} disabled={working} />
              Die Druckplatte ist frei und sauber.
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={props.onClose} disabled={working}>
                Abbrechen
              </button>
              <button className="btn" onClick={() => void send(false)} disabled={working || !props.host || !props.connected}>
                <Upload size={16} /> Nur hochladen
              </button>
              <button className="btn primary" onClick={() => void send(true)} disabled={working || !!blocker || !plateFree}>
                <Send size={16} /> Hochladen & drucken
              </button>
            </div>
          </>
        )}
        {state.kind === "done" && !state.start && (
          <div className="modal-actions">
            <button className="btn primary" onClick={props.onClose}>
              Fertig
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolBtn({ icon: Icon, label, on, onClick, disabled }: { icon: typeof Move3d; label: string; on?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={`tool-btn ${on ? "on" : ""}`} onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={on}>
      <Icon size={18} strokeWidth={1.75} />
      <span className="tip">{label}</span>
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
