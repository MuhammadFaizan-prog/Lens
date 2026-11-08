import type {
  CameraLayoutSegment,
  CursorShape,
  SpeedRange,
  SpringParams,
  TimeRange,
  ZoomSegment,
  ZoomStyle,
} from "./types.js";
import { springFromSettle } from "./spring.js";

/**
 * The editable project document (project.json inside a .lens bundle). Every visual default lives
 * here so the gauntlet loop can tune numbers against measured targets without touching code.
 * Defaults are starting points; research/measurements/*.json overrides them once measured.
 */
export interface ProjectConfig {
  version: 1;
  output: {
    /** Aspect ratio as w:h, e.g. "16:9", "1:1", "9:16", "4:5", "4:3". */
    aspect: string;
    /** Height of the output for 16:9, or the short side for other aspects. */
    resolution: 720 | 1080 | 1440 | 2160;
    fps: 24 | 30 | 60;
  };
  background: {
    kind: "solid" | "gradient" | "image";
    colors: string[];
    /** Gradient angle in degrees. */
    angle: number;
    imagePath?: string;
    blur: number;
  };
  frame: {
    /** Padding around the recording, fraction of the output short side. */
    padding: number;
    /** Corner radius in output px at 1080p (scaled with resolution). */
    radius: number;
    shadow: { opacity: number; blur: number; offsetY: number; angle: number };
    /** Inset of the recording inside its frame, px at 1080p. */
    inset: number;
  };
  zoom: {
    auto: boolean;
    defaultScale: number;
    minScale: number;
    maxScale: number;
    /** How long before the first action the zoom starts moving. */
    leadMs: number;
    /** How long after the last action the zoom holds before releasing. */
    holdMs: number;
    /** Actions closer than this merge into one zoom. */
    mergeGapMs: number;
    minDurationMs: number;
    style: ZoomStyle;
    spring: SpringParams;
    /** Fraction of the zoomed viewport the cursor may roam before the camera pans. */
    followDeadzone: number;
    segments: ZoomSegment[];
  };
  cursor: {
    visible: boolean;
    size: number;
    shape: CursorShape | "system";
    smoothing: { enabled: boolean; spring: SpringParams; prefilter: boolean };
    hideWhenIdle: boolean;
    idleMs: number;
    fadeMs: number;
    loopToStart: boolean;
    loopMs: number;
    clickEffect: "none" | "ripple" | "circle" | "highlight";
    clickEffectMs: number;
    clickSound: boolean;
    pressScale: number;
  };
  motionBlur: { enabled: boolean; strength: number; samples: number };
  camera: {
    enabled: boolean;
    corner: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    /** Overlay size as a fraction of the output short side. */
    size: number;
    shape: "circle" | "rounded" | "square";
    layouts: CameraLayoutSegment[];
    transitionMs: number;
    hideDuringSilence: boolean;
  };
  edits: {
    cuts: TimeRange[];
    speed: SpeedRange[];
    /** Auto speed-up for detected typing stretches (E04). */
    speedUpTyping: { enabled: boolean; rate: number };
  };
  captions: { enabled: boolean; maxWordsPerBlock: number; maxBlockMs: number };
  shortcuts: { enabled: boolean; displayMs: number };
}

export function defaultProject(): ProjectConfig {
  return {
    version: 1,
    output: { aspect: "16:9", resolution: 1080, fps: 60 },
    background: { kind: "gradient", colors: ["#3a1c71", "#d76d77", "#ffaf7b"], angle: 135, blur: 0 },
    frame: {
      padding: 0.08,
      radius: 14,
      shadow: { opacity: 0.45, blur: 48, offsetY: 18, angle: 90 },
      inset: 0,
    },
    zoom: {
      auto: true,
      defaultScale: 2.0,
      minScale: 1.25,
      maxScale: 4,
      leadMs: 350,
      holdMs: 1400,
      mergeGapMs: 2500,
      minDurationMs: 1200,
      style: "classic",
      spring: springFromSettle(900, 1),
      followDeadzone: 0.5,
      segments: [],
    },
    cursor: {
      visible: true,
      size: 1.5,
      shape: "system",
      smoothing: { enabled: true, spring: springFromSettle(220, 1), prefilter: true },
      hideWhenIdle: true,
      idleMs: 2500,
      fadeMs: 250,
      loopToStart: false,
      loopMs: 800,
      clickEffect: "ripple",
      clickEffectMs: 450,
      clickSound: false,
      pressScale: 0.85,
    },
    motionBlur: { enabled: true, strength: 0.35, samples: 8 },
    camera: {
      enabled: false,
      corner: "bottom-right",
      size: 0.24,
      shape: "rounded",
      layouts: [],
      transitionMs: 500,
      hideDuringSilence: false,
    },
    edits: { cuts: [], speed: [], speedUpTyping: { enabled: false, rate: 3 } },
    captions: { enabled: false, maxWordsPerBlock: 7, maxBlockMs: 2800 },
    shortcuts: { enabled: true, displayMs: 1200 },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export class ProjectValidationError extends Error {}

/** Merge a partial project over defaults and validate ranges. Throws ProjectValidationError. */
export function resolveProject(partial: DeepPartial<ProjectConfig> | unknown = {}): ProjectConfig {
  const p = deepMerge(defaultProject(), partial);
  const errs: string[] = [];
  if (p.version !== 1) errs.push(`unsupported project version ${String(p.version)}`);
  if (!/^\d+:\d+$/.test(p.output.aspect)) errs.push(`output.aspect must look like 16:9, got ${p.output.aspect}`);
  if (![24, 30, 60].includes(p.output.fps)) errs.push("output.fps must be 24, 30 or 60");
  if (p.frame.padding < 0 || p.frame.padding > 0.4) errs.push("frame.padding must be within 0..0.4");
  if (p.zoom.minScale < 1 || p.zoom.maxScale < p.zoom.minScale) errs.push("zoom scale range invalid");
  if (p.zoom.defaultScale < p.zoom.minScale || p.zoom.defaultScale > p.zoom.maxScale)
    errs.push("zoom.defaultScale outside min..max");
  for (const s of p.zoom.segments) {
    if (s.endMs <= s.startMs) errs.push(`zoom segment ${s.id} ends before it starts`);
    if (s.scale < 1) errs.push(`zoom segment ${s.id} scale < 1`);
  }
  for (const r of p.edits.speed) if (r.rate <= 0) errs.push("speed rate must be > 0");
  for (const r of [...p.edits.cuts, ...p.edits.speed]) if (r.endMs <= r.startMs) errs.push("edit range ends before it starts");
  if (errs.length) throw new ProjectValidationError(errs.join("; "));
  return p;
}
