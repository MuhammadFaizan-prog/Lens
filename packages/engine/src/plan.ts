import { buildAudioPlan, type AudioPlan } from "./audio.js";
import { effectiveZoomSegments } from "./autozoom.js";
import { buildCameraTrack, lerpCamera, zoomBlendTrack, type CameraSample } from "./camera.js";
import { cropEvents, cropMeta, cropRect, cropZoomSegments, insideCrop, normalizeCrop, zoomableEvents } from "./crop.js";
import { buildCursorTrack, clickEffects, cursorOverrideAt, lerpCursor, sampleTrack, type CursorSample } from "./cursor.js";
import { clicks, detectTyping, shortcutOverlays, DEFAULT_TYPING } from "./events.js";
import { layoutAt, layoutFor, outputSize, overlayAvoidRect, scaleCameraRect } from "./layout.js";
import { masksAt, type MaskFrame } from "./masks.js";
import type { CaptionStyle, ProjectConfig } from "./project.js";
import { buildTimeline, mergeRanges, outputDuration, outputToSource } from "./timeline.js";
import { captionBlocks, captionFrame, captionWords, cleanupCuts, type CaptionFrame } from "./transcript.js";
import type { InputEvent, RecordingMeta, Rect, TimeRange, Word, ZoomSegment } from "./types.js";

/**
 * The render plan: everything the compositor needs, per output frame, as plain numbers.
 * The engine owns all motion decisions; the compositor (Python reference today, wgpu later)
 * only draws. This is what makes preview == export (Rules.md).
 */
export interface RenderPlan {
  version: 1;
  output: { width: number; height: number; fps: number; frames: number; durationMs: number };
  /**
   * Source recording. crop is [x, y, w, h] in source px; every position in frames (cam, cur,
   * clicks, masks) and zoomSegments is in cropped space (origin at the crop's top-left).
   */
  source: { width: number; height: number; fps: number; durationMs: number; pixelRatio: number; crop: [number, number, number, number] };
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
    cameraMirror: boolean;
    /** Webcam crop [x, y, w, h] in camera px, or null. */
    cameraCrop: [number, number, number, number] | null;
    /** Caption style with fontSize already scaled to the output resolution. */
    captions: CaptionStyle & { wordHighlight: boolean };
  };
  export: ProjectConfig["export"];
  /** Audio mix instructions, or null when the export is silent. */
  audio: AudioPlan | null;
  /** Every source-time range removed from the output: manual cuts plus transcript cleanup cuts. */
  cuts: TimeRange[];
  /** The part of cuts that came from transcript cleanup (fillers, long pauses). */
  cleanupCuts: TimeRange[];
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
  /** Spotlight / blur / pixelate regions active on this frame (cropped source px). */
  masks: MaskFrame[];
  shortcut: string | null;
  caption: CaptionFrame | null;
}

export interface PlanInputs {
  meta: RecordingMeta;
  events: InputEvent[];
  project: ProjectConfig;
  words?: Word[];
  /** Measured silences from the transcript (Transcript.pauses); bounds pause cuts when given. */
  pauses?: TimeRange[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function buildRenderPlan({ meta: fullMeta, events: rawEvents, project, words = [], pauses }: PlanInputs): RenderPlan {
  const fps = project.output.fps;
  const out = outputSize(project.output.aspect, project.output.resolution);
  const resScale = Math.min(out.width, out.height) / 1080;

  // 0. Crop (LOOK-14): move everything into cropped space.
  const crop: Rect = normalizeCrop(project.crop, fullMeta);
  const meta = cropMeta(fullMeta, crop);
  const events = cropEvents(rawEvents, crop);
  const masks = project.masks.map((m) => ({ ...m, rect: cropRect(m.rect, crop) }));
  const sourceAspect = meta.width / meta.height;

  // 1. Source-time tracks at output fps.
  const cursor: CursorSample[] = buildCursorTrack(events, meta, project.cursor, fps, project.overrides);
  const zoomSegments = effectiveZoomSegments(zoomableEvents(events, crop), meta, { ...project.zoom, segments: cropZoomSegments(project.zoom.segments, crop) });
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
  // Transcript cleanup (E03): filler + long-pause cuts from word timings, in source time.
  const cl = project.edits.cleanup;
  const autoCuts = cl.enabled && words.length
    ? cleanupCuts(words, meta.durationMs, cl, { removeFillers: cl.removeFillers, shortenPauses: cl.shortenPauses, pauses })
    : [];
  const allCuts = mergeRanges([...project.edits.cuts, ...autoCuts]);
  const timeline = buildTimeline(meta.durationMs, allCuts, speed);
  const blend = project.camera.zoomedSize !== 1 ? zoomBlendTrack(camera, zoomSegments, project.zoom.spring) : [];
  const durationMs = outputDuration(timeline);
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps));

  const clickList = clickEffects(events).filter((c) => insideCrop(c, crop));
  const shortcuts = project.shortcuts.enabled ? shortcutOverlays(events, project.shortcuts.displayMs) : [];
  const shownWords = captionWords(words, cl.enabled && cl.removeFillers, cl.fillers);
  const captions = project.captions.enabled ? captionBlocks(shownWords, project.captions.maxWordsPerBlock, project.captions.maxBlockMs) : [];

  const planFrames: PlanFrame[] = [];
  for (let i = 0; i < frames; i++) {
    const t = (i * 1000) / fps;
    const src = outputToSource(timeline, t);
    const c = sampleTrack(camera, src, lerpCamera);
    const k = sampleTrack(cursor, src, lerpCursor);
    let layout = layoutAt(src, project.camera.layouts, out, sourceAspect, project);
    if (blend.length) {
      const b = sampleTrack(blend, src, (p, q, u) => ({ t: p.t + (q.t - p.t) * u, v: p.v + (q.v - p.v) * u })).v;
      layout = scaleCameraRect(layout, 1 + (project.camera.zoomedSize - 1) * b, project.camera.corner);
    }
    const curVisible = project.cursor.visible && k.opacity > 0.001 && insideCrop(k, crop);
    const activeClicks = project.cursor.clickEffect === "none"
      ? []
      : clickList
          .filter((cl) => src >= cl.t && src - cl.t < project.cursor.clickEffectMs && !cursorOverrideAt(project.overrides, cl.t).hidden)
          .map((cl) => [r2(cl.x), r2(cl.y), r4((src - cl.t) / project.cursor.clickEffectMs)] as [number, number, number]);
    const sc = shortcuts.find((s) => src >= s.startMs && src < s.endMs);
    const cap = captions.find((b) => src >= b.startMs && src < b.endMs);
    planFrames.push({
      t: r2(t),
      src: r2(src),
      cam: [r2(c.cx), r2(c.cy), r4(c.scale)],
      camVel: [r2(c.vx), r2(c.vy), r4(c.vScale)],
      cur: curVisible ? [r2(k.x), r2(k.y), r4(k.opacity), r4(k.scale), k.shape] : null,
      clicks: activeClicks,
      layout: {
        screen: [r2(layout.screen.x), r2(layout.screen.y), r2(layout.screen.w), r2(layout.screen.h)],
        screenOpacity: r4(layout.screenOpacity),
        camera: layout.camera ? [r2(layout.camera.x), r2(layout.camera.y), r2(layout.camera.w), r2(layout.camera.h)] : null,
        cameraOpacity: r4(layout.cameraOpacity),
        cutout: layout.cameraCutout,
      },
      masks: masksAt(masks, src),
      shortcut: sc ? sc.label : null,
      caption: cap ? captionFrame(cap, src, project.captions.style.maxWordsPerLine, project.captions.wordHighlight) : null,
    });
  }

  return {
    version: 1,
    output: { width: out.width, height: out.height, fps, frames, durationMs },
    source: {
      width: fullMeta.width,
      height: fullMeta.height,
      fps: fullMeta.fps,
      durationMs: fullMeta.durationMs,
      pixelRatio: fullMeta.pixelRatio,
      crop: [crop.x, crop.y, crop.w, crop.h],
    },
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
      cameraMirror: project.camera.mirror,
      cameraCrop: project.camera.crop ? [project.camera.crop.x, project.camera.crop.y, project.camera.crop.w, project.camera.crop.h] : null,
      captions: {
        ...project.captions.style,
        fontSize: project.captions.style.fontSize * resScale,
        wordHighlight: project.captions.wordHighlight,
      },
    },
    export: project.export,
    audio: buildAudioPlan(project, timeline, durationMs, clicks(rawEvents).map((c) => c.t)),
    cuts: allCuts.map((c) => ({ startMs: r2(Math.max(0, c.startMs)), endMs: r2(Math.min(meta.durationMs, c.endMs)) })),
    cleanupCuts: autoCuts.map((c) => ({ startMs: r2(c.startMs), endMs: r2(c.endMs) })),
    zoomSegments,
    frames: planFrames,
  };
}
