#!/usr/bin/env node
/**
 * lens-mcp: a Model Context Protocol server (stdio) that lets an agent open, edit, preview and
 * export Lens projects. Same operations as the lens CLI (project.ts), exposed as tools with JSON
 * schemas, plus resources (project JSON, transcript, a rendered preview frame as PNG).
 *
 * Sandbox: every path must resolve (symlinks followed) inside the allowed root
 * (`lens-mcp --root <dir>`, $LENS_MCP_ROOT, default: the working directory). Paths stored in a
 * project (audio tracks, logo, fonts) are checked on every write and before every render. There is
 * no shell tool: the only processes started are Lens's own renderer / transcriber / translator /
 * scanner scripts, with argument arrays.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LensError, notFound, usage } from "./errors.js";
import * as ops from "./project.js";
import { Sandbox } from "./sandbox.js";
import { runScript } from "./script.js";

type Json = Record<string, unknown>;
type Schema = { type: string; description?: string; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; additionalProperties?: boolean | Schema; minimum?: number; maximum?: number; oneOf?: Schema[] };

const S = {
  str: (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "string", description, ...extra }),
  num: (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "number", description, ...extra }),
  int: (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "integer", description, ...extra }),
  bool: (description: string): Schema => ({ type: "boolean", description }),
  strs: (description: string): Schema => ({ type: "array", description, items: { type: "string" } }),
  obj: (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({ type: "object", ...(description ? { description } : {}), properties, required, additionalProperties: false }),
};
const project = S.str("Project folder (inside the root). Default: the project opened last with project_open / project_new.");
const time = (d: string): Schema => ({ type: "time", description: `${d}: ms as a number, or a string "1.5s", "800ms", "m:ss"` });

interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  run: (a: Json, s: State) => Promise<unknown> | unknown;
  /** sets the current project from the result's `project` */
  opens?: boolean;
}

interface State {
  ctx: ops.Ctx;
  current: string | null;
  lastFrame: number;
}

const dirOf = (a: Json, s: State): string => {
  const d = (a.project as string | undefined) ?? s.current;
  if (!d) throw notFound("no project open (call project_open first, or pass project)");
  return d;
};

export const TOOLS: Tool[] = [
  {
    name: "project_new",
    description: "Create a Lens project folder from a recording (copy of an existing bundle, or screen + meta + events files). Idempotent: the same inputs again change nothing. Opens it.",
    inputSchema: S.obj({ dir: S.str("New project folder"), from: S.str("Existing bundle folder to copy"), screen: S.str("screen.mp4 (cursorless screen recording)"), meta: S.str("meta.json"), events: S.str("events.jsonl"), cam: S.str("cam.mp4"), mic: S.str("mic.wav"), transcript: S.str("transcript.json"), force: S.bool("overwrite files that differ") }, ["dir"]),
    run: (a, s) => ops.projectNew(s.ctx, a.dir as string, a as ops.NewOptions),
    opens: true,
  },
  {
    name: "project_open",
    description: "Open a Lens project folder (checks it and makes it the default for the other tools).",
    inputSchema: S.obj({ project: S.str("Project folder") }, ["project"]),
    run: (a, s) => ops.projectOpen(s.ctx, a.project as string),
    opens: true,
  },
  {
    name: "project_info",
    description: "Summary of the project: output size and duration, planned zoom segments, cuts, captions and languages, takes, privacy and step-label review counts, brand.",
    inputSchema: S.obj({ project }),
    run: (a, s) => ops.projectInfo(s.ctx, dirOf(a, s)),
  },
  {
    name: "plan",
    description: "Build the render plan (per-frame camera, cursor, captions...) and write it to <project>/.lens/plan.json. Returns its hash and counts.",
    inputSchema: S.obj({ project, language: S.str("caption language (a translated track) or source") }),
    run: (a, s) => ops.plan(s.ctx, dirOf(a, s), { language: a.language as string | undefined }),
  },
  {
    name: "export",
    description: "Render the project to MP4 or GIF, or write the captions as SRT / VTT (output clock: cuts and speed applied). Default output: <project>/exports/<name>.<format>.",
    inputSchema: S.obj({ project, format: S.str("output format", { enum: ["mp4", "gif", "srt", "vtt"] }), out: S.str("output file inside the root"), language: S.str("caption language to burn in / write"), crf: S.int("x264 quality 0..51 (default 18)", { minimum: 0, maximum: 51 }), x264Preset: S.str("x264 speed preset", { enum: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"] }) }),
    run: (a, s) => ops.exportProject(s.ctx, dirOf(a, s), a as ops.ExportOptions),
  },
  {
    name: "render_frame",
    description: "Render one output frame exactly as the export draws it and return it as a PNG image, so you can see the effect of an edit. Give frame (output frame index) or atMs (output time).",
    inputSchema: S.obj({ project, frame: S.int("output frame index", { minimum: 0 }), atMs: S.num("output time in ms", { minimum: 0 }), out: S.str("also keep the PNG here (inside the root)"), language: S.str("caption language") }),
    run: (a, s) => ops.renderFrame(s.ctx, dirOf(a, s), a as { frame?: number; atMs?: number; out?: string }),
  },
  {
    name: "transcribe",
    description: "Transcribe the mic track on-device (faster-whisper) into transcript.json. Skips when a transcript exists unless force.",
    inputSchema: S.obj({ project, force: S.bool("transcribe again"), model: S.str("faster-whisper model (default base.en)") }),
    run: (a, s) => ops.transcribe(s.ctx, dirOf(a, s), a as { force?: boolean; model?: string }),
  },
  {
    name: "translate",
    description: "Translate the captions on-device into caption tracks (es, fr, de, ur, ar) and optionally select one for the burned-in captions.",
    inputSchema: S.obj({ project, to: S.strs("target language codes"), select: S.str("caption language to select (or source)") }, ["to"]),
    run: (a, s) => ops.translate(s.ctx, dirOf(a, s), { to: a.to as string[], select: a.select as string | undefined }),
  },
  {
    name: "takes_list",
    description: "Retake groups found in the transcript, with the kept take of each.",
    inputSchema: S.obj({ project }),
    run: (a, s) => ops.takesList(s.ctx, dirOf(a, s)),
  },
  {
    name: "takes_set",
    description: "Turn retake detection on/off, choose the strategy (last | best), or keep a given take in a group.",
    inputSchema: S.obj({ project, enabled: S.bool("detect retakes"), strategy: S.str("which take to keep", { enum: ["last", "best"] }), group: S.str("group index or id"), keep: S.int("take index to keep in that group", { minimum: 0 }) }),
    run: (a, s) => ops.takesSet(s.ctx, dirOf(a, s), { ...(a as Json), group: a.group === undefined ? undefined : String(a.group) } as never),
  },
  {
    name: "privacy_scan",
    description: "Scan the recording on-device for sensitive text (emails, phones, cards, API keys, tokens, IPs, notifications) and add the findings for review.",
    inputSchema: S.obj({ project, force: S.bool("scan again even if cached") }),
    run: (a, s) => ops.privacyScan(s.ctx, dirOf(a, s), a as { force?: boolean }),
  },
  {
    name: "privacy_review",
    description: "Accept (blur) or dismiss privacy detections. No ids = all.",
    inputSchema: S.obj({ project, state: S.str("review state", { enum: ["accepted", "dismissed", "pending"] }), ids: S.strs("detection ids") }, ["state"]),
    run: (a, s) => ops.privacyReview(s.ctx, dirOf(a, s), a.state as "accepted", (a.ids as string[] | undefined) ?? null),
  },
  {
    name: "steps_generate",
    description: 'Draft step labels ("Click Save") from the clicks with on-device OCR, for review.',
    inputSchema: S.obj({ project, force: S.bool("generate again") }),
    run: (a, s) => ops.stepsGenerate(s.ctx, dirOf(a, s), a as { force?: boolean }),
  },
  {
    name: "steps_review",
    description: "Accept step-label drafts (they become numbered badges) or dismiss them. No ids = all.",
    inputSchema: S.obj({ project, state: S.str("review state", { enum: ["accepted", "dismissed", "pending"] }), ids: S.strs("draft ids") }, ["state"]),
    run: (a, s) => ops.stepsReview(s.ctx, dirOf(a, s), a.state as "accepted", (a.ids as string[] | undefined) ?? null),
  },
  {
    name: "preset_list",
    description: "Built-in look presets and the section names a preset can apply.",
    inputSchema: S.obj({}),
    run: () => ops.presetList(),
  },
  {
    name: "preset_apply",
    description: "Apply a built-in preset (by name) or a .lenspreset file, all sections or some.",
    inputSchema: S.obj({ project, preset: S.str("built-in preset name / id, or a .lenspreset file inside the root"), sections: S.strs("sections to apply (default all)") }, ["preset"]),
    run: (a, s) => ops.presetApply(s.ctx, dirOf(a, s), a.preset as string, a.sections as string[] | undefined),
  },
  {
    name: "brand_set",
    description: "Set the brand kit: colours, font, name, logo (PNG inside the root; copied into the project) and watermark. Other brand fields via json (merged).",
    inputSchema: S.obj({ project, primary: S.str("#rrggbb"), accent: S.str("#rrggbb"), font: S.str("font family"), name: S.str("brand name"), logo: S.str("PNG logo file"), watermark: S.bool("show the logo as a watermark"), enabled: S.bool("brand kit on"), json: { type: "object", description: "partial BrandKit merged in" } }),
    run: (a, s) => ops.brandSet(s.ctx, dirOf(a, s), a as ops.BrandOptions),
  },
  {
    name: "get",
    description: "Read a value from project.json by JSON pointer (empty = whole project).",
    inputSchema: S.obj({ project, pointer: S.str('JSON pointer, e.g. "/zoom/segments"') }),
    run: (a, s) => ops.get(s.ctx, dirOf(a, s), (a.pointer as string | undefined) ?? ""),
  },
  {
    name: "set",
    description: "Set a value in project.json by JSON pointer (validated by the engine; arrays: index or - to append). Returns the change list.",
    inputSchema: S.obj({ project, pointer: S.str('JSON pointer, e.g. "/captions/style/fontSize"'), value: { type: "any" as string, description: "any JSON value" }, create: S.bool("allow adding a key that does not exist yet") }, ["pointer", "value"]),
    run: (a, s) => ops.set(s.ctx, dirOf(a, s), a.pointer as string, a.value, { create: a.create as boolean | undefined }),
  },
  {
    name: "zoom_add",
    description: "Add (or replace, same id) a manual zoom on a time range of the recording. focus: [x, y] in source px, or follow (the cursor).",
    inputSchema: S.obj({ project, start: time("start (recording time)"), end: time("end"), scale: S.num("magnification, e.g. 2", { minimum: 1 }), focus: { type: "any" as string, description: '[x, y] source px, "x,y", or "follow"' }, id: S.str("segment id (default zoom-<start>-<end>)") }, ["start", "end"]),
    run: (a, s) => ops.zoomAdd(s.ctx, dirOf(a, s), a as unknown as ops.ZoomOptions),
  },
  {
    name: "cut_add",
    description: "Cut a time range of the recording out of the video (audio and captions follow).",
    inputSchema: S.obj({ project, start: time("start"), end: time("end") }, ["start", "end"]),
    run: (a, s) => ops.cutAdd(s.ctx, dirOf(a, s), { start: a.start, end: a.end }),
  },
  {
    name: "annotate",
    description: "Add (or replace, same id) an annotation: text, arrow, rect, ellipse, badge or callout, with start / end times, rect [x,y,w,h], from / to / at [x,y] in source px.",
    inputSchema: S.obj({ project, annotation: { type: "object", description: 'e.g. {"kind":"text","text":"Click Save","start":"2s","end":"4s","rect":[900,520,300,0]}' } }, ["annotation"]),
    run: (a, s) => ops.annotate(s.ctx, dirOf(a, s), a.annotation as Json),
  },
  {
    name: "captions",
    description: "Merge caption settings (enabled, wordHighlight, style: fontSize, position, colours, maxWordsPerLine, maxCharsPerLine...).",
    inputSchema: S.obj({ project, captions: { type: "object", description: "partial captions settings" } }, ["captions"]),
    run: (a, s) => ops.captions(s.ctx, dirOf(a, s), a.captions as Json),
  },
  {
    name: "run_script",
    description: "Run a demo-as-code script (.lens.yaml inside the root): a list of edits and exports applied in order.",
    inputSchema: S.obj({ script: S.str("script file"), project: S.str("override the script's project") }, ["script"]),
    run: (a, s) => runScript(s.ctx, a.script as string, { project: a.project as string | undefined }),
  },
];

/** Minimal JSON-schema check for tool arguments (types, enums, required, no unknown keys). */
export function validateArgs(schema: Schema, v: unknown, at = "arguments"): void {
  if (schema.type === "any") return;
  if (schema.type === "time") {
    if (!((typeof v === "number" && Number.isFinite(v)) || typeof v === "string")) throw usage(`${at} must be a number (ms) or a time string`);
    return;
  }
  const t = schema.type;
  const ok =
    t === "object" ? typeof v === "object" && v !== null && !Array.isArray(v) : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === t;
  if (!ok) throw usage(`${at} must be ${t === "integer" ? "an integer" : `a ${t}`}`);
  if (schema.enum && !schema.enum.includes(v)) throw usage(`${at} must be one of ${schema.enum.join(", ")}`);
  if (typeof v === "number") {
    if (schema.minimum !== undefined && v < schema.minimum) throw usage(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) throw usage(`${at} must be <= ${schema.maximum}`);
  }
  if (t === "array" && schema.items) (v as unknown[]).forEach((x, i) => validateArgs(schema.items!, x, `${at}[${i}]`));
  if (t === "object" && schema.properties) {
    const o = v as Json;
    for (const r of schema.required ?? []) if (o[r] === undefined) throw usage(`${at}.${r} is required`);
    for (const [k, x] of Object.entries(o)) {
      const ps = schema.properties[k];
      if (!ps) {
        if (schema.additionalProperties === false) throw usage(`${at}.${k} is not a known argument`);
        continue;
      }
      if (x !== undefined) validateArgs(ps, x, `${at}.${k}`);
    }
  }
}

/** JSON schema as published (our "any" becomes no type constraint). */
function publish(s: Schema): Json {
  if (s.type === "any") return { description: s.description };
  if (s.type === "time") return { anyOf: [{ type: "number" }, { type: "string" }], description: s.description };
  const out: Json = { ...s };
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, publish(v)]));
  if (s.items) out.items = publish(s.items);
  return out;
}

export function createServer(opts: { root: string }): Server {
  const sandbox = new Sandbox(opts.root);
  const server = new Server({ name: "lens-mcp", version: "0.1.0" }, { capabilities: { tools: {}, resources: {}, logging: {} } });
  const state: State = { ctx: { sandbox }, current: null, lastFrame: 0 };
  let lastLog = 0;
  state.ctx.progress = (line) => {
    const now = Date.now();
    if (now - lastLog < 1000) return;
    lastLog = now;
    void server.sendLoggingMessage({ level: "info", logger: "lens", data: line }).catch(() => undefined);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: publish(t.inputSchema) as { type: "object" } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    const args = (req.params.arguments ?? {}) as Json;
    try {
      if (!tool) throw usage(`unknown tool ${req.params.name}`);
      validateArgs(tool.inputSchema, args);
      const result = (await tool.run(args, state)) as Json;
      if (tool.opens && typeof result.project === "string") state.current = result.project;
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      if (tool.name === "render_frame") {
        state.lastFrame = result.frame as number;
        content.push({ type: "image", data: fs.readFileSync(result.out as string).toString("base64"), mimeType: "image/png" });
      }
      content.push({ type: "text", text: JSON.stringify(result) });
      return { content, structuredContent: result };
    } catch (e) {
      const le = e instanceof LensError ? e : new LensError("failed", e instanceof Error ? e.message : String(e));
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: le.toJSON() }) }], structuredContent: { error: le.toJSON() } };
    }
  });

  const RES = {
    project: "lens://project/project.json",
    transcript: "lens://project/transcript.json",
    info: "lens://project/info.json",
    preview: "lens://project/preview.png",
  };

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    if (!state.current) return { resources: [] };
    const name = path.basename(state.current);
    const r = [
      { uri: RES.project, name: `${name} project.json`, mimeType: "application/json", description: "The edit (project.json) of the open project" },
      { uri: RES.info, name: `${name} info`, mimeType: "application/json", description: "Summary: output, zooms, cuts, captions, review counts" },
      { uri: RES.preview, name: `${name} preview frame`, mimeType: "image/png", description: "The last frame render_frame drew (frame 0 before that), rendered now" },
    ];
    if (fs.existsSync(path.join(state.current, "transcript.json"))) r.splice(1, 0, { uri: RES.transcript, name: `${name} transcript`, mimeType: "application/json", description: "Word-level transcript" });
    return { resources: r };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: "lens://project/frame/{n}.png", name: "Output frame n", mimeType: "image/png", description: "Output frame n of the open project, rendered as the export draws it" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (!state.current) throw new Error("no project open");
    const dir = state.current;
    if (uri === RES.project) return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(ops.load(state.ctx, dir).project, null, 1) }] };
    if (uri === RES.info) return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(ops.projectInfo(state.ctx, dir)) }] };
    if (uri === RES.transcript) {
      const f = path.join(dir, "transcript.json");
      if (!fs.existsSync(f)) throw new Error("no transcript");
      return { contents: [{ uri, mimeType: "application/json", text: fs.readFileSync(f, "utf8") }] };
    }
    const m = /^lens:\/\/project\/frame\/(\d+)\.png$/.exec(uri);
    if (uri === RES.preview || m) {
      const frame = m ? Number(m[1]) : state.lastFrame;
      const r = await ops.renderFrame(state.ctx, dir, { frame });
      return { contents: [{ uri, mimeType: "image/png", blob: fs.readFileSync(r.out).toString("base64") }] };
    }
    throw new Error(`unknown resource ${uri}`);
  });

  return server;
}

export async function startStdio(argv: string[]): Promise<void> {
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv[i + 1] : process.env.LENS_MCP_ROOT ?? process.cwd();
  if (!root) throw usage("--root needs a folder");
  const server = createServer({ root });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStdio(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`lens-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(e instanceof LensError ? e.exit : 1);
  });
}
