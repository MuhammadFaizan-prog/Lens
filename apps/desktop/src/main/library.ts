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

/** Import a video file as a new bundle in root. Returns the bundle directory. */
export async function importVideo(root: string, ffmpeg: string, file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!IMPORT_EXTENSIONS.includes(ext)) throw new Error(`unsupported file type .${ext} (mp4, mov, webm, mkv)`);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const base = path.basename(file, path.extname(file)).replace(/[^\w.-]+/g, "_").slice(0, 40) || "video";
  const dir = path.join(root, `Lens-import-${stamp}-${base}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // probe: size, frame rate, audio present (ffmpeg -i prints the stream lines)
    const info = await run(ffmpeg, ["-hide_banner", "-i", file, "-f", "null", "-t", "0", "-"]).catch((e: Error) => e.message);
    const v = /Stream #\S+.*Video: .*?(\d{2,5})x(\d{2,5})/.exec(info);
    if (!v) throw new Error("no video stream in the file");
    const fpsM = /(\d+(?:\.\d+)?) fps/.exec(info);
    const fps = Math.min(60, Math.max(24, Math.round(Number(fpsM?.[1] ?? 30)))) >= 45 ? 60 : 30;
    const hasAudio = /Stream #\S+.*Audio:/.test(info);
    // even dimensions for yuv420p; constant frame rate (the editor indexes frames as round(t * fps))
    await run(ffmpeg, ["-v", "error", "-y", "-i", file, "-map", "0:v:0", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-fps_mode", "cfr", "-r", String(fps),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(dir, "screen.mp4")]);
    const out = await run(ffmpeg, ["-hide_banner", "-i", path.join(dir, "screen.mp4"), "-f", "null", "-"]).catch((e: Error) => e.message);
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
    const durationMs = d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : 0;
    const sz = /Video: .*?(\d{2,5})x(\d{2,5})/.exec(out)!;
    const width = Number(sz[1]);
    const height = Number(sz[2]);
    const tracks: unknown[] = [];
    if (hasAudio) {
      await run(ffmpeg, ["-v", "error", "-y", "-i", file, "-map", "0:a:0", "-vn", "-af", "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(dir, "mic.wav")]);
      tracks.push({ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false });
    }
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width, height, fps, durationMs, pixelRatio: 1 }));
    // no cursor / clicks: a header-only event log
    fs.writeFileSync(path.join(dir, "events.jsonl"), headerLine({ capture: { width, height }, source: "import", platform: process.platform, displayId: null }) + "\n");
    // zoom is manual only (no clicks to follow), Lens's cursor off (none was logged)
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, audio: { tracks }, zoom: { auto: false }, cursor: { visible: false } }, null, 2));
    fs.writeFileSync(path.join(dir, "recording.json"), JSON.stringify({ app: "lens-import", source: { file: path.basename(file) }, fps, autoTranscribe: hasAudio }, null, 2));
    return dir;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
