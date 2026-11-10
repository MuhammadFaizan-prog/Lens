/**
 * Lens projects on disk and every operation the CLI, the MCP server and `lens run` share.
 *
 * A project is a bundle folder: screen.mp4, meta.json, events.jsonl (required), project.json (the
 * edit; written by lens), and optionally cam.mp4, transcript.json, audio files and brand assets.
 * lens keeps its own working files in <project>/.lens/ (plans, scans, frames).
 *
 * Every operation returns plain JSON. Mutations return { changed, diff } where diff lists the
 * JSON-pointer changes to project.json; running the same mutation again returns changed: false.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  applyPreset,
  applyPrivacyScan,
  applyStepDrafts,
  buildRenderPlan,
  builtinPresets,
  normalizeAnnotation,
  parseEventLog,
  parsePreset,
  parseTranscript,
  PRESET_SECTIONS,
  PresetError,
  privacyCounts,
  ProjectValidationError,
  resolveProject,
  reviewPrivacy,
  reviewSteps,
  slugify,
  DemoExportError,
  setDemoHotspot,
  stepsExportInput,
  toSrt,
  toVtt,
  TranscriptError,
  withTakeChoice,
  type Annotation,
  type InputEvent,
  type PresetSection,
  type ProjectConfig,
  type RenderPlan,
  type RecordingMeta,
  type Transcript,
} from "@lens/engine";
import { invalid, LensError, notFound, usage } from "./errors.js";
import { diffJson, getAt, parsePointer, setAt, type Change } from "./jsonpointer.js";
import { Sandbox, isInside } from "./sandbox.js";
import { mustRun, type Progress } from "./tools.js";

export const REQUIRED = ["screen.mp4", "meta.json", "events.jsonl"] as const;
const WORK = ".lens";

export interface Loaded {
  dir: string;
  id: string;
  meta: RecordingMeta;
  events: InputEvent[];
  project: ProjectConfig;
  transcript: Transcript | null;
  /** transcript.json exists but the engine rejects it: edits still work, planning / rendering throw this */
  transcriptError?: LensError;
}

export interface Ctx {
  sandbox: Sandbox;
  /** progress lines from long-running tools (stderr in the CLI, MCP logging) */
  progress?: Progress;
}

const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
export const projectId = (dir: string) => "lp_" + sha256(dir).slice(0, 12);
const canon = (p: unknown) => JSON.stringify(p, null, 1) + "\n";

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw invalid(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

function engineError(e: unknown): never {
  if (e instanceof LensError) throw e;
  if (e instanceof ProjectValidationError) throw invalid(`invalid project: ${e.message}`);
  if (e instanceof PresetError) throw invalid(`invalid preset: ${e.message}`);
  if (e instanceof TranscriptError) throw invalid(`invalid transcript: ${e.message}`);
  throw new LensError("failed", e instanceof Error ? e.message : String(e));
}

export function resolveDir(ctx: Ctx, dir: string | undefined): string {
  return ctx.sandbox.resolve(dir ?? process.env.LENS_PROJECT ?? ".", { what: "project" });
}

export function load(ctx: Ctx, dirArg: string | undefined): Loaded {
  const dir = resolveDir(ctx, dirArg);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw notFound(`project ${dirArg ?? dir} does not exist`);
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) throw notFound(`not a Lens project (missing ${missing.join(", ")}): ${dirArg ?? dir}`);
  try {
    const meta = readJson(path.join(dir, "meta.json"), "meta.json") as RecordingMeta;
    const events = parseEventLog(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"));
    const pf = path.join(dir, "project.json");
    const project = resolveProject(fs.existsSync(pf) ? readJson(pf, "project.json") : {});
    const tf = path.join(dir, "transcript.json");
    let transcript: Transcript | null = null;
    let transcriptError: LensError | undefined;
    if (fs.existsSync(tf)) {
      try {
        transcript = parseTranscript(readJson(tf, "transcript.json"));
      } catch (e) {
        transcriptError = invalid(`transcript.json: ${e instanceof Error ? e.message : String(e)} (run lens transcribe --force, or fix the file)`);
      }
    }
    return { dir, id: projectId(dir), meta, events, project, transcript, ...(transcriptError ? { transcriptError } : {}) };
  } catch (e) {
    engineError(e);
  }
}

/** Every file path a project stores must stay inside the root (the renderer reads them). */
export function checkStoredPaths(ctx: Ctx, dir: string, p: ProjectConfig): void {
  const check = (v: string | null | undefined, what: string) => {
    if (!v || v.startsWith("builtin:")) return;
    if (v.startsWith("system:")) {
      if (/[\\/]|\.\./.test(v.slice(7))) throw new LensError("outside_root", `${what} ${v}: a system font is a file name only`);
      return;
    }
    if (path.isAbsolute(v) && !ctx.sandbox.root) return;
    ctx.sandbox.checkStored(dir, v, what);
  };
  p.audio.tracks.forEach((t, i) => check(t.path, `audio.tracks[${i}].path`));
  check(p.brand.logo.path, "brand.logo.path");
  p.brand.customFonts.forEach((f, i) => {
    check(f.regular, `brand.customFonts[${i}].regular`);
    check(f.bold, `brand.customFonts[${i}].bold`);
  });
}

export type Mutation = {
  project: string;
  changed: boolean;
  diff: Change[];
};

/** Validate, check stored paths, write project.json only when it changed. */
export function save(ctx: Ctx, l: Loaded, next: unknown): Mutation {
  let resolved: ProjectConfig;
  try {
    resolved = resolveProject(next);
  } catch (e) {
    engineError(e);
  }
  checkStoredPaths(ctx, l.dir, resolved);
  const diff = diffJson(l.project, resolved);
  const file = path.join(l.dir, "project.json");
  const text = canon(resolved);
  const onDisk = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (onDisk !== text) fs.writeFileSync(file, text);
  l.project = resolved;
  return { project: l.dir, changed: diff.length > 0, diff };
}

function workDir(l: Loaded, ...sub: string[]): string {
  const d = path.join(l.dir, WORK, ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ------------------------------------------------------------------ project new / open / info

export interface NewOptions {
  from?: string;
  screen?: string;
  meta?: string;
  events?: string;
  cam?: string;
  mic?: string;
  transcript?: string;
  project?: string;
  force?: boolean;
}

export function projectNew(ctx: Ctx, dirArg: string, o: NewOptions): { project: string; id: string; created: boolean; files: string[] } {
  if (!dirArg) throw usage("project new needs a folder");
  const dir = ctx.sandbox.resolve(dirArg, { what: "project" });
  const src = (p: string | undefined, what: string) => (p ? ctx.sandbox.resolve(p, { mustExist: true, what }) : undefined);
  const from = src(o.from, "--from");
  const plan: Array<[string, string]> = [];
  const pick = (name: string, explicit: string | undefined, what: string) => {
    const s = src(explicit, what) ?? (from && fs.existsSync(path.join(from, name)) ? path.join(from, name) : undefined);
    if (s) plan.push([name, s]);
  };
  pick("screen.mp4", o.screen, "--screen");
  pick("meta.json", o.meta, "--meta");
  pick("events.jsonl", o.events, "--events");
  pick("cam.mp4", o.cam, "--cam");
  pick("mic.wav", o.mic, "--mic");
  pick("transcript.json", o.transcript, "--transcript");
  pick("project.json", o.project, "--project-file");
  for (const r of REQUIRED) if (!plan.some(([n]) => n === r)) throw usage(`project new needs ${r} (--${r.split(".")[0]} or --from <bundle>)`);
  // validate inputs before writing anything
  try {
    readJson(plan.find(([n]) => n === "meta.json")![1], "meta.json");
    parseEventLog(fs.readFileSync(plan.find(([n]) => n === "events.jsonl")![1], "utf8"));
  } catch (e) {
    engineError(e);
  }
  const conflicts = plan.filter(([n, s]) => {
    const d = path.join(dir, n);
    return fs.existsSync(d) && sha256(fs.readFileSync(d)) !== sha256(fs.readFileSync(s));
  });
  if (conflicts.length && !o.force) throw new LensError("conflict", `${dirArg} already has different ${conflicts.map(([n]) => n).join(", ")} (use --force to overwrite)`);
  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  for (const [n, s] of plan) {
    const d = path.join(dir, n);
    if (path.resolve(s) === path.resolve(d)) continue;
    if (!fs.existsSync(d) || sha256(fs.readFileSync(d)) !== sha256(fs.readFileSync(s))) {
      fs.copyFileSync(s, d);
      created = true;
    }
  }
  // project.json: given, or defaults (+ the mic track when one was copied)
  const pf = path.join(dir, "project.json");
  if (!plan.some(([n]) => n === "project.json") && !fs.existsSync(pf)) {
    const base: Record<string, unknown> = {};
    if (plan.some(([n]) => n === "mic.wav")) base.audio = { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }] };
    fs.writeFileSync(pf, canon(resolveProject(base)));
    created = true;
  }
  const l = load(ctx, dir);
  checkStoredPaths(ctx, dir, l.project);
  return { project: dir, id: l.id, created, files: fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort() };
}

export function projectOpen(ctx: Ctx, dirArg: string | undefined) {
  const l = load(ctx, dirArg);
  checkStoredPaths(ctx, l.dir, l.project);
  return {
    project: l.dir,
    id: l.id,
    source: { width: l.meta.width, height: l.meta.height, fps: l.meta.fps, durationMs: l.meta.durationMs },
    files: fs.readdirSync(l.dir).filter((f) => !f.startsWith(".")).sort(),
    hasTranscript: !!l.transcript,
    hasCamera: fs.existsSync(path.join(l.dir, "cam.mp4")),
  };
}

export function planOf(l: Loaded, opts: { onlyFrames?: number[]; language?: string | null } = {}): RenderPlan {
  if (l.transcriptError) throw l.transcriptError;
  let project = l.project;
  if (opts.language !== undefined) {
    const lang = opts.language === "source" ? null : opts.language;
    if (lang && !project.translations.tracks.some((t) => t.language === lang))
      throw notFound(`no caption track for ${lang} (have: ${project.translations.tracks.map((t) => t.language).join(", ") || "none"}; run lens translate)`);
    project = { ...project, translations: { ...project.translations, language: lang } };
  }
  try {
    return buildRenderPlan({ meta: l.meta, events: l.events, project, words: l.transcript?.words ?? [], pauses: l.transcript?.pauses, onlyFrames: opts.onlyFrames });
  } catch (e) {
    engineError(e);
  }
}

export function projectInfo(ctx: Ctx, dirArg: string | undefined) {
  const l = load(ctx, dirArg);
  const plan = planOf(l, { onlyFrames: [] });
  const p = l.project;
  const pc = privacyCounts(p);
  const steps = p.stepLabels.drafts;
  return {
    project: l.dir,
    id: l.id,
    source: { width: l.meta.width, height: l.meta.height, fps: l.meta.fps, durationMs: l.meta.durationMs },
    output: plan.output,
    zoom: {
      auto: p.zoom.auto,
      preset: p.zoom.preset,
      manualSegments: p.zoom.segments.length,
      planned: plan.zoomSegments.map((z) => ({ id: z.id, startMs: z.startMs, endMs: z.endMs, scale: z.scale, auto: z.auto })),
    },
    edits: { cuts: p.edits.cuts.length, speed: p.edits.speed.length, plannedCuts: plan.cuts.length },
    captions: {
      enabled: p.captions.enabled,
      language: p.translations.language,
      languages: p.translations.tracks.map((t) => t.language),
      cues: plan.subtitles.length,
    },
    transcript: l.transcript ? { words: l.transcript.words.length, language: l.transcript.language ?? null } : null,
    takes: { enabled: p.edits.takes.enabled, strategy: p.edits.takes.strategy, groups: plan.takes.length },
    privacy: pc,
    steps: {
      drafts: steps.length,
      pending: steps.filter((s) => s.state === "pending").length,
      accepted: steps.filter((s) => s.state === "accepted").length,
    },
    annotations: p.annotations.length,
    slides: p.slides.length,
    freezes: {
      holds: (p.freezes ?? []).length,
      holdMs: (p.freezes ?? []).reduce((t, f) => t + Math.max(0, f.endMs - f.startMs), 0),
      pauses: p.slides.filter((s) => s.kind === "freeze").length,
      images: p.slides.filter((s) => s.kind === "image").length,
    },
    brand: { enabled: p.brand.enabled, name: p.brand.name, primary: p.brand.colors.primary, accent: p.brand.colors.accent },
  };
}

// ------------------------------------------------------------------ plan / export / frame

export function plan(ctx: Ctx, dirArg: string | undefined, o: { out?: string; language?: string } = {}) {
  const l = load(ctx, dirArg);
  const pl = planOf(l, { language: o.language });
  const text = JSON.stringify(pl);
  const out = o.out ? ctx.sandbox.resolve(o.out, { what: "--out" }) : path.join(workDir(l), "plan.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  return {
    project: l.dir,
    plan: out,
    sha256: sha256(text),
    output: pl.output,
    zoomSegments: pl.zoomSegments.length,
    cuts: pl.cuts.length,
    cleanupCuts: pl.cleanupCuts.length,
    takeGroups: pl.takes.length,
    subtitles: pl.subtitles.length,
  };
}

export const EXPORT_FORMATS = ["mp4", "gif", "srt", "vtt"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  format?: string;
  out?: string;
  language?: string;
  crf?: number;
  x264Preset?: string;
}

const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];

export async function exportProject(ctx: Ctx, dirArg: string | undefined, o: ExportOptions) {
  const l = load(ctx, dirArg);
  const fromOut = o.out ? path.extname(o.out).slice(1).toLowerCase() : undefined;
  const format = (o.format ?? fromOut ?? "mp4") as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw usage(`unknown export format ${format} (${EXPORT_FORMATS.join(", ")})`);
  if (o.crf !== undefined && !(Number.isInteger(o.crf) && o.crf >= 0 && o.crf <= 51)) throw usage("--crf must be an integer 0..51");
  if (o.x264Preset !== undefined && !X264_PRESETS.includes(o.x264Preset)) throw usage(`--x264-preset must be one of ${X264_PRESETS.join(", ")}`);
  const out = ctx.sandbox.resolve(o.out ?? path.join(l.dir, "exports", `${path.basename(l.dir)}${o.language ? "." + o.language : ""}.${format}`), { what: "--out" });
  if (path.extname(out).slice(1).toLowerCase() !== format) throw usage(`--out ${o.out} does not end in .${format}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  checkStoredPaths(ctx, l.dir, l.project);
  const pl = planOf(l, { language: o.language });
  if (format === "srt" || format === "vtt") {
    if (!pl.subtitles.length) throw notFound("no captions to export (captions off, or no transcript)");
    const lang = (o.language && o.language !== "source" ? o.language : null) ?? l.project.translations.language ?? l.transcript?.language ?? undefined;
    fs.writeFileSync(out, format === "srt" ? toSrt(pl.subtitles) : toVtt(pl.subtitles, lang));
    return { project: l.dir, format, out, cues: pl.subtitles.length, bytes: fs.statSync(out).size };
  }
  const planFile = path.join(workDir(l), "plan-export.json");
  // the renderer resolves audio paths against the plan's folder; the plan lives in .lens/, so make them absolute
  if (pl.audio) pl.audio.tracks = pl.audio.tracks.map((t) => ({ ...t, path: path.isAbsolute(t.path) ? t.path : path.join(l.dir, t.path) }));
  fs.writeFileSync(planFile, JSON.stringify(pl));
  const args = ["--plan", planFile, "--screen", path.join(l.dir, "screen.mp4"), "--out", out, "--assets", l.dir, "--progress"];
  const cam = path.join(l.dir, "cam.mp4");
  if (l.project.camera.enabled && fs.existsSync(cam)) args.push("--camera", cam);
  if (o.crf !== undefined) args.push("--crf", String(o.crf));
  if (o.x264Preset) args.push("--preset", o.x264Preset);
  const run = await mustRun("render", args, { onStderr: ctx.progress });
  return { project: l.dir, format, out, frames: pl.output.frames, durationMs: pl.output.durationMs, width: pl.output.width, height: pl.output.height, fps: pl.output.fps, bytes: fs.statSync(out).size, renderMs: run.ms };
}

export async function renderFrame(ctx: Ctx, dirArg: string | undefined, o: { frame?: number; atMs?: number; out?: string; language?: string }) {
  const l = load(ctx, dirArg);
  const full = planOf(l, { onlyFrames: [], language: o.language });
  let n: number;
  if (o.frame !== undefined) n = o.frame;
  else if (o.atMs !== undefined) n = Math.round((o.atMs * full.output.fps) / 1000);
  else n = 0;
  if (!Number.isInteger(n) || n < 0 || n >= full.output.frames) throw invalid(`frame ${n} is outside 0..${full.output.frames - 1}`);
  const pl = planOf(l, { onlyFrames: [n], language: o.language });
  const dir = workDir(l, "frames");
  const planFile = path.join(dir, `plan-${n}.json`);
  fs.writeFileSync(planFile, JSON.stringify(pl));
  const out = o.out ? ctx.sandbox.resolve(o.out, { what: "--out" }) : path.join(dir, `frame-${n}.png`);
  if (!out.toLowerCase().endsWith(".png")) throw usage("--out must end in .png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ["--plan", planFile, "--screen", path.join(l.dir, "screen.mp4"), "--out", out, "--assets", l.dir];
  const cam = path.join(l.dir, "cam.mp4");
  if (l.project.camera.enabled && fs.existsSync(cam)) args.push("--camera", cam);
  await mustRun("frame", args, { onStderr: ctx.progress });
  fs.rmSync(planFile, { force: true });
  const png = fs.readFileSync(out);
  return { project: l.dir, frame: n, timeMs: Math.round((n * 1000) / full.output.fps), out, width: full.output.width, height: full.output.height, sha256: sha256(png), bytes: png.length };
}

// ------------------------------------------------------------------ interactive demo / step guide (demand #7)

export const STEPS_KINDS = ["demo", "guide"] as const;
export type StepsKind = (typeof STEPS_KINDS)[number];

/**
 * Interactive click-through demo (self-contained index.html) or step guide (Markdown + HTML + PDF)
 * from the accepted step labels. Output: a folder (default <project>/exports/<name>-<kind>/).
 */
export async function exportSteps(ctx: Ctx, dirArg: string | undefined, o: { kind: string; out?: string }) {
  const l = load(ctx, dirArg);
  if (!STEPS_KINDS.includes(o.kind as StepsKind)) throw usage(`unknown export kind ${o.kind} (demo, guide)`);
  const kind = o.kind as StepsKind;
  checkStoredPaths(ctx, l.dir, l.project);
  let input;
  try {
    input = stepsExportInput({ meta: l.meta, events: l.events, project: l.project });
  } catch (e) {
    if (e instanceof DemoExportError) throw notFound(e.message);
    engineError(e);
  }
  const out = ctx.sandbox.resolve(o.out ?? path.join(l.dir, "exports", `${path.basename(l.dir)}-${kind}`), { what: "--out" });
  if (fs.existsSync(out) && !fs.statSync(out).isDirectory()) throw usage(`--out ${o.out} is a file; give a folder`);
  fs.mkdirSync(out, { recursive: true });
  const work = workDir(l, "steps-export");
  const planFile = path.join(work, `plan-${kind}.json`);
  const manifestFile = path.join(work, `manifest-${kind}.json`);
  fs.writeFileSync(planFile, JSON.stringify(input.plan));
  fs.writeFileSync(manifestFile, JSON.stringify(input.manifest));
  const run = await mustRun("stepsExport", ["--manifest", manifestFile, "--plan", planFile, "--screen", path.join(l.dir, "screen.mp4"), "--out", out, "--kind", kind, "--assets", l.dir], { onStderr: ctx.progress });
  const res = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  const files = kind === "demo" ? ["index.html", "demo.json"] : ["guide.md", "guide.html", "guide.pdf", "guide.json"];
  return {
    project: l.dir,
    kind,
    out,
    steps: input.manifest.steps.map((s) => ({ n: s.n, id: s.stepId, label: s.label, clickMs: s.clickMs })),
    files: files.map((f) => path.join(out, f)),
    ...(kind === "demo" ? { demo: res.demo } : { guide: res.guide }),
    renderMs: run.ms,
  };
}

/** Hotspot editor from the command line: move a step's hotspot (source px) or change its tooltip; clear = back to the click and label. */
export function demoHotspot(ctx: Ctx, dirArg: string | undefined, o: { step: string; x?: number; y?: number; tooltip?: string; clear?: boolean }) {
  const l = load(ctx, dirArg);
  if (!l.project.stepLabels.drafts.some((d) => d.id === o.step)) throw notFound(`unknown step id ${o.step}`);
  const patch = o.clear ? null : { ...(o.x !== undefined ? { x: o.x } : {}), ...(o.y !== undefined ? { y: o.y } : {}), ...(o.tooltip !== undefined ? { tooltip: o.tooltip } : {}) };
  if (patch && !Object.keys(patch).length) throw usage("demo hotspot needs --x / --y / --tooltip or --clear");
  return save(ctx, l, setDemoHotspot(l.project, o.step, patch));
}

// ------------------------------------------------------------------ transcribe / translate

export async function transcribe(ctx: Ctx, dirArg: string | undefined, o: { force?: boolean; model?: string; track?: string } = {}) {
  const l = load(ctx, dirArg);
  const out = path.join(l.dir, "transcript.json");
  if (fs.existsSync(out) && !o.force && !l.transcriptError) return { project: l.dir, transcript: out, words: l.transcript?.words.length ?? 0, skipped: true };
  const id = o.track ?? l.project.transcription.track;
  const track = l.project.audio.tracks.find((t) => t.id === id) ?? l.project.audio.tracks.find((t) => t.kind === "mic");
  if (!track) throw notFound(`no audio track ${id ?? "mic"} to transcribe`);
  const audio = ctx.sandbox.checkStored(l.dir, track.path, "audio track");
  if (!fs.existsSync(audio)) throw notFound(`audio file ${track.path} does not exist`);
  const tmp = path.join(workDir(l), "transcript.new.json");
  const args = [audio, "-o", tmp, "--offset-ms", String(Math.round(track.offsetMs))];
  if (o.model ?? l.project.transcription.model) args.push("--model", o.model ?? l.project.transcription.model);
  await mustRun("transcribe", args, { onStderr: ctx.progress });
  // only a transcript the engine accepts replaces the old one
  let t: Transcript;
  try {
    t = parseTranscript(readJson(tmp, "transcript"));
  } catch (e) {
    throw new LensError("failed", `lens-transcribe wrote a transcript the engine rejects (${e instanceof Error ? e.message : String(e)}); transcript.json left unchanged, the output is in .lens/transcript.new.json`);
  }
  fs.renameSync(tmp, out);
  return { project: l.dir, transcript: out, words: t.words.length, skipped: false };
}

export async function translate(ctx: Ctx, dirArg: string | undefined, o: { to: string[]; select?: string; noDownload?: boolean }) {
  const l = load(ctx, dirArg);
  if (!o.to?.length) throw usage("translate needs --to <lang[,lang]>");
  for (const lang of o.to) if (!/^[a-z]{2,3}$/.test(lang)) throw usage(`bad language code ${lang}`);
  if (o.select && o.select !== "source" && !o.to.includes(o.select) && !l.project.translations.tracks.some((t) => t.language === o.select))
    throw usage(`--select ${o.select} is not one of the languages`);
  if (l.transcriptError) throw l.transcriptError;
  if (!l.transcript) throw notFound("no transcript.json (run lens transcribe first)");
  const before = l.project;
  const tmp = path.join(workDir(l, "translate"), "project.json");
  fs.writeFileSync(tmp, canon(before));
  const args = [path.join(l.dir, "transcript.json"), "--to", o.to.join(","), "-o", workDir(l, "translate"), "--project", tmp, "--project-out", tmp];
  if (o.select) args.push("--select", o.select);
  if (o.noDownload) args.push("--no-download");
  await mustRun("translate", args, { onStderr: ctx.progress });
  const next = readJson(tmp, "translated project");
  const m = save(ctx, l, next);
  return { ...m, languages: l.project.translations.tracks.map((t) => t.language), selected: l.project.translations.language };
}

// ------------------------------------------------------------------ takes

export function takesList(ctx: Ctx, dirArg: string | undefined) {
  const l = load(ctx, dirArg);
  if (!l.transcript) throw notFound("no transcript.json (takes are found in the transcript; run lens transcribe)");
  const pl = planOf(l, { onlyFrames: [] });
  return {
    project: l.dir,
    enabled: l.project.edits.takes.enabled,
    strategy: l.project.edits.takes.strategy,
    groups: pl.takes.map((g, i) => ({
      index: i,
      id: g.id,
      startMs: g.startMs,
      endMs: g.endMs,
      kept: g.kept,
      auto: g.auto,
      manual: g.manual,
      takes: g.takes.length,
      cues: g.cues,
    })),
  };
}

export function takesSet(ctx: Ctx, dirArg: string | undefined, o: { enabled?: boolean; strategy?: string; group?: string; keep?: number }) {
  const l = load(ctx, dirArg);
  let t = { ...l.project.edits.takes };
  if (o.enabled !== undefined) t.enabled = o.enabled;
  if (o.strategy !== undefined) {
    if (o.strategy !== "last" && o.strategy !== "best") throw usage("--strategy must be last or best");
    t.strategy = o.strategy;
  }
  if (o.group !== undefined || o.keep !== undefined) {
    if (o.group === undefined || o.keep === undefined) throw usage("choosing a take needs --group <index|id> and --keep <take index>");
    if (!l.transcript) throw notFound("no transcript.json");
    const pl = planOf({ ...l, project: { ...l.project, edits: { ...l.project.edits, takes: { ...t, enabled: true } } } }, { onlyFrames: [] });
    const g = pl.takes.find((x, i) => x.id === o.group || String(i) === o.group);
    if (!g) throw notFound(`no take group ${o.group} (have ${pl.takes.length})`);
    if (!Number.isInteger(o.keep) || o.keep < 0 || o.keep >= g.takes.length) throw invalid(`--keep must be 0..${g.takes.length - 1}`);
    t = withTakeChoice({ ...t, enabled: true }, g, o.keep);
  }
  return save(ctx, l, { ...l.project, edits: { ...l.project.edits, takes: t } });
}

// ------------------------------------------------------------------ privacy / steps

export async function privacyScan(ctx: Ctx, dirArg: string | undefined, o: { force?: boolean } = {}) {
  const l = load(ctx, dirArg);
  const dir = workDir(l, "privacy");
  const out = path.join(dir, "scan.json");
  const stamp = path.join(dir, ".stamp");
  const screenStat = fs.statSync(path.join(l.dir, "screen.mp4"));
  const key = `${screenStat.size}:${screenStat.mtimeMs}`;
  let cached = !o.force && fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === key;
  if (!cached) {
    await mustRun("redact", [path.join(l.dir, "screen.mp4"), "--events", path.join(l.dir, "events.jsonl"), "-o", out, "--thumbs", dir, "--progress"], { onStderr: ctx.progress });
    fs.writeFileSync(stamp, key);
  }
  const scan = readJson(out, "privacy scan") as { detections: never[] };
  const scannedAt = fs.statSync(out).mtime.toISOString();
  const m = save(ctx, l, applyPrivacyScan(l.project, scan, scannedAt));
  return { ...m, cached, detections: scan.detections.length, counts: privacyCounts(l.project) };
}

export function privacyReview(ctx: Ctx, dirArg: string | undefined, state: "accepted" | "dismissed" | "pending", ids: string[] | null) {
  const l = load(ctx, dirArg);
  const have = new Set(l.project.privacy.detections.map((d) => d.id));
  if (!have.size) throw notFound("no privacy detections (run lens privacy scan)");
  const bad = (ids ?? []).filter((i) => !have.has(i));
  if (bad.length) throw notFound(`unknown detection id(s): ${bad.join(", ")}`);
  const m = save(ctx, l, reviewPrivacy(l.project, ids?.length ? ids : null, state));
  return { ...m, counts: privacyCounts(l.project) };
}

export async function stepsGenerate(ctx: Ctx, dirArg: string | undefined, o: { force?: boolean } = {}) {
  const l = load(ctx, dirArg);
  const out = path.join(workDir(l), "steps.json");
  const cached = !o.force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(path.join(l.dir, "screen.mp4")).mtimeMs;
  if (!cached) await mustRun("steps", [path.join(l.dir, "screen.mp4"), "--events", path.join(l.dir, "events.jsonl"), "-o", out], { onStderr: ctx.progress });
  const drafts = (readJson(out, "steps") as { drafts: never[] }).drafts;
  const m = save(ctx, l, applyStepDrafts(l.project, drafts, fs.statSync(out).mtime.toISOString()));
  return { ...m, cached, drafts: l.project.stepLabels.drafts.map((d) => ({ id: d.id, label: d.label, clickMs: d.clickMs, state: d.state })) };
}

export function stepsReview(ctx: Ctx, dirArg: string | undefined, state: "accepted" | "dismissed" | "pending", ids: string[] | null) {
  const l = load(ctx, dirArg);
  const have = new Set(l.project.stepLabels.drafts.map((d) => d.id));
  if (!have.size) throw notFound("no step-label drafts (run lens steps generate)");
  const bad = (ids ?? []).filter((i) => !have.has(i));
  if (bad.length) throw notFound(`unknown step id(s): ${bad.join(", ")}`);
  const m = save(ctx, l, reviewSteps(l.project, ids?.length ? ids : null, state));
  return { ...m, badges: l.project.annotations.filter((a) => a.stepId).length };
}

// ------------------------------------------------------------------ presets / brand

export function presetList() {
  return { presets: builtinPresets().map((p) => ({ id: p.id, name: p.name, slug: slugify(p.name), description: p.description ?? "" })), sections: PRESET_SECTIONS };
}

export function presetApply(ctx: Ctx, dirArg: string | undefined, nameOrFile: string, sections?: string[]) {
  if (!nameOrFile) throw usage("preset apply needs a built-in preset name or a .lenspreset file");
  const l = load(ctx, dirArg);
  const key = nameOrFile.toLowerCase();
  let preset = builtinPresets().find((p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key || slugify(p.name) === key);
  if (!preset) {
    if (!/\.lenspreset$|\.json$/i.test(nameOrFile)) throw notFound(`no built-in preset ${nameOrFile} (lens preset list)`);
    const file = ctx.sandbox.resolve(nameOrFile, { mustExist: true, what: "preset file" });
    try {
      preset = parsePreset(fs.readFileSync(file, "utf8"));
    } catch (e) {
      engineError(e);
    }
  }
  const want = (sections?.length ? sections : PRESET_SECTIONS) as PresetSection[];
  for (const s of want) if (!PRESET_SECTIONS.includes(s)) throw usage(`unknown preset section ${s} (${PRESET_SECTIONS.join(", ")})`);
  const m = save(ctx, l, applyPreset(l.project, preset, want));
  return { ...m, preset: preset.name, sections: want };
}

/** PNG width / height from the IHDR chunk (the editor reads the logo's aspect on upload). */
function pngAspect(file: string): number | null {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  return w && h ? w / h : null;
}

export interface BrandOptions {
  json?: Record<string, unknown>;
  name?: string;
  primary?: string;
  accent?: string;
  font?: string;
  logo?: string;
  watermark?: boolean;
  enabled?: boolean;
}

function deepMergeObj(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur) ? deepMergeObj(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

export function brandSet(ctx: Ctx, dirArg: string | undefined, o: BrandOptions) {
  const l = load(ctx, dirArg);
  let b = structuredClone(l.project.brand) as unknown as Record<string, unknown>;
  if (o.json) b = deepMergeObj(b, o.json);
  const patch: Record<string, unknown> = {};
  if (o.name !== undefined) patch.name = o.name;
  if (o.primary !== undefined || o.accent !== undefined) patch.colors = { ...(o.primary !== undefined ? { primary: o.primary } : {}), ...(o.accent !== undefined ? { accent: o.accent } : {}) };
  if (o.font !== undefined) patch.font = o.font;
  if (o.logo !== undefined) {
    const src = ctx.sandbox.resolve(o.logo, { mustExist: true, what: "--logo" });
    const aspect = pngAspect(src);
    if (aspect === null) throw invalid("--logo must be a PNG file");
    let rel: string;
    if (isInside(l.dir, src)) rel = path.relative(l.dir, src).split(path.sep).join("/");
    else {
      const dst = path.join(l.dir, "brand", path.basename(src));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (!fs.existsSync(dst) || sha256(fs.readFileSync(dst)) !== sha256(fs.readFileSync(src))) fs.copyFileSync(src, dst);
      rel = "brand/" + path.basename(src);
    }
    patch.logo = { path: rel, aspect: Math.round(aspect * 10000) / 10000, ...(o.watermark === undefined ? { watermark: true } : {}) };
  }
  if (o.watermark !== undefined) patch.logo = { ...((patch.logo as object) ?? {}), watermark: o.watermark };
  patch.enabled = o.enabled ?? true;
  b = deepMergeObj(b, patch);
  const m = save(ctx, l, { ...l.project, brand: b });
  return { ...m, brand: { enabled: l.project.brand.enabled, name: l.project.brand.name, primary: l.project.brand.colors.primary, accent: l.project.brand.colors.accent, font: l.project.brand.font, logo: l.project.brand.logo.path } };
}

// ------------------------------------------------------------------ get / set / zoom / cut / annotate

export function get(ctx: Ctx, dirArg: string | undefined, pointer = "") {
  const l = load(ctx, dirArg);
  const r = getAt(l.project, parsePointer(pointer));
  if (!r.found) throw notFound(`nothing at ${pointer}`);
  return { project: l.dir, pointer, value: r.value };
}

export function set(ctx: Ctx, dirArg: string | undefined, pointer: string, value: unknown, o: { create?: boolean } = {}) {
  const l = load(ctx, dirArg);
  const parts = parsePointer(pointer);
  if (!parts.length) throw invalid("set needs a pointer below the root (e.g. /zoom/defaultScale)");
  const before = getAt(l.project, parts);
  const next = setAt(l.project, parts, value, o.create);
  const m = save(ctx, l, next);
  return { ...m, pointer, before: before.found ? before.value : null, after: getAt(l.project, parts.at(-1) === "-" ? parts.slice(0, -1) : parts).value };
}

/** Times: numbers are ms; strings "1.5s", "800ms", "1:02.5" (m:ss). */
export function parseTime(v: unknown, what = "time"): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*ms$/))) return Number(m[1]);
    if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*s$/))) return Math.round(Number(m[1]) * 1000);
    if ((m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/))) return Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000);
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  }
  throw usage(`bad ${what} ${JSON.stringify(v)} (ms, "1.5s", "800ms" or "m:ss")`);
}

function checkRange(l: Loaded, start: number, end: number, what: string) {
  if (!(start >= 0 && end > start && end <= l.meta.durationMs)) throw invalid(`${what} ${start}..${end} ms must satisfy 0 <= start < end <= ${l.meta.durationMs}`);
}

export interface ZoomOptions {
  start: unknown;
  end: unknown;
  scale?: number;
  focus?: unknown;
  id?: string;
}

export function zoomAdd(ctx: Ctx, dirArg: string | undefined, o: ZoomOptions) {
  const l = load(ctx, dirArg);
  const startMs = parseTime(o.start, "--start");
  const endMs = parseTime(o.end, "--end");
  checkRange(l, startMs, endMs, "zoom");
  const scale = o.scale ?? l.project.zoom.defaultScale;
  if (!(typeof scale === "number" && scale >= 1 && scale <= l.project.zoom.maxScale)) throw invalid(`--scale must be 1..${l.project.zoom.maxScale}`);
  let focus: { x: number; y: number } | "follow" = "follow";
  if (o.focus !== undefined && o.focus !== "follow") {
    const f = typeof o.focus === "string" ? o.focus.split(",").map(Number) : Array.isArray(o.focus) ? o.focus.map(Number) : o.focus && typeof o.focus === "object" ? [(o.focus as { x: number }).x, (o.focus as { y: number }).y] : [];
    if (f.length !== 2 || !f.every((v) => Number.isFinite(v))) throw usage('--focus must be "x,y" (source px) or follow');
    if (f[0]! < 0 || f[1]! < 0 || f[0]! > l.meta.width || f[1]! > l.meta.height) throw invalid(`--focus ${f.join(",")} is outside the ${l.meta.width}x${l.meta.height} recording`);
    focus = { x: f[0]!, y: f[1]! };
  }
  const id = o.id ?? `zoom-${Math.round(startMs)}-${Math.round(endMs)}`;
  const seg = { id, startMs, endMs, scale, focus, style: l.project.zoom.style, auto: false };
  const segments = [...l.project.zoom.segments.filter((s) => s.id !== id), seg].sort((a, b) => a.startMs - b.startMs);
  const m = save(ctx, l, { ...l.project, zoom: { ...l.project.zoom, segments } });
  return { ...m, zoom: seg };
}

export function cutAdd(ctx: Ctx, dirArg: string | undefined, o: { start: unknown; end: unknown }) {
  const l = load(ctx, dirArg);
  const startMs = parseTime(o.start, "--start");
  const endMs = parseTime(o.end, "--end");
  checkRange(l, startMs, endMs, "cut");
  const cuts = l.project.edits.cuts.some((c) => c.startMs === startMs && c.endMs === endMs) ? l.project.edits.cuts : [...l.project.edits.cuts, { startMs, endMs }].sort((a, b) => a.startMs - b.startMs);
  const m = save(ctx, l, { ...l.project, edits: { ...l.project.edits, cuts } });
  return { ...m, cut: { startMs, endMs } };
}

export function annotate(ctx: Ctx, dirArg: string | undefined, raw: Record<string, unknown>) {
  const l = load(ctx, dirArg);
  if (!raw || typeof raw !== "object") throw usage("annotate needs a JSON object");
  const kind = raw.kind as Annotation["kind"];
  if (!["text", "arrow", "rect", "ellipse", "badge", "callout"].includes(kind)) throw usage("annotation kind must be text, arrow, rect, ellipse, badge or callout");
  const a: Record<string, unknown> = { ...raw };
  if (a.start !== undefined) (a.startMs = parseTime(a.start, "start")), delete a.start;
  if (a.end !== undefined) (a.endMs = parseTime(a.end, "end")), delete a.end;
  const vec = (v: unknown) => (Array.isArray(v) ? { x: Number(v[0]), y: Number(v[1]) } : v);
  if (Array.isArray(a.rect)) a.rect = { x: Number(a.rect[0]), y: Number(a.rect[1]), w: Number(a.rect[2]), h: Number(a.rect[3]) };
  for (const k of ["from", "to", "at"]) if (a[k] !== undefined) a[k] = vec(a[k]);
  const id = (a.id as string) ?? `ann-${sha256(JSON.stringify(a)).slice(0, 8)}`;
  const item = normalizeAnnotation({ ...(a as Partial<Annotation>), kind, id });
  const annotations = [...l.project.annotations.filter((x) => x.id !== id), item];
  const m = save(ctx, l, { ...l.project, annotations });
  return { ...m, annotation: { id, kind, startMs: item.startMs, endMs: item.endMs } };
}

/** Deep-merge a partial captions object (style etc.) into project.captions. */
export function captions(ctx: Ctx, dirArg: string | undefined, patch: Record<string, unknown>) {
  const l = load(ctx, dirArg);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw usage("captions needs an object");
  const known = Object.keys(l.project.captions);
  const unknown = Object.keys(patch).filter((k) => !known.includes(k));
  if (unknown.length) throw invalid(`unknown captions field(s): ${unknown.join(", ")}`);
  const next = deepMergeObj(l.project.captions as unknown as Record<string, unknown>, patch);
  return save(ctx, l, { ...l.project, captions: next });
}
