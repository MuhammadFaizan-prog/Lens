/**
 * Local dev-server endpoints for the Lens editor (Vite plugin; Tauri commands replace these later).
 *
 *   GET  /api/bundle[?dir=]          meta, events, project, transcript and frame counts of a bundle
 *   GET  /api/frames/:track/:n.jpg   decoded source frame n (0-based) of screen | cam
 *   GET  /api/media/:name            a file inside the bundle (audio tracks)
 *   GET  /api/font/caption.ttf       the caption font the reference compositor uses (DejaVu Sans Bold)
 *   POST /api/project                save project.json into the bundle
 *   POST /api/export                 { project } -> { id }: engine plan + compositor/render.py
 *   GET  /api/export/:id             { state, done, total, error }
 *   GET  /api/export/:id/file        the exported MP4
 *   POST /api/privacy/scan[?force=1] start redact/lens-redact on screen.mp4 -> { id } (cached per screen.mp4)
 *   GET  /api/privacy/scan/:id       { state, stage, done, total, error, result }
 *   GET  /api/privacy/thumb/:name    a review thumbnail (.lens-cache/privacy/)
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
import { buildRenderPlan, parseEventLog, parseTranscript, resolveProject } from "../../../packages/engine/src/index";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.resolve(HERE, "..");
const ROOT = path.resolve(EDITOR, "..", "..");
const FONT_CANDIDATES = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/DejaVuSans-Bold.ttf"];

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

const jobs = new Map<string, ExportJob>();

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
const extracting = new Map<string, Promise<number>>();

export function defaultBundle(): string {
  return path.resolve(process.env.LENS_BUNDLE ?? path.join(EDITOR, "sample"));
}

function ensureSample(dir: string): void {
  if (fs.existsSync(path.join(dir, "screen.mp4"))) return;
  const takes = path.resolve(dir) === path.resolve(EDITOR, "sample-takes");
  const privacy = path.resolve(dir) === path.resolve(EDITOR, "sample-privacy");
  if (path.resolve(dir) !== path.resolve(EDITOR, "sample") && !takes && !privacy) throw new Error(`no screen.mp4 in ${dir}`);
  const r = spawnSync("python3", [path.join(EDITOR, "scripts", "make_sample.py"), "--out", dir, ...(takes ? ["--takes"] : []), ...(privacy ? ["--privacy"] : [])], { encoding: "utf8" });
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
    const ff = spawn("ffmpeg", ["-v", "error", "-y", "-i", video, "-vsync", "0", "-q:v", "2", path.join(dir, "%05d.jpg")]);
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
  const probe = (f: string) => {
    const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", f], { encoding: "utf8" });
    const s = JSON.parse(r.stdout).streams[0];
    const [n, d] = String(s.r_frame_rate).split("/").map(Number);
    return { width: s.width as number, height: s.height as number, fps: (n ?? 30) / (d ?? 1) };
  };
  return {
    dir,
    name: path.basename(dir),
    meta,
    events,
    project,
    transcript,
    screen: { ...probe(path.join(dir, "screen.mp4")), frames: screenFrames },
    camera: hasCam ? { ...probe(path.join(dir, "cam.mp4")), frames: camFrames } : null,
  };
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
    "--out", out, "--preset", "veryfast", "--progress"];
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
      if (url.pathname === "/api/font/caption.ttf") {
        const f = FONT_CANDIDATES.find((p) => fs.existsSync(p));
        if (!f) return sendJson(res, { error: "font not installed" }, 404);
        res.setHeader("content-type", "font/ttf");
        return fs.createReadStream(f).pipe(res);
      }
      if (url.pathname === "/api/project" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        resolveProject(body); // validate before writing
        fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify(body, null, 2));
        return sendJson(res, { ok: true, path: path.join(bundle, "project.json") });
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
