/**
 * H.264 encoder choice for Stop-to-editor (desktop finalize) and the export (v0.1.3, Windows report
 * 2026-11-09: saving slow, "not optimized acc to fps n quality"). A hardware encoder is used when the
 * ffmpeg build has one and a 1-frame test encode with it succeeds on this machine (h264_nvenc /
 * h264_qsv / h264_amf on Windows, h264_videotoolbox on macOS); otherwise libx264 at a fast preset.
 * Quality follows Settings > Record quality. LENS_H264_ENCODER=<name> forces one (libx264 = software).
 */
import { spawn } from "node:child_process";

export type Quality = "standard" | "high" | "max";
/** libx264 crf per quality (lower = better); the hardware encoders get the matching constant-quality value */
export const CRF: Record<Quality, number> = { standard: 23, high: 20, max: 17 };

export function hardwareCandidates(platform = process.platform): string[] {
  if (platform === "win32") return ["h264_nvenc", "h264_qsv", "h264_amf"];
  if (platform === "darwin") return ["h264_videotoolbox"];
  return ["h264_nvenc"]; // VA-API needs a device and an hwupload filter: not used
}

/** Encoder arguments (codec, rate control, pixel format) for one encoder at a quality. */
export function h264Args(encoder: string, quality: Quality = "high", opts: { threads?: number } = {}): string[] {
  const q = CRF[quality] ?? CRF.high;
  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", String(q), "-b:v", "0", "-pix_fmt", "yuv420p"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "faster", "-global_quality", String(q), "-pix_fmt", "nv12"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", String(q), "-qp_p", String(q), "-pix_fmt", "yuv420p"];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-q:v", String({ standard: 55, high: 65, max: 75 }[quality] ?? 65), "-pix_fmt", "yuv420p"];
    default:
      // superfast: ~2x veryfast's speed at a few % more bytes for screen content; max keeps veryfast
      return ["-c:v", "libx264", "-preset", quality === "max" ? "veryfast" : "superfast", "-crf", String(q), ...(opts.threads ? ["-threads", String(opts.threads)] : []), "-pix_fmt", "yuv420p"];
  }
}

function tryEncode(ffmpeg: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30:d=0.1", "-frames:v", "2", ...h264Args(encoder, "high"), "-f", "null", "-"], { windowsHide: true });
    const t = setTimeout(() => p.kill("SIGKILL"), 10_000);
    p.on("error", () => resolve(false));
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

const picked = new Map<string, Promise<string>>();
const broken = new Set<string>();

/** The H.264 encoder to use with this ffmpeg (cached per process). */
export function pickH264(ffmpeg: string): Promise<string> {
  const forced = process.env.LENS_H264_ENCODER;
  if (forced) return Promise.resolve(forced);
  let p = picked.get(ffmpeg);
  if (!p) {
    p = (async () => {
      for (const e of hardwareCandidates()) if (!broken.has(e) && (await tryEncode(ffmpeg, e))) return e;
      return "libx264";
    })();
    picked.set(ffmpeg, p);
  }
  return p;
}

/** A hardware encoder failed on a real job: stop using it in this process (the job is redone with libx264). */
export function markBroken(ffmpeg: string, encoder: string): void {
  if (encoder === "libx264") return;
  broken.add(encoder);
  picked.delete(ffmpeg);
}
