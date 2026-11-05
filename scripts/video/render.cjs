/*
 * Setzt ein Video aus der Zeitleiste zusammen und schreibt es als MP4 (H.264, 30 fps).
 *   node scripts/video/render.cjs <zeitleiste.js> <sprache> [--still sekunden,...]
 * Die Zeitleiste exportiert (lang) => { name, w, h, segments }.
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const [, , timelineFile, lang = "de", ...rest] = process.argv;
const stills = rest[0] === "--still" ? rest[1].split(",").map(Number) : null;
const FPS = 30;
const RAW = path.join(__dirname, "out", "raw", lang);
const OUTDIR = path.join(__dirname, "out", "final");

(async () => {
  const make = require(path.resolve(timelineFile));
  const tl = make(lang, (scene) => "file://" + path.join(RAW, scene + ".webm"));
  fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: tl.w, height: tl.h } });
  page.on("pageerror", (e) => console.log("Seitenfehler:", e.message));
  await page.goto("file://" + path.join(__dirname, "compose.html"));
  const logo = "file://" + path.resolve(__dirname, "../../src-tauri/icons/128x128@2x.png");
  const total = await page.evaluate((cfg) => window.setup(cfg), { ...tl, logo });
  await page.evaluate(() => document.fonts.ready);
  if (stills) {
    for (const s of stills) {
      await page.evaluate((t) => window.render(t), s);
      const f = path.join(OUTDIR, `${tl.name}_${s}s.png`);
      await page.screenshot({ path: f });
      console.log("Standbild", f);
    }
    await browser.close();
    return;
  }
  const out = path.join(OUTDIR, tl.name + ".mp4");
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const n = Math.round(total * FPS);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    const buf = await page.screenshot({ type: "jpeg", quality: 94 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % (FPS * 10) === 0) process.stdout.write(`  ${tl.name}: ${Math.round((i / n) * 100)} %\n`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  await browser.close();
  console.log(`✓ ${out}  ${total.toFixed(1)} s  (${((Date.now() - t0) / 1000).toFixed(0)} s Rechenzeit)`);
})();
