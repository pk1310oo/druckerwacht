/**
 * Eingabeleiste des KI-Designers unten auf der Platte: Wunsch eintippen, die KI baut ihn fest
 * an das ausgewählte Teil an (oder schneidet, graviert …). Rückgängig wie immer möglich.
 */
import { useEffect, useRef, useState } from "react";
import { ExternalLink, KeyRound, Loader2, Send, Sparkles, Square, Undo2, X } from "lucide-react";
import type { Plate } from "./plate";
import { AiDesignError, runAiDesign, type AiPhase } from "./aiDesigner";
import { ABO, aboStatus, runAiDesignAbo } from "./aiDesignerAbo";
import { getLang, t } from "../lib/i18n";
import { useStore } from "../lib/store";
import { saveSettings } from "../lib/api";
import { getState } from "../lib/store";
import { openProjectLink } from "../lib/update";
import { fmtNum } from "../lib/format";

const KEY_URL = "https://console.anthropic.com/settings/keys";

const PHASE: Record<AiPhase, () => string> = {
  look: () => t("Schaut sich das Teil an …"),
  think: () => t("Überlegt …"),
  probe: () => t("Tastet die Oberfläche ab …"),
  slice: () => t("Misst Querschnitte …"),
  try: () => t("Probiert einen Entwurf aus …"),
  apply: () => t("Baut es an …"),
};

const EXAMPLES = () => [t("Haken zum Aufhängen hinten dran"), t("Loch für eine M4-Schraube in der Mitte"), t("Meinen Namen vorne eingravieren"), t("Schlüsselloch zum Aufhängen an der Wand")];

type State =
  | { kind: "idle" }
  | { kind: "running"; phase: AiPhase; round: number; note?: string }
  | { kind: "done"; summary: string; cost: number }
  | { kind: "error"; message: string };

function errorText(e: unknown): string | null {
  if (!(e instanceof AiDesignError)) return t("KI-Designer: {m}", { m: e instanceof Error ? e.message : String(e) });
  if (e.message === "abort") return null;
  switch (e.kind) {
    case "key":
      return t("Der API-Schlüssel wurde abgelehnt – bitte in den Einstellungen prüfen.");
    case "offline":
      return t("Anthropic ist nicht erreichbar – ist der Computer online?");
    case "limit":
      return t("Limit oder Guthaben beim API-Schlüssel erreicht – bitte später noch einmal oder Guthaben aufladen.");
    case "refused":
      return t("Die KI hat diese Anfrage abgelehnt.");
    case "gave-up":
      return t("Die KI ist zu keinem passenden Ergebnis gekommen. Beschreib es etwas genauer und versuch es noch einmal.");
    case "part":
      return t("Dieses Teil ist kein geschlossener Körper – die KI kann es leider nicht bearbeiten.");
    default:
      return t("KI-Designer: {m}", { m: e.message });
  }
}

export function AiDesignBar({ plate, partName, hidden }: { plate: Plate; partName: string | null; hidden?: boolean }) {
  const apiKey = useStore((s) => s.settings.aiKey);
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [keyDraft, setKeyDraft] = useState("");
  const [open, setOpen] = useState(true);
  const abort = useRef<AbortController | null>(null);
  // Abo-Ausgabe: Claude Code statt API-Schlüssel
  const [aboFound, setAboFound] = useState<boolean | null>(null);
  useEffect(() => {
    if (ABO) void aboStatus().then((s) => setAboFound(s.found));
  }, []);
  const ready = ABO ? aboFound === true : !!apiKey;
  // Anderes Teil gewählt: altes Ergebnis/Fehler ausblenden
  useEffect(() => setState((s) => (s.kind === "running" ? s : { kind: "idle" })), [partName]);

  const run = async () => {
    const text = prompt.trim();
    const part = plate.aiPart();
    if (!text || !part || !ready) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ kind: "running", phase: "look", round: 0 });
    try {
      const job = {
        prompt: text,
        part: part.geometry,
        partName: part.name,
        lang: getLang(),
        signal: ctrl.signal,
        onProgress: (p: { phase: AiPhase; turn: number; note?: string }) => setState({ kind: "running", phase: p.phase, round: p.turn, note: p.note }),
      };
      const res = ABO ? await runAiDesignAbo(job) : await runAiDesign({ ...job, apiKey });
      if (!plate.applyAiResult(part.id, res.geometry)) throw new AiDesignError(t("Das Teil ist nicht mehr auf der Platte."));
      setState({ kind: "done", summary: res.summary || t("Fertig – an das Teil angebaut."), cost: res.costUsd });
      setPrompt("");
    } catch (e) {
      const m = errorText(e);
      setState(m ? { kind: "error", message: m } : { kind: "idle" });
    } finally {
      part.geometry.dispose();
      abort.current = null;
    }
  };

  const saveKey = async () => {
    const k = keyDraft.trim();
    if (!k) return;
    await saveSettings({ ...getState().settings, aiKey: k });
    setKeyDraft("");
  };

  // Ohne einzelnes ausgewähltes Teil nur sichtbar, solange ein Auftrag läuft oder sein Ergebnis steht
  if (hidden || (!partName && state.kind !== "running" && state.kind !== "done")) return null;

  if (!open) {
    return (
      <button className="ai-bar-fab card" onClick={() => setOpen(true)} title={t("KI-Designer")}>
        <Sparkles size={16} /> {t("KI-Designer")}
      </button>
    );
  }

  const running = state.kind === "running";
  return (
    <div className={`ai-bar card${running ? " busy" : ""}`} role="form" aria-label={t("KI-Designer")}>
      <div className="ai-bar-head">
        <Sparkles size={15} className="ai-spark" />
        <span className="label">{t("KI-Designer")}</span>
        {partName && <span className="small muted ai-target">{t("für „{n}“", { n: partName })}</span>}
        {!running && (
          <button className="icon-btn" aria-label={t("Schließen")} onClick={() => setOpen(false)}>
            <X size={14} />
          </button>
        )}
      </div>

      {ABO && !ready ? (
        <div className="ai-key">
          <span className="small">
            {aboFound === null
              ? t("Suche Claude Code …")
              : t("Diese Ausgabe nutzt dein Claude-Abo über Claude Code. Claude Code wurde nicht gefunden – bitte installieren, einmal im Terminal „claude“ starten, mit dem Abo anmelden und Druckerwacht neu starten.")}
          </span>
          {aboFound === false && (
            <code className="small">{navigator.userAgent.includes("Windows") ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash"}</code>
          )}
        </div>
      ) : !ready ? (
        <div className="ai-key">
          <span className="small">{t("Der KI-Designer nutzt Claude von Anthropic mit deinem eigenen API-Schlüssel. Ein Auftrag kostet meist nur ein paar Cent bis etwa 50 Cent – abgerechnet direkt bei Anthropic.")}</span>
          <span className="ai-row">
            <KeyRound size={15} className="muted" />
            <input
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveKey()}
              aria-label={t("API-Schlüssel")}
            />
            <button className="btn sm primary" disabled={!keyDraft.trim()} onClick={() => void saveKey()}>
              {t("Speichern")}
            </button>
          </span>
          <button className="link small" onClick={() => void openProjectLink(KEY_URL)}>
            <ExternalLink size={12} /> {t("Schlüssel bei Anthropic anlegen")}
          </button>
          <span className="small muted">{t("Der Schlüssel bleibt nur auf diesem Computer und landet nie in Sicherungen.")}</span>
        </div>
      ) : (
        <>
          {running ? (
            <div className="ai-status" aria-live="polite">
              <Loader2 size={15} className="spin" />
              <span>{PHASE[state.phase]()}</span>
              {state.round > 1 && <span className="small muted num">{t("Runde {n}", { n: state.round })}</span>}
              <button className="btn sm ghost" onClick={() => abort.current?.abort()}>
                <Square size={12} /> {t("Stopp")}
              </button>
              {state.note && <span className="small muted ai-note">{state.note}</span>}
            </div>
          ) : (
            <>
              <span className="ai-row">
                <textarea
                  className="input ai-input"
                  rows={2}
                  maxLength={1000}
                  placeholder={t("Was soll die KI am Teil ändern? Einfach beschreiben …")}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void run();
                    }
                  }}
                />
                <button className="btn primary ai-send" disabled={!prompt.trim() || !partName} onClick={() => void run()} aria-label={t("Bauen")}>
                  <Send size={15} /> {t("Bauen")}
                </button>
              </span>
              {state.kind === "idle" && (
                <span className="ai-examples">
                  {EXAMPLES().map((x) => (
                    <button key={x} className="chip-btn" onClick={() => setPrompt(x)}>
                      {x}
                    </button>
                  ))}
                </span>
              )}
            </>
          )}
          {state.kind === "done" && (
            <div className="ai-result">
              <span>{state.summary}</span>
              <span className="ai-row">
                <span className="small muted num">{ABO ? t("Über dein Claude-Abo") : t("Kosten ca. {c} $", { c: state.cost < 0.01 ? `< ${fmtNum(0.01, 2)}` : fmtNum(state.cost, 2) })}</span>
                <button className="btn sm ghost" onClick={() => (plate.undo(), setState({ kind: "idle" }))}>
                  <Undo2 size={13} /> {t("Rückgängig")}
                </button>
              </span>
            </div>
          )}
          {state.kind === "error" && <div className="ai-error small">{state.message}</div>}
        </>
      )}
    </div>
  );
}
