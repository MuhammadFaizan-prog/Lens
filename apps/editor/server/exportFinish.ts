/**
 * After the encode (demand #24, docs/ExportPresets.md): the platform preset's last steps, shared by the
 * in-app (browser) export and the Python reference export, all with ffmpeg and no Python:
 *
 *   - GIF: the finished MP4 becomes an animated GIF with a whole-clip palette (palettegen
 *     stats_mode=diff, paletteuse sierra2_4a), the same filter as compositor/lens_compositor/audio.py
 *     export_gif, at project.export.gif fps / width / loop;
 *   - size cap: an MP4 over the cap is re-encoded at the average bitrate that fits (audio copied,
 *     peak = average, so the rate control cannot overshoot), smaller on each retry, at most 3 passes.
 *
 * Every step runs one ffmpeg child at a time through `run`, which the job keeps so Cancel can kill it,
 * and `cancelled()` is asked between steps, so a cancelled export never turns "done".
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bitrateForCap, type EncodeSettings } from "../../../packages/engine/src/index";

export interface FinishHooks {
  /** Called with each ffmpeg child (and null when it is gone), so Cancel can kill it. */
  child?: (c: ChildProcess | null) => void;
  cancelled?: () => boolean;
  stage?: (s: "gif" | "cap") => void;
}

export interface FinishResult {
  /** The file to hand out (export.mp4 or export.gif). */
  out: string;
  format: "mp4" | "gif";
  /** Size-cap re-encode: bytes before, bytes after, passes and the last bitrate (Mbps). */
  cap?: { maxBytes: number; before: number; after: number; passes: number; bitrateMbps: number };
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

function run(ffmpeg: string, args: string[], hooks: FinishHooks): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hooks.cancelled?.()) return reject(new CancelledError());
    const p = spawn(ffmpeg, args, { windowsHide: true });
    hooks.child?.(p);
    let err = "";
    p.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => {
      hooks.child?.(null);
      reject(e);
    });
    p.on("close", (code) => {
      hooks.child?.(null);
      if (hooks.cancelled?.()) reject(new CancelledError());
      else if (code === 0) resolve();
      else reject(new Error(err.trim().split("\n").slice(-3).join("\n") || `ffmpeg exited ${code}`));
    });
  });
}

/** ffmpeg arguments for the GIF (same filter as audio.py export_gif). */
export function gifArgs(mp4: string, out: string, gif: EncodeSettings["gif"]): string[] {
  const vf = `fps=${gif.fps},scale=${Math.round(gif.width)}:-1:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
  return ["-v", "error", "-nostdin", "-y", "-i", mp4, "-filter_complex", vf, "-loop", gif.loop ? "0" : "-1", out];
}

/** ffmpeg arguments for one size-cap pass: H.264 at `mbps` average and peak, audio copied. */
export function capArgs(src: string, out: string, mbps: number): string[] {
  const k = Math.max(50, Math.floor(mbps * 1000));
  return ["-v", "error", "-nostdin", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", `${k}k`, "-maxrate", `${k}k`, "-bufsize", `${k * 2}k`, "-threads", "2", "-x264-params", "rc-lookahead=10:sync-lookahead=0",
    "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "copy", "-movflags", "+faststart", out];
}

/**
 * Apply the preset's last steps to `mp4` (the finished export, video + audio) and return the file to
 * hand out. Nothing to do (MP4, no cap or under it) returns `mp4` untouched.
 */
export async function finishExport(ffmpeg: string, mp4: string, enc: EncodeSettings, durationMs: number, hasAudio: boolean, hooks: FinishHooks = {}): Promise<FinishResult> {
  const dir = path.dirname(mp4);
  if (enc.format === "gif") {
    hooks.stage?.("gif");
    const gif = path.join(dir, "export.gif");
    await run(ffmpeg, gifArgs(mp4, gif, enc.gif), hooks);
    return { out: gif, format: "gif" };
  }
  if (!enc.maxBytes) return { out: mp4, format: "mp4" };
  const before = fs.statSync(mp4).size;
  if (before <= enc.maxBytes) return { out: mp4, format: "mp4", cap: { maxBytes: enc.maxBytes, before, after: before, passes: 0, bitrateMbps: enc.bitrateMbps } };
  hooks.stage?.("cap");
  const src = path.join(dir, "uncapped.mp4");
  fs.renameSync(mp4, src);
  const tmp = path.join(dir, "capped.mp4");
  let after = before;
  let mbps = 0;
  let passes = 0;
  try {
    for (const scale of [1, 0.85, 0.7]) {
      mbps = bitrateForCap(enc.maxBytes, durationMs, hasAudio, scale);
      if (enc.bitrateMbps) mbps = Math.min(mbps, enc.bitrateMbps);
      passes++;
      await run(ffmpeg, capArgs(src, tmp, mbps), hooks);
      after = fs.statSync(tmp).size;
      if (after <= enc.maxBytes) break;
    }
    if (after > enc.maxBytes) throw new Error(`could not fit under ${(enc.maxBytes / 1e6).toFixed(1)} MB (${(after / 1e6).toFixed(1)} MB at ${mbps.toFixed(2)} Mbps); shorten the video or raise the cap`);
    fs.renameSync(tmp, mp4);
    fs.rmSync(src, { force: true });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (!fs.existsSync(mp4) && fs.existsSync(src)) fs.renameSync(src, mp4);
    throw e;
  }
  return { out: mp4, format: "mp4", cap: { maxBytes: enc.maxBytes, before, after, passes, bitrateMbps: mbps } };
}
