/**
 * NLE hand-off export (demand #11): the transparent overlay layer (cursor, click effects, annotations)
 * the editor draws frame by frame (PlanRenderer overlay mode, PNG with alpha), encoded here by ffmpeg
 * alone (no Python, the desktop app's path) into
 *   overlay.mov   ProRes 4444 with alpha (yuva444p10le, 16-bit alpha), for Final Cut / Resolve / Premiere
 *   overlay.webm  VP9 with alpha (yuva420p), for browsers and lighter editors
 * plus the edit as project files, written when the job starts:
 *   cuts.fcpxml   FCPXML 1.9: kept ranges as clips, slides as gaps, zooms as markers, overlay on lane 1
 *   cuts.edl      CMX3600: one event per kept range, M2 speed lines, zoom locators
 * The overlay frames arrive through the same /api/export-browser/:id/frame endpoint as the video export.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toEdl, toFcpxml, type RenderPlan } from "../../../packages/engine/src/index";
import type { BrowserExportJob } from "./browserExport";

export interface NleExportJob extends BrowserExportJob {
  kind: "nle";
  files: { mov: string; webm: string; fcpxml: string; edl: string };
}

export function overlayArgs(plan: RenderPlan, mov: string, webm: string): string[] {
  const fps = String(plan.output.fps);
  return [
    "-v", "error", "-y", "-f", "image2pipe", "-framerate", fps, "-c:v", "png", "-i", "pipe:0",
    "-map", "0:v", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-vendor", "apl0",
    "-r", fps, "-threads", "2", mov,
    "-map", "0:v", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30", "-deadline", "realtime", "-cpu-used", "8",
    "-row-mt", "1", "-auto-alt-ref", "0", "-r", fps, "-threads", "2", webm,
  ];
}

/** Writes cuts.fcpxml / cuts.edl and starts ffmpeg on the overlay frames. */
export function startNleExport(ffmpeg: string, plan: RenderPlan, bundle: string, dir: string, id: string, name: string): NleExportJob {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const files = { mov: path.join(dir, "overlay.mov"), webm: path.join(dir, "overlay.webm"), fcpxml: path.join(dir, "cuts.fcpxml"), edl: path.join(dir, "cuts.edl") };
  fs.writeFileSync(files.fcpxml, toFcpxml(plan, { name, screenSrc: pathToFileURL(path.join(bundle, "screen.mp4")).href, overlaySrc: pathToFileURL(files.mov).href }));
  fs.writeFileSync(files.edl, toEdl(plan, { title: name, clipName: "screen.mp4" }));
  const ff = spawn(ffmpeg, overlayArgs(plan, files.mov, files.webm), { windowsHide: true });
  const job: NleExportJob = { kind: "nle", id, state: "running", done: 0, total: plan.frames.length, out: files.mov, files, startedAt: Date.now(), ff, chain: Promise.resolve(), stage: "frames" };
  let err = "";
  ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
  ff.stdin.on("error", () => undefined);
  ff.on("error", (e) => {
    job.state = "error";
    job.error = `ffmpeg: ${e.message}`;
  });
  ff.on("close", (code) => {
    job.finishedAt = Date.now();
    if (job.state === "error") return;
    if (code === 0 && job.done === job.total && fs.existsSync(files.mov) && fs.existsSync(files.webm)) job.state = "done";
    else {
      job.state = "error";
      job.error = err.trim().split("\n").slice(-4).join("\n") || (job.done !== job.total ? `export ended at frame ${job.done} of ${job.total}` : `ffmpeg exited ${code}`);
    }
  });
  return job;
}
