/*
 * Wird bei Videoaufnahmen in die Browser-Vorschau der App geladen (nur Entwicklung).
 * - window.__dwDemo: simulierter Drucker (Suche, Slicen, Hochladen, Pause …)
 * - window.__dwSim:  tickende Live-Werte
 * - window.__dwCursor: sichtbarer Mauszeiger mit Klick-Welle
 */
(() => {
  const opts = window.__dwDemoOpts || {};
  const store = () => window.__dwStore;
  const st = () => store().getState();
  const set = (p) => store().setState(p);
  const host = "192.168.178.42";

  // ------------------------------------------------------------ Drucker-Simulation
  const sim = {
    timer: null,
    phase: "printing", // printing | preparing | idle
    tick() {
      const s = st().status;
      if (!s) return;
      const now = Date.now();
      const n = { ...s };
      if (sim.phase === "preparing") {
        n.bedTemp = Math.min(60, n.bedTemp + 1.6 + Math.random() * 0.3);
        if (n.bedTemp > 52) n.nozzleTemp = Math.min(215, n.nozzleTemp + 7 + Math.random());
        if (n.bedTemp >= 59.9 && n.nozzleTemp >= 214.5) {
          sim.phase = "printing";
          Object.assign(n, { preparing: false, speedMmS: 120, fanPct: 100, layer: 1, progress: 1, elapsedS: 1, usedMaterialMm: 30 });
        }
      } else if (sim.phase === "printing" && n.state === "printing") {
        n.nozzleTemp = 215 + (Math.random() - 0.5) * 0.8;
        n.bedTemp = 60 + (Math.random() - 0.5) * 0.3;
        n.speedMmS = Math.round(160 + 40 * Math.sin(now / 900) + 18 * Math.sin(now / 230));
        n.progress = Math.min(100, (n.progress ?? 0) + 0.05);
        n.elapsedS = (n.elapsedS ?? 0) + 1;
        n.remainingS = Math.max(0, (n.remainingS ?? 0) - 1);
        if (Math.random() < 0.2) n.layer = Math.min(n.totalLayers ?? 999, (n.layer ?? 0) + 1);
        n.usedMaterialMm = (n.usedMaterialMm ?? 0) + 6;
      } else if (n.state === "paused") {
        n.speedMmS = 0;
      }
      set({ status: n });
      store().pushSample({
        t: now, nozzle: n.nozzleTemp, nozzleTarget: n.nozzleTarget, bed: n.bedTemp, bedTarget: n.bedTarget,
        speed: n.state === "printing" && !n.preparing ? n.speedMmS : 0, flow: 100, fan: n.preparing ? 0 : n.fanPct,
      });
    },
    start(ms = 500) {
      clearInterval(sim.timer);
      sim.timer = setInterval(sim.tick, ms);
    },
  };
  window.__dwSim = sim;

  // ------------------------------------------------------------ Demo-Drucker für die App
  const progress = (name, ms, done) =>
    new Promise((res) => {
      const t0 = performance.now();
      const step = () => {
        const p = Math.min(100, ((performance.now() - t0) / ms) * 100);
        window.dispatchEvent(new CustomEvent(name, { detail: Math.round(p) }));
        if (p < 100) setTimeout(step, 60);
        else res(done);
      };
      step();
    });

  window.__dwDemo = {
    discover: () => new Promise((r) => setTimeout(() => r([{ ip: host, model: "F005", hostname: "Ender3V3KE-6497" }]), opts.discoverMs ?? 1800)),
    slice: async (job) => {
      if (window.__dwSaveJob) await window.__dwSaveJob(JSON.stringify(job)); // Vorlauf: Auftrag für OrcaSlicer sichern
      return progress("dw-demo-slice", opts.sliceMs ?? 3200, opts.result);
    },
    gcode: async () => (await fetch("/@fs" + opts.gcodePath)).text(),
    send: async (path, start) => {
      await progress("dw-demo-upload", opts.uploadMs ?? 2600);
      if (start) {
        setTimeout(() => {
          sim.phase = "preparing";
          set({
            status: {
              ...st().status, state: "printing", stateCode: 1, preparing: true, fileName: opts.result.fileName.replace(/\.gcode$/, ""),
              nozzleTarget: 215, bedTarget: 60, nozzleTemp: 27, bedTemp: 26, progress: 0, layer: 0, totalLayers: opts.result.layers,
              elapsedS: 0, remainingS: opts.result.timeS, speedMmS: 0, fanPct: 0, usedMaterialMm: null,
            },
            samples: [],
          });
          sim.start(250);
        }, 700);
      }
      return opts.result.fileName;
    },
    control: (action) => {
      setTimeout(() => {
        const s = st().status;
        if (action === "pause") set({ status: { ...s, state: "paused", stateCode: 5 } });
        if (action === "resume") set({ status: { ...s, state: "printing", stateCode: 1 } });
        if (action === "stop") set({ status: { ...s, state: "aborted", stateCode: 4 } });
      }, 1300);
    },
  };

  // Verbindung nach dem Speichern einer IP simulieren (Einrichtungs-Szene)
  let lastIp = null;
  setInterval(() => {
    const s = store()?.getState();
    if (!s) return;
    if (lastIp === null) lastIp = s.settings.printerIp;
    if (s.settings.printerIp && s.settings.printerIp !== lastIp) {
      lastIp = s.settings.printerIp;
      set({ connection: { kind: "connecting", host: lastIp, attempt: 1 } });
      setTimeout(() => {
        set({
          connection: { kind: "connected", host: lastIp, sinceMs: Date.now() },
          status: {
            model: "F005", hostname: "Ender3V3KE-6497", nozzleTemp: 24.6, nozzleTarget: 0, bedTemp: 23.9, bedTarget: 0, chamberTemp: null,
            state: "idle", stateCode: 0, fileName: null, progress: 0, layer: 0, totalLayers: 0, elapsedS: 0, remainingS: 0, speedMmS: 0,
            speedPct: 100, flowPct: 100, flowMm3S: 0, fanPct: 0, fanAuxPct: 0, fanCasePct: 0, errorCode: 0, errorKey: 0,
            maxNozzleTemp: 300, maxBedTemp: 100, preparing: false, usedMaterialMm: null,
          },
        });
      }, 1400);
    }
  }, 200);

  // ------------------------------------------------------------ Sichtbarer Mauszeiger
  const install = () => {
    if (document.getElementById("dw-cursor")) return;
    const css = document.createElement("style");
    css.textContent = `
      #dw-cursor { position: fixed; left: 0; top: 0; width: 28px; height: 28px; z-index: 2147483647; pointer-events: none;
        transform: translate(960px, 1200px); transition: transform 0ms; filter: drop-shadow(0 4px 10px rgba(0,0,0,.55)); }
      #dw-cursor svg { width: 28px; height: 28px; }
      .dw-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%;
        border: 2px solid #E68A6B; background: rgba(217,119,87,.25); animation: dwr 520ms cubic-bezier(.2,.7,.2,1) forwards; }
      @keyframes dwr { to { transform: scale(4.2); opacity: 0; } }
      * { cursor: none !important; }`;
    document.head.appendChild(css);
    const c = document.createElement("div");
    c.id = "dw-cursor";
    c.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2.5 19.5 13l-6.6 1.3 3.9 7-2.6 1.4-3.9-7.1L4 20.6z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
  };
  let pos = { x: 960, y: 1200 };
  window.__dwCursor = {
    move(x, y, ms) {
      install();
      const c = document.getElementById("dw-cursor");
      c.style.transition = `transform ${ms}ms cubic-bezier(.45,.05,.25,1)`;
      c.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
      pos = { x, y };
    },
    click() {
      const r = document.createElement("div");
      r.className = "dw-ripple";
      r.style.left = pos.x + "px";
      r.style.top = pos.y + "px";
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 600);
    },
    hide() { const c = document.getElementById("dw-cursor"); if (c) c.style.opacity = "0"; },
    show() { install(); document.getElementById("dw-cursor").style.opacity = "1"; },
  };
  document.addEventListener("DOMContentLoaded", install);
})();
