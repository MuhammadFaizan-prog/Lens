/**
 * Local dev-server endpoints for the Lens editor (Vite plugin; Tauri commands replace these later).
 *
 *   GET  /api/bundle[?dir=]          meta, events, project, transcript and frame counts of a bundle
 *   GET  /api/frames/:track/:n.jpg   decoded source frame n (0-based) of screen | cam
 *   GET  /api/media/:name            a file inside the bundle (audio tracks)
 *   GET  /api/font/caption.ttf       the caption font the reference compositor uses (DejaVu Sans Bold)
 *   GET  /api/font/file?ref=         a theme / brand font: builtin:<file> (assets/fonts), system:<file>, or a bundle path
 *   GET  /api/asset?path=            a file inside the bundle (brand logo, user fonts)
 *   POST /api/asset?name=            { data: base64 } -> saves <bundle>/brand/<name>, returns { path }
 *   POST /api/project                save project.json into the bundle
 *   POST /api/export                 { project } -> { id }: engine plan + compositor/render.py
 *   GET  /api/export/:id             { state, done, total, error }
 *   GET  /api/export/:id/file        the exported MP4
 *   POST /api/privacy/scan[?force=1] start redact/lens-redact on screen.mp4 -> { id } (cached per screen.mp4)
 *   GET  /api/privacy/scan/:id       { state, stage, done, total, error, result }
 *   GET  /api/privacy/thumb/:name    a review thumbnail (.lens-cache/privacy/)
 *   POST /api/steps                  start `redact/lens-redact steps` (auto step labels) -> { id } (cached per screen.mp4)
 *   GET  /api/steps/:id              { state, error, result }
 *   POST /api/steps-export           { project, kind: demo|guide } -> { id }: interactive demo / step guide (compositor/export_steps.py)
 *   GET  /api/steps-export/:id       { state, error, result }
 *   GET  /api/steps-export/:id/file/<path>   a file of that export (index.html, demo.json, images/..., guide.pdf, ...)
 *   POST /api/translate              { langs } -> { id }: translate/lens-translate on the bundle's transcript.json
 *   GET  /api/translate/:id          { state, language, index, languages, done, total, error, result: { tracks, stats } }
 *
 * A bundle is a folder with screen.mp4, meta.json, events.jsonl and optionally cam.mp4,
 * transcript.json, project.json and audio files. Default: $LENS_BUNDLE or apps/editor/sample
 * (generated on first use by scripts/make_sample.py; apps/editor/sample-takes, the multi-take sample, and
 * apps/editor/sample-privacy, the privacy-redaction sample, too).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { finishBrowserExport, startBrowserExport, writeFrame, type BrowserExportJob } from "./browserExport";
import { buildRenderPlan, DemoExportError, parseEventLog, parseTranscript, resolveProject, stepsExportInput } from "../../../packages/engine/src/index";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.resolve(HERE, "..");
// The desktop app (apps/desktop) runs this middleware from a bundle inside its resources, so the repo
// root, ffmpeg / ffprobe and the font folder can be set from the environment.
const ROOT = process.env.LENS_ROOT ? path.resolve(process.env.LENS_ROOT) : path.resolve(EDITOR, "..", "..");
const FFMPEG = process.env.LENS_FFMPEG || "ffmpeg";
const FFPROBE = process.env.LENS_FFPROBE || "ffprobe";
const FONT_DIR = process.env.LENS_FONT_DIR ? [process.env.LENS_FONT_DIR] : [];
const FONT_CANDIDATES = [...FONT_DIR.map((d) => path.join(d, "DejaVuSans-Bold.ttf")), "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/DejaVuSans-Bold.ttf"];
const FONT_REGULAR = [...FONT_DIR.map((d) => path.join(d, "DejaVuSans.ttf")), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/Library/Fonts/DejaVuSans.ttf"];
/** "browser": export through the editor's Canvas2D renderer + ffmpeg (no Python); default: compositor/render.py. */
const EXPORT_PATH = process.env.LENS_EXPORT === "browser" ? "browser" : "compositor";

type Next = (err?: unknown) => void;

interface ExportJob {
  id: string;
  state: "running" | "done" | "error";
  done: number;
  total: number;
  error?: string;
  out: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ExportJob | BrowserExportJob>();

interface ScanJob {
  id: string;
  state: "running" | "done" | "error";
  stage: string;
  done: number;
  total: number;
  error?: string;
  result?: unknown;
  startedAt: number;
  finishedAt?: number;
}

const scans = new Map<string, ScanJob>();

/** Run the on-device privacy scan; the result is cached next to the frames, keyed by screen.mp4's mtime. */
function startScan(bundle: string, force: boolean): ScanJob {
  const id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(bundle, ".lens-cache", "privacy");
  const out = path.join(dir, "scan.json");
  const stamp = path.join(dir, ".stamp");
  const video = path.join(bundle, "screen.mp4");
  const mtime = String(fs.statSync(video).mtimeMs);
  const job: ScanJob = { id, state: "running", stage: "start", done: 0, total: 0, startedAt: Date.now() };
  scans.set(id, job);
  if (!force && fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === mtime) {
    job.result = JSON.parse(fs.readFileSync(out, "utf8"));
    job.state = "done";
    job.stage = "cached";
    job.finishedAt = Date.now();
    return job;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const args = [path.join(ROOT, "redact", "lens-redact"), video, "-o", out, "--thumbs", dir, "--progress"];
  const ev = path.join(bundle, "events.jsonl");
  if (fs.existsSync(ev)) args.push("--events", ev);
  const py = spawn("python3", args, { cwd: ROOT });
  let err = "";
  py.stderr.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      const m = /^progress (\w+) (\d+) (\d+)/.exec(line);
      if (m) {
        job.stage = m[1]!;
        job.done = Number(m[2]);
        job.total = Number(m[3]);
      } else if (line.trim()) err += line + "\n";
    }
  });
  py.on("close", (code) => {
    job.finishedAt = Date.now();
    if (code === 0 && fs.existsSync(out)) {
      job.result = JSON.parse(fs.readFileSync(out, "utf8"));
      fs.writeFileSync(stamp, mtime);
      job.state = "done";
    } else {
      job.state = "error";
      job.error = err.trim().split("\n").slice(-4).join("\n") || `lens-redact exited ${code}`;
    }
  });
  return job;
}
interface StepJob {
  id: string;
  state: "running" | "done" | "error";
  error?: string;
  result?: unknown;
  startedAt: number;
  finishedAt?: number;
}

const stepJobs = new Map<string, StepJob>();

interface TranslateJob {
  id: string;
  state: "running" | "done" | "error";
  stage: string;
  language: string;
  index: number;
  languages: number;
  done: number;
  total: number;
  error?: string;
  result?: { tracks: unknown[]; stats: unknown };
  startedAt: number;
  finishedAt?: number;
}

const translateJobs = new Map<string, TranslateJob>();

/** Caption translation (demand #8): on-device lens-translate over the bundle transcript, one track per language. */
function startTranslate(bundle: string, langs: string[]): TranslateJob {
  const id = "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job: TranslateJob = { id, state: "running", stage: "start", language: langs[0] ?? "", index: 0, languages: langs.length, done: 0, total: 0, startedAt: Date.now() };
  translateJobs.set(id, job);
  const transcript = path.join(bundle, "transcript.json");
  const out = path.join(bundle, ".lens-cache", "translate", id);
  if (!fs.existsSync(transcript)) {
    job.state = "error";
    job.error = "this recording has no transcript";
    return job;
  }
  if (!langs.length || langs.some((l) => !/^[a-z]{2,3}$/.test(l))) {
    job.state = "error";
    job.error = "choose at least one language";
    return job;
  }
  fs.mkdirSync(out, { recursive: true });
  const py = spawn("python3", [path.join(ROOT, "translate", "lens-translate"), transcript, "--to", langs.join(","), "-o", out, "--progress"], { cwd: ROOT });
  let err = "";
  let buf = "";
  let stats: unknown = null;
  py.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        job.stage = String(ev.stage ?? job.stage);
        if (typeof ev.language === "string") job.language = ev.language;
        if (typeof ev.index === "number") job.index = ev.index;
        if (typeof ev.done === "number") job.done = ev.done;
        if (typeof ev.total === "number") job.total = ev.total;
        if (ev.stage === "done") stats = ev.stats;
      } catch {
        // not a progress line
      }
    }
  });
  py.stderr.on("data", (d: Buffer) => (err += d.toString()));
  py.on("close", (code) => {
    job.finishedAt = Date.now();
    try {
      if (code !== 0) throw new Error(err.trim().split("\n").slice(-3).join("\n") || `lens-translate exited ${code}`);
      const tracks = langs.map((l) => JSON.parse(fs.readFileSync(path.join(out, `${l}.track.json`), "utf8")));
      job.result = { tracks, stats };
      job.state = "done";
    } catch (e) {
      job.state = "error";
      job.error = e instanceof Error ? e.message : String(e);
    }
  });
  return job;
}

/** Draft step labels from the clicks in events.jsonl + local OCR; cached next to the frames by screen.mp4's mtime. */
function startSteps(bundle: string): StepJob {
  const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(bundle, ".lens-cache", "steps");
  const out = path.join(dir, "steps.json");
  const stamp = path.join(dir, ".stamp");
  const video = path.join(bundle, "screen.mp4");
  const ev = path.join(bundle, "events.jsonl");
  const key = `${fs.statSync(video).mtimeMs}:${fs.statSync(ev).mtimeMs}`;
  const job: StepJob = { id, state: "running", startedAt: Date.now() };
  stepJobs.set(id, job);
  if (fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === key) {
    job.result = JSON.parse(fs.readFileSync(out, "utf8"));
    job.state = "done";
    job.finishedAt = Date.now();
    return job;
  }
  fs.mkdirSync(dir, { recursive: true });
  const py = spawn("python3", [path.join(ROOT, "redact", "lens-redact"), "steps", video, "--events", ev, "-o", out], { cwd: ROOT });
  let err = "";
  py.stderr.on("data", (d: Buffer) => (err += d.toString()));
  py.on("close", (code) => {
    job.finishedAt = Date.now();
    if (code === 0 && fs.existsSync(out)) {
      job.result = JSON.parse(fs.readFileSync(out, "utf8"));
      fs.writeFileSync(stamp, key);
      job.state = "done";
    } else {
      job.state = "error";
      job.error = err.trim().split("\n").slice(-4).join("\n") || `lens-redact steps exited ${code}`;
    }
  });
  return job;
}

const extracting = new Map<string, Promise<number>>();

export function defaultBundle(): string {
  return path.resolve(process.env.LENS_BUNDLE ?? path.join(EDITOR, "sample"));
}

function ensureSample(dir: string): void {
  if (fs.existsSync(path.join(dir, "screen.mp4"))) return;
  const takes = path.resolve(dir) === path.resolve(EDITOR, "sample-takes");
  const privacy = path.resolve(dir) === path.resolve(EDITOR, "sample-privacy");
  const annotations = path.resolve(dir) === path.resolve(EDITOR, "sample-annotations");
  const brand = path.resolve(dir) === path.resolve(EDITOR, "sample-brand");
  const translate = path.resolve(dir) === path.resolve(EDITOR, "sample-translate");
  if (path.resolve(dir) !== path.resolve(EDITOR, "sample") && !takes && !privacy && !annotations && !brand && !translate) throw new Error(`no screen.mp4 in ${dir}`);
  const r = spawnSync("python3", [path.join(EDITOR, "scripts", "make_sample.py"), "--out", dir, ...(takes ? ["--takes"] : []), ...(privacy ? ["--privacy"] : []),
    ...(annotations ? ["--annotations"] : []), ...(brand ? ["--brand"] : []), ...(translate ? ["--translate"] : [])], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`make_sample failed: ${r.stderr}`);
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

/** Decode every frame of a track to JPEG once (cached in <bundle>/.lens-cache/<track>/). */
function extractFrames(bundle: string, track: "screen" | "cam"): Promise<number> {
  const video = path.join(bundle, `${track}.mp4`);
  const dir = path.join(bundle, ".lens-cache", track);
  const key = dir;
  const pending = extracting.get(key);
  if (pending) return pending;
  const p = new Promise<number>((resolve, reject) => {
    const stamp = path.join(dir, ".done");
    const mtime = fs.statSync(video).mtimeMs;
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === String(mtime)) {
      resolve(fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const ff = spawn(FFMPEG, ["-v", "error", "-y", "-i", video, "-vsync", "0", "-q:v", "2", path.join(dir, "%05d.jpg")]);
    let err = "";
    ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg frame extract failed: ${err}`));
      fs.writeFileSync(stamp, String(mtime));
      resolve(fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length);
    });
  });
  extracting.set(key, p);
  p.catch(() => extracting.delete(key));
  return p;
}

/** A path inside the bundle (no escaping it with .. or an absolute path). */
function insideBundle(bundle: string, rel: string): string | null {
  const p = path.resolve(bundle, rel);
  return p.startsWith(path.resolve(bundle) + path.sep) ? p : null;
}

function fontFile(bundle: string, ref: string): string | null {
  if (ref.startsWith("builtin:")) {
    const f = path.join(ROOT, "assets", "fonts", path.basename(ref.slice(8)));
    return fs.existsSync(f) ? f : null;
  }
  if (ref.startsWith("system:")) {
    const name = path.basename(ref.slice(7));
    return [...FONT_CANDIDATES, ...FONT_REGULAR].find((c) => path.basename(c) === name && fs.existsSync(c)) ?? null;
  }
  const p = path.isAbsolute(ref) ? ref : insideBundle(bundle, ref);
  return p && fs.existsSync(p) ? p : null;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf" };

function readJson(file: string): unknown {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function loadBundle(dir: string) {
  ensureSample(dir);
  const meta = readJson(path.join(dir, "meta.json"));
  const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  const project = readJson(path.join(dir, "project.json")) ?? {};
  const transcript = readJson(path.join(dir, "transcript.json"));
  const hasCam = fs.existsSync(path.join(dir, "cam.mp4"));
  const [screenFrames, camFrames] = await Promise.all([extractFrames(dir, "screen"), hasCam ? extractFrames(dir, "cam") : Promise.resolve(0)]);
  return {
    dir,
    name: path.basename(dir),
    /** No project.json yet: the editor applies the user's default preset. */
    isNew: !fs.existsSync(path.join(dir, "project.json")),
    meta,
    events,
    project,
    transcript,
    screen: { ...probeVideo(path.join(dir, "screen.mp4")), frames: screenFrames },
    camera: hasCam ? { ...probeVideo(path.join(dir, "cam.mp4")), frames: camFrames } : null,
  };
}

/** Width, height and frame rate of a video's first stream: ffprobe, or `ffmpeg -i` when no ffprobe is shipped (desktop build). */
export function probeVideo(f: string): { width: number; height: number; fps: number } {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", f], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) {
    const s = JSON.parse(r.stdout).streams[0];
    const [n, d] = String(s.r_frame_rate).split("/").map(Number);
    return { width: s.width as number, height: s.height as number, fps: (n ?? 30) / (d ?? 1) };
  }
  const info = spawnSync(FFMPEG, ["-hide_banner", "-i", f], { encoding: "utf8" }).stderr ?? "";
  return parseFfmpegVideoInfo(info);
}

/** Parse "Stream #0:0...: Video: h264 ..., 1280x720 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr" from `ffmpeg -i`. */
export function parseFfmpegVideoInfo(text: string): { width: number; height: number; fps: number } {
  const line = text.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*: Video:/.test(l));
  if (!line) throw new Error("no video stream");
  const size = / (\d{2,5})x(\d{2,5})[ ,]/.exec(line);
  const fps = /([\d.]+) fps/.exec(line) ?? /([\d.]+) tbr/.exec(line);
  if (!size) throw new Error("no video size");
  return { width: Number(size[1]), height: Number(size[2]), fps: fps ? Number(fps[1]) : 30 };
}

/** Resolve a project against the bundle: audio paths made absolute so the compositor finds them. */
function exportProject(bundle: string, raw: unknown) {
  const p = resolveProject(raw);
  p.audio.tracks = p.audio.tracks.map((t) => ({ ...t, path: path.isAbsolute(t.path) ? t.path : path.join(bundle, t.path) }));
  return p;
}

function startExport(bundle: string, rawProject: unknown): ExportJob {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(bundle, ".lens-export", id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8"));
  const events = parseEventLog(fs.readFileSync(path.join(bundle, "events.jsonl"), "utf8"));
  const tj = readJson(path.join(bundle, "transcript.json"));
  const tr = tj ? parseTranscript(tj) : null;
  const project = exportProject(bundle, rawProject);
  const plan = buildRenderPlan({ meta, events, project, words: tr?.words ?? [], pauses: tr?.pauses });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const out = path.join(dir, "export.mp4");
  const job: ExportJob = { id, state: "running", done: 0, total: plan.frames.length, out, startedAt: Date.now() };
  jobs.set(id, job);
  const args = [path.join(ROOT, "compositor", "render.py"), "--plan", path.join(dir, "plan.json"), "--screen", path.join(bundle, "screen.mp4"),
    "--out", out, "--preset", "veryfast", "--progress", "--assets", bundle];
  if (project.camera.enabled && fs.existsSync(path.join(bundle, "cam.mp4"))) args.push("--camera", path.join(bundle, "cam.mp4"));
  const py = spawn("python3", args, { cwd: ROOT });
  let err = "";
  py.stderr.on("data", (d: Buffer) => {
    const s = d.toString();
    for (const line of s.split("\n")) {
      const m = /^progress (\d+) (\d+)/.exec(line);
      if (m) {
        job.done = Number(m[1]);
        job.total = Number(m[2]);
      } else if (line.trim()) err += line + "\n";
    }
  });
  py.on("close", (code) => {
    job.finishedAt = Date.now();
    if (code === 0 && fs.existsSync(out)) job.state = "done";
    else {
      job.state = "error";
      job.error = err.trim().split("\n").slice(-4).join("\n") || `render.py exited ${code}`;
    }
  });
  return job;
}

/** In-browser export (LENS_EXPORT=browser): the plan is built here, the editor posts the frames. */
function startExportBrowser(bundle: string, rawProject: unknown): BrowserExportJob {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8"));
  const events = parseEventLog(fs.readFileSync(path.join(bundle, "events.jsonl"), "utf8"));
  const tj = readJson(path.join(bundle, "transcript.json"));
  const tr = tj ? parseTranscript(tj) : null;
  const project = exportProject(bundle, rawProject);
  const plan = buildRenderPlan({ meta, events, project, words: tr?.words ?? [], pauses: tr?.pauses });
  const job = startBrowserExport(FFMPEG, plan, path.join(bundle, ".lens-export", id), id);
  jobs.set(id, job);
  return job;
}

interface StepsExportJob {
  id: string;
  kind: "demo" | "guide";
  state: "running" | "done" | "error";
  out: string;
  error?: string;
  result?: unknown;
  startedAt: number;
  finishedAt?: number;
}
const stepsJobs = new Map<string, StepsExportJob>();

/** Interactive demo / step guide (demand #7): engine stepsExportInput -> compositor/export_steps.py into .lens-export/<id>/. */
function startStepsExport(bundle: string, rawProject: unknown, kind: "demo" | "guide"): StepsExportJob {
  const id = "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(bundle, ".lens-export", id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8"));
  const events = parseEventLog(fs.readFileSync(path.join(bundle, "events.jsonl"), "utf8"));
  const input = stepsExportInput({ meta, events, project: resolveProject(rawProject) });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(input.plan));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(input.manifest));
  const out = path.join(dir, kind);
  const job: StepsExportJob = { id, kind, state: "running", out, startedAt: Date.now() };
  stepsJobs.set(id, job);
  const py = spawn("python3", [path.join(ROOT, "compositor", "export_steps.py"), "--manifest", path.join(dir, "manifest.json"), "--plan", path.join(dir, "plan.json"),
    "--screen", path.join(bundle, "screen.mp4"), "--out", out, "--kind", kind, "--assets", bundle], { cwd: ROOT });
  let stdout = "";
  let err = "";
  py.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  py.stderr.on("data", (d: Buffer) => (err += d.toString()));
  py.on("close", (code) => {
    job.finishedAt = Date.now();
    if (code === 0) {
      job.state = "done";
      try {
        job.result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
      } catch {
        job.result = {};
      }
    } else {
      job.state = "error";
      job.error = err.trim().split("\n").slice(-4).join("\n") || `export_steps.py exited ${code}`;
    }
  });
  return job;
}

const EXPORT_MIME: Record<string, string> = { ...MIME, ".html": "text/html; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf" };

export function apiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return next();
    const bundle = path.resolve(url.searchParams.get("dir") ?? defaultBundle());
    try {
      let m: RegExpExecArray | null;
      if (url.pathname === "/api/bundle" && req.method === "GET") return sendJson(res, await loadBundle(bundle));
      if ((m = /^\/api\/frames\/(screen|cam)\/(\d+)\.jpg$/.exec(url.pathname))) {
        const track = m[1] as "screen" | "cam";
        const n = await extractFrames(bundle, track);
        const idx = Math.min(n - 1, Math.max(0, Number(m[2])));
        const file = path.join(bundle, ".lens-cache", track, `${String(idx + 1).padStart(5, "0")}.jpg`);
        res.setHeader("content-type", "image/jpeg");
        res.setHeader("cache-control", "max-age=3600");
        return fs.createReadStream(file).pipe(res);
      }
      if ((m = /^\/api\/media\/([^/]+)$/.exec(url.pathname))) {
        const file = path.join(bundle, path.basename(decodeURIComponent(m[1]!)));
        if (!fs.existsSync(file)) return sendJson(res, { error: "not found" }, 404);
        res.setHeader("content-type", file.endsWith(".wav") ? "audio/wav" : "application/octet-stream");
        return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname === "/api/font/caption.ttf" || url.pathname === "/api/font/caption-regular.ttf") {
        const f = (url.pathname.endsWith("regular.ttf") ? FONT_REGULAR : FONT_CANDIDATES).find((p) => fs.existsSync(p));
        if (!f) return sendJson(res, { error: "font not installed" }, 404);
        res.setHeader("content-type", "font/ttf");
        return fs.createReadStream(f).pipe(res);
      }
      if (url.pathname === "/api/font/file") {
        const f = fontFile(bundle, url.searchParams.get("ref") ?? "");
        if (!f) return sendJson(res, { error: "font not found" }, 404);
        res.setHeader("content-type", "font/ttf");
        res.setHeader("cache-control", "max-age=3600");
        return fs.createReadStream(f).pipe(res);
      }
      if (url.pathname === "/api/asset" && req.method === "GET") {
        const f = insideBundle(bundle, url.searchParams.get("path") ?? "");
        if (!f || !fs.existsSync(f)) return sendJson(res, { error: "not found" }, 404);
        res.setHeader("content-type", MIME[path.extname(f).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("cache-control", "no-store");
        return fs.createReadStream(f).pipe(res);
      }
      if (url.pathname === "/api/asset" && req.method === "POST") {
        const name = path.basename(url.searchParams.get("name") ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
        if (!name || !MIME[path.extname(name).toLowerCase()]) return sendJson(res, { error: "unsupported file type" }, 400);
        const body = JSON.parse(await readBody(req)) as { data: string };
        fs.mkdirSync(path.join(bundle, "brand"), { recursive: true });
        fs.writeFileSync(path.join(bundle, "brand", name), Buffer.from(body.data, "base64"));
        return sendJson(res, { path: `brand/${name}` });
      }
      if (url.pathname === "/api/project" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        resolveProject(body); // validate before writing
        fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify(body, null, 2));
        return sendJson(res, { ok: true, path: path.join(bundle, "project.json") });
      }
      if (url.pathname === "/api/capabilities" && req.method === "GET") return sendJson(res, { export: EXPORT_PATH });
      if (url.pathname === "/api/export-browser" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const job = startExportBrowser(bundle, body.project);
        return sendJson(res, { id: job.id, total: job.total });
      }
      if ((m = /^\/api\/export-browser\/([a-z0-9]+)\/(frame|finish|cancel)$/.exec(url.pathname)) && req.method === "POST") {
        const job = jobs.get(m[1]!);
        if (!job || !("ff" in job)) return sendJson(res, { error: "no such export" }, 404);
        if (m[2] === "cancel") {
          // Windows bug #11: long jobs can be cancelled; ffmpeg is stopped and the partial file left behind
          if (job.state === "running") {
            job.state = "error";
            job.error = "cancelled";
            try {
              job.ff.kill("SIGKILL");
            } catch {
              // already gone
            }
          }
          return sendJson(res, { ok: true });
        }
        if (m[2] === "finish") {
          finishBrowserExport(job);
          return sendJson(res, { ok: true });
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        await writeFrame(job, Number(url.searchParams.get("i")), Buffer.concat(chunks));
        return sendJson(res, { ok: true, done: job.done });
      }
      if (url.pathname === "/api/export" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const job = startExport(bundle, body.project);
        return sendJson(res, { id: job.id, total: job.total });
      }
      if ((m = /^\/api\/export\/([a-z0-9]+)(\/file)?$/.exec(url.pathname))) {
        const job = jobs.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such export" }, 404);
        if (m[2]) {
          if (job.state !== "done") return sendJson(res, { error: "not finished" }, 409);
          res.setHeader("content-type", "video/mp4");
          res.setHeader("content-disposition", `attachment; filename="lens-export.mp4"`);
          return fs.createReadStream(job.out).pipe(res);
        }
        return sendJson(res, { id: job.id, state: job.state, done: job.done, total: job.total, error: job.error, out: job.out,
          seconds: ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 });
      }
      if (url.pathname === "/api/privacy/scan" && req.method === "POST") {
        const job = startScan(bundle, url.searchParams.get("force") === "1");
        return sendJson(res, { id: job.id, state: job.state });
      }
      if ((m = /^\/api\/privacy\/scan\/([a-z0-9]+)$/.exec(url.pathname))) {
        const job = scans.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such scan" }, 404);
        return sendJson(res, { id: job.id, state: job.state, stage: job.stage, done: job.done, total: job.total, error: job.error,
          result: job.state === "done" ? job.result : undefined, seconds: ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 });
      }
      if ((m = /^\/api\/privacy\/thumb\/([A-Za-z0-9_.-]+\.jpg)$/.exec(url.pathname))) {
        const file = path.join(bundle, ".lens-cache", "privacy", path.basename(m[1]!));
        if (!fs.existsSync(file)) return sendJson(res, { error: "not found" }, 404);
        res.setHeader("content-type", "image/jpeg");
        res.setHeader("cache-control", "no-store");
        return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname === "/api/steps" && req.method === "POST") {
        const job = startSteps(bundle);
        return sendJson(res, { id: job.id, state: job.state });
      }
      if ((m = /^\/api\/steps\/([a-z0-9]+)$/.exec(url.pathname))) {
        const job = stepJobs.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such run" }, 404);
        return sendJson(res, { id: job.id, state: job.state, error: job.error, result: job.state === "done" ? job.result : undefined,
          seconds: ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 });
      }
      if (url.pathname === "/api/steps-export" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { project: unknown; kind?: string };
        const kind = body.kind === "guide" ? "guide" : "demo";
        try {
          const job = startStepsExport(bundle, body.project, kind);
          return sendJson(res, { id: job.id, state: job.state });
        } catch (e) {
          if (e instanceof DemoExportError) return sendJson(res, { error: e.message }, 400);
          throw e;
        }
      }
      if ((m = /^\/api\/steps-export\/([a-z0-9]+)(?:\/file\/(.+))?$/.exec(url.pathname))) {
        const job = stepsJobs.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such export" }, 404);
        if (m[2]) {
          if (job.state !== "done") return sendJson(res, { error: "not finished" }, 409);
          const f = path.resolve(job.out, decodeURIComponent(m[2]));
          if (!f.startsWith(job.out + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return sendJson(res, { error: "not found" }, 404);
          res.setHeader("content-type", EXPORT_MIME[path.extname(f).toLowerCase()] ?? "application/octet-stream");
          res.setHeader("cache-control", "no-store");
          return fs.createReadStream(f).pipe(res);
        }
        return sendJson(res, { id: job.id, kind: job.kind, state: job.state, error: job.error, result: job.state === "done" ? job.result : undefined,
          seconds: ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 });
      }
      if (url.pathname === "/api/translate" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { langs?: string[] };
        const job = startTranslate(bundle, body.langs ?? []);
        return sendJson(res, { id: job.id, state: job.state, error: job.error });
      }
      if ((m = /^\/api\/translate\/([a-z0-9]+)$/.exec(url.pathname))) {
        const job = translateJobs.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such run" }, 404);
        return sendJson(res, { id: job.id, state: job.state, stage: job.stage, language: job.language, index: job.index, languages: job.languages,
          done: job.done, total: job.total, error: job.error, result: job.state === "done" ? job.result : undefined,
          seconds: ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 });
      }
      return sendJson(res, { error: "unknown endpoint" }, 404);
    } catch (e) {
      return sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  };
}

export function lensApi(): Plugin {
  return {
    name: "lens-api",
    configureServer(server) {
      server.middlewares.use(apiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware());
    },
  };
}
