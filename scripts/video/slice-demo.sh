#!/usr/bin/env bash
# Vorlauf für die Videos: Slicer-Szene durchspielen, Auftrag sichern, mit echtem OrcaSlicer slicen.
#   ORCA_BIN=/pfad/zu/orca-slicer scripts/video/slice-demo.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 scripts/video/make-models.py
DW_CAPTURE=1 node scripts/video/record.cjs de slicer-capture
ORCA_BIN="${ORCA_BIN:?ORCA_BIN setzen}" DW_JOB="$PWD/scripts/video/cache/job.json" \
  cargo test -q --manifest-path src-tauri/Cargo.toml real_orca_slice -- --nocapture 2>&1 | tee /tmp/dw-slice.log | grep ERGEBNIS
python3 - <<'PY'
import json, re, shutil
line = next(l for l in open("/tmp/dw-slice.log") if "ERGEBNIS" in l)
g = re.search(r'gcode_path: "([^"]+)"', line).group(1)
num = lambda k: float(re.search(k + r': Some\(([\d.]+)\)', line).group(1))
shutil.copy(g, "scripts/video/cache/demo.gcode")
res = {"gcodePath": "demo", "fileName": "Vase_gedreht_+2_Generic PLA_0.2mm.gcode", "timeS": num("time_s"),
       "filamentMm": num("filament_mm"), "filamentG": num("filament_g"), "layers": int(num("layers")), "warnings": []}
json.dump(res, open("scripts/video/cache/demo-result.json", "w"))
print("demo-result.json:", res)
PY
