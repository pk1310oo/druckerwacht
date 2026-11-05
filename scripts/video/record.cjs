/*
 * Nimmt die App-Szenen für die Werbevideos auf (Browser-Vorschau mit Demo-Drucker).
 * Voraussetzung: `npx vite --port 1420` läuft, Playwright ist installiert,
 * scripts/video/cache/demo.gcode existiert (siehe README in diesem Ordner).
 *
 *   node scripts/video/record.cjs de        → scripts/video/out/raw/de/<szene>.webm
 *   node scripts/video/record.cjs en [szene]
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const LANG = process.argv[2] || "de";
const ONLY = process.argv[3] || null;
const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(__dirname, "out", "raw", LANG);
const MODELS = path.join(__dirname, "models");
const W = 1920, H = 1080;
const L = (de, en) => (LANG === "en" ? en : de);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rec0 = 0; // Startzeit der laufenden Aufnahme (für das Protokoll)

const resultFile = path.join(__dirname, "cache", "demo-result.json");
const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : { gcodePath: "demo", fileName: "demo.gcode", timeS: 1, filamentMm: 1, filamentG: 1, layers: 1, warnings: [] };
const demoOpts = { result, gcodePath: path.join(__dirname, "cache", "demo.gcode"), sliceMs: 3400, uploadMs: 2800, discoverMs: 1900 };

// ------------------------------------------------------------------ Aufnahme (CDP-Screencast)
async function recorder(page) {
  const cdp = await page.context().newCDPSession(page);
  let frames = null, dir = null, name = null, stillFrames = null;
  cdp.on("Page.screencastFrame", async (f) => {
    if (frames) {
      const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, "base64"));
      frames.push({ file, t: f.metadata.timestamp });
    }
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  return {
    async start(n) {
      rec0 = Date.now();
      name = n;
      dir = path.join(OUT, "frames-" + n);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      frames = [];
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
      // erzwingt sofort ein erstes Bild
      await page.evaluate(() => document.body.style.setProperty("--dw-nudge", String(Math.random())));
    },
    // Einzelbilder mit fester Dauer (für Szenen, die zu schwer für Echtzeit sind)
    async startStill(n) {
      name = n;
      dir = path.join(OUT, "frames-" + n);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      stillFrames = [];
    },
    async still(dur) {
      const file = path.join(dir, `s${String(stillFrames.length).padStart(5, "0")}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: 92 });
      stillFrames.push({ file, dur });
    },
    async stopStill() {
      const fr = stillFrames; stillFrames = null;
      encode(fr.map((f) => ({ file: f.file, d: f.dur })), fr.length);
    },
    async stop() {
      await sleep(300);
      await cdp.send("Page.stopScreencast");
      const fr = frames;
      frames = null;
      const end = Date.now() / 1000;
      encode(fr.map((f, i) => ({ file: f.file, d: (fr[i + 1]?.t ?? end) - f.t })), fr.length);
    },
  };
  function encode(items, count) {
    {
      const list = items.map((f) => `file '${f.file}'\nduration ${f.d.toFixed(4)}`).join("\n") + `\nfile '${items[items.length - 1].file}'\n`;
      fs.writeFileSync(path.join(dir, "list.txt"), list);
      const out = path.join(OUT, name + ".webm");
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"),
        "-vf", `fps=30,scale=${W}:${H}`, "-c:v", "libvpx-vp9", "-crf", "20", "-b:v", "0", "-g", "15", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", out]);
      fs.rmSync(dir, { recursive: true, force: true });
      const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim();
      console.log(`  ✓ ${name}.webm  ${Number(dur).toFixed(1)} s  (${count} Bilder)`);
    }
  }
}

// ------------------------------------------------------------------ Bedienung mit sichtbarem Zeiger
function actor(page) {
  const center = async (target) => {
    if (typeof target === "object" && "x" in target) return target;
    const loc = typeof target === "string" ? page.locator(target).first() : target;
    await loc.waitFor({ state: "visible", timeout: 15000 });
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const a = {
    async aim(target, ms = 650) {
      const p = await center(target);
      await page.evaluate(([x, y, ms]) => window.__dwCursor.move(x, y, ms), [p.x, p.y, ms]);
      await page.mouse.move(p.x, p.y, { steps: 6 });
      await sleep(ms + 60);
      return p;
    },
    async click(target, { ms = 650, after = 450 } = {}) {
      if (rec0) console.log(`    @${((Date.now() - rec0) / 1000).toFixed(1)}s klick`, typeof target === "string" ? target.slice(0, 60) : "");
      if (process.env.DW_DEBUG) console.log("    klick", typeof target === "string" ? target : JSON.stringify(target), "modelle:", await page.evaluate(() => window.__dwPlate?.count));
      const p = await a.aim(target, ms);
      await page.evaluate(() => window.__dwCursor.click());
      await page.mouse.click(p.x, p.y);
      await sleep(after);
      return p;
    },
    async type(target, text, { clear = true } = {}) {
      await a.click(target);
      if (clear) {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type(text, { delay: 90 });
      await sleep(250);
    },
    async drag(from, to, { ms = 1100, button = "left", hold = [] } = {}) {
      const p = await a.aim(from);
      const q = await center(to);
      for (const k of hold) await page.keyboard.down(k);
      await page.mouse.down({ button });
      const steps = Math.max(8, Math.round(ms / 40));
      for (let i = 1; i <= steps; i++) {
        const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const x = p.x + (q.x - p.x) * e, y = p.y + (q.y - p.y) * e;
        await page.evaluate(([x, y]) => window.__dwCursor.move(x, y, 40), [x, y]);
        await page.mouse.move(x, y);
        await sleep(ms / steps);
      }
      await page.mouse.up({ button });
      for (const k of hold) await page.keyboard.up(k);
      await sleep(300);
    },
    wait: sleep,
  };
  return a;
}

// ------------------------------------------------------------------ Szenen
const nav = (name) => `.sidebar button[aria-label="${name}"]`;

const SCENES = {
  // Dashboard während eines Drucks: Werte ticken, Diagramm-Zeitraum wird umgeschaltet
  async dashboard({ page, a, rec }) {
    await rec.start("dashboard");
    await a.wait(1500);
    await a.aim(".stat >> nth=0", 900);
    await a.wait(1200);
    await a.aim(".stat >> nth=3", 900);
    await a.wait(1200);
    await a.click(`.seg button:has-text("60 min")`);
    await a.wait(1800);
    await a.click(`.seg button:has-text("5 min")`);
    await a.wait(1800);
    await a.click(`.seg button:has-text("15 min")`);
    await a.wait(1200);
    await rec.stop();
  },

  // Pause und Fortsetzen
  async pause({ page, a, rec }) {
    await page.evaluate(() => document.querySelector(".content").scrollTo(0, 0));
    await rec.start("pause");
    await a.wait(800);
    await a.click(`.job-controls button:has-text("${L("Pause", "Pause")}")`);
    await a.wait(2600);
    await a.click(`.job-controls button:has-text("${L("Fortsetzen", "Resume")}")`);
    await a.wait(2600);
    await rec.stop();
  },

  // Slicer: Modelle laden, Rechteck-Auswahl, Temperatur, Füllmuster, Slicen, Vorschau
  async slicer({ page, a, rec }) {
    await rec.start("slicer");
    await a.click(nav("Slicer"));
    await a.wait(900);
    await a.aim(`.plate-tools button[aria-label="${L("Hinzufügen", "Add")}"]`, 700);
    await page.evaluate(() => window.__dwCursor.click());
    await page.setInputFiles("input[type=file]", [path.join(MODELS, "Vase_gedreht.stl"), path.join(MODELS, "Zahnrad.stl"), path.join(MODELS, "Pflanztopf.stl")]);
    await a.wait(2200);
    await page.evaluate(() => { window.__dwPlate.arrange(); window.__dwPlate.select(null); });
    await a.wait(1200);
    // Rechteck über alle Modelle
    const c = await page.locator(".slicer-canvas").boundingBox();
    await a.drag({ x: c.x + c.width * 0.18, y: c.y + c.height * 0.3 }, { x: c.x + c.width * 0.86, y: c.y + c.height * 0.78 }, { ms: 1400 });
    await a.wait(1400);
    await a.click({ x: c.x + c.width * 0.1, y: c.y + c.height * 0.3 });
    await a.wait(500);
    // Temperaturen
    await a.type(`input[aria-label="${L("Düse-Temperatur", "Nozzle temperature")}"]`, "205");
    await page.keyboard.press("Enter");
    await a.type(`input[aria-label="${L("Bett-Temperatur", "Bed temperature")}"]`, "60");
    await page.keyboard.press("Enter");
    await a.wait(400);
    // Füllmuster
    await a.click(`button[role=tab]:has-text("${L("Festigkeit", "Strength")}")`);
    await a.wait(500);
    await page.locator(`button[aria-label="${L("Füllmuster", "Infill pattern")}"]`).scrollIntoViewIfNeeded();
    await a.click(`button[aria-label="${L("Füllmuster", "Infill pattern")}"]`);
    await a.wait(900);
    const gy = page.locator(`.pattern-pop button[role=option]`).filter({ hasText: new RegExp(`^${L("Kubisch", "Cubic")}$`) });
    await gy.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
    await a.wait(700);
    await a.click(gy);
    await a.wait(700);
    // Slicen
    await a.click(`.actions-row button.primary`);
    if (process.env.DW_CAPTURE) return a.wait(1500); // Vorlauf: nur den Auftrag sichern
    await page.locator(".layer-bar").waitFor({ timeout: 120000 });
    await a.wait(1200);
    await rec.stop();

    // Schichten durchblättern – zu schwer für Echtzeit, daher Bild für Bild (12 Bilder/s)
    await rec.startStill("preview");
    const slider = page.locator(".layer-bar input[type=range]");
    const bar = await slider.boundingBox();
    const max = Number(await slider.getAttribute("max"));
    const setLayer = async (v) => {
      await slider.evaluate((el, v) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, Math.round(v));
      const x = bar.x + 8 + (bar.width - 16) * (v / max), y = bar.y + bar.height / 2;
      await page.evaluate(([x, y]) => window.__dwCursor.move(x, y, 0), [x, y]);
    };
    await setLayer(max);
    await page.evaluate(() => window.__dwCursor.click());
    await rec.still(0.9);
    const path2 = [[max, max * 0.3, 26], [max * 0.3, max * 0.3, 1], [max * 0.3, max, 30]];
    for (const [from, to, n] of path2) {
      for (let i = 1; i <= n; i++) {
        const k = i / n, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        await setLayer(from + (to - from) * e);
        await rec.still(n === 1 ? 0.8 : 1 / 12);
      }
    }
    await rec.still(1.2);
    await rec.stopStill();
  },

  // An den Drucker senden → Vorbereitung im Dashboard
  async print({ page, a, rec }) {
    await page.evaluate(() => {
      const s = window.__dwStore.getState();
      window.__dwSim.phase = "idle";
      window.__dwStore.setState({ status: { ...s.status, state: "idle", stateCode: 0, fileName: null, progress: 0, nozzleTarget: 0, bedTarget: 0, nozzleTemp: 26.2, bedTemp: 25.1, speedMmS: 0, fanPct: 0 } });
    });
    await rec.start("print");
    await a.wait(600);
    await a.click(`.actions-row button:has-text("${L("Drucken", "Print")}")`);
    await a.wait(900);
    await a.click(".plate-check input");
    await a.wait(400);
    await a.click(`.modal-actions button.primary`);
    await page.locator(".view .progress").waitFor({ timeout: 30000 });
    await a.wait(600);
    await a.aim(".stat >> nth=1", 900);
    await a.wait(4500);
    await a.aim(".charts .chart-card >> nth=0", 900);
    await a.wait(3000);
    await rec.stop();
  },

  // Druckverlauf vom Drucker
  async history({ page, a, rec }) {
    await page.evaluate(() => window.__dwStore.setState({
      printerHistory: {
        totalJobs: 128, totalTimeS: 523400, totalMaterialMm: 612300,
        jobs: [
          { id: 1, file: "Vase_gedreht_+2_Generic_PLA_0.2mm", startedS: Date.now() / 1000 - 4000, durationS: 13990, materialMm: 37600, finished: true, thumbnail: null },
          { id: 2, file: "Kabelhalter_Schreibtisch", startedS: Date.now() / 1000 - 90000, durationS: 2810, materialMm: 4100, finished: true, thumbnail: null },
          { id: 3, file: "Benchy_PETG_0.16mm", startedS: Date.now() / 1000 - 180000, durationS: 3920, materialMm: 5200, finished: false, thumbnail: null },
          { id: 4, file: "Organizer_Schublade_gross", startedS: Date.now() / 1000 - 270000, durationS: 30200, materialMm: 61200, finished: true, thumbnail: null },
          { id: 5, file: "Ersatzteil_Lüfterhalter", startedS: Date.now() / 1000 - 400000, durationS: 1860, materialMm: 2300, finished: true, thumbnail: null },
        ],
      },
    }));
    await rec.start("history");
    await a.click(nav(L("Verlauf", "History")));
    await a.wait(2400);
    await a.aim(".job-printer >> nth=1", 900);
    await a.wait(1500);
    await rec.stop();
  },

  // Einrichtung: Drucker suchen, verbinden
  async connect({ page, a, rec }) {
    await rec.start("connect");
    await a.wait(1200);
    await a.click(`.empty .btn.primary`);
    await a.wait(900);
    await a.click(`button:has-text("${L("Im Netz suchen", "Search network")}")`);
    await page.locator(".found button").first().waitFor({ timeout: 15000 });
    await a.wait(700);
    await a.click(".found button");
    await a.wait(500);
    await a.click(`.save-bar .btn.primary`);
    await a.wait(2600);
    await a.click(nav("Dashboard"));
    await a.wait(2500);
    await rec.stop();
  },

  // Sprache umschalten (Deutsch ⇄ English)
  async language({ page, a, rec }) {
    await a.click(nav(L("Einstellungen", "Settings")));
    await page.evaluate(() => document.querySelector(".content").scrollTo(0, 0));
    await rec.start("language");
    await a.wait(900);
    await a.click(`.seg[role=radiogroup] button:has-text("${L("English", "Deutsch")}")`);
    await a.wait(1600);
    await a.click(`.seg[role=radiogroup] button:has-text("${L("Deutsch", "English")}")`);
    await a.wait(1400);
    await rec.stop();
  },
};

// ------------------------------------------------------------------ Ablauf
async function session(browser, url, names) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: LANG === "en" ? "en-US" : "de-DE" });
  await ctx.addInitScript(`window.__dwDemoOpts = ${JSON.stringify(demoOpts)};`);
  await ctx.addInitScript({ path: path.join(__dirname, "demo-page.js") });
  const page = await ctx.newPage();
  if (process.env.DW_CAPTURE) await page.exposeFunction("__dwSaveJob", (job) => fs.writeFileSync(path.join(__dirname, "cache", "job.json"), job));
  page.on("pageerror", (e) => console.log("  Seitenfehler:", e.message));
  if (process.env.DW_DEBUG) page.on("console", (m) => console.log("  [konsole]", m.text()));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__dwStore && window.__dwCursor);
  await page.evaluate(() => { window.__dwCursor.show(); if (window.__dwStore.getState().status) window.__dwSim.start(1000); });
  await sleep(1500);
  const rec = await recorder(page);
  const a = actor(page);
  for (const n of names) {
    if (ONLY === "slicer-capture" && n === "slicer") {
      console.log("Vorlauf: Slice-Auftrag sichern");
      await SCENES.slicer({ page, a, rec: { start() {}, stop() {} } });
      continue;
    }
    if (ONLY && n !== ONLY) continue;
    console.log("Szene", n);
    await SCENES[n]({ page, a, rec });
  }
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  await session(browser, "http://localhost:1420/?preview=printing&orca=1", ["dashboard", "pause", "slicer", "print", "history"]);
  await session(browser, "http://localhost:1420/?preview=setup&orca=1", ["connect", "language"]);
  await browser.close();
})();
