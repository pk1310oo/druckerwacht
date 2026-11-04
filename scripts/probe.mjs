#!/usr/bin/env node
/**
 * Probe für die Creality-WebSocket-Schnittstelle (Port 9999).
 *
 * Schneidet alle Nachrichten mit und fasst am Ende zusammen, welche Felder der
 * Drucker schickt (mit Beispielwerten). Damit wird der Parser in
 * src-tauri/src/model.rs gegen den echten Drucker abgeglichen.
 *
 * Benötigt nur Node.js ≥ 22 (eingebauter WebSocket-Client), keine Pakete.
 *
 *   node scripts/probe.mjs 192.168.178.42            # 120 s mitschneiden
 *   node scripts/probe.mjs 192.168.178.42 600        # 10 min (am besten während eines Drucks)
 *   node scripts/probe.mjs 192.168.178.42 120 --passive   # nichts senden, nur zuhören
 *   node scripts/probe.mjs --scan                    # Drucker im lokalen Netz suchen
 *
 * Die Probe sendet NUR Leseanfragen: {"method":"get","params":{"reqPrinterPara":1}}
 * und beantwortet Heartbeats mit "ok" (wie Creality Print). Keine Steuerbefehle.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

const args = process.argv.slice(2);
const passive = args.includes("--passive");
const positional = args.filter((a) => !a.startsWith("--"));

if (typeof WebSocket === "undefined") {
  console.error("Node.js 22 oder neuer wird benötigt (eingebauter WebSocket-Client).");
  process.exit(1);
}

if (args.includes("--scan")) {
  await scan();
  process.exit(0);
}

const host = positional[0];
const seconds = Number(positional[1] ?? 120);
if (!host) {
  console.error("Aufruf: node scripts/probe.mjs <drucker-ip> [sekunden] [--passive]   oder   --scan");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = `probe-${host.replace(/[^0-9a-z.]/gi, "_")}-${stamp}.jsonl`;
const out = fs.createWriteStream(outFile);
const keys = new Map(); // key → { count, types:Set, samples:Set }
let messages = 0;

function log(dir, msg) {
  let parsed = msg;
  try {
    parsed = JSON.parse(msg);
  } catch {
    /* Text bleibt Text */
  }
  out.write(JSON.stringify({ t: Date.now(), dir, msg: parsed }) + "\n");
  return parsed;
}

function collect(obj, prefix = "") {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      collect(v, key + ".");
      continue;
    }
    const e = keys.get(key) ?? { count: 0, types: new Set(), samples: new Set() };
    e.count++;
    e.types.add(Array.isArray(v) ? "array" : typeof v);
    const sample = JSON.stringify(v);
    if (e.samples.size < 4 && sample.length < 80) e.samples.add(sample);
    keys.set(key, e);
  }
}

console.log(`Verbinde mit ws://${host}:9999 … (Mitschnitt: ${outFile}, Dauer: ${seconds} s)`);
const ws = new WebSocket(`ws://${host}:9999`);
const send = (text) => {
  if (passive || ws.readyState !== WebSocket.OPEN) return;
  log("out", text);
  ws.send(text);
};

const connectTimer = setTimeout(() => {
  console.error("Keine Verbindung nach 10 s. Stimmt die IP? Ist der Drucker im selben Netz?");
  process.exit(2);
}, 10_000);

ws.addEventListener("open", () => {
  clearTimeout(connectTimer);
  console.log("Verbunden. Sammle Nachrichten …  (Strg+C beendet vorzeitig)");
  send(JSON.stringify({ method: "get", params: { reqPrinterPara: 1 } }));
});

ws.addEventListener("message", async (ev) => {
  const text = typeof ev.data === "string" ? ev.data : await ev.data.text?.();
  messages++;
  const parsed = log("in", text);
  if (parsed && typeof parsed === "object") {
    if (parsed.ModeCode === "heart_beat") send("ok");
    else collect(parsed);
  }
  process.stdout.write(`\r${messages} Nachrichten, ${keys.size} verschiedene Felder`);
});

ws.addEventListener("close", (ev) => {
  console.log(`\nVerbindung beendet (Code ${ev.code}).`);
  finish();
});
ws.addEventListener("error", () => {
  console.error("\nWebSocket-Fehler – Drucker nicht erreichbar oder Verbindung abgelehnt.");
});

setTimeout(() => {
  ws.close();
  finish();
}, seconds * 1000);
process.on("SIGINT", () => finish());

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  out.end();
  console.log(`\n\n=== Gefundene Felder (${keys.size}) ===`);
  const rows = [...keys.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [k, e] of rows) {
    console.log(`${k.padEnd(28)} ${String(e.count).padStart(5)}×  ${[...e.types].join("/").padEnd(8)} ${[...e.samples].join("  ")}`);
  }
  console.log(`\nMitschnitt gespeichert: ${outFile}`);
  setTimeout(() => process.exit(0), 100);
}

async function scan() {
  const hosts = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const p = a.address.split(".");
      for (let i = 1; i < 255; i++) {
        const h = `${p[0]}.${p[1]}.${p[2]}.${i}`;
        if (h !== a.address) hosts.push(h);
      }
    }
  }
  console.log(`Suche Port 9999 auf ${hosts.length} Adressen …`);
  const open = [];
  const probe = (h) =>
    new Promise((res) => {
      const s = net.connect({ host: h, port: 9999, timeout: 600 });
      const done = (ok) => {
        s.destroy();
        if (ok) open.push(h);
        res();
      };
      s.on("connect", () => done(true));
      s.on("timeout", () => done(false));
      s.on("error", () => done(false));
    });
  for (let i = 0; i < hosts.length; i += 128) await Promise.all(hosts.slice(i, i + 128).map(probe));
  console.log(open.length ? `Gefunden: ${open.join(", ")}` : "Nichts gefunden.");
}
