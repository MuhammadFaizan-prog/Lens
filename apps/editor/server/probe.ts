/**
 * Video probe and per-file result cache for the editor server (v0.1.3 editor open: /api/bundle spent
 * 2.8 s of a 3.6 s open in spawnSync calls on Electron's main thread: a frame-count pass and an
 * `ffmpeg -i` probe per track, plus the mic's two silence passes).
 *
 * - probeVideoFile: ONE async process per file gives width, height, fps and the frame count:
 *   ffprobe -count_packets when ffprobe is there, else one `ffmpeg -c copy -f null` pass whose stderr
 *   carries both the stream line and the final frame= count (the desktop build ships no ffprobe).
 * - FileCache: results keyed by path + size + mtime; concurrent callers share one promise, a failure is
 *   not remembered (the next call retries), and an optional JSON file per entry survives a restart.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** Cache key of a file's current contents: its path, size and mtime. Throws when the file is missing. */
export function fileKey(file: string): string {
  const st = fs.statSync(file);
  return `${path.resolve(file)}|${st.size}|${st.mtimeMs}`;
}

export class FileCache<T> {
  private readonly mem = new Map<string, Promise<T>>();
  private readonly settled = new Map<string, T>();
  constructor(private readonly compute: (file: string) => Promise<T>, private readonly version = "v1") {}

  /** The value for the file as it is now: from memory, the disk copy (when given), else computed once. */
  get(file: string, diskCache?: string, extra = ""): Promise<T> {
    const key = `${fileKey(file)}|${extra}|${this.version}`;
    const hit = this.mem.get(key);
    if (hit) return hit;
    const disk = diskCache ? readCache<T>(diskCache, key) : undefined;
    const p = disk !== undefined ? Promise.resolve(disk) : this.compute(file).then((v) => {
      if (diskCache) {
        try {
          fs.mkdirSync(path.dirname(diskCache), { recursive: true });
          fs.writeFileSync(diskCache, JSON.stringify({ key, value: v }));
        } catch {
          // a read-only bundle still works, uncached across restarts
        }
      }
      return v;
    });
    this.mem.set(key, p);
    p.then((v) => this.settled.set(key, v), () => this.mem.delete(key));
    return p;
  }

  /** The value if it is already known (memory or disk) without starting any work; undefined otherwise. */
  peek(file: string, diskCache?: string, extra = ""): T | undefined {
    const key = `${fileKey(file)}|${extra}|${this.version}`;
    if (this.settled.has(key)) return this.settled.get(key);
    const disk = diskCache ? readCache<T>(diskCache, key) : undefined;
    if (disk !== undefined) {
      this.settled.set(key, disk);
      this.mem.set(key, Promise.resolve(disk));
    }
    return disk;
  }
}

function readCache<T>(file: string, key: string): T | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as { key?: string; value?: T };
    return c.key === key && c.value !== undefined ? c.value : undefined;
  } catch {
    return undefined;
  }
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
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

/** Width, height, fps and frame count of a video's first stream from `ffmpeg -i f -map 0:v:0 -c copy -f null -` stderr. */
export function parseCopyPass(stderr: string): VideoProbe {
  const all = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  const frames = all.length ? Number(all[all.length - 1]![1]) : 0;
  return { ...parseFfmpegVideoInfo(stderr), frames };
}

/** One process per file: ffprobe (packets counted) when present, else one ffmpeg stream-copy pass. */
export async function probeVideoFile(ffmpeg: string, ffprobe: string, file: string): Promise<VideoProbe> {
  const name = path.basename(file);
  let v: VideoProbe | null = null;
  const pr = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,r_frame_rate,nb_read_packets", "-of", "json", file]).catch(() => null);
  if (pr?.code === 0 && pr.stdout) {
    const s = JSON.parse(pr.stdout).streams?.[0];
    if (s) {
      const [n, d] = String(s.r_frame_rate).split("/").map(Number);
      v = { width: Number(s.width), height: Number(s.height), fps: (n || 30) / (d || 1), frames: Number(s.nb_read_packets) || 0 };
    }
  }
  if (!v) {
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(ffmpeg, ["-hide_banner", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]);
    } catch (e) {
      throw new Error(`could not run ffmpeg (${ffmpeg}) to read ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      v = parseCopyPass(r.stderr);
    } catch {
      v = { width: 0, height: 0, fps: 30, frames: 0 };
    }
    if (!v.frames || !v.width) throw new Error(`${name} has no readable video frames (ffmpeg: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(" / ").slice(0, 300)})`);
  }
  if (!v.frames) throw new Error(`${name} has no readable video frames`);
  return v;
}
