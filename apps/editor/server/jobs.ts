/**
 * On-device jobs without Python: privacy scan and step labels (redact/), and where they run (a
 * worker thread when LENS_JOB_WORKER names the bundled jobWorker.cjs, else in-process).
 */
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { scan } from "./redact/scan";
import { stepLabels } from "./redact/steps";

export type JobRequest =
  | { kind: "scan"; ffmpeg: string; video: string; events: string | null; thumbs: string; env?: Record<string, string> }
  | { kind: "steps"; ffmpeg: string; video: string; events: string; env?: Record<string, string> };

export type JobProgress = (stage: string, done: number, total: number) => void;

export async function runJob(req: JobRequest, progress: JobProgress): Promise<unknown> {
  for (const [k, v] of Object.entries(req.env ?? {})) process.env[k] = v;
  if (req.kind === "scan") return scan(req.ffmpeg, req.video, req.events, req.thumbs, progress);
  return stepLabels(req.ffmpeg, req.video, req.events);
}

/** Run a job off the main thread when a worker script is available. */
export function startJob(req: JobRequest, progress: JobProgress): Promise<unknown> {
  const script = process.env.LENS_JOB_WORKER;
  if (!script || !fs.existsSync(script)) return runJob(req, progress);
  const env: Record<string, string> = {};
  for (const k of ["LENS_ROOT", "LENS_MODELS_DIR", "LENS_TESSDATA", "LENS_FFMPEG", "LENS_OCR_WORKERS"]) if (process.env[k]) env[k] = process.env[k]!;
  return new Promise((resolve, reject) => {
    const w = new Worker(script, { workerData: { ...req, env } });
    let settled = false;
    w.on("message", (m: { type: string; stage?: string; done?: number; total?: number; result?: unknown; message?: string }) => {
      if (m.type === "progress") progress(m.stage!, m.done!, m.total!);
      else if (m.type === "done") {
        settled = true;
        resolve(m.result);
        void w.terminate();
      } else if (m.type === "error") {
        settled = true;
        reject(new Error(m.message));
        void w.terminate();
      }
    });
    w.on("error", (e) => {
      if (!settled) reject(e);
      settled = true;
    });
    w.on("exit", (code) => {
      if (!settled) reject(new Error(`job worker exited (${code})`));
    });
  });
}
