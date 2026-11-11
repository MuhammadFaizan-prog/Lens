/**
 * Chapters into the exported MP4 (demand #27, docs/Chapters.md): the plan's chapters (output clock),
 * title and description written as an FFMETADATA1 file and copied into the MP4 with ffmpeg
 * (-map_chapters, streams copied, no re-encode). Used by the in-app export and the Python reference
 * export alike; no Python.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffmetadata, type RenderPlan } from "../../../packages/engine/src/index";

/** True when the plan asks for chapters in the file. */
export const wantsChapters = (plan: Pick<RenderPlan, "chapters">) => !!plan.chapters?.embed && plan.chapters.items.length > 0;

export function chapterArgs(mp4: string, meta: string, out: string): string[] {
  return ["-v", "error", "-nostdin", "-y", "-i", mp4, "-f", "ffmetadata", "-i", meta, "-map", "0", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", "-movflags", "+faststart", out];
}

/**
 * Rewrite `mp4` in place with the plan's chapters and title / description. `onChild` gets the ffmpeg
 * process (Cancel kills it); a failed or killed run leaves `mp4` as it was and rejects.
 */
export function embedChapters(ffmpeg: string, mp4: string, plan: Pick<RenderPlan, "chapters" | "output">, onChild?: (c: ChildProcess | null) => void): Promise<void> {
  const ch = plan.chapters!;
  const dir = path.dirname(mp4);
  const meta = path.join(dir, "chapters.ffmeta");
  const tmp = path.join(dir, "chaptered.mp4");
  fs.writeFileSync(meta, ffmetadata({ title: ch.title, description: ch.description }, ch.items, plan.output.durationMs));
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, chapterArgs(mp4, meta, tmp), { windowsHide: true });
    onChild?.(p);
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => {
      onChild?.(null);
      reject(e);
    });
    p.on("close", (code) => {
      onChild?.(null);
      fs.rmSync(meta, { force: true });
      if (code === 0 && fs.existsSync(tmp)) {
        fs.renameSync(tmp, mp4);
        resolve();
      } else {
        fs.rmSync(tmp, { force: true });
        reject(new Error(err.trim().split("\n").slice(-3).join("\n") || `ffmpeg exited ${code}`));
      }
    });
  });
}
