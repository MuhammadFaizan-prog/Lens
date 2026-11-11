/**
 * Platform export presets (demand #24, docs/ExportPresets.md).
 *
 * A preset is a named set of output numbers for one destination: canvas size, frame rate, video
 * bitrate (average + peak), a file size cap and the destination's duration / dimension limits. Picking
 * one in the Export dialog writes its size and frame rate into `project.output` (so the preview shows
 * the exported framing) and stores `project.export.video` = { preset, bitrateMbps, maxSizeMB }; the
 * export reads `export.video` for the encoder's rate control, the size-cap re-encode and the GIF path.
 *
 * `export.video` absent (every project written before this) = the old export, byte for byte: crf 18,
 * or the Settings bitrate the desktop app passes in LENS_EXPORT_BITRATE_MBPS, no size cap.
 *
 * Numbers and their sources (read 2026-11-11):
 * - YouTube 1080p: 8 Mbps at 24-30 fps, 12 Mbps at 48-60 fps (SDR upload recommendations,
 *   https://support.google.com/youtube/answer/1722171).
 * - YouTube Shorts: vertical or square, up to 3 minutes (https://support.google.com/youtube/answer/15424877).
 * - Instagram Reels: up to 3 minutes (https://about.instagram.com/features/reels).
 * - X: 140 s and 512 MB without Premium (https://help.x.com/en/using-x/x-videos).
 * - LinkedIn: 256x144 to 4096x2304, 192 kbps to 30 Mbps, 10-60 fps, 3 s to 15 min
 *   (https://www.linkedin.com/help/linkedin/answer/a548372).
 * - App Store app previews: 886x1920 / 1920x886 (6.9"-6.1" iPhones), 1080x1920 (5.5" iPhones),
 *   1200x1600 (iPad 13"/11"), H.264 10-12 Mbps, at most 30 fps, 15-30 s, 500 MB
 *   (https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications).
 */
import type { ProjectConfig } from "./project.js";

export const EXPORT_PRESET_IDS = [
  "custom",
  "youtube-1080p30",
  "youtube-1080p60",
  "youtube-shorts",
  "tiktok-reels",
  "x",
  "linkedin",
  "appstore-iphone-portrait",
  "appstore-iphone-landscape",
  "appstore-1080x1920",
  "appstore-ipad",
  "gif",
] as const;
export type ExportPresetId = (typeof EXPORT_PRESET_IDS)[number];

/** project.export.video: the chosen preset and the user's overrides. */
export interface ExportVideoSettings {
  preset: ExportPresetId;
  /** Average video bitrate in Mbps; null / absent = the preset's (Custom: crf 18 or the Settings bitrate). */
  bitrateMbps?: number | null;
  /** File size cap in MB (1 MB = 1,000,000 bytes); null / absent = the preset's cap (Custom: none). */
  maxSizeMB?: number | null;
}

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  group: "General" | "YouTube" | "Social" | "App Store" | "Animated";
  format: "mp4" | "gif";
  /** Exact canvas size; absent = keep the project's. */
  size?: { w: number; h: number };
  fps?: 24 | 30 | 60;
  /** Highest frame rate the destination takes. */
  maxFps?: number;
  /** Average video bitrate (Mbps). */
  bitrateMbps?: number;
  /** Peak video bitrate (Mbps); default 1.5 x the average. */
  maxrateMbps?: number;
  /** Highest average bitrate the destination takes (Mbps). */
  maxBitrateMbps?: number;
  /** File size cap (MB, 1e6 bytes). */
  maxSizeMB?: number;
  durationS?: { min?: number; max?: number };
  /** Allowed canvas range (each side). */
  dims?: { minW: number; minH: number; maxW: number; maxH: number };
  /** One line under the picker. */
  note: string;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: "custom", label: "Custom", group: "General", format: "mp4", note: "The project's own size and frame rate; set a bitrate and a size cap yourself." },
  { id: "youtube-1080p30", label: "YouTube 1080p 30 fps", group: "YouTube", format: "mp4", size: { w: 1920, h: 1080 }, fps: 30, bitrateMbps: 8, note: "1920×1080, 30 fps, 8 Mbps (YouTube's SDR recommendation)." },
  { id: "youtube-1080p60", label: "YouTube 1080p 60 fps", group: "YouTube", format: "mp4", size: { w: 1920, h: 1080 }, fps: 60, bitrateMbps: 12, note: "1920×1080, 60 fps, 12 Mbps (YouTube's SDR recommendation)." },
  { id: "youtube-shorts", label: "YouTube Shorts", group: "YouTube", format: "mp4", size: { w: 1080, h: 1920 }, fps: 30, bitrateMbps: 10, durationS: { max: 180 }, note: "Vertical 1080×1920, 30 fps, 10 Mbps; Shorts are up to 3 minutes." },
  { id: "tiktok-reels", label: "TikTok / Reels", group: "Social", format: "mp4", size: { w: 1080, h: 1920 }, fps: 30, bitrateMbps: 10, durationS: { max: 180 }, note: "Vertical 1080×1920, 30 fps, 10 Mbps; Reels are up to 3 minutes." },
  { id: "x", label: "X (Twitter)", group: "Social", format: "mp4", size: { w: 1920, h: 1080 }, fps: 30, bitrateMbps: 8, maxSizeMB: 512, durationS: { max: 140 }, note: "1920×1080, 30 fps, 8 Mbps, at most 140 s and 512 MB (without Premium)." },
  { id: "linkedin", label: "LinkedIn", group: "Social", format: "mp4", size: { w: 1920, h: 1080 }, fps: 30, bitrateMbps: 8, maxBitrateMbps: 30, maxSizeMB: 5000, durationS: { min: 3, max: 900 }, dims: { minW: 256, minH: 144, maxW: 4096, maxH: 2304 }, note: "1920×1080, 30 fps, 8 Mbps; LinkedIn takes 256×144 to 4096×2304, up to 30 Mbps, 3 s to 15 min." },
  { id: "appstore-iphone-portrait", label: "App Store · iPhone 886×1920", group: "App Store", format: "mp4", size: { w: 886, h: 1920 }, fps: 30, maxFps: 30, bitrateMbps: 11, maxrateMbps: 12, maxBitrateMbps: 12, maxSizeMB: 500, durationS: { min: 15, max: 30 }, note: "App preview for 6.9\"–6.1\" iPhones: 886×1920, 30 fps, 11 Mbps (Apple: 10–12), 15–30 s, 500 MB." },
  { id: "appstore-iphone-landscape", label: "App Store · iPhone 1920×886", group: "App Store", format: "mp4", size: { w: 1920, h: 886 }, fps: 30, maxFps: 30, bitrateMbps: 11, maxrateMbps: 12, maxBitrateMbps: 12, maxSizeMB: 500, durationS: { min: 15, max: 30 }, note: "Landscape app preview for 6.9\"–6.1\" iPhones: 1920×886, 30 fps, 11 Mbps, 15–30 s, 500 MB." },
  { id: "appstore-1080x1920", label: "App Store · iPhone 1080×1920", group: "App Store", format: "mp4", size: { w: 1080, h: 1920 }, fps: 30, maxFps: 30, bitrateMbps: 11, maxrateMbps: 12, maxBitrateMbps: 12, maxSizeMB: 500, durationS: { min: 15, max: 30 }, note: "App preview for 5.5\" iPhones: 1080×1920, 30 fps, 11 Mbps, 15–30 s, 500 MB." },
  { id: "appstore-ipad", label: "App Store · iPad 1200×1600", group: "App Store", format: "mp4", size: { w: 1200, h: 1600 }, fps: 30, maxFps: 30, bitrateMbps: 11, maxrateMbps: 12, maxBitrateMbps: 12, maxSizeMB: 500, durationS: { min: 15, max: 30 }, note: "App preview for 13\" / 11\" iPads: 1200×1600, 30 fps, 11 Mbps, 15–30 s, 500 MB." },
  { id: "gif", label: "GIF", group: "Animated", format: "gif", note: "Animated GIF with a whole-clip palette; frame rate, width and looping below." },
];

export function exportPreset(id: string | undefined | null): ExportPreset {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? EXPORT_PRESETS[0]!;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The project with a preset applied: its size and frame rate in `output`, the preset in `export.video`. */
export function applyExportPreset(project: ProjectConfig, id: ExportPresetId): ProjectConfig {
  const pr = exportPreset(id);
  const output = { ...project.output };
  if (pr.size) {
    const g = gcd(pr.size.w, pr.size.h);
    output.size = { w: pr.size.w, h: pr.size.h };
    output.aspect = `${pr.size.w / g}:${pr.size.h / g}`;
  }
  if (pr.fps) output.fps = pr.fps;
  return { ...project, output, export: { ...project.export, video: { preset: pr.id } } };
}

/** What the encoder does for an export. */
export interface EncodeSettings {
  format: "mp4" | "gif";
  /** Average video bitrate (Mbps); 0 = constant quality (crf 18). */
  bitrateMbps: number;
  /** Peak (Mbps), 0 with crf. */
  maxrateMbps: number;
  /** File size cap in bytes; 0 = none. */
  maxBytes: number;
  gif: { fps: number; width: number; loop: boolean };
}

/**
 * Encode settings for a project. `envBitrateMbps` is the desktop Settings > Export bitrate (0 = auto);
 * a preset's or the user's bitrate in `export.video` wins over it.
 */
export function encodeSettings(project: Pick<ProjectConfig, "export">, envBitrateMbps = 0): EncodeSettings {
  const v = project.export?.video;
  const gif = project.export?.gif ?? { fps: 15, width: 640, loop: true };
  if (!v) return { format: "mp4", bitrateMbps: envBitrateMbps, maxrateMbps: envBitrateMbps ? envBitrateMbps * 1.5 : 0, maxBytes: 0, gif };
  const pr = exportPreset(v.preset);
  const user = v.bitrateMbps && v.bitrateMbps > 0 ? v.bitrateMbps : 0;
  let bitrate = user || pr.bitrateMbps || envBitrateMbps;
  if (pr.maxBitrateMbps) bitrate = Math.min(bitrate || pr.maxBitrateMbps, pr.maxBitrateMbps);
  let maxrate = bitrate ? (user ? bitrate * 1.5 : pr.maxrateMbps ?? bitrate * 1.5) : 0;
  if (pr.maxBitrateMbps) maxrate = Math.min(maxrate, pr.maxBitrateMbps);
  maxrate = Math.max(maxrate, bitrate);
  const capMB = v.maxSizeMB && v.maxSizeMB > 0 ? v.maxSizeMB : pr.maxSizeMB ?? 0;
  return { format: pr.format, bitrateMbps: bitrate, maxrateMbps: maxrate, maxBytes: Math.round(capMB * 1e6), gif };
}

/** Audio bitrate of the MP4 mux (exportAudio.ts muxArgs, kbps). */
export const EXPORT_AUDIO_KBPS = 160;

/** Estimated MP4 size in bytes (video + audio + ~1 % container); null with constant quality. */
export function estimateBytes(durationMs: number, enc: EncodeSettings, hasAudio: boolean): number | null {
  if (enc.format !== "mp4" || !enc.bitrateMbps) return null;
  const bps = enc.bitrateMbps * 1e6 + (hasAudio ? EXPORT_AUDIO_KBPS * 1000 : 0);
  return Math.round(((bps * durationMs) / 1000 / 8) * 1.01);
}

/**
 * Average video bitrate (Mbps) that fits `maxBytes` for `durationMs`: the audio and 3 % container /
 * rate-control margin come off first, and `scale` (< 1 on a retry) leaves more room.
 */
export function bitrateForCap(maxBytes: number, durationMs: number, hasAudio: boolean, scale = 1): number {
  const sec = Math.max(0.1, durationMs / 1000);
  const totalBits = maxBytes * 8 * 0.97;
  const audioBits = hasAudio ? EXPORT_AUDIO_KBPS * 1000 * sec : 0;
  return Math.max(0.05, ((totalBits - audioBits) / sec / 1e6) * scale);
}

export interface ExportCheck {
  level: "warn" | "info";
  code: "duration-max" | "duration-min" | "size-over-cap" | "fps-over" | "dims-range" | "size-mismatch" | "fps-mismatch" | "bitrate-over";
  text: string;
}

const fmtS = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${Math.round(s % 60)} s` : ""}` : `${Math.round(s * 10) / 10} s`);
export const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

/**
 * Warnings for the Export dialog: the output against the chosen preset's limits (duration, size
 * estimate vs cap, frame rate, canvas range, size / fps changed since the preset was applied).
 */
export function exportChecks(project: Pick<ProjectConfig, "export">, out: { width: number; height: number; fps: number; durationMs: number }, hasAudio: boolean, envBitrateMbps = 0): ExportCheck[] {
  const v = project.export?.video;
  if (!v) return [];
  const pr = exportPreset(v.preset);
  const enc = encodeSettings(project, envBitrateMbps);
  const sec = out.durationMs / 1000;
  const c: ExportCheck[] = [];
  if (pr.durationS?.max && sec > pr.durationS.max + 1e-6) c.push({ level: "warn", code: "duration-max", text: `${fmtS(sec)} is longer than ${pr.label} takes (${fmtS(pr.durationS.max)}). Trim ${fmtS(sec - pr.durationS.max)}.` });
  if (pr.durationS?.min && sec < pr.durationS.min - 1e-6) c.push({ level: "warn", code: "duration-min", text: `${fmtS(sec)} is shorter than ${pr.label} takes (at least ${fmtS(pr.durationS.min)}).` });
  if (pr.size && (out.width !== pr.size.w || out.height !== pr.size.h)) c.push({ level: "warn", code: "size-mismatch", text: `Canvas is ${out.width}×${out.height}; ${pr.label} is ${pr.size.w}×${pr.size.h}. Apply the preset again to reset it.` });
  if (pr.fps && !pr.maxFps && out.fps !== pr.fps) c.push({ level: "warn", code: "fps-mismatch", text: `Frame rate is ${out.fps} fps; ${pr.label} uses ${pr.fps} fps.` });
  if (pr.maxFps && out.fps > pr.maxFps) c.push({ level: "warn", code: "fps-over", text: `${out.fps} fps is over the ${pr.maxFps} fps ${pr.label} allows.` });
  if (pr.dims && (out.width < pr.dims.minW || out.height < pr.dims.minH || out.width > pr.dims.maxW || out.height > pr.dims.maxH))
    c.push({ level: "warn", code: "dims-range", text: `${out.width}×${out.height} is outside ${pr.dims.minW}×${pr.dims.minH} – ${pr.dims.maxW}×${pr.dims.maxH}.` });
  if (pr.maxBitrateMbps && v.bitrateMbps && v.bitrateMbps > pr.maxBitrateMbps) c.push({ level: "warn", code: "bitrate-over", text: `${v.bitrateMbps} Mbps is over the ${pr.maxBitrateMbps} Mbps ${pr.label} takes; the export uses ${pr.maxBitrateMbps} Mbps.` });
  const est = estimateBytes(out.durationMs, enc, hasAudio);
  if (enc.maxBytes && est !== null && est > enc.maxBytes)
    c.push({ level: "info", code: "size-over-cap", text: `Estimated ${fmtBytes(est)} is over the ${fmtBytes(enc.maxBytes)} cap; the export re-encodes at a lower bitrate to fit.` });
  return c;
}

/** Validation for resolveProject. */
export function validateExportVideo(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const errs: string[] = [];
  if (typeof v !== "object" || Array.isArray(v)) return ["export.video must be an object"];
  const o = v as Record<string, unknown>;
  if (!EXPORT_PRESET_IDS.includes(o.preset as ExportPresetId)) errs.push(`export.video.preset must be one of ${EXPORT_PRESET_IDS.join(", ")}`);
  if (o.bitrateMbps !== undefined && o.bitrateMbps !== null && !(typeof o.bitrateMbps === "number" && o.bitrateMbps >= 0.1 && o.bitrateMbps <= 200)) errs.push("export.video.bitrateMbps must be within 0.1..200 or null");
  if (o.maxSizeMB !== undefined && o.maxSizeMB !== null && !(typeof o.maxSizeMB === "number" && o.maxSizeMB >= 0.1 && o.maxSizeMB <= 100000)) errs.push("export.video.maxSizeMB must be within 0.1..100000 or null");
  return errs;
}
