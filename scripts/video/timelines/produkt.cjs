// Produktvideo 16:9 (YouTube, Website) – ca. 80 Sekunden
module.exports = (lang, clip) => {
  const L = (de, en) => (lang === "en" ? en : de);
  const T = require("./texts.cjs")(lang);
  return {
    name: `Druckerwacht_Produktvideo_${lang.toUpperCase()}`,
    w: 1920, h: 1080, progress: true,
    segments: [
      { type: "title", dur: 3.6, kicker: T.forKE, title: "Druckerwacht", sub: T.tagline },

      { type: "clip", src: clip("dashboard"), from: 0.8, dur: 12.5, caps: [
          { t: 0, dur: 6.4, kicker: L("Live-Überwachung", "Live monitoring"), title: L("Alles live. <em>Auf einen Blick.</em>", "Everything live. <em>At a glance.</em>") },
          { t: 6.4, dur: 6.1, kicker: L("Diagramme", "Charts"), title: L("Jede Kurve in <em>Echtzeit</em> – 5, 15 oder 60 Minuten.", "Every curve in <em>real time</em> – 5, 15 or 60 minutes.") },
        ], cam: [{ t: 0, x: .5, y: .5, z: 1 }, { t: 1.6, x: .5, y: .5, z: 1 }, { t: 4.2, x: .42, y: .24, z: 1.55 }, { t: 6.2, x: .42, y: .24, z: 1.55 }, { t: 8, x: .55, y: .78, z: 1.45 }, { t: 12.5, x: .55, y: .78, z: 1.3 }] },

      { type: "clip", src: clip("pause"), from: 0.3, dur: 7.2, caps: [
          { t: 0, dur: 7.2, kicker: L("Steuern", "Control"), title: L("Pausieren. Fortsetzen. <em>Ein Klick.</em>", "Pause. Resume. <em>One click.</em>") },
        ], cam: [{ t: 0, x: .4, y: .42, z: 1.7 }, { t: 7.2, x: .4, y: .42, z: 1.85 }] },

      { type: "clip", src: clip("slicer"), from: 0.4, speed: 1.25, dur: 34, caps: [
          { t: 0, dur: 6.2, kicker: L("Slicer", "Slicer"), title: L("Modelle rein. <em>Fertig zum Slicen.</em>", "Drop in your models. <em>Ready to slice.</em>") },
          { t: 6.2, dur: 5.6, kicker: L("Wie auf dem Desktop", "Like your desktop"), title: L("Mehrere Teile <em>aufziehen</em> und gemeinsam bewegen.", "<em>Drag</em> to select several parts at once.") },
          { t: 11.8, dur: 6.4, kicker: L("Deine Werte", "Your settings"), title: L("Temperatur einmal eintragen – <em>gilt für jeden Druck.</em>", "Set your temperatures once – <em>used for every print.</em>") },
          { t: 18.2, dur: 6, kicker: L("Füllmuster", "Infill"), title: L("Alle Muster – <em>mit Vorschaubild.</em>", "Every pattern – <em>with a preview.</em>") },
          { t: 24.2, dur: 9.8, kicker: L("OrcaSlicer-Motor", "OrcaSlicer engine"), title: L("Slicen und jede <em>Schicht</em> ansehen.", "Slice and inspect every <em>layer</em>.") },
        ], cam: [
          { t: 0, x: .4, y: .5, z: 1.15 }, { t: 6, x: .4, y: .52, z: 1.15 }, { t: 11.5, x: .4, y: .52, z: 1.15 },
          { t: 12.8, x: .2, y: .12, z: 1.9 }, { t: 17.6, x: .2, y: .12, z: 1.9 },
          { t: 19, x: .88, y: .6, z: 1.6 }, { t: 23.8, x: .88, y: .6, z: 1.6 },
          { t: 25.4, x: .5, y: .55, z: 1.08 }, { t: 34, x: .45, y: .55, z: 1.25 } ] },

      { type: "clip", src: clip("print"), from: 0.3, dur: 13.5, caps: [
          { t: 0, dur: 5.2, kicker: L("Drucken", "Print"), title: L("Direkt an den Drucker – <em>sicher geprüft.</em>", "Straight to your printer – <em>safety-checked.</em>") },
          { t: 5.2, dur: 8.3, kicker: L("Vorbereitung", "Preparing"), title: L("Heizen und Leveling <em>live verfolgen.</em>", "Watch heating and leveling <em>live.</em>") },
        ], cam: [{ t: 0, x: .5, y: .5, z: 1.25 }, { t: 4.6, x: .5, y: .5, z: 1.25 }, { t: 6.4, x: .45, y: .3, z: 1.35 }, { t: 9.5, x: .32, y: .2, z: 1.6 }, { t: 13.5, x: .35, y: .72, z: 1.35 }] },

      { type: "clip", src: clip("history"), from: 0.6, dur: 5.6, caps: [
          { t: 0, dur: 5.6, kicker: L("Verlauf", "History"), title: L("Jeder Druck – <em>direkt vom Drucker.</em>", "Every print – <em>straight from the printer.</em>") },
        ], cam: [{ t: 0, x: .5, y: .35, z: 1.2 }, { t: 5.6, x: .5, y: .35, z: 1.35 }] },

      { type: "outro", dur: 5.5, title: "Druckerwacht", chips: [T.free, "macOS & Linux", "Deutsch · English"], cta: T.cta, url: T.url },
    ],
  };
};
