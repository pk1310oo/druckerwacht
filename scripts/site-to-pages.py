#!/usr/bin/env python3
"""Macht aus der Website-Datei (ohne HTML-Gerüst) eine eigenständige Seite für GitHub Pages.

Aufruf: python3 scripts/site-to-pages.py <website.html> <bilder-ordner>
Schreibt docs/index.html und kopiert die Bilder nach docs/img/.
"""
import shutil
import sys
from pathlib import Path

# Besucherzähler (GoatCounter, ohne Cookies): Code von goatcounter.com eintragen, z. B. "druckerwacht".
# Leer = kein Zähler.
GOATCOUNTER = ""

src = Path(sys.argv[1]).read_text(encoding="utf-8")
img = Path(sys.argv[2])
i = src.index('<div class="aurora"')
head, body = src[:i], src[i:]
# Titel und Claude-spezifische Angaben ersetzen wir durch eigene
import re

head = re.sub(r"<title>.*?</title>\s*", "", head, flags=re.S)
head = re.sub(r'<meta name="claude:[^>]*>\s*', "", head)
url = "https://pk1310oo.github.io/druckerwacht/"
desc = ("Druckerwacht – kostenlose Open-Source-App für 3D-Drucker: Ender 3 V3 KE, K1, Klipper, OctoPrint und Prusa. "
        "Live-Überwachung, Slicer mit OrcaSlicer-Motor, Bett-Leveling und Kalibrieren, Handy im WLAN, Nachtmodus, "
        "Warteschlange und Filament-Lager. Für Windows, Mac und Linux.")
logo = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='100 100 824 824'%3E%3Crect x='100' "
        "y='100' width='824' height='824' rx='190' fill='%231A1A1A'/%3E%3Cpath d='M432 250h160v70l-40 60h-80l-40-60z' "
        "fill='%23F5F4EF'/%3E%3Crect x='300' y='520' width='424' height='56' rx='28' fill='%23D97757'/%3E%3Crect "
        "x='300' y='604' width='424' height='56' rx='28' fill='%23D97757' opacity='.75'/%3E%3Crect x='300' y='688' "
        "width='424' height='56' rx='28' fill='%23D97757' opacity='.5'/%3E%3C/svg%3E")
# Klicks auf Download- und Spendenknöpfe zählen (wirkt nur mit Zähler)
def tag_clicks(html: str) -> str:
    def tag(m):
        a = m.group(0)
        if "data-goatcounter-click" in a:
            return a
        href = m.group(1)
        if "ko-fi.com" in href:
            name = "kofi"
        elif "releases" in href:
            name = "download"
        else:
            return a
        return a[:-1] + f' data-goatcounter-click="{name}">'
    return re.sub(r'<a [^>]*href="([^"]+)"[^>]*>', tag, html)

body = tag_clicks(body)
counter = (
    f'<script data-goatcounter="https://{GOATCOUNTER}.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>'
    if GOATCOUNTER
    else ""
)
page = f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Druckerwacht – kostenlose App für den Ender 3 V3 KE (Windows, Mac &amp; Linux)</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<link rel="icon" href="{logo}">
<meta name="theme-color" content="#0c0c0c">
<meta property="og:type" content="website">
<meta property="og:title" content="Druckerwacht – dein Ender 3 V3 KE, in Ruhe im Blick">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{url}img/dashboard.jpg">
<meta name="twitter:card" content="summary_large_image">
{head.strip()}
</head>
<body>
{body.strip()}
{counter}
</body>
</html>
"""
out = Path("docs")
out.mkdir(exist_ok=True)
(out / "index.html").write_text(page, encoding="utf-8")
shutil.copytree(img, out / "img", dirs_exist_ok=True)
print("docs/index.html geschrieben")
