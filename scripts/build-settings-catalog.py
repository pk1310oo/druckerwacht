#!/usr/bin/env python3
"""
Baut src/slicer/catalog.json: alle OrcaSlicer-Einstellungen mit Gruppe (process/filament/machine),
Typ, Einheit, Grenzwerten, Auswahlwerten und deutscher Bezeichnung/Erklärung
(aus Orcas eigener Übersetzung). Aufruf:

    python3 scripts/build-settings-catalog.py <orcaslicer-quellordner> <full-settings.json>
"""
import json, os, re, sys

root, full_path = sys.argv[1], sys.argv[2]
cfg = open(os.path.join(root, "src/libslic3r/PrintConfig.cpp"), encoding="utf-8").read()
preset = open(os.path.join(root, "src/libslic3r/Preset.cpp"), encoding="utf-8").read()
po = open(os.path.join(root, "localization/i18n/de/OrcaSlicer_de.po"), encoding="utf-8").read()
full = json.load(open(full_path))

# --- deutsche Übersetzung
def _one(p):
    try:
        return json.loads('"' + p + '"')
    except Exception:
        return p.replace('\\"', '"').replace("\\n", "\n")
def unq(parts):
    return "".join(_one(p) for p in parts)
tr = {}
for m in re.finditer(r'(?:msgctxt "[^"]*"\n)?msgid ((?:"(?:[^"\\]|\\.)*"\n?)+)msgstr ((?:"(?:[^"\\]|\\.)*"\n?)+)', po):
    try:
        k = unq(re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1)))
        v = unq(re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(2)))
    except Exception:
        continue
    if k and v:
        tr[k] = v

# --- Zuordnung zu Preset-Gruppen
def option_list(var):
    m = re.search(var + r'\s*(?:=|\{)(.*?)\};', preset, re.S)
    return set(re.findall(r'"([a-z0-9_]+)"', m.group(1))) if m else set()
groups = {
    "process": option_list(r"s_Preset_print_options"),
    "filament": option_list(r"s_Preset_filament_options"),
    "machine": option_list(r"s_Preset_machine_limits_options") | option_list(r"s_Preset_printer_options"),
}

# --- Definitionen aus PrintConfig.cpp
blocks = re.split(r'\n[^\n]*?\bdef\s*=\s*this->add(?:_nullable)?\(', cfg)
defs = {}
for b in blocks[1:]:
    m = re.match(r'\s*"([a-z0-9_]+)"\s*,\s*(co\w+)\)', b)
    if not m:
        continue
    key, typ = m.group(1), m.group(2)
    body = b
    def grab(field):
        mm = re.search(r'def->' + field + r'\s*=\s*L?\(?\s*((?:"(?:[^"\\]|\\.)*"\s*)+)', body)
        return unq(re.findall(r'"((?:[^"\\]|\\.)*)"', mm.group(1))) if mm else None
    def num(field):
        mm = re.search(r'def->' + field + r'\s*=\s*(-?[\d.]+)', body)
        return float(mm.group(1)) if mm else None
    enum_vals = re.findall(r'enum_values\.(?:push_back|emplace_back)\("([^"]*)"\)', body)
    enum_labels = re.findall(r'enum_labels\.(?:push_back|emplace_back)\((?:L\()?"([^"]*)"\)?\)', body)
    if typ != "coEnum" and typ != "coEnums":
        enum_vals, enum_labels = [], []
    elif not enum_vals:
        mm = re.search(r'set_enum<\w+>\(\s*\{(.*?)\}\s*(?:,\s*\{(.*?)\})?\s*\)', body, re.S)
        if mm and mm.group(1).strip():
            enum_vals = re.findall(r'"([^"]*)"', mm.group(1))
            enum_labels = re.findall(r'"([^"]*)"', mm.group(2) or "")
        else:
            mm = re.search(r'set_enum<(\w+)>\(', body)
            if mm:
                em = re.search(r's_keys_map_' + mm.group(1) + r'\s*\{(.*?)\};', cfg, re.S)
                if em:
                    enum_vals = re.findall(r'\{\s*"([^"]+)"', em.group(1))
    label, cat, tip, side = grab("label"), grab("category"), grab("tooltip"), grab("sidetext")
    defs[key] = {
        "type": typ,
        "label": tr.get(label, label) if label else key,
        "labelEn": label,
        "category": tr.get(cat, cat) if cat else None,
        "tooltip": tr.get(tip, tip) if tip else None,
        "unit": tr.get(side, side) if side else None,
        "min": num("min"),
        "max": num("max"),
        "enum": [{"value": v, "label": tr.get(l, l) if l else v} for v, l in zip(enum_vals, enum_labels + [None] * len(enum_vals))] or None,
    }

catalog = {}
for key, default in full.items():
    g = next((g for g, ks in groups.items() if key in ks), None)
    if g is None or key not in defs:
        continue
    d = defs[key]
    catalog[key] = {"group": g, "default": default, **{k: v for k, v in d.items() if v is not None}}

# Orca übernimmt hier die Werte der Oberflächenmuster zur Laufzeit
for k in ("bottom_surface_pattern", "internal_solid_infill_pattern"):
    if k in catalog and not catalog[k].get("enum") and catalog.get("top_surface_pattern", {}).get("enum"):
        catalog[k]["enum"] = catalog["top_surface_pattern"]["enum"]

out = os.path.join(os.path.dirname(__file__), "..", "src", "slicer", "catalog.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump(catalog, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
from collections import Counter
print(len(catalog), Counter(v["group"] for v in catalog.values()))
for k in ["sparse_infill_pattern", "support_type", "brim_type", "seam_position", "sparse_infill_density", "nozzle_temperature"]:
    print(k, json.dumps(catalog.get(k), ensure_ascii=False)[:400])
