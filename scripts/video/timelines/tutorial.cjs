// Tutorial „Erste Schritte“ 16:9 – Installation, Verbinden, erster Druck
module.exports = (lang, clip) => {
  const L = (de, en) => (lang === "en" ? en : de);
  const T = require("./texts.cjs")(lang);
  const step = (n, de, en) => ({ kicker: L(`Schritt ${n}`, `Step ${n}`), title: L(de, en) });
  return {
    name: `Druckerwacht_Tutorial_${lang.toUpperCase()}`,
    w: 1920, h: 1080, progress: true,
    segments: [
      { type: "title", dur: 4.2, kicker: L("Tutorial", "Tutorial"), title: L("Erste Schritte", "Getting started"), sub: L("Installieren, verbinden, drucken – in drei Minuten.", "Install, connect, print – in three minutes.") },

      { type: "finder", dur: 4.5, step: "1", dest: L("Programme", "Applications"),
        title: L("Mac: In „Programme“ ziehen", "Mac: drag into Applications"), sub: L(".dmg öffnen und Druckerwacht hinüberziehen.", "Open the .dmg and drag Druckerwacht across.") },
      { type: "terminal", dur: 6, step: "1", os: "Terminal · macOS",
        title: L("Mac: Einmal freigeben", "Mac: allow it once"), sub: L("Die App ist nicht bei Apple registriert – dieser Befehl erlaubt sie.", "The app isn’t registered with Apple – this command allows it."),
        cmds: [{ cmd: "xattr -dr com.apple.quarantine /Applications/Druckerwacht.app", out: L("✓ fertig – Druckerwacht startet jetzt ganz normal", "✓ done – Druckerwacht now opens normally") }] },
      { type: "terminal", dur: 6.5, step: "1", os: "Terminal · Linux Mint / Ubuntu",
        title: L("Linux: .deb installieren", "Linux: install the .deb"), sub: L("Im Download-Ordner – ein Update ersetzt die alte Version.", "In your Downloads folder – an update replaces the old version."),
        cmds: [{ cmd: "cd ~/Downloads", out: "" }, { cmd: "sudo apt install ./Druckerwacht_0.6.1_amd64.deb", out: L("✓ Druckerwacht ist installiert – Start über das Menü", "✓ Druckerwacht is installed – start it from the menu") }] },
      { type: "terminal", dur: 6, step: "2", os: L("Für den Slicer", "For the slicer"),
        title: L("OrcaSlicer dazulegen", "Add OrcaSlicer"), sub: L("Kostenlos – Druckerwacht findet ihn automatisch, öffnen musst du ihn nie.", "Free – Druckerwacht finds it automatically, you never open it."),
        cmds: [{ cmd: "github.com/SoftFever/OrcaSlicer/releases", out: L("Mac: in „Programme“ ziehen · Linux: AppImage nach ~/Applications", "Mac: drag into Applications · Linux: AppImage into ~/Applications") }] },

      { type: "clip", src: clip("connect"), from: 0.3, dur: 10.5, caps: [
          { t: 0, dur: 10.5, ...step(3, "Drucker <em>verbinden</em>", "<em>Connect</em> your printer") },
        ], cam: [{ t: 0, x: .5, y: .45, z: 1.15 }, { t: 2.2, x: .5, y: .45, z: 1.15 }, { t: 3.4, x: .35, y: .3, z: 1.5 }, { t: 7.5, x: .35, y: .32, z: 1.5 }, { t: 8.8, x: .5, y: .3, z: 1.05 }] },

      { type: "clip", src: clip("language"), from: 0.3, dur: 4.6, caps: [
          { t: 0, dur: 4.6, kicker: L("Tipp", "Tip"), title: L("Sprache: <em>Deutsch oder English</em>", "Language: <em>English or German</em>") },
        ], cam: [{ t: 0, x: .32, y: .2, z: 1.6 }, { t: 4.6, x: .32, y: .2, z: 1.7 }] },

      { type: "clip", src: clip("slicer"), from: 0.4, dur: 30, caps: [
          { t: 0, dur: 6.2, ...step(4, "Modelle <em>laden</em>", "<em>Load</em> your models") },
          { t: 6.2, dur: 6.6, kicker: L("Auswählen & Ansicht", "Select & view"), title: L("Links ziehen wählt aus · <em>rechts dreht die Ansicht</em>", "Left-drag selects · <em>right-drag rotates the view</em>") },
          { t: 12.8, dur: 6.4, kicker: L("Temperaturen", "Temperatures"), title: L("Düse und Bett oben eintragen", "Set nozzle and bed at the top") },
          { t: 19.2, dur: 5.6, kicker: L("Einstellungen", "Settings"), title: L("Füllmuster wählen – <em>mit Vorschau</em>", "Pick an infill – <em>with preview</em>") },
          { t: 24.8, dur: 5.2, ...step(5, "<em>Slicen</em>", "<em>Slice</em>") },
        ], cam: [
          { t: 0, x: .4, y: .5, z: 1.1 }, { t: 12.4, x: .4, y: .52, z: 1.1 },
          { t: 13.6, x: .2, y: .12, z: 1.9 }, { t: 19, x: .2, y: .12, z: 1.9 },
          { t: 20.2, x: .88, y: .6, z: 1.6 }, { t: 25.6, x: .88, y: .7, z: 1.6 }, { t: 30, x: .82, y: .9, z: 1.5 } ] },
      { type: "clip", src: clip("preview"), from: 0, dur: 7.5, caps: [
          { t: 0, dur: 7.5, kicker: L("Vorschau", "Preview"), title: L("Schichten <em>durchblättern</em>", "Scrub through the <em>layers</em>") },
        ], cam: [{ t: 0, x: .45, y: .55, z: 1.05 }, { t: 7.5, x: .45, y: .6, z: 1.2 }] },

      { type: "clip", src: clip("print"), from: 0.3, dur: 13.5, caps: [
          { t: 0, dur: 5.4, ...step(6, "An den Drucker <em>senden</em>", "<em>Send</em> to the printer") },
          { t: 5.4, dur: 8.1, kicker: L("Fertig!", "Done!"), title: L("Der Druck startet – <em>du siehst alles live.</em>", "Your print starts – <em>watch it live.</em>") },
        ], cam: [{ t: 0, x: .5, y: .5, z: 1.4 }, { t: 4.8, x: .5, y: .5, z: 1.4 }, { t: 6.4, x: .45, y: .3, z: 1.3 }, { t: 13.5, x: .4, y: .5, z: 1.15 }] },

      { type: "clip", src: clip("pause"), from: 0.3, dur: 7.4, caps: [
          { t: 0, dur: 7.4, kicker: L("Während des Drucks", "While printing"), title: L("Pausieren, fortsetzen, <em>abbrechen</em>", "Pause, resume, <em>cancel</em>") },
        ], cam: [{ t: 0, x: .4, y: .42, z: 1.7 }, { t: 7.4, x: .4, y: .42, z: 1.8 }] },

      { type: "outro", dur: 6, title: "Druckerwacht", chips: [T.free, "macOS & Linux", "Deutsch · English"], cta: T.cta, url: T.url },
    ],
  };
};
