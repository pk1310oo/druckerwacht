# Mitmachen bei Druckerwacht

Schön, dass du helfen willst! So geht's am einfachsten:

## Fehler melden oder Wünsche äußern
Lege ein [Issue](https://github.com/pk1310oo/druckerwacht/issues) an. Hilfreich sind:
- Betriebssystem und App-Version (Einstellungen → unten)
- Druckermodell und Firmware-Version
- Was du erwartet hast und was passiert ist, gerne mit Bildschirmfoto

## Einen anderen Drucker beisteuern
Für neue Drucker braucht es einen Mitschnitt der Schnittstelle. Wie das geht, steht in der
[README, Abschnitt 1](README.md#1-erster-schritt-am-echten-drucker-mitschnitt-wichtig). Die Datei bitte an ein Issue hängen
(vorher prüfen, dass keine privaten Daten wie WLAN-Namen enthalten sind).

## Code beitragen
1. Repository forken und einen Branch anlegen.
2. Entwicklungsumgebung einrichten (README, Abschnitt 2).
3. Vor dem Pull Request:
   ```bash
   npm run build
   ```
   ```bash
   cargo test --manifest-path src-tauri/Cargo.toml
   ```
4. Pull Request mit kurzer Beschreibung, was und warum.

Gestaltung: Bitte beim Farbschema „Schwarz & Orange“ (Tokens in `src/styles.css`) und bei deutschen Texten bleiben.

## Lizenz
Mit deinem Beitrag stimmst du zu, dass er unter der AGPL-3.0-or-later veröffentlicht wird.
