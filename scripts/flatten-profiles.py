#!/usr/bin/env python3
"""
Erzeugt aus den OrcaSlicer-Systemprofilen (resources/profiles/Creality) vollständig
aufgelöste Profile für den Ender 3 V3 KE (0.4-Düse) – ohne "inherits"-Ketten.
Diese liegen dann in src-tauri/resources/profiles und werden dem Orca-Motor übergeben.

    python3 scripts/flatten-profiles.py <pfad-zu-orcaslicer>/resources/profiles/Creality
"""
import json, os, sys

src = sys.argv[1]
dst = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "resources", "profiles")
MACHINE = "Creality Ender-3 V3 KE 0.4 nozzle"

index = {}
for kind in ("machine", "process", "filament"):
    for f in os.listdir(os.path.join(src, kind)):
        if f.endswith(".json"):
            with open(os.path.join(src, kind, f), encoding="utf-8") as fh:
                d = json.load(fh)
            index[(kind, d["name"])] = d

def resolve(kind, name, depth=0):
    d = index[(kind, name)]
    base = resolve(kind, d["inherits"], depth + 1) if d.get("inherits") else {}
    merged = {**base, **d}
    merged.pop("inherits", None)
    return merged

def compatible(d):
    cp = d.get("compatible_printers") or []
    return MACHINE in cp

out = {"machine": [], "process": [], "filament": []}
m = resolve("machine", MACHINE)
out["machine"].append(m)
for (kind, name), d in index.items():
    if kind == "machine" or d.get("instantiation") != "true":
        continue
    full = resolve(kind, name)
    if compatible(full):
        out[kind].append(full)

for kind, items in out.items():
    os.makedirs(os.path.join(dst, kind), exist_ok=True)
    for d in items:
        d["from"] = "system"
        with open(os.path.join(dst, kind, d["name"].replace("/", "_") + ".json"), "w", encoding="utf-8") as fh:
            json.dump(d, fh, indent=1, ensure_ascii=False)
    print(kind, len(items), *sorted(d["name"] for d in items), sep="\n  ")
