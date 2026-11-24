/**
 * Private Abo-Ausgabe des KI-Designers: läuft über das auf diesem Computer installierte und mit
 * dem eigenen Claude-Abo angemeldete Claude Code (`claude -p`), nicht über einen API-Schlüssel.
 * Nur in Builds mit VITE_DW_ABO=1 aktiv – nicht im öffentlichen Release.
 *
 * Claude Code kann unsere Werkzeuge nicht direkt aufrufen; es antwortet deshalb in jeder Runde mit
 * einem JSON-Block {"tool": …, "input": …}. Bilder liegen als PNG im Arbeitsordner und werden mit
 * dem Read-Werkzeug von Claude Code angesehen.
 */
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { AiDesignError, execTool, LANG, MAX_TURNS, preparePart, SYSTEM, TOOLS, type AiProgress, type AiResult } from "./aiDesigner";
import { renderViews } from "./aiRender";

export const ABO = import.meta.env.VITE_DW_ABO === "1";

interface Reply {
  text: string;
  sessionId: string;
  isError: boolean;
}

export async function aboStatus(): Promise<{ enabled: boolean; found: boolean }> {
  try {
    return await invoke("abo_status");
  } catch {
    return { enabled: false, found: false };
  }
}

const PROTOCOL = `
HOW TO USE TOOLS IN THIS SESSION: you are running inside the Druckerwacht app through Claude Code. You cannot call the design tools directly. Instead, end EVERY reply with exactly one JSON code block naming one tool call, like:
\`\`\`json
{"tool": "probe_surface", "input": {"rays": [{"origin": [0, 0, 50], "direction": [0, 0, -1]}]}}
\`\`\`
The app runs it and answers with the result. Images (the part and each try_design result) are saved as PNG files in the current directory – open them with the Read tool whenever they are mentioned. Do not use any other Claude Code tool and do not create or change files.

The tools:
${TOOLS.map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema)}`).join("\n")}
`;

/** Letzten JSON-Block der Antwort lesen */
export function parseCall(text: string): { tool: string; input: unknown } | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) {
    const i = text.lastIndexOf('{"tool"');
    if (i >= 0) blocks.push(text.slice(i));
  }
  for (const b of blocks.reverse()) {
    try {
      const v = JSON.parse(b.trim()) as { tool?: unknown; input?: unknown };
      if (typeof v.tool === "string") return { tool: v.tool, input: v.input ?? {} };
    } catch {
      /* nächster Block */
    }
  }
  return null;
}

async function round(message: string, session: string | null): Promise<Reply> {
  try {
    return await invoke<Reply>("abo_run", { message, session, model: "opus" });
  } catch (e) {
    throw new AiDesignError(typeof e === "string" ? e : String(e), "other");
  }
}

export async function runAiDesignAbo(opts: {
  prompt: string;
  part: THREE.BufferGeometry;
  partName: string;
  lang: string;
  signal?: AbortSignal;
  onProgress?: (p: AiProgress) => void;
}): Promise<AiResult> {
  const { part, signal } = opts;
  const progress = (p: AiProgress) => opts.onProgress?.(p);
  progress({ phase: "look", turn: 0 });
  const { probeMesh, info } = await preparePart(part, opts.partName);
  try {
    await invoke("abo_start");
    let img = 0;
    const saveImage = async (png: string) => {
      const name = `view-${img++}.png`;
      await invoke("abo_image", { name, data: png });
      return name;
    };
    const first = await saveImage(renderViews(part));
    let message = `${SYSTEM.replace("LANGUAGE", LANG[opts.lang] ?? "German")}\n${PROTOCOL}\n\nThe part from four sides: ${first}\n${info}\n\nUser request:\n${opts.prompt.trim()}`;
    let session: string | null = null;
    let nudged = false;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (signal?.aborted) throw new AiDesignError("abort");
      progress({ phase: "think", turn });
      const reply = await round(message, session);
      if (signal?.aborted) throw new AiDesignError("abort");
      if (reply.isError) throw new AiDesignError(reply.text || "Claude Code", "other");
      session = reply.sessionId || session;
      const call = parseCall(reply.text);
      const note = reply.text.replace(/```[\s\S]*?```/g, "").trim().slice(0, 300) || undefined;
      if (!call) {
        if (nudged) throw new AiDesignError(note ?? "no design", "gave-up");
        nudged = true;
        message = "Please end your reply with one JSON block calling a tool – finish with apply_design.";
        continue;
      }
      const r = await execTool(call.tool, call.input, { part, probeMesh, turn, note, progress });
      if (r.done) return { ...r.done, costUsd: 0 };
      message = `${r.error ? "ERROR from" : "Result of"} ${call.tool}:\n${r.text}`;
      if (r.image) message += `\nImage of the result: ${await saveImage(r.image)}`;
    }
    throw new AiDesignError("too many rounds", "gave-up");
  } finally {
    probeMesh.material.dispose();
  }
}
