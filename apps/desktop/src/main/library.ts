/**
 * Recorder home File menu (Windows #18): History (the recordings / projects in the save folder) and
 * "Import Video to Create Project" (an mp4 / mov / webm / mkv becomes a Lens bundle with no cursor or
 * click events: zooms are manual only, captions come from in-app speech-to-text on its audio).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { headerLine } from "../shared/eventlog";

export interface HistoryItem {
  dir: string;
  name: string;
  createdMs: number;
  durationMs: number | null;
  imported: boolean;
  thumbnail: string | null; // data: URL (jpeg)
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out + err) : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-400)}`))));
  });
}

const readJson = (f: string): any => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

/** Bundles under root, newest first (at most `limit`), each with a cached 240 px thumbnail. */
export async function listHistory(root: string, ffmpeg: string, limit = 50): Promise<HistoryItem[]> {
  if (!fs.existsSync(root)) return [];
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "screen.mp4")))
    .map((d) => path.join(root, d.name))
    .map((dir) => ({ dir, createdMs: fs.statSync(path.join(dir, "screen.mp4")).mtimeMs }))
    .sort((a, b) => b.createdMs - a.createdMs)
    .slice(0, limit);
  const items: HistoryItem[] = [];
  for (const { dir, createdMs } of dirs) {
    const meta = readJson(path.join(dir, "meta.json"));
    const rec = readJson(path.join(dir, "recording.json"));
    const thumb = path.join(dir, ".lens-cache", "thumb.jpg");
    if (!fs.existsSync(thumb)) {
      fs.mkdirSync(path.dirname(thumb), { recursive: true });
      const at = meta?.durationMs ? Math.min(1, meta.durationMs / 2000) : 0;
      await run(ffmpeg, ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", path.join(dir, "screen.mp4"), "-frames:v", "1", "-vf", "scale=240:-2", "-q:v", "5", thumb]).catch(() => undefined);
    }
    items.push({
      dir,
      name: path.basename(dir),
      createdMs,
      durationMs: typeof meta?.durationMs === "number" ? meta.durationMs : null,
      imported: rec?.app === "lens-import",
      thumbnail: fs.existsSync(thumb) ? `data:image/jpeg;base64,${fs.readFileSync(thumb).toString("base64")}` : null,
    });
  }
  return items;
}

/** Delete a bundle, only if it is a bundle directly inside root (never anything else). */
export function deleteBundle(root: string, dir: string): void {
  const r = path.resolve(root);
  const d = path.resolve(dir);
  if (path.dirname(d) !== r || !fs.existsSync(path.join(d, "screen.mp4"))) throw new Error("not a Lens recording in the save folder");
  fs.rmSync(d, { recursive: true, force: true });
}

export const IMPORT_EXTENSIONS = ["mp4", "mov", "webm", "mkv"];

export interface ImportProgress {
  /** 0-100 over the whole import (video, then audio when the file has any) */
  pct: number;
  phase: "probe" | "video" | "audio";
}
export interface ImportOptions {
  onProgress?: (p: ImportProgress) => void;
  /** aborting kills the running ffmpeg; the half-made bundle folder is removed */
  signal?: AbortSignal;
  /** probe step guard (ms); a file ffmpeg cannot read the header of fails instead of hanging */
  probeTimeoutMs?: number;
}
export interface ImportResult {
  dir: string;
  /** "copy": the source h264 stream was remuxed as is; "encode": re-encoded (libx264, constant frame rate) */
  video: "copy" | "encode";
  durationMs: number;
  progressEvents: number;
}

export class ImportCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "ImportCancelled";
  }
}

export interface ProbeInfo {
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  pixFmt: string;
  /** average frame rate ("fps" in ffmpeg -i), and the stream's base rate ("tbr") */
  fps: number;
  tbr: number;
  hasAudio: boolean;
  rotated: boolean;
}

/** Parse the stream lines `ffmpeg -i` prints. Exported for tests. */
export function parseProbe(info: string): ProbeInfo {
  const line = info.split(/\r?\n/).find((l) => /Stream #\S+.*: Video:/.test(l));
  if (!line) throw new Error("no video stream in the file");
  const sz = / (\d{2,5})x(\d{2,5})[ ,\]]/.exec(line);
  if (!sz) throw new Error("could not read the video size");
  const codec = /Video: (\w+)/.exec(line)?.[1] ?? "";
  // "Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 ..." / "yuv420p(tv, bt709, progressive)"
  const pixFmt = /Video: [^,]+, (\w+)/.exec(line)?.[1] ?? "";
  const fps = Number(/([\d.]+) fps/.exec(line)?.[1] ?? NaN);
  const tbr = Number(/([\d.]+k?) tbr/.exec(line)?.[1]?.replace(/k$/, "000") ?? NaN);
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  const durationMs = d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : 0;
  return {
    durationMs, width: Number(sz[1]), height: Number(sz[2]), codec, pixFmt, fps, tbr,
    hasAudio: /Stream #\S+.*: Audio:/.test(info),
    rotated: /rotate\s*:\s*-?[1-9]|displaymatrix: rotation of -?[1-9]/.test(info),
  };
}

/**
 * The stream can be remuxed unchanged: h264, yuv420p, even size, <= 60 fps and constant frame rate
 * (average rate = stream rate; the editor indexes frames as round(t * fps)), no rotation to apply.
 */
export function canCopy(p: ProbeInfo): boolean {
  return p.codec === "h264" && p.pixFmt === "yuv420p" && p.width % 2 === 0 && p.height % 2 === 0
    && Number.isFinite(p.fps) && p.fps > 0 && p.fps <= 60.5 && Number.isFinite(p.tbr) && Math.abs(p.fps - p.tbr) <= 0.01 * p.tbr && !p.rotated;
}

/** Run ffmpeg with -progress on stdout; reports out_time in ms. Kills the process on abort or timeout. */
function runFfmpeg(bin: string, args: string[], o: { signal?: AbortSignal; timeoutMs?: number; onTime?: (ms: number) => void; allowFail?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new ImportCancelled());
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let err = "";
    let buf = "";
    let why: Error | null = null;
    const kill = (e: Error) => {
      why ??= e;
      p.kill("SIGKILL");
    };
    const onAbort = () => kill(new ImportCancelled());
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = o.timeoutMs ? setTimeout(() => kill(new Error(`ffmpeg did not answer within ${Math.round(o.timeoutMs! / 1000)} s reading the file`)), o.timeoutMs) : null;
    p.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        // out_time_us (newer ffmpeg) and out_time_ms (also microseconds, despite the name)
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
        if (m && o.onTime) o.onTime(Number(m[1]) / 1000);
      }
    });
    p.stderr.on("data", (d) => {
      err += d;
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    p.on("error", (e) => {
      why ??= e;
    });
    let settled = false;
    const finish = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    // killed: settle on exit (a grandchild holding the pipes open must not keep us waiting for close)
    p.on("exit", () => {
      if (why && !settled) {
        finish();
        reject(why);
      }
    });
    p.on("close", (c) => {
      if (settled) return;
      finish();
      if (why) return reject(why);
      if (c === 0 || o.allowFail) return resolve(err);
      const last = err.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
      reject(new Error(`ffmpeg exited ${c}${last ? `: ${last.slice(-400)}` : ""}`));
    });
  });
}

const PROGRESS = ["-progress", "pipe:1", "-nostats"];

/** Import a video file as a new bundle in root. */
export async function importVideo(root: string, ffmpeg: string, file: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!IMPORT_EXTENSIONS.includes(ext)) throw new Error(`unsupported file type .${ext} (mp4, mov, webm, mkv)`);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const base = path.basename(file, path.extname(file)).replace(/[^\w.-]+/g, "_").slice(0, 40) || "video";
  const dir = path.join(root, `Lens-import-${stamp}-${base}`);
  fs.mkdirSync(dir, { recursive: true });
  let events = 0;
  let lastPct = -1;
  const report = (phase: ImportProgress["phase"], pct: number) => {
    const v = Math.max(0, Math.min(100, Math.floor(pct)));
    if (v === lastPct && phase !== "probe") return;
    lastPct = v;
    events++;
    opts.onProgress?.({ pct: v, phase });
  };
  try {
    report("probe", 0);
    // probe: size, codec, pixel format, frame rate, duration, audio (ffmpeg -i prints them; it exits 1 without an output, so allowFail)
    const info = await runFfmpeg(ffmpeg, ["-hide_banner", "-i", file], { signal: opts.signal, timeoutMs: opts.probeTimeoutMs ?? 30_000, allowFail: true });
    const pr = parseProbe(info);
    const copy = canCopy(pr);
    const videoShare = pr.hasAudio ? (copy ? 50 : 85) : 100;
    const total = pr.durationMs;
    let videoMs = 0;
    const onVideo = (ms: number) => {
      videoMs = Math.max(videoMs, ms);
      if (total > 0) report("video", (Math.min(ms, total) / total) * videoShare);
    };
    const screen = path.join(dir, "screen.mp4");
    let fps: number;
    let width = pr.width;
    let height = pr.height;
    if (copy) {
      fps = Math.round(pr.fps * 1000) / 1000;
      await runFfmpeg(ffmpeg, ["-v", "error", ...PROGRESS, "-y", "-i", file, "-map", "0:v:0", "-c:v", "copy", "-an", "-sn", "-dn", "-movflags", "+faststart", screen], { signal: opts.signal, onTime: onVideo });
    } else {
      // even dimensions for yuv420p; constant frame rate (the editor indexes frames as round(t * fps))
      fps = Number.isFinite(pr.fps) && pr.fps >= 45 ? 60 : 30;
      width -= width % 2;
      height -= height % 2;
      await runFfmpeg(ffmpeg, ["-v", "error", ...PROGRESS, "-y", "-i", file, "-map", "0:v:0", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-fps_mode", "cfr", "-r", String(fps),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", screen], { signal: opts.signal, onTime: onVideo });
    }
    // duration from the probe (the container); no second decode of screen.mp4
    const durationMs = total > 0 ? total : Math.round(videoMs);
    const tracks: unknown[] = [];
    if (pr.hasAudio) {
      await runFfmpeg(ffmpeg, ["-v", "error", ...PROGRESS, "-y", "-i", file, "-map", "0:a:0", "-vn", "-af", "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(dir, "mic.wav")],
        { signal: opts.signal, onTime: (ms) => total > 0 && report("audio", videoShare + (Math.min(ms, total) / total) * (100 - videoShare)) });
      tracks.push({ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false });
    }
    if (opts.signal?.aborted) throw new ImportCancelled();
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width, height, fps, durationMs, pixelRatio: 1 }));
    // no cursor / clicks: a header-only event log
    fs.writeFileSync(path.join(dir, "events.jsonl"), headerLine({ capture: { width, height }, source: "import", platform: process.platform, displayId: null }) + "\n");
    // zoom is manual only (no clicks to follow), Lens's cursor off (none was logged)
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, audio: { tracks }, zoom: { auto: false }, cursor: { visible: false } }, null, 2));
    fs.writeFileSync(path.join(dir, "recording.json"), JSON.stringify({ app: "lens-import", source: { file: path.basename(file) }, fps, autoTranscribe: pr.hasAudio, video: copy ? "copy" : "encode" }, null, 2));
    report(pr.hasAudio ? "audio" : "video", 100);
    return { dir, video: copy ? "copy" : "encode", durationMs, progressEvents: events };
  } catch (e) {
    // ffmpeg has exited (runFfmpeg settles on close), so Windows has released screen.mp4
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw e;
  }
}
