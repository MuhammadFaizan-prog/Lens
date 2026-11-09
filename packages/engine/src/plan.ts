import { buildAudioPlan, type AudioPlan } from "./audio.js";
import { effectiveZoomSegments } from "./autozoom.js";
import { buildCameraTrack, lerpCamera, zoomBlendTrack, type CameraSample } from "./camera.js";
import { cropEvents, cropMeta, cropRect, cropZoomSegments, insideCrop, normalizeCrop, zoomableEvents } from "./crop.js";
import { buildCursorTrack, clickEffects, cursorOverrideAt, lerpCursor, sampleTrack, type CursorSample } from "./cursor.js";
import { clicks, detectTyping, shortcutOverlays, DEFAULT_TYPING } from "./events.js";
import { layoutAt, layoutFor, outputSize, overlayAvoidRect, scaleCameraRect } from "./layout.js";
import { masksAt, type MaskFrame } from "./masks.js";
import type { CaptionStyle, ProjectConfig } from "./project.js";
import { buildTimeline, insertSlides, mergeRanges, outputDuration, outputToSource, type SlideSpan } from "./timeline.js";
import { annotationsAt, badgeNumbers, slideFrame, type AnnFrame, type SlideFrame } from "./annotations.js";
import { resolveTakes, type TakeGroup } from "./takes.js";
import { captionBlocks, captionFrame, captionWords, cleanupCuts, type CaptionFrame } from "./transcript.js";
import type { InputEvent, RecordingMeta, Rect, TimeRange, Word, ZoomSegment } from "./types.js";
import { applyTheme } from "./theme.js";
import type { WatermarkPlan } from "./brand.js";
import type { FontFiles } from "./palette.js";

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
  /** Retake groups (edits.takes): every take, which one is kept, and why the group was found. */
  takes: TakeGroup[];
  /** The part of cuts that removes rejected takes. */
  takeCuts: TimeRange[];
  zoomSegments: ZoomSegment[];
  /** Text slides on the output clock (demand #4): each holds its source time and has no audio. */
  slides: SlideSpan[];
  /**
   * Fonts the frames use besides the default (DejaVu Sans): family and files ("builtin:" = Lens's
   * assets/fonts, else relative to the bundle). Text ops and the caption style name the family.
   */
  fonts?: FontFiles[];
  /** Brand logo watermark (demand #9), whole output px, drawn on every frame above the caption and under slides. */
  watermark?: WatermarkPlan | null;
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
  /**
   * Annotations on this frame (demand #4), as drawing ops: screen-anchored ones in cropped source px
   * (mapped through the camera, drawn inside the screen under the cursor), frame-anchored ones in
   * output px (drawn above the webcam, under shortcut and caption). List order = draw order.
   */
  annotations: AnnFrame[];
  /** A full-frame text slide over everything (output px), or null. */
  slide: SlideFrame | null;
}

export interface PlanInputs {
  meta: RecordingMeta;
  events: InputEvent[];
  project: ProjectConfig;
  words?: Word[];
  /** Measured silences from the transcript (Transcript.pauses); bounds pause cuts when given. */
  pauses?: TimeRange[];
  /** Build only these output frames (preset thumbnails); plan.frames then holds just them, in this order. */
  onlyFrames?: number[];
}

function insideRanges(ranges: TimeRange[], t: number): boolean {
  return ranges.some((r) => t >= r.startMs && t < r.endMs);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function buildRenderPlan({ meta: fullMeta, events: rawEvents, project: rawProject, words = [], pauses, onlyFrames }: PlanInputs): RenderPlan {
  const fps = rawProject.output.fps;
  const out = outputSize(rawProject.output.aspect, rawProject.output.resolution);
  // Theme (demand #9): resolve "@slot" references (built-in < preset < brand < item), add brand cards.
  const theme = applyTheme(rawProject, fullMeta.durationMs, out);
  const project = theme.project;
  const resScale = Math.min(out.width, out.height) / 1080;

  // 0. Crop (LOOK-14): move everything into cropped space.
  const crop: Rect = normalizeCrop(project.crop, fullMeta);
  const meta = cropMeta(fullMeta, crop);
  const events = cropEvents(rawEvents, crop);
  const masks = project.masks.map((m) => ({ ...m, rect: cropRect(m.rect, crop), keys: m.keys?.map((k) => ({ tMs: k.tMs, rect: cropRect(k.rect, crop) })) }));
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
  // Multi-take (demand #1): rejected takes become cuts, so audio, captions and video all follow.
  const takes = resolveTakes(words, project.edits.takes, cl.fillers, meta.durationMs);
  const allCuts = mergeRanges([...project.edits.cuts, ...autoCuts, ...takes.cuts]);
  const slideList = project.slides;
  const { pieces: timeline, spans: slideSpans } = insertSlides(buildTimeline(meta.durationMs, allCuts, speed), slideList);
  const blend = project.camera.zoomedSize !== 1 ? zoomBlendTrack(camera, zoomSegments, project.zoom.spring) : [];
  const durationMs = Math.max(outputDuration(timeline), ...slideSpans.map((sp) => sp.outEnd));
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps));

  const clickList = clickEffects(events).filter((c) => insideCrop(c, crop));
  const shortcuts = project.shortcuts.enabled ? shortcutOverlays(events, project.shortcuts.displayMs) : [];
  // Words removed by any cut (transcript deletions, manual cuts, cleanup) never appear in captions.
  const shownWords = captionWords(words, cl.enabled && cl.removeFillers, cl.fillers).filter((w) => !insideRanges(allCuts, (w.startMs + w.endMs) / 2));
  const captions = project.captions.enabled ? captionBlocks(shownWords, project.captions.maxWordsPerBlock, project.captions.maxBlockMs) : [];

  const annSpace = { cropX: crop.x, cropY: crop.y, width: out.width, height: out.height, resScale, palette: theme.palette };
  const numbers = badgeNumbers(project.annotations);

  const planFrames: PlanFrame[] = [];
  const frameList = onlyFrames ? onlyFrames.map((i) => Math.max(0, Math.min(frames - 1, Math.round(i)))) : null;
  for (let n = 0; n < (frameList ? frameList.length : frames); n++) {
    const i = frameList ? frameList[n]! : n;
    const t = (i * 1000) / fps;
    const span = slideSpans.find((sp) => t >= sp.outStart - 1e-6 && t < sp.outEnd - 1e-6);
    const src = span ? span.srcAt : outputToSource(timeline, t);
    const slide = span ? slideList.find((x) => x.id === span.id) : undefined;
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
    // during a slide the source holds still: no clicks, shortcut or caption from the frozen moment
    const sc = span ? undefined : shortcuts.find((s) => src >= s.startMs && src < s.endMs);
    const cap = span ? undefined : captions.find((b) => src >= b.startMs && src < b.endMs);
    planFrames.push({
      t: r2(t),
      src: r2(src),
      cam: [r2(c.cx), r2(c.cy), r4(c.scale)],
      camVel: span ? [0, 0, 0] : [r2(c.vx), r2(c.vy), r4(c.vScale)],
      cur: curVisible ? [r2(k.x), r2(k.y), r4(k.opacity), r4(k.scale), k.shape] : null,
      clicks: span ? [] : activeClicks,
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
      annotations: annotationsAt(project.annotations, src, annSpace, numbers),
      slide: slide && span ? slideFrame(slide, t - span.outStart, out.width, out.height, resScale, theme.palette) : null,
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
    takes: takes.groups,
    takeCuts: takes.cuts.map((c) => ({ startMs: r2(c.startMs), endMs: r2(c.endMs) })),
    zoomSegments,
    slides: slideSpans.map((sp) => ({ id: sp.id, outStart: r2(sp.outStart), outEnd: r2(sp.outEnd), srcAt: r2(sp.srcAt) })),
    ...(theme.fonts.length ? { fonts: theme.fonts } : {}),
    ...(theme.watermark ? { watermark: theme.watermark } : {}),
    frames: planFrames,
  };
}
