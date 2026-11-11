/**
 * Local dev-server endpoints for the Lens editor (Vite plugin; Tauri commands replace these later).
 *
 *   GET  /api/bundle[?dir=]          meta, events, project, transcript and frame counts of a bundle
 *   GET  /api/silences[?dir=]        { silences }: measured mic silences (measured once in the background, cached)
 *   GET  /api/frames/:track/:n.jpg   decoded source frame n (0-based) of screen | cam
 *   GET  /api/media/:name            a file inside the bundle (audio tracks)
 *   GET  /api/font/caption.ttf       the caption font the reference compositor uses (DejaVu Sans Bold)
 *   GET  /api/font/file?ref=         a theme / brand font: builtin:<file> (assets/fonts), system:<file>, or a bundle path
 *   GET  /api/asset?path=            a file inside the bundle (brand logo, user fonts)
 *   POST /api/asset?name=            { data: base64 } -> saves <bundle>/brand/<name>, returns { path }
 *   GET  /api/fonts/library          { fonts }: the user's imported-font library ("My fonts")
 *   POST /api/fonts/import           { kind: file | path | url | google | library, ... } -> { font, format, weights }:
 *                                    validates the font and copies it into <bundle>/fonts/ and the library (server/fonts.ts)
 *   DELETE /api/fonts/library?family= removes a family from the library
 *   POST /api/music?name=            { data: base64 } -> imports an audio file into <bundle>/music/<name> (checked by ffmpeg), { path, name, durationMs }
 *   POST /api/music/builtin          { id } -> writes the Lens built-in bed (CC0, engine musicBed.ts) to <bundle>/music/lens-<id>.wav, { path, name, durationMs }
 *   POST /api/voiceover?name=        raw audio bytes -> saves <bundle>/voiceover/<name>, returns { path, durationMs } (demand #17)
 *   POST /api/project                save project.json into the bundle
 *   POST /api/export                 { project } -> { id }: engine plan + compositor/render.py
 *   GET  /api/export/:id             { state, done, total, error }
 *   GET  /api/export/:id/file        the exported MP4 (?name=overlay.mov | overlay.webm | cuts.fcpxml | cuts.edl for an NLE hand-off)
 *   POST /api/export-overlay         { project } -> { id, total }: NLE hand-off (demand #11): writes cuts.fcpxml / cuts.edl, then the
 *                                    editor posts transparent overlay PNGs to /api/export-browser/:id/frame (ffmpeg -> ProRes 4444 + VP9 alpha)
 *   POST /api/privacy/scan[?force=1] start redact/lens-redact on screen.mp4 -> { id } (cached per screen.mp4)
 *   GET  /api/privacy/scan/:id       { state, stage, done, total, error, result }
 *   GET  /api/privacy/thumb/:name    a review thumbnail (.lens-cache/privacy/)
 *   POST /api/steps                  start `redact/lens-redact steps` (auto step labels) -> { id } (cached per screen.mp4)
 *   GET  /api/steps/:id              { state, error, result }
 *   POST /api/steps-export           { project, kind: demo|guide } -> { id }: interactive demo / step guide (compositor/export_steps.py)
 *   GET  /api/steps-export/:id       { state, error, result }
 *   GET  /api/steps-export/:id/file/<path>   a file of that export (index.html, demo.json, images/..., guide.pdf, ...)
 *   POST /api/transcribe             in-app speech-to-text (whisper.cpp, base.en) on the mic track -> { id }; writes transcript.json
 *   GET  /api/transcribe/:id         { state, done (percent), error, result (transcript) }
 *   POST /api/translate              { langs } -> { id }: translate/lens-translate on the bundle's transcript.json
 *   GET  /api/translate/:id          { state, language, index, languages, done, total, error, result: { tracks, stats } }
 *
 * A bundle is a folder with screen.mp4, meta.json, events.jsonl and optionally cam.mp4,
 * transcript.json, project.json and audio files. Default: $LENS_BUNDLE or apps/editor/sample
 * (generated on first use by scripts/make_sample.py; apps/editor/sample-takes, the multi-take sample, and
 * apps/editor/sample-privacy, the privacy-redaction sample, too).
 */
import { cameraWarningOf } from "../src/state/webcamPanel";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { startJob } from "./jobs";
import { transcribe } from "./stt";
import { detectSilences, type Range } from "./silence";
import { FileCache, probeVideoFile, type VideoProbe } from "./probe";
import { importMusic, writeBuiltinBed } from "./music";
import { cancelBrowserExport, exportBitrateMbps, finishBrowserExport, startBrowserExport, writeFrame, type BrowserExportJob } from "./browserExport";
import { CancelledError, finishExport, type FinishResult } from "./exportFinish";
import { embedChapters, wantsChapters } from "./chapterMeta";
import { startNleExport } from "./nleExport";
import { buildRenderPlan, encodeSettings, DemoExportError, parseEventLog, parseTranscript, resolveProject, stepsExportInput, withFontFallback, type RenderPlan } from "../../../packages/engine/src/index";
import { defaultLibraryDir, FontImportError, importFont, listLibrary, missingFamilies, removeFromLibrary, type ImportRequest } from "./fonts";
import { forgetShare, publicConfig, saveShare, shareJob, ShareError, startShare, testShare, type ShareSettings } from "./share/share";

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
/** Privacy scan / step labels: in-app (Node + tesseract.js, no Python) unless LENS_REDACT=python (the reference). */
const PYTHON_JOBS = process.env.LENS_REDACT === "python";
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
  /** Platform preset output (demand #24). */
  stage?: string;
  format?: "mp4" | "gif";
  cap?: FinishResult["cap"];
  /** render.py, then the GIF / size-cap ffmpeg: killed by Cancel. */
  child?: import("node:child_process").ChildProcess | null;
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
  const ev = path.join(bundle, "events.jsonl");
  if (!PYTHON_JOBS) {
    // in-app (Windows #1): Node + tesseract.js on a worker thread, no Python
    startJob({ kind: "scan", ffmpeg: FFMPEG, video, events: fs.existsSync(ev) ? ev : null, thumbs: dir }, (stage, done, total) => Object.assign(job, { stage, done, total }))
      .then((r) => {
        fs.writeFileSync(out, JSON.stringify(r));
        fs.writeFileSync(stamp, mtime);
        Object.assign(job, { result: r, state: "done", finishedAt: Date.now() });
      })
      .catch((e) => Object.assign(job, { state: "error", error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() }));
    return job;
  }
  const args = [path.join(ROOT, "redact", "lens-redact"), video, "-o", out, "--thumbs", dir, "--progress"];
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

/**
 * Windows #1b: caption translation still runs the Python lens-translate (CTranslate2 + OPUS-MT models),
 * which the desktop app does not ship. The desktop server sets LENS_TRANSLATE=off; the editor then shows
 * the reason instead of a Translate button that fails with "python3: can't open file".
 */
export function translateUnavailable(): string | null {
  return process.env.LENS_TRANSLATE === "off"
    ? "Caption translation is not available in the desktop app yet: it needs the on-device translation models, which are not bundled. Captions in the recording's own language work."
    : null;
}

/** Caption translation (demand #8): on-device lens-translate over the bundle transcript, one track per language. */
function startTranslate(bundle: string, langs: string[]): TranslateJob {
  const id = "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job: TranslateJob = { id, state: "running", stage: "start", language: langs[0] ?? "", index: 0, languages: langs.length, done: 0, total: 0, startedAt: Date.now() };
  translateJobs.set(id, job);
  const transcript = path.join(bundle, "transcript.json");
  const out = path.join(bundle, ".lens-cache", "translate", id);
  const off = translateUnavailable();
  if (off) {
    job.state = "error";
    job.error = off;
    return job;
  }
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
  if (!PYTHON_JOBS) {
    startJob({ kind: "steps", ffmpeg: FFMPEG, video, events: ev }, () => undefined)
      .then((r) => {
        fs.writeFileSync(out, JSON.stringify(r));
        fs.writeFileSync(stamp, key);
        Object.assign(job, { result: r, state: "done", finishedAt: Date.now() });
      })
      .catch((e) => Object.assign(job, { state: "error", error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() }));
    return job;
  }
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

interface TranscribeJob { id: string; state: "running" | "done" | "error"; done: number; error?: string; result?: unknown; startedAt: number; finishedAt?: number }
const transcribeJobs = new Map<string, TranscribeJob>();

/** The bundle's mic track (project.json audio tracks, else mic.wav) and its offset on the recording clock. */
function micTrack(bundle: string): { file: string; offsetMs: number } | null {
  const p = readJson(path.join(bundle, "project.json")) as { audio?: { tracks?: Array<{ kind?: string; path?: string; offsetMs?: number }> } } | null;
  const t = p?.audio?.tracks?.find((x) => x.kind === "mic" && x.path) ?? p?.audio?.tracks?.find((x) => x.path);
  if (t?.path && fs.existsSync(path.join(bundle, t.path))) return { file: path.join(bundle, t.path), offsetMs: t.offsetMs ?? 0 };
  for (const f of ["mic.wav", "mic.webm"]) if (fs.existsSync(path.join(bundle, f))) return { file: path.join(bundle, f), offsetMs: 0 };
  return null;
}

/** In-app speech-to-text (Windows #5): whisper.cpp + base.en on the mic track, written to transcript.json. */
function startTranscribe(bundle: string, auto = false): TranscribeJob {
  if (auto) {
    fs.mkdirSync(path.join(bundle, ".lens-cache"), { recursive: true });
    fs.writeFileSync(path.join(bundle, ".lens-cache", "transcribe-auto"), new Date().toISOString());
  }
  const id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job: TranscribeJob = { id, state: "running", done: 0, startedAt: Date.now() };
  transcribeJobs.set(id, job);
  const mic = micTrack(bundle);
  if (!mic) return Object.assign(job, { state: "error" as const, error: "this recording has no microphone track", finishedAt: Date.now() });
  transcribe(FFMPEG, mic.file, mic.offsetMs, (pct) => (job.done = pct))
    .then((t) => {
      fs.writeFileSync(path.join(bundle, "transcript.json"), JSON.stringify(t, null, 1));
      Object.assign(job, { state: "done", done: 100, result: t, finishedAt: Date.now() });
    })
    .catch((e) => Object.assign(job, { state: "error", error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() }));
  return job;
}

/**
 * Measured silences on the mic track, on the recording clock (Windows #17: "Shorten pauses" works with
 * no transcript). Two ffmpeg passes (~1.5 s on a minute): async and cached (memory + .lens-cache/silences.json,
 * keyed by the mic file's path, size, mtime and offset), so /api/bundle never waits for them; the editor
 * gets them from GET /api/silences.
 */
const silenceCache = new FileCache<Range[]>(async (file) => (await detectSilences(FFMPEG, file, { minMs: 300 })).silences, "sil-v2");
function micSilences(bundle: string): Promise<Range[]> {
  const mic = micTrack(bundle);
  if (!mic) return Promise.resolve([]);
  return silenceCache.get(mic.file, path.join(bundle, ".lens-cache", "silences.json"))
    .then((s) => s.map((r) => ({ startMs: r.startMs + mic.offsetMs, endMs: r.endMs + mic.offsetMs })), () => []);
}
/** The silences when already measured (no work started), else undefined. */
function micSilencesReady(bundle: string): Range[] | undefined {
  const mic = micTrack(bundle);
  if (!mic) return [];
  const s = silenceCache.peek(mic.file, path.join(bundle, ".lens-cache", "silences.json"));
  return s?.map((r) => ({ startMs: r.startMs + mic.offsetMs, endMs: r.endMs + mic.offsetMs }));
}

const extracting = new Map<string, Extraction>();

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

const VOICE_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".webm", ".flac"]);

/** The request body as bytes (uploads), at most `max` bytes. */
function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new Error("file too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Length of an audio file in ms, by decoding it (MediaRecorder webm carries no duration). */
function audioDurationMs(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"], { windowsHide: true });
    let bytes = 0;
    p.stdout.on("data", (d: Buffer) => (bytes += d.length));
    p.on("error", () => resolve(0));
    p.on("close", (code) => resolve(code === 0 ? Math.round((bytes / 2 / 8000) * 1000) : 0));
  });
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

/**
 * Decode every frame of a track to JPEG once (cached in <bundle>/.lens-cache/<track>/), in the
 * background: /api/bundle no longer waits for it (Windows report 2026-11-09: the editor sat on its empty
 * defaults while a 1080p60 minute was decoded to 3600 JPEGs; 37 s on the 2-core test box, minutes on
 * Windows). Frames already written are served from the cache, the rest one by one (frameAt), and the
 * export (?exact=1) waits for this full pass, so exported frames are the exact decoded ones.
 */
interface Extraction {
  done: Promise<number>;
  /** frames fully written so far (a frame counts once the next one exists or the pass ended) */
  written(): number;
  finished: boolean;
}
function extractFrames(bundle: string, track: "screen" | "cam"): Extraction {
  const video = path.join(bundle, `${track}.mp4`);
  const dir = path.join(bundle, ".lens-cache", track);
  const pending = extracting.get(dir);
  if (pending) return pending;
  const stamp = path.join(dir, ".done");
  const mtime = String(fs.statSync(video).mtimeMs);
  const count = () => fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length;
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === mtime) {
    const n = count();
    const x: Extraction = { done: Promise.resolve(n), written: () => n, finished: true };
    extracting.set(dir, x);
    return x;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let progress = 0;
  const x: Extraction = {
    finished: false,
    written: () => (x.finished ? Number.MAX_SAFE_INTEGER : Math.max(0, progress - 1)),
    done: new Promise<number>((resolve, reject) => {
      const ff = spawn(FFMPEG, ["-hide_banner", "-v", "error", "-progress", "pipe:1", "-nostats", "-y", "-i", video, "-vsync", "0", "-q:v", "2", path.join(dir, "%05d.jpg")], { windowsHide: true });
      let err = "";
      let buf = "";
      ff.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        for (const m of buf.matchAll(/^frame=(\d+)/gm)) progress = Number(m[1]);
        buf = buf.slice(buf.lastIndexOf("\n") + 1);
      });
      ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
      ff.on("error", (e) => reject(new Error(`ffmpeg frame extract could not start (${FFMPEG}): ${e.message}`)));
      ff.on("close", (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg frame extract failed (exit ${code}): ${err.trim().slice(-400)}`));
        fs.writeFileSync(stamp, mtime);
        x.finished = true;
        resolve(count());
      });
    }),
  };
  extracting.set(dir, x);
  // a failed pass stays recorded (no restart per frame request): frames then come from frameAt, and
  // the export's exact request reports the reason
  x.done.catch((e) => {
    console.error(`[lens] ${track} frame extract: ${e instanceof Error ? e.message : String(e)} (${bundle})`);
  });
  return x;
}

/** Size, fps and frame count of a track: one async probe per file, cached by path + size + mtime (memory and .lens-cache). */
const probeCache = new FileCache<VideoProbe>((f) => probeVideoFile(FFMPEG, FFPROBE, f), "probe-v1");
function probeTrack(bundle: string, track: "screen" | "cam"): Promise<VideoProbe> {
  return probeCache.get(path.join(bundle, `${track}.mp4`), path.join(bundle, ".lens-cache", `${track}.probe.json`));
}

// at most 3 seek decodes at a time (scrubbing far ahead of the pass must not start dozens of ffmpegs)
let seekBusy = 0;
const seekWait: Array<() => void> = [];
function seekSlot(): Promise<() => void> {
  const release = () => {
    seekBusy--;
    seekWait.shift()?.();
  };
  if (seekBusy < 3) {
    seekBusy++;
    return Promise.resolve(release);
  }
  return new Promise((r) => seekWait.push(() => {
    seekBusy++;
    r(release);
  }));
}

/** One frame decoded on demand (seek, then the first frame at or after n / fps): for frames the background pass has not reached. */
const frameJobs = new Map<string, Promise<Buffer>>();
function frameAt(bundle: string, track: "screen" | "cam", n: number, fps: number): Promise<Buffer> {
  const key = `${bundle}|${track}|${n}`;
  const hit = frameJobs.get(key);
  if (hit) return hit;
  const video = path.join(bundle, `${track}.mp4`);
  const t = Math.max(0, (n - 0.25) / fps);
  const p = seekSlot().then((release) => new Promise<Buffer>((resolve, reject) => {
    const ff = spawn(FFMPEG, ["-hide_banner", "-v", "error", "-ss", t.toFixed(4), "-i", video, "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
    ff.on("error", reject);
    ff.on("close", (code) => {
      const b = Buffer.concat(out);
      if (code === 0 && b.length) resolve(b);
      else reject(new Error(`frame ${n}: ffmpeg exited ${code}: ${err.trim().slice(-300)}`));
    });
  }).finally(release));
  frameJobs.set(key, p);
  void p.finally(() => frameJobs.delete(key)).catch(() => undefined);
  return p;
}

/** A path inside the bundle (no escaping it with .. or an absolute path). */
function insideBundle(bundle: string, rel: string): string | null {
  const p = path.resolve(bundle, rel);
  return p.startsWith(path.resolve(bundle) + path.sep) ? p : null;
}

/**
 * Fonts the plan names whose files are not there (an imported font missing from fonts/, a built-in that
 * was not fetched, a caption family with no files at all) are drawn in the default font, as the preview
 * does, instead of failing the export; the editor shows them as a warning (Windows v0.1.3).
 */
function planFontFallback(bundle: string, plan: RenderPlan): RenderPlan {
  const missing = missingFamilies(plan.fonts, (ref) => fontFile(bundle, ref));
  const cap = plan.style.captions.font;
  if (cap && !(plan.fonts ?? []).some((f) => f.family === cap)) missing.push(cap);
  return withFontFallback(plan, missing);
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

const MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2" };

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
  // one probe per track (size, fps, frame count; both tracks at once, off the event loop); the JPEG pass
  // starts in the background (served as it lands)
  const [screen, camera] = await Promise.all([probeTrack(dir, "screen"), hasCam ? probeTrack(dir, "cam") : null]);
  extractFrames(dir, "screen");
  if (hasCam) extractFrames(dir, "cam");
  const mic = micTrack(dir);
  // measured silences: in the answer when already cached, else measured in the background (GET /api/silences)
  const silences = micSilencesReady(dir);
  if (silences === undefined) void micSilences(dir);
  return {
    dir,
    name: path.basename(dir),
    /** No project.json yet: the editor applies the user's default preset. */
    isNew: !fs.existsSync(path.join(dir, "project.json")),
    meta,
    events,
    project,
    transcript,
    hasMic: !!mic,
    /** Measured silences on the mic (pauses for Cleanup when there is no transcript); absent while being measured. */
    ...(silences !== undefined ? { silences } : { silencesPending: true }),
    // a fresh desktop recording with a mic (recording.json autoTranscribe, written at Stop): the editor
    // starts on-device speech-to-text once; the marker stops a failed run from repeating on every open
    translateUnavailable: translateUnavailable(),
    autoTranscribe: !transcript && !!mic && (readJson(path.join(dir, "recording.json")) as { autoTranscribe?: boolean } | null)?.autoTranscribe === true
      && !fs.existsSync(path.join(dir, ".lens-cache", "transcribe-auto")),
    screen,
    camera,
    // the recorder's reason a selected camera is missing (conversion failed / nothing recorded), for the Webcam tab
    cameraWarning: cameraWarningOf(readJson(path.join(dir, "recording.json")) as Parameters<typeof cameraWarningOf>[0]),
  };
}

export { parseFfmpegVideoInfo } from "./probe";

/** Resolve a project against the bundle: audio paths made absolute so the compositor finds them. */
function exportProject(bundle: string, raw: unknown) {
  const p = resolveProject(raw);
  p.audio.tracks = p.audio.tracks.map((t) => ({ ...t, path: path.isAbsolute(t.path) ? t.path : path.join(bundle, t.path) }));
  // voiceover clips (demand #17) live in <bundle>/voiceover/
  if (p.voiceover) p.voiceover = { clips: p.voiceover.clips.map((c) => ({ ...c, path: path.isAbsolute(c.path) ? c.path : path.join(bundle, c.path) })) };
  // an uploaded backdrop lives in the bundle (Windows bug #20); built-in art ("builtin:<id>") is drawn
  const ip = p.background.imagePath;
  if (ip && !ip.startsWith("builtin:") && !path.isAbsolute(ip)) p.background.imagePath = path.join(bundle, ip);
  // the music bed lives in the bundle (demand #23)
  const mp = p.audio.music?.path;
  if (p.audio.music && mp && !path.isAbsolute(mp)) p.audio.music = { ...p.audio.music, path: path.join(bundle, mp) };
  return p;
}

async function startExport(bundle: string, rawProject: unknown): Promise<ExportJob> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(bundle, ".lens-export", id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8"));
  const events = parseEventLog(fs.readFileSync(path.join(bundle, "events.jsonl"), "utf8"));
  const tj = readJson(path.join(bundle, "transcript.json"));
  const tr = tj ? parseTranscript(tj) : null;
  const project = exportProject(bundle, rawProject);
  const plan = planFontFallback(bundle, buildRenderPlan({ meta, events, project, words: tr?.words ?? [], pauses: tr?.pauses ?? (await micSilences(bundle)) }));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const out = path.join(dir, "export.mp4");
  const job: ExportJob = { id, state: "running", done: 0, total: plan.frames.length, out, startedAt: Date.now() };
  jobs.set(id, job);
  const args = [path.join(ROOT, "compositor", "render.py"), "--plan", path.join(dir, "plan.json"), "--screen", path.join(bundle, "screen.mp4"),
    "--out", out, "--preset", "veryfast", "--progress", "--assets", bundle];
  // platform preset (demand #24): its bitrate; GIF and the size cap run after render.py (exportFinish.ts)
  const enc = project.export.video ? encodeSettings(project, exportBitrateMbps()) : null;
  if (enc?.bitrateMbps) args.push("--bitrate", String(enc.bitrateMbps), "--maxrate", String(enc.maxrateMbps));
  if (project.camera.enabled && fs.existsSync(path.join(bundle, "cam.mp4"))) args.push("--camera", path.join(bundle, "cam.mp4"));
  const py = spawn("python3", args, { cwd: ROOT });
  job.child = py;
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
    job.child = null;
    if (job.state !== "running") return; // cancelled
    if (!(code === 0 && fs.existsSync(out))) {
      job.finishedAt = Date.now();
      job.state = "error";
      job.error = err.trim().split("\n").slice(-4).join("\n") || `render.py exited ${code}`;
      return;
    }
    const chapters = wantsChapters(plan);
    const finish = !!enc && (enc.format === "gif" || !!enc.maxBytes);
    if (!chapters && !finish) {
      job.finishedAt = Date.now();
      job.state = "done";
      return;
    }
    const cancelled = () => job.state !== "running";
    (async () => {
      // chapters, title and description into the MP4 first (demand #27, stream copy); the preset's GIF /
      // size-cap step (demand #24) then runs on the chaptered file (ffmpeg carries chapters through a re-encode)
      if (chapters) {
        job.stage = "chapters";
        await embedChapters(FFMPEG, out, plan, (c) => (job.child = c));
      }
      if (cancelled()) throw new CancelledError();
      if (finish) {
        const r = await finishExport(FFMPEG, out, enc!, plan.output.durationMs, !!plan.audio, { child: (c) => (job.child = c), cancelled, stage: (s) => (job.stage = s) });
        if (cancelled()) return;
        job.out = r.out;
        job.format = r.format;
        job.cap = r.cap;
      }
      job.state = "done";
    })()
      .catch((e) => {
        if (cancelled() || e instanceof CancelledError) return;
        job.state = "error";
        job.error = `${job.stage === "chapters" ? "chapters" : job.stage === "gif" ? "gif" : "size cap"}: ${e instanceof Error ? e.message : String(e)}`;
      })
      .finally(() => (job.finishedAt = Date.now()));
  });
  return job;
}

/** NLE hand-off (demand #11): plan with its edit pieces, project files, ffmpeg waiting for overlay PNGs. */
async function startExportOverlay(bundle: string, rawProject: unknown): Promise<BrowserExportJob> {
  const id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8"));
  const events = parseEventLog(fs.readFileSync(path.join(bundle, "events.jsonl"), "utf8"));
  const tj = readJson(path.join(bundle, "transcript.json"));
  const tr = tj ? parseTranscript(tj) : null;
  const project = exportProject(bundle, rawProject);
  const plan = buildRenderPlan({ meta, events, project, words: tr?.words ?? [], pauses: tr?.pauses ?? (await micSilences(bundle)), editPieces: true });
  const job = startNleExport(FFMPEG, plan, bundle, path.join(bundle, ".lens-export", id), id, path.basename(bundle));
  jobs.set(id, job);
  return job;
}

/** In-browser export (LENS_EXPORT=browser): the plan is built here, the editor posts the frames. */
async function startExportBrowser(bundle: string, rawProject: unknown): Promise<BrowserExportJob> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8"));
  const events = parseEventLog(fs.readFileSync(path.join(bundle, "events.jsonl"), "utf8"));
  const tj = readJson(path.join(bundle, "transcript.json"));
  const tr = tj ? parseTranscript(tj) : null;
  const project = exportProject(bundle, rawProject);
  const plan = buildRenderPlan({ meta, events, project, words: tr?.words ?? [], pauses: tr?.pauses ?? (await micSilences(bundle)) });
  // platform preset (demand #24); without one the export is the old one (Settings bitrate or crf 18)
  const enc = project.export.video ? encodeSettings(project, exportBitrateMbps()) : undefined;
  const job = startBrowserExport(FFMPEG, plan, path.join(bundle, ".lens-export", id), id, ROOT, enc);
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
      if (url.pathname === "/api/silences" && req.method === "GET") return sendJson(res, { silences: await micSilences(bundle) });
      if ((m = /^\/api\/frames\/(screen|cam)\/(\d+)\.jpg$/.exec(url.pathname))) {
        const track = m[1] as "screen" | "cam";
        const x = extractFrames(bundle, track);
        const total = x.finished ? await x.done : (await probeTrack(bundle, track)).frames;
        const idx = Math.min(total - 1, Math.max(0, Number(m[2])));
        res.setHeader("content-type", "image/jpeg");
        res.setHeader("cache-control", "max-age=3600");
        // the export asks for exact frames: wait for the full decode pass
        if (url.searchParams.get("exact") === "1" && !x.finished) await x.done;
        const file = path.join(bundle, ".lens-cache", track, `${String(idx + 1).padStart(5, "0")}.jpg`);
        if (x.finished || idx < x.written()) return fs.createReadStream(file).pipe(res);
        // not decoded yet: frames a little ahead of the pass are worth a short wait, the rest are decoded on their own
        for (let i = 0; i < 10 && !x.finished && idx >= x.written() && idx - x.written() < 30; i++) await new Promise((r) => setTimeout(r, 50));
        if (x.finished || idx < x.written()) return fs.createReadStream(file).pipe(res);
        res.setHeader("cache-control", "no-store");
        return res.end(await frameAt(bundle, track, idx, (await probeTrack(bundle, track)).fps));
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
        res.setHeader("content-type", MIME[path.extname(f).toLowerCase()] ?? "font/ttf");
        // imported fonts can be replaced under the same name: never let the page keep a stale copy
        res.setHeader("cache-control", (url.searchParams.get("ref") ?? "").startsWith("fonts/") ? "no-store" : "max-age=3600");
        return fs.createReadStream(f).pipe(res);
      }
      if (url.pathname === "/api/fonts/library" && req.method === "GET") return sendJson(res, { fonts: listLibrary(defaultLibraryDir()) });
      if (url.pathname === "/api/fonts/library" && req.method === "DELETE") {
        const ok = removeFromLibrary(defaultLibraryDir(), url.searchParams.get("family") ?? "");
        return sendJson(res, { ok });
      }
      if (url.pathname === "/api/fonts/import" && req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req)) as ImportRequest;
          const r = await importFont(bundle, body, { fetch: globalThis.fetch, libraryDir: defaultLibraryDir() });
          return sendJson(res, r);
        } catch (e) {
          return sendJson(res, { error: e instanceof FontImportError ? e.message : `import failed: ${e instanceof Error ? e.message : String(e)}` }, 400);
        }
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
        // brand/ (logo, backdrop) or media/ (image slides, demand #20); nothing else is writable
        const folder = url.searchParams.get("folder") === "media" ? "media" : "brand";
        fs.mkdirSync(path.join(bundle, folder), { recursive: true });
        fs.writeFileSync(path.join(bundle, folder, name), Buffer.from(body.data, "base64"));
        return sendJson(res, { path: `${folder}/${name}` });
      }
      if (url.pathname === "/api/music" && req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req)) as { data: string };
          return sendJson(res, await importMusic(FFMPEG, bundle, url.searchParams.get("name") ?? "", Buffer.from(body.data ?? "", "base64")));
        } catch (e) {
          return sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (url.pathname === "/api/music/builtin" && req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req)) as { id: string };
          return sendJson(res, writeBuiltinBed(bundle, body.id));
        } catch (e) {
          return sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (url.pathname === "/api/voiceover" && req.method === "POST") {
        // demand #17: an imported audio file or a take recorded in the app -> <bundle>/voiceover/<name>
        const name = path.basename(url.searchParams.get("name") ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
        if (!name || !VOICE_EXT.has(path.extname(name).toLowerCase())) return sendJson(res, { error: "unsupported audio file (wav, mp3, m4a, aac, ogg, opus, webm, flac)" }, 400);
        const data = await readRaw(req, 200 * 1024 * 1024);
        fs.mkdirSync(path.join(bundle, "voiceover"), { recursive: true });
        let file = path.join(bundle, "voiceover", name);
        for (let i = 2; fs.existsSync(file); i++) file = path.join(bundle, "voiceover", `${path.basename(name, path.extname(name))}-${i}${path.extname(name)}`);
        fs.writeFileSync(file, data);
        const durationMs = await audioDurationMs(file);
        if (!(durationMs > 0)) {
          fs.rmSync(file, { force: true });
          return sendJson(res, { error: "no audio in that file" }, 400);
        }
        return sendJson(res, { path: `voiceover/${path.basename(file)}`, durationMs });
      }
      if (url.pathname === "/api/project" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        resolveProject(body); // validate before writing
        fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify(body, null, 2));
        return sendJson(res, { ok: true, path: path.join(bundle, "project.json") });
      }
      // share link with bring-your-own storage (demand #13); keys never leave this server
      if (url.pathname.startsWith("/api/share/")) {
        try {
          if (url.pathname === "/api/share/config" && req.method === "GET") return sendJson(res, publicConfig());
          if (url.pathname === "/api/share/config" && req.method === "PUT") {
            const b = JSON.parse(await readBody(req)) as { settings: ShareSettings; accessKeyId?: string; secretAccessKey?: string };
            saveShare(b.settings, { accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey });
            return sendJson(res, publicConfig());
          }
          if (url.pathname === "/api/share/config" && req.method === "DELETE") {
            forgetShare();
            return sendJson(res, publicConfig());
          }
          if (url.pathname === "/api/share/test" && req.method === "POST") return sendJson(res, await testShare());
          if (url.pathname === "/api/share/upload" && req.method === "POST") {
            const b = JSON.parse(await readBody(req)) as { exportId?: string; title?: string; chapters?: Array<{ t: number; title: string }> };
            if (!b.exportId || !/^[a-z0-9]+$/.test(b.exportId)) return sendJson(res, { error: "Export the video first: no finished export to share" }, 400);
            const chapters = Array.isArray(b.chapters) ? b.chapters.filter((c) => Number.isFinite(c?.t) && typeof c?.title === "string").slice(0, 200) : [];
            const job = startShare({ exportFile: path.join(bundle, ".lens-export", b.exportId, "export.mp4"), title: String(b.title ?? "").slice(0, 200), chapters, ffmpeg: FFMPEG });
            return sendJson(res, { id: job.id });
          }
          if ((m = /^\/api\/share\/upload\/([a-f0-9]+)$/.exec(url.pathname))) {
            const job = shareJob(m[1]!);
            return job ? sendJson(res, job) : sendJson(res, { error: "no such share" }, 404);
          }
          return sendJson(res, { error: "unknown endpoint" }, 404);
        } catch (e) {
          // ShareError messages are already redacted; anything else is reported without its text
          const se = e instanceof ShareError ? e : null;
          const msg = se ? se.message : e instanceof SyntaxError ? "bad request" : "share failed";
          console.error(`[lens] ${req.method} ${url.pathname}: ${msg}`);
          return sendJson(res, { error: msg }, se?.status ?? 500);
        }
      }
      if (url.pathname === "/api/capabilities" && req.method === "GET") return sendJson(res, { export: EXPORT_PATH });
      if (url.pathname === "/api/export-overlay" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const job = await startExportOverlay(bundle, body.project);
        return sendJson(res, { id: job.id, total: job.total });
      }
      if (url.pathname === "/api/export-browser" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const job = await startExportBrowser(bundle, body.project);
        return sendJson(res, { id: job.id, total: job.total });
      }
      if ((m = /^\/api\/export-browser\/([a-z0-9]+)\/(frame|finish|cancel)$/.exec(url.pathname)) && req.method === "POST") {
        const job = jobs.get(m[1]!);
        if (!job || !("ff" in job)) return sendJson(res, { error: "no such export" }, 404);
        if (m[2] === "cancel") {
          // Windows bug #11: long jobs can be cancelled; ffmpeg (and a mux / GIF / size-cap step) is
          // stopped and the partial file left behind
          cancelBrowserExport(job);
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
      if ((m = /^\/api\/export\/([a-z0-9]+)\/cancel$/.exec(url.pathname)) && req.method === "POST") {
        const job = jobs.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such export" }, 404);
        if ("ff" in job) cancelBrowserExport(job);
        else if (job.state === "running") {
          job.state = "error";
          job.error = "cancelled";
          job.finishedAt = Date.now();
          try {
            job.child?.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
        return sendJson(res, { ok: true });
      }
      if (url.pathname === "/api/export" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const job = await startExport(bundle, body.project);
        return sendJson(res, { id: job.id, total: job.total });
      }
      if ((m = /^\/api\/export\/([a-z0-9]+)(\/file)?$/.exec(url.pathname))) {
        const job = jobs.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such export" }, 404);
        const files = "files" in job ? (job.files as Record<string, string>) : null;
        if (m[2] && files) {
          if (job.state !== "done") return sendJson(res, { error: "not finished" }, 409);
          const want = url.searchParams.get("name") ?? "overlay.mov";
          const file = Object.values(files).find((f) => path.basename(f) === want);
          if (!file) return sendJson(res, { error: "no such file" }, 404);
          const types: Record<string, string> = { ".mov": "video/quicktime", ".webm": "video/webm", ".fcpxml": "application/xml", ".edl": "text/plain" };
          res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
          res.setHeader("content-disposition", `attachment; filename="${path.basename(file)}"`);
          return fs.createReadStream(file).pipe(res);
        }
        if (m[2]) {
          if (job.state !== "done") return sendJson(res, { error: "not finished" }, 409);
          const gif = job.out.toLowerCase().endsWith(".gif");
          res.setHeader("content-type", gif ? "image/gif" : "video/mp4");
          res.setHeader("content-disposition", `attachment; filename="lens-export.${gif ? "gif" : "mp4"}"`);
          return fs.createReadStream(job.out).pipe(res);
        }
        return sendJson(res, { id: job.id, state: job.state, done: job.done, total: job.total, error: job.error, out: job.out,
          stage: job.stage, format: job.format ?? (job.out.toLowerCase().endsWith(".gif") ? "gif" : "mp4"), cap: job.cap,
          bytes: job.state === "done" && fs.existsSync(job.out) ? fs.statSync(job.out).size : undefined,
          ...(files ? { files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, path.basename(f)])) } : {}),
          seconds: ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 });
      }
      if (url.pathname === "/api/transcribe" && req.method === "POST") {
        const job = startTranscribe(bundle, url.searchParams.get("auto") === "1");
        return sendJson(res, { id: job.id, state: job.state, error: job.error });
      }
      if ((m = /^\/api\/transcribe\/([a-z0-9]+)$/.exec(url.pathname))) {
        const job = transcribeJobs.get(m[1]!);
        if (!job) return sendJson(res, { error: "no such job" }, 404);
        return sendJson(res, { id: job.id, state: job.state, done: job.done, error: job.error, result: job.state === "done" ? job.result : undefined,
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
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[lens] ${req.method} ${url.pathname} (${bundle}): ${msg}`);
      return sendJson(res, { error: msg }, 500);
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
