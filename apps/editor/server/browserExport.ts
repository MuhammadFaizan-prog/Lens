/**
 * In-browser export path (desktop app, docs/Desktop.md). Used where the Python reference compositor
 * is not available (the Windows desktop build): the editor draws every plan frame with the same
 * Canvas2D renderer as the preview (preview/export parity is measured in e2e/parity.spec.ts) and
 * posts each frame as a JPEG; this side pipes them into ffmpeg (H.264, BT.709 limited range, the
 * same tags as the compositor) and mixes the plan's audio pieces with an ffmpeg filter graph.
 *
 * Differences from compositor/render.py, by design for now: loudness is one-pass loudnorm (the
 * compositor runs two passes), no afftdn denoise, no synthesized click sounds, no 3 ms fades at cuts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AudioPlan, RenderPlan } from "../../../packages/engine/src/index";

/** ffmpeg filter chain for a playback rate (atempo takes 0.5..100 per stage). */
export function atempoChain(rate: number): string {
  if (Math.abs(rate - 1) < 1e-6) return "";
  const stages: number[] = [];
  let r = rate;
  while (r < 0.5) {
    stages.push(0.5);
    r /= 0.5;
  }
  while (r > 100) {
    stages.push(100);
    r /= 100;
  }
  stages.push(r);
  return stages.map((s) => `atempo=${s.toFixed(6)}`).join(",");
}

const sec = (ms: number) => (ms / 1000).toFixed(6);

/**
 * filter_complex for the plan's audio. Inputs 1..n are the plan's tracks (input 0 is the video pipe).
 * Each track is aligned to the recording clock (offset), gained and summed; every plan piece is then
 * sliced from that sum, time-stretched, gained and delayed to its output start; pieces are summed.
 * Returns null when the plan has no audible track.
 */
export function audioFilterGraph(audio: AudioPlan | null, firstInput = 1): string | null {
  if (!audio || audio.tracks.length === 0 || audio.pieces.length === 0) return null;
  const sr = audio.sampleRate;
  const parts: string[] = [];
  audio.tracks.forEach((t, i) => {
    const align =
      t.offsetMs > 0 ? `,adelay=${Math.round(t.offsetMs)}:all=1` : t.offsetMs < 0 ? `,atrim=start=${sec(-t.offsetMs)},asetpts=PTS-STARTPTS` : "";
    parts.push(`[${firstInput + i}:a]aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=stereo${align},volume=${t.volume},apad[t${i}]`);
  });
  const n = audio.tracks.length;
  if (n > 1) parts.push(`${audio.tracks.map((_, i) => `[t${i}]`).join("")}amix=inputs=${n}:normalize=0:duration=longest[src]`);
  else parts.push(`[t0]anull[src]`);
  const k = audio.pieces.length;
  parts.push(k > 1 ? `[src]asplit=${k}${audio.pieces.map((_, i) => `[s${i}]`).join("")}` : `[src]anull[s0]`);
  audio.pieces.forEach((p, i) => {
    const tempo = atempoChain(p.rate);
    const len = sec(p.outEnd - p.outStart);
    parts.push(
      `[s${i}]atrim=start=${sec(p.srcStart)}:end=${sec(p.srcEnd)},asetpts=PTS-STARTPTS${tempo ? "," + tempo : ""},volume=${p.gain},` +
        `apad,atrim=end=${len},adelay=${Math.round(p.outStart)}:all=1[p${i}]`,
    );
  });
  const mixed = k > 1 ? `${audio.pieces.map((_, i) => `[p${i}]`).join("")}amix=inputs=${k}:normalize=0:duration=longest` : `[p0]anull`;
  const L = audio.loudness;
  const norm = L.enabled ? `,loudnorm=I=${L.targetLufs}:TP=${L.truePeakDb}:LRA=${L.lra},aresample=${sr}` : "";
  parts.push(`${mixed}${norm},apad,atrim=end=${sec(audio.durationMs)}[aout]`);
  return parts.join(";");
}

/** ffmpeg arguments: JPEG frames on stdin -> H.264 MP4 (+ AAC audio when the plan has any). */
export function browserExportArgs(plan: RenderPlan, out: string): string[] {
  const { width, height, fps, durationMs } = plan.output;
  const args = ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0"];
  const graph = audioFilterGraph(plan.audio);
  if (graph && plan.audio) for (const t of plan.audio.tracks) args.push("-i", t.path);
  const vf = `scale=${width}:${height}:in_range=pc:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p`;
  if (graph) args.push("-filter_complex", `[0:v]${vf}[vout];${graph}`, "-map", "[vout]", "-map", "[aout]", "-c:a", "aac", "-b:a", "160k");
  else args.push("-vf", vf);
  // threads / lookahead capped: x264's default (1.5 x cores frame threads, 40-frame lookahead at
  // veryfast = 10) is the bulk of its memory; this keeps it small on low-RAM machines.
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-x264-params", "rc-lookahead=10:sync-lookahead=0", "-r", String(fps),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-t", sec(durationMs), "-movflags", "+faststart", out);
  return args;
}

export interface BrowserExportJob {
  id: string;
  state: "running" | "done" | "error";
  done: number;
  total: number;
  error?: string;
  out: string;
  startedAt: number;
  finishedAt?: number;
  ff: ChildProcessWithoutNullStreams;
  /** Serialises frame writes so frames land in order. */
  chain: Promise<void>;
}

export function startBrowserExport(ffmpeg: string, plan: RenderPlan, dir: string, id: string): BrowserExportJob {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const out = path.join(dir, "export.mp4");
  const ff = spawn(ffmpeg, browserExportArgs(plan, out));
  const job: BrowserExportJob = { id, state: "running", done: 0, total: plan.frames.length, out, startedAt: Date.now(), ff, chain: Promise.resolve() };
  let err = "";
  ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
  ff.stdin.on("error", () => undefined); // reported through the exit code
  ff.on("error", (e) => {
    job.state = "error";
    job.error = `ffmpeg: ${e.message}`;
  });
  ff.on("close", (code) => {
    job.finishedAt = Date.now();
    if (code === 0 && fs.existsSync(out) && job.done === job.total) job.state = "done";
    else if (job.state !== "error") {
      job.state = "error";
      job.error = err.trim().split("\n").slice(-4).join("\n") || (job.done !== job.total ? `export ended at frame ${job.done} of ${job.total}` : `ffmpeg exited ${code}`);
    }
  });
  return job;
}

/** Append one frame (JPEG bytes); frames must arrive in order (index checked). */
export function writeFrame(job: BrowserExportJob, index: number, jpeg: Buffer): Promise<void> {
  job.chain = job.chain.then(
    () =>
      new Promise<void>((resolve, reject) => {
        if (job.state !== "running") return reject(new Error(job.error ?? "export is not running"));
        if (index !== job.done) return reject(new Error(`frame ${index} out of order (expected ${job.done})`));
        job.done++;
        // Back-pressure: at most one frame waits on ffmpeg's stdin (the editor awaits each POST), so
        // nothing piles up in memory. A dead ffmpeg ends the wait instead of leaving it hanging.
        if (job.ff.stdin.write(jpeg)) return resolve();
        const onDrain = () => {
          job.ff.off("close", onClose);
          resolve();
        };
        const onClose = () => {
          job.ff.stdin.off("drain", onDrain);
          reject(new Error(job.error ?? `ffmpeg exited at frame ${job.done} of ${job.total}`));
        };
        job.ff.stdin.once("drain", onDrain);
        job.ff.once("close", onClose);
      }),
  );
  const p = job.chain;
  job.chain = p.catch(() => undefined);
  return p;
}

export function finishBrowserExport(job: BrowserExportJob): void {
  void job.chain.then(() => job.ff.stdin.end());
}
