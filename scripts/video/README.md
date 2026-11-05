# Werbevideos erzeugen

Alle Videos entstehen automatisch aus der echten App (Browser-Vorschau mit simuliertem Drucker).
Bei einer neuen App-Version einfach neu erzeugen – Gestaltung und Texte bleiben gleich.

## Voraussetzungen
- `npm install`, Node 22+, ffmpeg, Playwright mit Chromium
- OrcaSlicer (nur für Schritt 1)

## Ablauf

```bash
npx vite --port 1420
```

1. Vorführmodelle erzeugen und echt slicen (einmalig bzw. wenn sich die Slicer-Szene ändert):

```bash
ORCA_BIN=/pfad/zu/orca-slicer scripts/video/slice-demo.sh
```

2. App-Szenen aufnehmen (Deutsch und Englisch):

```bash
node scripts/video/record.cjs de
```

```bash
node scripts/video/record.cjs en
```

3. Videos schneiden (Ergebnis in `scripts/video/out/final/`):

```bash
node scripts/video/render.cjs scripts/video/timelines/produkt.cjs de
```

```bash
node scripts/video/render.cjs scripts/video/timelines/tutorial.cjs de
```

```bash
DW_SHORT=1 node scripts/video/render.cjs scripts/video/timelines/shorts.cjs de
```

(`en` statt `de` für Englisch, `DW_SHORT=1…4` für die vier Kurzvideos.)
Standbilder zur Kontrolle: `… render.cjs <zeitleiste> de --still 2,10,30`.

## Dateien
- `demo-page.js` – simulierter Drucker, sichtbarer Mauszeiger (nur in der Browser-Vorschau)
- `record.cjs` – spielt die Szenen ab und nimmt sie auf (`out/raw/<sprache>/<szene>.webm`)
- `compose.html` – Schnittvorlage: Zooms, Texte, Intro, Outro, Installationsgrafiken
- `timelines/*.cjs` – Ablauf und Texte der einzelnen Videos
- `make-models.py` – eigene Vorführmodelle (Vase, Zahnrad, Pflanztopf)
