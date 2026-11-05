import catalogJson from "./catalog.json";
import { isEn, t } from "../lib/i18n";

/** Ein Eintrag aus dem Orca-Einstellungskatalog (siehe scripts/build-settings-catalog.py) */
export interface CatalogEntry {
  group: "process" | "filament" | "machine";
  default: unknown;
  type: string;
  label: string;
  labelEn?: string;
  category?: string;
  categoryEn?: string;
  tooltip?: string;
  tooltipEn?: string;
  unit?: string;
  unitEn?: string;
  min?: number;
  max?: number;
  enum?: { value: string; label: string; labelEn?: string }[];
}

export const CATALOG = catalogJson as Record<string, CatalogEntry>;

export type Group = CatalogEntry["group"];
export type Preset = Record<string, unknown> & { name: string };
export type Overrides = Record<string, string>;

export interface FieldDef {
  key: string;
  /** Eigene, im Zusammenhang klarere Bezeichnung (sonst Orcas deutsche Übersetzung) */
  label?: string;
  hint?: string;
  /** Diese Schlüssel werden beim Ändern mitgesetzt (z. B. alle Druckbett-Typen) */
  alsoSet?: string[];
}

export interface SectionDef {
  title: string;
  fields: FieldDef[];
}

export interface TabDef {
  id: string;
  label: string;
  sections: SectionDef[];
}

const BED = ["hot_plate_temp", "textured_plate_temp", "eng_plate_temp", "supertack_plate_temp", "textured_cool_plate_temp"];
const BED_FIRST = BED.map((k) => `${k}_initial_layer`);

/** Kuratierte Ansicht – gegliedert wie in Creality Print. „Alle“ zeigt zusätzlich jede Einstellung. */
export const TABS: TabDef[] = [
  {
    id: "quality",
    label: "Qualität",
    sections: [
      {
        title: "Schichthöhe",
        fields: [{ key: "layer_height", label: "Schichthöhe" }, { key: "initial_layer_print_height", label: "Erste Schicht" }],
      },
      {
        title: "Linienbreite",
        fields: [
          { key: "line_width", label: "Standard" },
          { key: "initial_layer_line_width", label: "Erste Schicht" },
          { key: "outer_wall_line_width", label: "Außenwand" },
          { key: "sparse_infill_line_width", label: "Füllung" },
        ],
      },
      {
        title: "Naht",
        fields: [{ key: "seam_position", label: "Nahtposition" }, { key: "seam_slope_type", label: "Schräge Naht (Scarf)" }],
      },
      {
        title: "Wände",
        fields: [
          { key: "wall_generator", label: "Wandgenerator" },
          { key: "wall_sequence", label: "Wandreihenfolge" },
          { key: "detect_thin_wall", label: "Dünne Wände erkennen" },
          { key: "only_one_wall_top", label: "Nur eine Wand oben" },
          { key: "detect_overhang_wall", label: "Überhangwände erkennen" },
        ],
      },
      {
        title: "Bügeln",
        fields: [
          { key: "ironing_type", label: "Bügeln" },
          { key: "ironing_flow", label: "Fluss" },
          { key: "ironing_spacing", label: "Linienabstand" },
          { key: "ironing_speed", label: "Geschwindigkeit" },
        ],
      },
    ],
  },
  {
    id: "strength",
    label: "Festigkeit",
    sections: [
      { title: "Wände", fields: [{ key: "wall_loops", label: "Anzahl Wände" }, { key: "alternate_extra_wall", label: "Abwechselnd zusätzliche Wand" }] },
      {
        title: "Oben",
        fields: [
          { key: "top_shell_layers", label: "Schichten oben" },
          { key: "top_shell_thickness", label: "Mindestdicke oben" },
          { key: "top_surface_pattern", label: "Muster oben" },
        ],
      },
      {
        title: "Unten",
        fields: [
          { key: "bottom_shell_layers", label: "Schichten unten" },
          { key: "bottom_shell_thickness", label: "Mindestdicke unten" },
          { key: "bottom_surface_pattern", label: "Muster unten" },
        ],
      },
      {
        title: "Füllung (Infill)",
        fields: [
          { key: "sparse_infill_density", label: "Fülldichte" },
          { key: "sparse_infill_pattern", label: "Füllmuster" },
          { key: "infill_direction", label: "Füllwinkel" },
          { key: "internal_solid_infill_pattern", label: "Muster massive Füllung" },
          { key: "infill_wall_overlap", label: "Überlappung mit Wänden" },
          { key: "infill_combination", label: "Füllung kombinieren" },
          { key: "minimum_sparse_infill_area", label: "Mindestfläche Füllung" },
        ],
      },
    ],
  },
  {
    id: "speed",
    label: "Geschwindigkeit",
    sections: [
      {
        title: "Erste Schicht",
        fields: [{ key: "initial_layer_speed", label: "Wände" }, { key: "initial_layer_infill_speed", label: "Füllung" }],
      },
      {
        title: "Weitere Schichten",
        fields: [
          { key: "outer_wall_speed", label: "Außenwand" },
          { key: "inner_wall_speed", label: "Innenwand" },
          { key: "sparse_infill_speed", label: "Füllung" },
          { key: "internal_solid_infill_speed", label: "Massive Füllung" },
          { key: "top_surface_speed", label: "Oberfläche" },
          { key: "gap_infill_speed", label: "Lückenfüllung" },
          { key: "bridge_speed", label: "Brücken" },
          { key: "support_speed", label: "Stützen" },
          { key: "enable_overhang_speed", label: "Langsamer bei Überhängen" },
        ],
      },
      { title: "Bewegung", fields: [{ key: "travel_speed", label: "Leerfahrt" }] },
      {
        title: "Beschleunigung",
        fields: [
          { key: "default_acceleration", label: "Standard" },
          { key: "outer_wall_acceleration", label: "Außenwand" },
          { key: "inner_wall_acceleration", label: "Innenwand" },
          { key: "initial_layer_acceleration", label: "Erste Schicht" },
          { key: "travel_acceleration", label: "Leerfahrt" },
        ],
      },
    ],
  },
  {
    id: "support",
    label: "Stützen",
    sections: [
      {
        title: "Stützen",
        fields: [
          { key: "enable_support", label: "Stützen aktivieren" },
          { key: "support_type", label: "Typ" },
          { key: "support_style", label: "Stil" },
          { key: "support_threshold_angle", label: "Überhangwinkel" },
          { key: "support_on_build_plate_only", label: "Nur auf dem Druckbett" },
        ],
      },
      {
        title: "Abstände",
        fields: [
          { key: "support_top_z_distance", label: "Abstand oben (Z)" },
          { key: "support_bottom_z_distance", label: "Abstand unten (Z)" },
          { key: "support_object_xy_distance", label: "Abstand zum Modell (XY)" },
        ],
      },
      {
        title: "Aufbau",
        fields: [
          { key: "support_interface_top_layers", label: "Kontaktschichten oben" },
          { key: "support_interface_bottom_layers", label: "Kontaktschichten unten" },
          { key: "support_base_pattern", label: "Muster" },
          { key: "support_base_pattern_spacing", label: "Linienabstand" },
          { key: "tree_support_branch_angle", label: "Baum: Astwinkel" },
          { key: "tree_support_branch_diameter", label: "Baum: Astdurchmesser" },
        ],
      },
    ],
  },
  {
    id: "adhesion",
    label: "Haftung",
    sections: [
      {
        title: "Skirt",
        fields: [
          { key: "skirt_loops", label: "Anzahl Linien" },
          { key: "skirt_distance", label: "Abstand" },
          { key: "skirt_height", label: "Höhe (Schichten)" },
        ],
      },
      {
        title: "Brim",
        fields: [
          { key: "brim_type", label: "Brim-Typ" },
          { key: "brim_width", label: "Breite" },
          { key: "brim_object_gap", label: "Abstand zum Modell" },
        ],
      },
      { title: "Raft", fields: [{ key: "raft_layers", label: "Raft-Schichten" }] },
      { title: "Erste Schicht", fields: [{ key: "elefant_foot_compensation", label: "Elefantenfuß-Ausgleich" }] },
    ],
  },
  {
    id: "filament",
    label: "Filament",
    sections: [
      {
        title: "Temperatur",
        fields: [
          { key: "nozzle_temperature_initial_layer", label: "Düse – erste Schicht" },
          { key: "nozzle_temperature", label: "Düse – weitere Schichten" },
          { key: "cool_plate_temp_initial_layer", label: "Bett – erste Schicht", alsoSet: BED_FIRST },
          { key: "cool_plate_temp", label: "Bett – weitere Schichten", alsoSet: BED },
        ],
      },
      {
        title: "Kühlung",
        fields: [
          { key: "close_fan_the_first_x_layers", label: "Lüfter aus für erste Schichten" },
          { key: "fan_min_speed", label: "Lüfter minimal" },
          { key: "fan_max_speed", label: "Lüfter maximal" },
          { key: "overhang_fan_speed", label: "Lüfter bei Überhängen" },
          { key: "slow_down_layer_time", label: "Mindest-Schichtzeit" },
        ],
      },
      {
        title: "Fluss",
        fields: [
          { key: "filament_flow_ratio", label: "Flussrate" },
          { key: "filament_max_volumetric_speed", label: "Max. Volumenstrom" },
          { key: "enable_pressure_advance", label: "Pressure Advance aktivieren" },
          { key: "pressure_advance", label: "Pressure Advance" },
        ],
      },
      {
        title: "Rückzug",
        fields: [
          { key: "retraction_length", label: "Länge" },
          { key: "retraction_speed", label: "Geschwindigkeit" },
          { key: "z_hop", label: "Z-Hop" },
        ],
      },
    ],
  },
  {
    id: "other",
    label: "Sonstiges",
    sections: [
      {
        title: "Spezialmodi",
        fields: [
          { key: "spiral_mode", label: "Spiralvase" },
          { key: "print_sequence", label: "Druckreihenfolge" },
        ],
      },
      {
        title: "Fuzzy Skin",
        fields: [
          { key: "fuzzy_skin", label: "Fuzzy Skin" },
          { key: "fuzzy_skin_thickness", label: "Stärke" },
          { key: "fuzzy_skin_point_distance", label: "Punktabstand" },
        ],
      },
      {
        title: "Maßhaltigkeit",
        fields: [
          { key: "xy_hole_compensation", label: "Löcher (XY)" },
          { key: "xy_contour_compensation", label: "Außenkontur (XY)" },
        ],
      },
      { title: "Bewegung", fields: [{ key: "reduce_infill_retraction", label: "Weniger Rückzug in der Füllung" }] },
    ],
  },
];

export const ALL_TAB = { id: "all", label: "Alle" };

// Bezeichnungen der kuratierten Ansicht werden beim Anzeigen mit t() übersetzt.

/** Felder, die es wirklich gibt (falls Orca eine Einstellung umbenennt, fällt sie still weg). */
for (const tab of TABS) for (const s of tab.sections) s.fields = s.fields.filter((f) => f.key in CATALOG);

export function groupOf(key: string): Group {
  return CATALOG[key]?.group ?? "process";
}

/** Rohwert aus Profil bzw. Katalog-Standard (Orca speichert alles als String oder String-Array). */
export function baseValue(key: string, presets: Record<Group, Preset>): unknown {
  const g = groupOf(key);
  const p = presets[g];
  return p && key in p ? p[key] : CATALOG[key]?.default;
}

export function isArrayValue(key: string, presets: Record<Group, Preset>) {
  return Array.isArray(baseValue(key, presets));
}

/** Für die Anzeige: immer ein einzelner String (bei Listen der erste Eintrag). */
export function scalar(v: unknown): string {
  if (Array.isArray(v)) return v.length ? String(v[0]) : "";
  if (v == null) return "";
  return String(v);
}

export function effective(key: string, presets: Record<Group, Preset>, overrides: Overrides): string {
  return key in overrides ? overrides[key] : scalar(baseValue(key, presets));
}

/** Baut ein vollständiges Profil für Orca: Basis + Änderungen, Listen bleiben Listen. */
export function buildConfig(group: Group, base: Preset, presets: Record<Group, Preset>, overrides: Overrides): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (groupOf(k) !== group) continue;
    const orig = baseValue(k, presets);
    if (Array.isArray(orig)) {
      out[k] = orig.length > 1 ? orig.map(() => v) : [v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

export type Kind = "number" | "percent" | "floatOrPercent" | "bool" | "enum" | "text";

export function kindOf(key: string): Kind {
  const e = CATALOG[key];
  if (!e) return "text";
  const t = e.type.replace(/s$/, "");
  if (e.enum?.length && (t === "coEnum" || t === "coString")) return "enum";
  if (t === "coBool") return "bool";
  if (t === "coPercent") return "percent";
  if (t === "coFloatOrPercent") return "floatOrPercent";
  if (t === "coFloat" || t === "coInt") return "number";
  return "text";
}

export function labelOf(key: string, field?: FieldDef) {
  if (field?.label) return t(field.label);
  const e = CATALOG[key];
  if (!e) return key;
  return isEn() ? e.labelEn ?? e.label : e.label;
}

export function tooltipOf(key: string): string | undefined {
  const e = CATALOG[key];
  return isEn() ? e?.tooltipEn ?? e?.tooltip : e?.tooltip;
}

export function categoryOf(e: CatalogEntry): string | undefined {
  return isEn() ? e.categoryEn ?? e.category : e.category;
}

/** Auswahlwerte mit Bezeichnung in der aktiven Sprache */
export function enumOptions(key: string): { value: string; label: string }[] {
  return (CATALOG[key]?.enum ?? []).map((o) => ({ value: o.value, label: isEn() ? o.labelEn ?? o.label : o.label }));
}

/** Einheiten kurz und einheitlich */
export function unitOf(key: string): string | undefined {
  const e = CATALOG[key];
  const u = isEn() ? e?.unitEn ?? e?.unit : e?.unit;
  if (!u) return undefined;
  return u.replace("mm/s²", "mm/s²").replace(/^°C$/, "°C");
}
