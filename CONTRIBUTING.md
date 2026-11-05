# Contributing to Druckerwacht

🇬🇧 English · 🇩🇪 [Deutsch](#mitmachen-bei-druckerwacht)

Thanks for helping! The easiest ways:

## Report a bug or request a feature
Open an [issue](https://github.com/pk1310oo/druckerwacht/issues) and include:
- Operating system and app version (Settings → About)
- Printer model and firmware version
- What you expected and what happened – screenshots help

## Add support for another printer
New printers need a recording of their interface: `node scripts/probe.mjs <printer-ip> 600` (ideally during a print).
Attach the resulting file to an issue (check it for private data such as Wi-Fi names first).

## Translations
All interface texts go through `t("German text")`; the English version lives in `src/i18n/en.ts`.
`python3 scripts/i18n-keys.py` lists missing translations. New languages are welcome – open an issue first.

## Contribute code
1. Fork the repository and create a branch.
2. Set up the development environment (README, section 5).
3. Before opening a pull request:
   ```bash
   npm run build
   ```
   ```bash
   cargo test --manifest-path src-tauri/Cargo.toml
   ```
   ```bash
   python3 scripts/i18n-keys.py
   ```
4. Open a pull request with a short description of what and why.

Design: please stick to the “Black & Orange” theme (tokens in `src/styles.css`).

## License
By contributing you agree that your contribution is published under the AGPL-3.0-or-later.

---

# Mitmachen bei Druckerwacht

Schön, dass du helfen willst! So geht's am einfachsten:

## Fehler melden oder Wünsche äußern
Lege ein [Issue](https://github.com/pk1310oo/druckerwacht/issues) an. Hilfreich sind:
- Betriebssystem und App-Version (Einstellungen → unten)
- Druckermodell und Firmware-Version
- Was du erwartet hast und was passiert ist, gerne mit Bildschirmfoto

## Einen anderen Drucker beisteuern
Für neue Drucker braucht es einen Mitschnitt der Schnittstelle. Wie das geht, steht in der
[README, Abschnitt 1](README.de.md#1-erster-schritt-am-echten-drucker-mitschnitt-wichtig). Die Datei bitte an ein Issue hängen
(vorher prüfen, dass keine privaten Daten wie WLAN-Namen enthalten sind).

## Code beitragen
1. Repository forken und einen Branch anlegen.
2. Entwicklungsumgebung einrichten (README.de.md, Abschnitt 2).
3. Vor dem Pull Request:
   ```bash
   npm run build
   ```
   ```bash
   cargo test --manifest-path src-tauri/Cargo.toml
   ```
4. Pull Request mit kurzer Beschreibung, was und warum.

Gestaltung: Bitte beim Farbschema „Schwarz & Orange“ (Tokens in `src/styles.css`) bleiben. Neue Texte immer mit `t("…")` schreiben und die englische Übersetzung in `src/i18n/en.ts` ergänzen (`python3 scripts/i18n-keys.py` prüft das).

## Lizenz
Mit deinem Beitrag stimmst du zu, dass er unter der AGPL-3.0-or-later veröffentlicht wird.
