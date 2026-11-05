// Vier Kurzvideos 9:16 (TikTok, Reels, Shorts). Aufruf mit Index: DW_SHORT=1..4
module.exports = (lang, clip) => {
  const L = (de, en) => (lang === "en" ? en : de);
  const T = require("./texts.cjs")(lang);
  const outro = { type: "outro", dur: 4, title: "Druckerwacht", chips: [T.free, "macOS & Linux"], cta: T.cta, url: T.urlBio };
  const shorts = {
    1: {
      name: "live",
      segments: [
        { type: "clip", src: clip("dashboard"), from: 0.6, dur: 9.5, caps: [
            { t: 0, dur: 4.6, kicker: L("Ender 3 V3 KE", "Ender 3 V3 KE"), title: L("Dein Drucker druckt. <em>Du siehst alles.</em>", "Your printer prints. <em>You see everything.</em>") },
            { t: 4.6, dur: 4.9, kicker: L("Live per WLAN", "Live over Wi-Fi"), title: L("Temperaturen, Tempo, Restzeit – <em>jede Sekunde.</em>", "Temperatures, speed, time left – <em>every second.</em>") },
          ], cam: [{ t: 0, x: .3, y: .25, z: 1.0 }, { t: 3.5, x: .62, y: .25, z: 1.0 }, { t: 5.5, x: .55, y: .8, z: 1.0 }, { t: 9.5, x: .35, y: .8, z: 1.0 }] },
        { type: "clip", src: clip("pause"), from: 0.4, dur: 6.6, caps: [
            { t: 0, dur: 6.6, kicker: L("Ein Klick", "One click"), title: L("Pausieren und <em>fortsetzen.</em>", "Pause and <em>resume.</em>") },
          ], cam: [{ t: 0, x: .36, y: .42, z: 1.15 }, { t: 6.6, x: .36, y: .42, z: 1.3 }] },
        outro,
      ],
    },
    2: {
      name: "slicer",
      segments: [
        { type: "clip", src: clip("slicer"), from: 0.8, speed: 1.6, dur: 6.5, caps: [
            { t: 0, dur: 6.5, kicker: L("Slicer eingebaut", "Built-in slicer"), title: L("Modelle rein, <em>alles einstellen.</em>", "Drop in models, <em>tune everything.</em>") },
          ], cam: [{ t: 0, x: .4, y: .5, z: 1 }, { t: 6.5, x: .4, y: .52, z: 1.1 }] },
        { type: "clip", src: clip("slicer"), from: 17, speed: 1.4, dur: 6, caps: [
            { t: 0, dur: 6, kicker: L("Füllmuster", "Infill"), title: L("Jedes Muster <em>mit Bild.</em>", "Every pattern <em>with a picture.</em>") },
          ], cam: [{ t: 0, x: .86, y: .55, z: 1 }, { t: 6, x: .86, y: .6, z: 1.1 }] },
        { type: "clip", src: clip("preview"), from: 0, dur: 7, caps: [
            { t: 0, dur: 7, kicker: L("OrcaSlicer-Motor", "OrcaSlicer engine"), title: L("Jede Schicht <em>ansehen.</em>", "See every <em>layer.</em>") },
          ], cam: [{ t: 0, x: .42, y: .5, z: 1.15 }, { t: 7, x: .42, y: .5, z: 1.3 }] },
        outro,
      ],
    },
    3: {
      name: "drucken",
      segments: [
        { type: "clip", src: clip("print"), from: 0.3, dur: 6, caps: [
            { t: 0, dur: 6, kicker: L("Ohne USB-Stick", "No USB stick"), title: L("Ein Klick – <em>und es druckt.</em>", "One click – <em>and it prints.</em>") },
          ], cam: [{ t: 0, x: .5, y: .5, z: 1.0 }, { t: 6, x: .5, y: .5, z: 1.1 }] },
        { type: "clip", src: clip("print"), from: 6.3, dur: 7.5, caps: [
            { t: 0, dur: 7.5, kicker: L("Vorbereitung", "Preparing"), title: L("Aufheizen <em>live verfolgen.</em>", "Watch it heat up <em>live.</em>") },
          ], cam: [{ t: 0, x: .3, y: .25, z: 1.0 }, { t: 3, x: .3, y: .25, z: 1.0 }, { t: 7.5, x: .35, y: .78, z: 1.0 }] },
        outro,
      ],
    },
    4: {
      name: "opensource",
      segments: [
        { type: "title", dur: 3.4, kicker: L("Kostenlos. Für immer.", "Free. Forever."), title: "Open Source", sub: L("Kein Konto, keine Cloud, keine Werbung.", "No account, no cloud, no ads.") },
        { type: "clip", src: clip("language"), from: 0.4, dur: 5.5, caps: [
            { t: 0, dur: 5.5, kicker: "Deutsch · English", title: L("Spricht <em>deine Sprache.</em>", "Speaks <em>your language.</em>") },
          ], cam: [{ t: 0, x: .3, y: .2, z: 1.0 }, { t: 5.5, x: .3, y: .2, z: 1.1 }] },
        { type: "clip", src: clip("history"), from: 0.8, dur: 5, caps: [
            { t: 0, dur: 5, kicker: L("Für den Ender 3 V3 KE", "For the Ender 3 V3 KE"), title: L("Überwachen, slicen, <em>drucken.</em>", "Monitor, slice, <em>print.</em>") },
          ], cam: [{ t: 0, x: .5, y: .4, z: 1.0 }, { t: 5, x: .5, y: .4, z: 1.1 }] },
        outro,
      ],
    },
  };
  const n = Number(process.env.DW_SHORT || 1);
  const s = shorts[n];
  return { name: `Druckerwacht_Short${n}_${s.name}_${lang.toUpperCase()}`, w: 1080, h: 1920, segments: s.segments };
};
