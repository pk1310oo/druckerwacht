# Druckerwacht

Live-Überwachung für den **Creality Ender 3 V3 KE** per WLAN. Läuft als Desktop-App für macOS (Apple Silicon) und Linux (x86_64).
Gebaut mit Tauri 2, React und TypeScript, das Backend ist in Rust geschrieben.

- **Dashboard:** Düse und Bett (Ist/Soll), Geschwindigkeit, Flow, Lüfter, Status, Datei, Fortschritt, Schicht, Zeiten und voraussichtliches Ende
- **Live-Diagramme:** Temperatur sowie Geschwindigkeit, Flow und Lüfter, wahlweise über 5, 15 oder 60 Minuten
- **Kamera (optional):** MJPEG-Stream, z. B. Nebula-Kamera oder USB-Webcam
- **Benachrichtigungen:** Druck fertig, Fehler, Verbindung verloren
- **Druckverlauf:** Jeder mitverfolgte Druck mit Dauer und Ergebnis
- **Verbindung:** Automatische Suche im Netz, automatischer Reconnect und Verbindungsstatus jederzeit sichtbar

> **Nur lesend.** Pause, Fortsetzen, Abbrechen und Heizen sind bewusst noch nicht eingebaut.
> Sie kommen erst dazu, wenn am echten Drucker bestätigt ist, wie die Schnittstelle sie annimmt (siehe unten).

---

## 1. Erster Schritt am echten Drucker: Mitschnitt (wichtig)

Die Schnittstelle (`ws://<IP>:9999`, dieselbe wie bei Creality Print) ist **nicht dokumentiert**.
Der Parser kennt die Feldnamen, die von der K1/KE-Familie öffentlich bekannt sind. Gegen **deinen** Drucker muss er aber noch geprüft werden.

Voraussetzung ist Node.js ab Version 22. Pakete werden nicht benötigt.

```bash
node scripts/probe.mjs --scan                 # Drucker im Netz finden
node scripts/probe.mjs 192.168.178.42 600     # 10 Minuten mitschneiden, am besten WÄHREND eines Drucks
```

Das Skript speichert alle Nachrichten in `probe-<ip>-<zeit>.jsonl` und listet am Ende jedes gefundene Feld mit Beispielwerten auf.
Es sendet nur zwei Dinge: eine Leseanfrage (`reqPrinterPara`) und die Antwort `ok` auf Heartbeats. Wer gar nichts senden will, hängt `--passive` an.

**Stand des Abgleichs** (Ender 3 V3 KE, Modell `F005`, Firmware V1.1.0.17, Mitschnitt im Leerlauf, siehe `src-tauri/fixtures/ke-idle.jsonl`):

| Anzeige | Schlüssel | Status |
|---|---|---|
| Düse Ist/Soll | `nozzleTemp`, `targetNozzleTemp` | ✅ bestätigt |
| Bett Ist/Soll | `bedTemp0`, `targetBedTemp0` | ✅ bestätigt |
| Max. Temperaturen | `maxNozzleTemp` (300), `maxBedTemp` (100) | ✅ bestätigt |
| Datei / Fortschritt | `printFileName`, `printProgress` | ✅ vorhanden, Werte beim Druck noch offen |
| Schicht | `layer`, `TotalLayer` | ✅ vorhanden |
| Zeiten (s) | `printJobTime`, `printLeftTime` | ✅ vorhanden |
| Geschwindigkeit | `realTimeSpeed` (mm/s), `curFeedratePct` (%) | ✅ vorhanden |
| Flow | `curFlowratePct` | ✅ bestätigt |
| Lüfter | `modelFanPct`, `auxiliaryFanPct`, `caseFanPct` | ✅ vorhanden |
| Fehler | `err.errcode`, `err.key` | ✅ vorhanden |
| Status | `state` | ✅ 1 = druckt, 2 = fertig (gemessen) · Leerlauf meldet 4 · Pause/Fehler noch nicht gemessen |
| Vorbereitung | `withSelfTest` 5 → 100, `printJobTime` = 0 | ✅ gemessen: Heizen + Leveling (~6 min) vor der ersten Schicht |
| Filament | `usedMaterialLength` (mm) | ✅ gemessen |

Der Drucker schickt nach dem Verbinden einmal den vollständigen Zustand und danach etwa alle 5 Sekunden nur geänderte Werte.
Heartbeats kamen in 10 Minuten keine.

Ein vollständiger Druck (`fixtures/ke-print.jsonl`) ist als Test hinterlegt.
**Noch offen:** die Codes für „pausiert“, „abgebrochen“ und „Fehler“. Zum Prüfen in der App *Einstellungen → Diagnose → Rohdaten mitschneiden* aktivieren.

Fehlende oder unbekannte Felder führen nie zu einem Absturz. Die App zeigt dann einfach „–“.
Besonders wichtig ist die Zuordnung der `state`-Codes, denn davon hängen die Meldungen „Druck fertig“ und „Fehler“ ab.

Während die App läuft, gibt es einen zweiten Weg: **Einstellungen → Diagnose → Rohdaten mitschneiden**. Der Speicherort steht direkt darunter.

---

## 2. Entwicklungsumgebung

### Gemeinsam (macOS und Linux)

- [Rust](https://rustup.rs) (stable): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node.js ab Version 22 und npm

### macOS (Apple Silicon)

```bash
xcode-select --install
```

### Linux Mint 22 / Ubuntu 24.04 (x86_64)

```bash
sudo apt update
sudo apt install -y build-essential curl wget file libssl-dev libxdo-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

### Starten im Entwicklungsmodus

```bash
npm install
npm run tauri dev
```

Tests für Parser und Verbindungsschicht:

```bash
cd src-tauri && cargo test
```

---

## 3. Installationspakete bauen

Jedes Paket wird auf seinem eigenen System gebaut. Die `.dmg` entsteht also auf dem Mac, `.deb` und AppImage entstehen unter Linux.

### macOS → `.dmg`

```bash
npm install
npm run tauri build -- --bundles dmg
```

Ergebnis: `src-tauri/target/release/bundle/dmg/Druckerwacht_0.1.2_aarch64.dmg`

Die App ist nicht signiert. Beim ersten Start deshalb im Finder per **Rechtsklick → Öffnen** starten,
oder das Quarantäne-Flag entfernen:

```bash
xattr -dr com.apple.quarantine /Applications/Druckerwacht.app
```

### Linux → `.deb` und AppImage

```bash
npm install
npm run tauri build -- --bundles deb appimage
```

Ergebnisse:

- `src-tauri/target/release/bundle/deb/Druckerwacht_0.1.2_amd64.deb`
- `src-tauri/target/release/bundle/appimage/Druckerwacht_0.1.2_amd64.AppImage`

Installation:

```bash
sudo apt install ./Druckerwacht_0.1.2_amd64.deb
```

Die AppImage-Datei kann man stattdessen auch direkt ausführen:

```bash
chmod +x Druckerwacht_0.1.2_amd64.AppImage && ./Druckerwacht_0.1.2_amd64.AppImage
```

> Für den AppImage-Build lädt Tauri beim ersten Mal `linuxdeploy` von GitHub herunter. Dafür ist eine Internetverbindung nötig.

---

## 4. Bedienung

1. **Einstellungen → IP-Adresse** eintragen, oder auf **Im Netz suchen** klicken. Die IP steht am Druckerdisplay unter Einstellungen → Netzwerk.
2. **Speichern.** Danach verbindet sich die App sofort. Der Punkt in der Kopfzeile wird grün.
3. Optional die Kamera-URL eintragen, z. B. `http://<ip>:8080/?action=stream`. Ohne URL bleibt die Kamera ausgeblendet.

Die Einstellungen werden lokal gespeichert:

- macOS: `~/Library/Application Support/de.druckerwacht.app/settings.json`
- Linux: `~/.config/de.druckerwacht.app/settings.json`

Der Druckverlauf liegt als `jobs.json` im Datenordner der App.

Das Vorschaubild des aktuellen Drucks lädt die App von `http://<ip>/downloads/original/current_print_image.png` (K1/KE-Firmware).
Gibt es das Bild nicht, erscheint ein neutraler Platzhalter.

---

## 5. Aufbau

```
src-tauri/src/
  adapter/mod.rs       Trait PrinterAdapter + ConnectionState (austauschbare Verbindungsschicht)
  adapter/creality.rs  WebSocket :9999, Heartbeat, Watchdog, Reconnect mit Backoff (1…15 s)
  model.rs             Toleranter Parser → normalisierter PrinterStatus
  discovery.rs         Netzwerksuche (eigene /24-Netze, Port 9999 + WebSocket-Check)
  settings.rs          Einstellungen (JSON, atomar gespeichert)
  lib.rs               Zustand, 1-Hz-Messreihe (60 min), Verlauf, Benachrichtigungen, Tauri-Befehle
src/
  lib/                 Store, Tauri-Anbindung, Formatierung, weiche Zahlenanimation
  components/          Shell, Karten, Diagramme (uPlot), Kamera
  views/               Dashboard, Kamera, Verlauf, Einstellungen
  dev/preview.ts       Nur Browser-Entwicklung: Layoutvorschau (?preview=printing), nicht im Build
scripts/probe.mjs      Mitschnitt der echten Schnittstelle
```

**Moonraker nachrüsten** (Port 7125, z. B. nach dem Rooten): Dafür in `adapter/` eine neue Datei `moonraker.rs` anlegen, die `PrinterAdapter` implementiert und `PrinterStatus` liefert.
Anschließend in `lib.rs` (`restart_connection`) den passenden Adapter wählen. Am Frontend muss dafür nichts geändert werden.

**Designvorschau ohne Drucker:** `npm run dev` starten und dann `http://localhost:1420/?preview=printing` öffnen.
Weitere Werte für `preview`: `idle`, `connecting`, `reconnecting` und `history`. Mit `&cam=1` wird zusätzlich die Kamerakachel eingeblendet.
Die Werte sind erfunden und dienen nur zur Layoutkontrolle. In der App selbst gibt es sie nicht.
