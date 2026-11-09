/**
 * In-browser export path (desktop app, docs/Desktop.md). Used where the Python reference compositor
 * is not available (the Windows desktop build): the editor draws every plan frame with the same
 * Canvas2D renderer as the preview (preview/export parity is measured in e2e/parity.spec.ts) and
 * posts each frame as a JPEG; this side pipes them into ffmpeg (H.264, BT.709 limited range, the
 * same tags as the compositor) and mixes the plan's audio pieces with an ffmpeg filter graph.
 *
 * Audio (exportAudio.ts) is rendered beside the frames, as compositor/lens_compositor/audio.py does it:
 * tracks decoded with the format pinned (48 kHz stereo float), pieces laid with 3 ms fades at cuts,
 * RNNoise / afftdn denoise, two-pass loudnorm and the click sound; the encoded video and that audio
 * are muxed when the last frame is in.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AudioPlan, RenderPlan } from "../../../packages/engine/src/index";
import { mux, renderExportAudio, type RenderedAudio } from "./exportAudio";

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
  // Every link is pinned to fltp / stereo / sr: a mono or layout-less input (a MediaRecorder Opus
  // webm, a mono WAV) makes ffmpeg re-initialise the graph on its first decoded frame, and an
  // unpinned aresample -> apad link then has no channel layout to agree on (the v0.1.0 Windows
  // export failure).
  const pin = `aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=${sr}`;
  const parts: string[] = [];
  audio.tracks.forEach((t, i) => {
    const align =
      t.offsetMs > 0 ? `,adelay=${Math.round(t.offsetMs)}:all=1` : t.offsetMs < 0 ? `,atrim=start=${sec(-t.offsetMs)},asetpts=PTS-STARTPTS` : "";
    parts.push(`[${firstInput + i}:a]${pin}${align},${pin},volume=${t.volume},apad[t${i}]`);
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
      `[s${i}]${pin},atrim=start=${sec(p.srcStart)}:end=${sec(p.srcEnd)},asetpts=PTS-STARTPTS${tempo ? "," + tempo : ""},volume=${p.gain},${pin},` +
        `apad,atrim=end=${len},${pin},adelay=${Math.round(p.outStart)}:all=1[p${i}]`,
    );
  });
  const mixed = k > 1 ? `${audio.pieces.map((_, i) => `[p${i}]`).join("")}amix=inputs=${k}:normalize=0:duration=longest` : `[p0]anull`;
  const L = audio.loudness;
  const norm = L.enabled ? `,loudnorm=I=${L.targetLufs}:TP=${L.truePeakDb}:LRA=${L.lra}` : "";
  parts.push(`${mixed},${pin}${norm},${pin},apad,atrim=end=${sec(audio.durationMs)}[aout]`);
  return parts.join(";");
}

/** Output length: the frame count at the output rate (the audio is cut to the same length). */
export function outputMs(plan: RenderPlan): number {
  return (plan.frames.length * 1000) / plan.output.fps;
}

/** ffmpeg arguments: JPEG frames on stdin -> H.264 MP4 (video only; exportAudio.ts adds the audio). */
export function browserExportArgs(plan: RenderPlan, out: string): string[] {
  const { width, height, fps } = plan.output;
  const durationMs = outputMs(plan);
  const args = ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0"];
  const vf = `scale=${width}:${height}:in_range=pc:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p`;
  args.push("-vf", vf);
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
  /** Copy in the desktop export folder (LENS_EXPORT_DIR), or why it failed. */
  copiedTo?: string;
  copyError?: string;
  startedAt: number;
  finishedAt?: number;
  ff: ChildProcessWithoutNullStreams;
  /** Serialises frame writes so frames land in order. */
  chain: Promise<void>;
  /** The audio, rendered while the frames stream in (null: silent export). */
  audio?: Promise<RenderedAudio | null>;
  stage?: "frames" | "audio" | "mux";
}

export function startBrowserExport(ffmpeg: string, plan: RenderPlan, dir: string, id: string, root = process.cwd()): BrowserExportJob {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const out = path.join(dir, "export.mp4");
  const video = path.join(dir, "video.mp4");
  const ff = spawn(ffmpeg, browserExportArgs(plan, video));
  const job: BrowserExportJob = { id, state: "running", done: 0, total: plan.frames.length, out, startedAt: Date.now(), ff, chain: Promise.resolve(), stage: "frames" };
  job.audio = renderExportAudio(ffmpeg, plan.audio, outputMs(plan), path.join(dir, "audio"), root);
  job.audio.catch(() => undefined); // reported when the video is done
  let err = "";
  ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
  ff.stdin.on("error", () => undefined); // reported through the exit code
  ff.on("error", (e) => {
    job.state = "error";
    job.error = `ffmpeg: ${e.message}`;
  });
  ff.on("close", (code) => {
    if (!(code === 0 && fs.existsSync(video) && job.done === job.total)) {
      job.finishedAt = Date.now();
      if (job.state !== "error") {
        job.state = "error";
        job.error = err.trim().split("\n").slice(-4).join("\n") || (job.done !== job.total ? `export ended at frame ${job.done} of ${job.total}` : `ffmpeg exited ${code}`);
      }
      return;
    }
    void (async () => {
      try {
        job.stage = "audio";
        const a = await job.audio!;
        job.stage = "mux";
        if (a) await mux(ffmpeg, video, a, out, outputMs(plan));
        else fs.renameSync(video, out);
        job.state = "done";
        // desktop Settings > Export location (Windows #19): a copy of the finished export lands there
        const exportDir = process.env.LENS_EXPORT_DIR;
        if (exportDir) {
          try {
            fs.mkdirSync(exportDir, { recursive: true });
            const bundle = path.basename(path.dirname(path.dirname(dir)));
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
            const dest = path.join(exportDir, `${bundle}-${stamp}.mp4`);
            fs.copyFileSync(out, dest);
            job.copiedTo = dest;
          } catch (e) {
            job.copyError = e instanceof Error ? e.message : String(e);
          }
        }
      } catch (e) {
        job.state = "error";
        job.error = `audio: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        job.finishedAt = Date.now();
        fs.rmSync(path.join(dir, "audio"), { recursive: true, force: true });
        if (job.state === "done") fs.rmSync(video, { force: true });
      }
    })();
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
