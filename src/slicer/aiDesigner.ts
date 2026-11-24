/**
 * KI-Designer: Man beschreibt in eigenen Worten, was am Teil auf der Platte geändert werden soll
 * („Haken zum Aufhängen hinten dran“, „Loch für eine M4-Schraube“, „Name vorne eingravieren“).
 * Claude sieht das Teil (vier Ansichten + Maße), tastet die Oberfläche ab, probiert Entwürfe aus
 * und erst ein Entwurf, der fest mit dem Teil verbunden ist, kommt auf die Platte.
 *
 * Läuft mit dem eigenen API-Schlüssel des Nutzers direkt von diesem Computer zu Anthropic.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as THREE from "three";
import { evaluate, OpError, parseOps, sliceOutline, type Evaluation, type V3 } from "./aiGeometry";
import { renderViews } from "./aiRender";

export const AI_MODEL = "claude-opus-5-5";
const MAX_TURNS = 16;

export type AiPhase = "look" | "think" | "probe" | "slice" | "try" | "apply";
export interface AiProgress {
  phase: AiPhase;
  turn: number;
  /** Kurzer Gedanke/Zwischentext der KI, falls vorhanden */
  note?: string;
}
export interface AiResult {
  geometry: THREE.BufferGeometry;
  summary: string;
  costUsd: number;
}

/** Fehler mit Text für die Oberfläche */
export class AiDesignError extends Error {
  constructor(
    message: string,
    readonly kind: "key" | "offline" | "limit" | "refused" | "gave-up" | "part" | "other" = "other",
  ) {
    super(message);
  }
}

const LANG: Record<string, string> = { de: "German", en: "English", es: "Spanish", fr: "French", pl: "Polish" };

const SYSTEM = `You are the design assistant inside Druckerwacht, a 3D-printing app. The user has a part on the print bed and describes a change in plain words (often German): add a hook, a hole, a mounting tab, engrave or emboss text, a slot, a handle, fillets/feet, a stand, a lid recess, etc. You build that change as CSG operations that are fused EXACTLY with the existing part, so the result is one solid, printable body.

Coordinates: millimetres, bed coordinates. X = right, Y = back (away from the viewer), Z = up, the bed is z = 0. "Front" means the -Y side, "back" the +Y side, "left" -X, "right" +X, "top" +Z. All coordinates in tool calls are absolute bed coordinates, never relative to the part.

Operations (applied in order to the part):
{"op": "add" | "cut", "shape": SHAPE}
SHAPE is one of:
- {"type":"box","center":[x,y,z],"size":[sx,sy,sz],"rotate":[rx,ry,rz] (optional, degrees, applied about X then Y then Z around the box centre),"round":r (optional edge radius)}
- {"type":"cylinder","from":[x,y,z],"to":[x,y,z],"radius":r,"radius2":r2 (optional radius at "to", makes a cone)}
- {"type":"sphere","center":[x,y,z],"radius":r}
- {"type":"tube","points":[[x,y,z],...],"radius":r}  a round rod through the points with rounded joints and ends. Ideal for hooks, handles, loops, rails, bent wire shapes. Use many points (every 5-15 degrees) for smooth curves.
- {"type":"ring","center":[x,y,z],"axis":[ax,ay,az],"start":[sx,sy,sz] (optional),"radius":R,"thickness":t,"degrees":d (optional, default 360)}  a torus/arc of round rod: R = distance from centre to rod centre, t = rod diameter. The arc starts in direction "start" (projected perpendicular to axis) and turns counter-clockwise around "axis" (right-hand rule) by "degrees". Ends are rounded.
- {"type":"extrude","origin":[x,y,z],"axis":[ax,ay,az],"xdir":[x,y,z] (optional),"polygon":[[u,v],...],"height":h}  a 2D profile extruded along axis from origin by height. Local u runs along xdir, local v = axis × xdir. Great for brackets, gussets, tabs, plates, keyholes, custom outlines.
- {"type":"text","text":"...","at":[x,y,z],"normal":[nx,ny,nz],"up":[ux,uy,uz] (optional),"size":cap height mm,"depth":mm}  "at" is a point ON the surface (centre of the text), "normal" is the outward surface normal. With op "add" the text is embossed (sinks 0.3 mm in, stands out by depth); with op "cut" it is engraved (depth deep). "up" is the reading-up direction (default: +Z on side walls, +Y on top faces).

Rules for a good result:
1. Look at the four views and the measurements first. Then measure the real surface where you attach things with probe_surface (rays) and slice_outline (horizontal cross-sections). Never guess where a curved or irregular surface is.
2. Everything you add must overlap the part by about 0.5-1.5 mm (sink it into the surface), otherwise it floats. Things that only touch are not connected.
3. Cuts must actually intersect the part. Through-holes should extend about 1 mm beyond both sides. Engravings 0.6-1.2 mm deep; embossed text 0.6-1.5 mm high; text cap height at least 5 mm for FDM.
4. Design for FDM printing in the current orientation: nothing below z = 0, avoid large overhangs (>45 deg) where possible, minimum wall/rod thickness about 2 mm, hooks/clips strong enough (rod 4-6 mm or more for hanging hooks). Use sensible real-world sizes (M3 hole 3.4 mm, M4 4.5 mm, M5 5.5 mm, screw head counterbores, keyhole slots for wall screws, etc.).
5. Call try_design to check a draft: it reports per operation whether it overlaps/removes material, whether the result has extra separate pieces, and returns an image of the result. Fix every reported problem. Look at the image critically: does it match what the user asked for and look good?
6. When the draft is right, call apply_design with the same operations and a short friendly summary (1-3 sentences, in LANGUAGE) of what you built, with key dimensions. apply_design is mandatory to finish; you cannot change anything any other way.
7. If the request is impossible or unclear, still make the most sensible interpretation, and mention it in the summary.
Keep it efficient: usually 1-3 probing rounds and 1-3 try_design rounds are enough.`;

const v3 = {
  type: "array",
  items: { type: "number" },
  minItems: 3,
  maxItems: 3,
} as const;

const opsSchema = {
  type: "array",
  description: "CSG operations, applied in order. See the system prompt for the shape types.",
  items: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["add", "cut"] },
      shape: { type: "object", description: "One SHAPE object with a 'type' field (box, cylinder, sphere, tube, ring, extrude, text)." },
    },
    required: ["op", "shape"],
  },
} as const;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "probe_surface",
    description:
      "Shoots rays at the part and returns the first hit of each ray: the surface point, the outward surface normal and the distance. Use it to find exactly where walls, faces and curved surfaces are before attaching or cutting something. Up to 64 rays per call.",
    input_schema: {
      type: "object",
      properties: {
        rays: {
          type: "array",
          maxItems: 64,
          items: { type: "object", properties: { origin: v3, direction: v3 }, required: ["origin", "direction"] },
        },
      },
      required: ["rays"],
    },
  },
  {
    name: "slice_outline",
    description: "Returns the outline polygons (x, y) of the part's horizontal cross-section at height z. Useful to understand the shape and wall thickness at a given height.",
    input_schema: { type: "object", properties: { z: { type: "number" } }, required: ["z"] },
  },
  {
    name: "try_design",
    description:
      "Applies the operations to a copy of the part and reports: per operation whether an 'add' overlaps the part (volumeEffect = overlap in mm³) or a 'cut' removes material, the number of separate pieces before/after, the bounding box, the problems found, and an image of the result (orange = result, four views). Nothing is changed on the bed.",
    input_schema: { type: "object", properties: { operations: opsSchema }, required: ["operations"] },
  },
  {
    name: "apply_design",
    description:
      "Final step: applies the operations to the part on the bed (the user can undo). It is refused if an add does not overlap, a cut removes nothing or the result has extra separate pieces – then fix and call again.",
    input_schema: {
      type: "object",
      properties: { operations: opsSchema, summary: { type: "string", description: "1-3 friendly sentences for the user about what was built, with key dimensions." } },
      required: ["operations", "summary"],
    },
  },
];

const fmt = (e: Evaluation) => JSON.stringify(e);

/** Strahlen gegen das Teil (Bettkoordinaten) */
function probe(mesh: THREE.Mesh, input: unknown) {
  const rays = (input as { rays?: unknown })?.rays;
  if (!Array.isArray(rays) || !rays.length) throw new OpError("rays must be a non-empty array");
  const rc = new THREE.Raycaster();
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return rays.slice(0, 64).map((ray, i) => {
    const o = (ray as { origin?: unknown }).origin;
    const d = (ray as { direction?: unknown }).direction;
    if (!Array.isArray(o) || o.length !== 3 || !Array.isArray(d) || d.length !== 3 || [...o, ...d].some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      return { ray: i, error: "origin and direction must be [x, y, z]" };
    }
    const dir = new THREE.Vector3(...(d as V3));
    if (dir.lengthSq() < 1e-12) return { ray: i, error: "direction is zero" };
    rc.set(new THREE.Vector3(...(o as V3)), dir.normalize());
    const hit = rc.intersectObject(mesh, false)[0];
    if (!hit) return { ray: i, hit: false };
    const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3();
    // Außen-Normale: zeigt zum Strahl hin
    if (n.dot(dir) > 0) n.negate();
    return { ray: i, hit: true, point: hit.point.toArray().map(r2), normal: n.toArray().map((v) => Math.round(v * 1000) / 1000), distance: r2(hit.distance) };
  });
}

function apiError(e: unknown): AiDesignError {
  if (e instanceof AiDesignError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiDesignError(e.message, "key");
  if (e instanceof Anthropic.RateLimitError) return new AiDesignError(e.message, "limit");
  if (e instanceof Anthropic.APIUserAbortError) return new AiDesignError("abort", "other");
  if (e instanceof Anthropic.APIConnectionError) return new AiDesignError(e.message, "offline");
  if (e instanceof Anthropic.APIError) return new AiDesignError(`${e.status ?? ""} ${e.message}`.trim(), e.status === 402 || /credit|billing/i.test(e.message) ? "limit" : "other");
  return new AiDesignError(e instanceof Error ? e.message : String(e));
}

/**
 * Führt einen Design-Auftrag aus. `part` ist die Geometrie des Teils in Bettkoordinaten.
 * Liefert die neue Geometrie (Bettkoordinaten) – die Platte ist noch nicht verändert.
 */
export async function runAiDesign(opts: {
  apiKey: string;
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

  // Teil prüfen und vermessen
  let stats: Evaluation;
  try {
    stats = (await evaluate(part, [])).report;
  } catch (e) {
    throw new AiDesignError(e instanceof Error ? e.message : String(e), "part");
  }
  const probeMesh = new THREE.Mesh(part, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  probeMesh.updateMatrixWorld(true);
  part.computeBoundingBox();
  const bb = part.boundingBox!;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const size = bb.getSize(new THREE.Vector3());
  const info = [
    `Part name: ${opts.partName}`,
    `Bounding box min [${[bb.min.x, bb.min.y, bb.min.z].map(r1).join(", ")}], max [${[bb.max.x, bb.max.y, bb.max.z].map(r1).join(", ")}]`,
    `Size X ${r1(size.x)} × Y ${r1(size.y)} × Z ${r1(size.z)} mm, volume ${r1(stats.volumeBefore / 1000)} cm³, ${stats.piecesBefore} solid piece(s), ${Math.round(part.getAttribute("position").count / 3)} triangles.`,
  ].join("\n");

  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const system = SYSTEM.replace("LANGUAGE", LANG[opts.lang] ?? "German");
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: renderViews(part) } },
        { type: "text", text: `${info}\n\nUser request:\n${opts.prompt.trim()}` },
      ],
    },
  ];
  let cost = 0;
  let nudged = false;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (signal?.aborted) throw new AiDesignError("abort");
    progress({ phase: "think", turn });
    let msg: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(
        {
          model: AI_MODEL,
          max_tokens: 32000,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system,
          tools: TOOLS,
          messages,
        },
        { signal },
      );
      msg = await stream.finalMessage();
    } catch (e) {
      throw apiError(e);
    }
    const u = msg.usage;
    cost += ((u.input_tokens ?? 0) * 4 + (u.cache_creation_input_tokens ?? 0) * 5 + (u.cache_read_input_tokens ?? 0) * 0.4 + (u.output_tokens ?? 0) * 20) / 1e6;

    if (msg.stop_reason === "refusal") throw new AiDesignError(msg.stop_details?.explanation ?? "refused", "refused");
    if (msg.stop_reason === "max_tokens") throw new AiDesignError("max_tokens", "gave-up");
    messages.push({ role: "assistant", content: msg.content });

    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      if (msg.stop_reason === "pause_turn") continue;
      if (nudged) throw new AiDesignError(text || "no design", "gave-up");
      nudged = true;
      messages.push({ role: "user", content: "Please finish by calling apply_design with your operations (or try_design first if you have not checked them)." });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let done: AiResult | null = null;
    for (const use of uses) {
      const input = use.input as Record<string, unknown>;
      try {
        if (use.name === "probe_surface") {
          progress({ phase: "probe", turn, note: text || undefined });
          results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(probe(probeMesh, input)) });
        } else if (use.name === "slice_outline") {
          progress({ phase: "slice", turn, note: text || undefined });
          const z = input?.z;
          if (typeof z !== "number" || !Number.isFinite(z)) throw new OpError("z must be a number");
          const polys = await sliceOutline(part, z);
          results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(polys.length ? { z, polygons: polys } : { z, polygons: [], note: "no material at this height" }) });
        } else if (use.name === "try_design" || use.name === "apply_design") {
          const final = use.name === "apply_design";
          progress({ phase: final ? "apply" : "try", turn, note: text || undefined });
          const ops = parseOps(input?.operations);
          const { geometry, report } = await evaluate(part, ops);
          if (final) {
            if (!geometry || report.problems.length) {
              geometry?.dispose();
              results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Not applied. Fix these problems first: ${report.problems.join(" | ")}. Full report: ${fmt(report)}` });
            } else {
              const summary = typeof input?.summary === "string" ? input.summary.trim() : "";
              done = { geometry, summary, costUsd: cost };
              results.push({ type: "tool_result", tool_use_id: use.id, content: "Applied." });
            }
          } else {
            const content: Anthropic.Beta.BetaToolResultBlockParam["content"] = [{ type: "text", text: fmt(report) }];
            if (geometry) {
              content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: renderViews(geometry) } });
              geometry.dispose();
            }
            results.push({ type: "tool_result", tool_use_id: use.id, content });
          }
        } else {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}` });
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Error: ${m}` });
      }
    }
    if (done) {
      probeMesh.material.dispose();
      return done;
    }
    messages.push({ role: "user", content: results });
  }
  probeMesh.material.dispose();
  throw new AiDesignError("too many rounds", "gave-up");
}
