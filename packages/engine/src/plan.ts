import { effectiveZoomSegments } from "./autozoom.js";
import { buildCameraTrack, lerpCamera, type CameraSample } from "./camera.js";
import { buildCursorTrack, clickEffects, lerpCursor, sampleTrack, type CursorSample } from "./cursor.js";
import { detectTyping, shortcutOverlays, DEFAULT_TYPING } from "./events.js";
import { layoutAt, layoutFor, outputSize, overlayAvoidRect } from "./layout.js";
import type { ProjectConfig } from "./project.js";
import { buildTimeline, outputDuration, outputToSource } from "./timeline.js";
import { captionBlocks } from "./transcript.js";
import type { InputEvent, RecordingMeta, Word, ZoomSegment } from "./types.js";

/**
 * The render plan: everything the compositor needs, per output frame, as plain numbers.
 * The engine owns all motion decisions; the compositor (Python reference today, wgpu later)
 * only draws. This is what makes preview == export (Rules.md).
 */
export interface RenderPlan {
  version: 1;
  output: { width: number; height: number; fps: number; frames: number; durationMs: number };
  source: { width: number; height: number; fps: number; durationMs: number; pixelRatio: number };
  style: {
    background: ProjectConfig["background"];
    radius: number;
    shadow: ProjectConfig["frame"]["shadow"];
    cursorSize: number;
    cursorShape: ProjectConfig["cursor"]["shape"];
    clickEffect: ProjectConfig["cursor"]["clickEffect"];
    clickEffectMs: number;
    motionBlur: ProjectConfig["motionBlur"];
    zoomStyle: ProjectConfig["zoom"]["style"];
    cameraShape: ProjectConfig["camera"]["shape"];
  };
  zoomSegments: ZoomSegment[];
  frames: PlanFrame[];
}

export interface PlanFrame {
  /** Output time and the source time it shows. */
  t: number;
  src: number;
  /** Camera: center x, center y (source px), scale. */
  cam: [number, number, number];
  /** Camera velocity: vx, vy (source px/s), vScale (1/s). */
  camVel: [number, number, number];
  /** Cursor: x, y (source px), opacity, scale, shape; null when hidden. */
  cur: [number, number, number, number, string] | null;
  /** Active click effects: x, y (source px), progress 0..1. */
  clicks: Array<[number, number, number]>;
  layout: { screen: [number, number, number, number]; screenOpacity: number; camera: [number, number, number, number] | null; cameraOpacity: number; cutout: boolean };
  shortcut: string | null;
  caption: string | null;
}

export interface PlanInputs {
  meta: RecordingMeta;
  events: InputEvent[];
  project: ProjectConfig;
  words?: Word[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function buildRenderPlan({ meta, events, project, words = [] }: PlanInputs): RenderPlan {
  const fps = project.output.fps;
  const out = outputSize(project.output.aspect, project.output.resolution);
  const sourceAspect = meta.width / meta.height;
  const resScale = Math.min(out.width, out.height) / 1080;

  // 1. Source-time tracks at output fps.
  const cursor: CursorSample[] = buildCursorTrack(events, meta, project.cursor, fps);
  const zoomSegments = effectiveZoomSegments(events, meta, project.zoom);
  const staticLayout = layoutFor(project.camera.enabled ? "camera-overlay" : "screen-only", out, sourceAspect, project);
  const camera: CameraSample[] = buildCameraTrack(cursor, zoomSegments, meta, {
    spring: project.zoom.spring,
    followDeadzone: project.zoom.followDeadzone,
    avoid: overlayAvoidRect(staticLayout),
  });

  // 2. Edit timeline (cuts, manual speed, typing speed-up).
  const speed = [...project.edits.speed];
  if (project.edits.speedUpTyping.enabled) {
    for (const r of detectTyping(events, DEFAULT_TYPING)) speed.push({ ...r, rate: project.edits.speedUpTyping.rate });
  }
  const timeline = buildTimeline(meta.durationMs, project.edits.cuts, speed);
  const durationMs = outputDuration(timeline);
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps));

  const clickList = clickEffects(events);
  const shortcuts = project.shortcuts.enabled ? shortcutOverlays(events, project.shortcuts.displayMs) : [];
  const captions = project.captions.enabled ? captionBlocks(words, project.captions.maxWordsPerBlock, project.captions.maxBlockMs) : [];

  const planFrames: PlanFrame[] = [];
  for (let i = 0; i < frames; i++) {
    const t = (i * 1000) / fps;
    const src = outputToSource(timeline, t);
    const c = sampleTrack(camera, src, lerpCamera);
    const k = sampleTrack(cursor, src, lerpCursor);
    const layout = layoutAt(src, project.camera.layouts, out, sourceAspect, project);
    const activeClicks = project.cursor.clickEffect === "none"
      ? []
      : clickList
          .filter((cl) => src >= cl.t && src - cl.t < project.cursor.clickEffectMs)
          .map((cl) => [r2(cl.x), r2(cl.y), r4((src - cl.t) / project.cursor.clickEffectMs)] as [number, number, number]);
    const sc = shortcuts.find((s) => src >= s.startMs && src < s.endMs);
    const cap = captions.find((b) => src >= b.startMs && src < b.endMs);
    planFrames.push({
      t: r2(t),
      src: r2(src),
      cam: [r2(c.cx), r2(c.cy), r4(c.scale)],
      camVel: [r2(c.vx), r2(c.vy), r4(c.vScale)],
      cur: project.cursor.visible && k.opacity > 0.001 ? [r2(k.x), r2(k.y), r4(k.opacity), r4(k.scale), k.shape] : null,
      clicks: activeClicks,
      layout: {
        screen: [r2(layout.screen.x), r2(layout.screen.y), r2(layout.screen.w), r2(layout.screen.h)],
        screenOpacity: r4(layout.screenOpacity),
        camera: layout.camera ? [r2(layout.camera.x), r2(layout.camera.y), r2(layout.camera.w), r2(layout.camera.h)] : null,
        cameraOpacity: r4(layout.cameraOpacity),
        cutout: layout.cameraCutout,
      },
      shortcut: sc ? sc.label : null,
      caption: cap ? cap.text : null,
    });
  }

  return {
    version: 1,
    output: { width: out.width, height: out.height, fps, frames, durationMs },
    source: { width: meta.width, height: meta.height, fps: meta.fps, durationMs: meta.durationMs, pixelRatio: meta.pixelRatio },
    style: {
      background: project.background,
      radius: project.frame.radius * resScale,
      shadow: { ...project.frame.shadow, blur: project.frame.shadow.blur * resScale, offsetY: project.frame.shadow.offsetY * resScale },
      cursorSize: project.cursor.size,
      cursorShape: project.cursor.shape,
      clickEffect: project.cursor.clickEffect,
      clickEffectMs: project.cursor.clickEffectMs,
      motionBlur: project.motionBlur,
      zoomStyle: project.zoom.style,
      cameraShape: project.camera.shape,
    },
    zoomSegments,
    frames: planFrames,
  };
}
