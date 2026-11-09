#!/usr/bin/env python3
"""Sammelt alle zu übersetzenden deutschen Texte der Oberfläche und prüft, ob src/i18n/en.ts
für jeden eine englische Übersetzung hat. Aufruf: python3 scripts/i18n-keys.py [--missing]"""
import json, os, re, sys

root = os.path.join(os.path.dirname(__file__), "..", "src")
keys = set()
STR = r'"((?:[^"\\]|\\.)*)"'
for dp, _, fs in os.walk(root):
    if "i18n" in dp or "dev" in dp:
        continue
    for f in fs:
        if not f.endswith((".ts", ".tsx")) or f == "i18n.ts":
            continue
        s = open(os.path.join(dp, f), encoding="utf-8").read()
        keys |= set(re.findall(r'\bt\(' + STR, s))
        # indirekt übersetzt (Komponenten rufen t() selbst auf)
        if f == "SlicerView.tsx":
            keys |= set(re.findall(r'<(?:ToolBtn|TempField|PresetSelect)\b[^>]*?\blabel=' + STR, s, re.S))
            keys |= set(re.findall(r'\{ value: [^,]+, label: ' + STR, s))
            keys |= set(re.findall(r'\["(?:support|seam|both|upper|lower)", ' + STR + r'\]', s))
        if f == "gcode.ts":
            keys |= set(re.findall(r'label: ' + STR, s))
        if f == "settings.ts":
            keys |= set(re.findall(r'(?:label|title): ' + STR, s))
        if f == "SettingsView.tsx":
            m = re.search(r'THEME_NAMES[^=]*= \{([^}]*)\}', s)
            if m:
                keys |= set(re.findall(r':\s*' + STR, m.group(1)))
        if f == "Shell.tsx":
            keys |= set(re.findall(r'label: ' + STR, s))
keys = {json.loads('"' + k + '"') for k in keys}

en_src = open(os.path.join(root, "i18n", "en.ts"), encoding="utf-8").read()
have = {json.loads('"' + m + '"') for m in re.findall(r'^\s*' + STR + r'\s*:', en_src, re.M)}
missing = sorted(keys - have)
unused = sorted(have - keys)
if "--missing" in sys.argv:
    print(json.dumps(missing, ensure_ascii=False, indent=1))
else:
    print(f"{len(keys)} Texte, {len(missing)} ohne Übersetzung, {len(unused)} unbenutzt")
    for u in unused:
        print("  unbenutzt:", u)
# Weitere Sprachen: gleiche Schlüssel wie Englisch (fehlende zeigen Englisch)
other_missing = 0
for lang in ("es", "fr", "pl"):
    src = open(os.path.join(root, "i18n", f"{lang}.ts"), encoding="utf-8").read()
    got = {json.loads('"' + m + '"') for m in re.findall(r'^\s*' + STR + r'\s*:', src, re.M)}
    miss = sorted(keys - got)
    other_missing += len(miss)
    if miss:
        print(f"  {lang}: {len(miss)} ohne Übersetzung (zeigt Englisch), z. B. {miss[0]!r}")
sys.exit(1 if missing else 0)
