import { buildAudioPlan, type AudioPlan } from "./audio.js";
import { backdropById, type Backdrop } from "./backdropArt.js";
import { effectiveZoomSegments } from "./autozoom.js";
import { activeSegment, buildCameraTrack, lerpCamera, zoomBlendTrack, type CameraSample } from "./camera.js";
import { applyWordEdits, mergeCaptionCues } from "./captionsManual.js";
import { stepSpring, type SpringState } from "./spring.js";
import { cropEvents, cropMeta, cropRect, cropZoomSegments, insideCrop, normalizeCrop, zoomableEvents } from "./crop.js";
import { buildCursorTrack, clickEffects, cursorOverrideAt, lerpCursor, sampleTrack, type CursorSample } from "./cursor.js";
import { clicks, detectTyping, shortcutOverlays, DEFAULT_TYPING } from "./events.js";
import { canvasSize, cardCrop, fillCard, fillScreenRect, layoutAt, layoutFor, overlayAvoidRect, scaleCameraRect, validCard } from "./layout.js";
import { customWindow, fillWindow, followFrame, followTargetAt, framingMode } from "./framing.js";
import { framingWindowAt, hasFramingKeys, windowScreenRect } from "./exportTargets.js";
import { masksAt, type MaskFrame } from "./masks.js";
import { motion3dAt, motion3dFrame, type Motion3DFrame } from "./motion3d.js";
import type { CaptionStyle, ProjectConfig } from "./project.js";
import { outputChapters, type OutputChapter } from "./chapters.js";
import { buildTimeline, insertSlides, mergeRanges, outputDuration, outputToSource, sourceToOutput, type SlideSpan } from "./timeline.js";
import { freezeAt } from "./freeze.js";
import { annotationsAt, badgeNumbers, slideFrame, type AnnFrame, type SlideFrame } from "./annotations.js";
import { resolveTakes, type TakeGroup } from "./takes.js";
import { ARABIC_FONT, hasArabicScript, trackWords } from "./translation.js";
import { subtitleCues, captionBlocks, captionFrame, captionWords, cleanupCuts, type CaptionFrame } from "./transcript.js";
import type { InputEvent, RecordingMeta, Rect, TimeRange, Word, ZoomSegment } from "./types.js";
import { applyTheme } from "./theme.js";
import { DEFAULT_FONT } from "./palette.js";
import { captionNeedsProgress } from "./captionStyles.js";
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
    /** kind image with imagePath "builtin:<id>": the procedural art to draw (Windows bug #20). */
    backdropArt?: Backdrop;
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
    captions: CaptionStyle & {
      wordHighlight: boolean;
      /** Family for Arabic-script words (demand #8; shaped, right to left); in plan.fonts. */
      scriptFont?: string;
      /** Language of the burned-in captions when it is a translation. */
      language?: string;
    };
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
  /**
   * Caption cues on the output clock in the caption language (demand #8), wrapped like the burned-in
   * caption: what SRT / VTT export writes. Empty when captions are off.
   */
  subtitles: Array<{ startMs: number; endMs: number; text: string }>;
  /** Text slides on the output clock (demand #4): each holds its source time and has no audio. */
  slides: SlideSpan[];
  /**
   * Chapters on the output clock (demand #27): present only when the project has chapter items.
   * Title / description ride along for the MP4 metadata; `embed` = write them into the export.
   */
  chapters?: { title: string; description: string; embed: boolean; items: OutputChapter[] };
  /**
   * Fonts the frames use besides the default (DejaVu Sans): family and files ("builtin:" = Lens's
   * assets/fonts, else relative to the bundle). Text ops and the caption style name the family.
   */
  fonts?: FontFiles[];
  /** Families that were missing and are drawn in the default font instead (withFontFallback); absent when none. */
  fontFallbacks?: string[];
  /** Brand logo watermark (demand #9), whole output px, drawn on every frame above the caption and under slides. */
  watermark?: WatermarkPlan | null;
  frames: PlanFrame[];
}

export interface PlanFrame {
  /** Output time and the source time it shows. */
  t: number;
  src: number;
  /**
   * Source time of the screen picture when it differs from src: a freeze frame (demand #20) holds the
   * screen on this frame while src (cursor, zoom, captions, audio) keeps running. Absent = src, so
   * plans of projects without freezes are unchanged. Read it with videoTime(frame).
   */
  vid?: number;
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
  /**
   * 3D transform of the screen card (feat/motion-3d); absent when the card is flat, so plans of
   * projects without 3D motion are unchanged.
   */
  m3d?: Motion3DFrame;
}

export interface PlanInputs {
  meta: RecordingMeta;
  events: InputEvent[];
  project: ProjectConfig;
  words?: Word[];
  /**
   * Measured silences (Transcript.pauses, or the mic track's silences when there is no transcript);
   * bound pause cuts when given, and are the pauses themselves when there are no words.
   */
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
  // Canvas (feat/canvas-layout): custom W x H, aspect "auto" (the user crop's shape) or aspect x resolution.
  const userCrop: Rect = normalizeCrop(rawProject.crop, fullMeta);
  const out = canvasSize(rawProject.output, { width: userCrop.w, height: userCrop.h });
  // Theme (demand #9): resolve "@slot" references (built-in < preset < brand < item), add brand cards.
  const theme = applyTheme(rawProject, fullMeta.durationMs, out);
  // Framing (fix/aspect-framing-014): Fill / Custom show a window of the source, cropped to the canvas
  // shape, on a card covering the whole canvas. A free card (project.card) owns the placement instead.
  const mode = framingMode(theme.project.output);
  // Custom framing with crop keys (demand #15): the window moves, so the crop stays the whole (user-
  // cropped) source and each frame's window becomes a screen rect covering the canvas (like Follow).
  const keyed = !validCard(theme.project.card) && mode === "custom" && hasFramingKeys(theme.project.output);
  const framed = !validCard(theme.project.card) && (mode === "fill" || mode === "custom") && !keyed;
  const project: ProjectConfig = framed ? { ...theme.project, card: fillCard() } : theme.project;
  const resScale = Math.min(out.width, out.height) / 1080;

  // 0. Crop (LOOK-14): move everything into cropped space. A custom card trims the crop to its own
  // shape first (cardCrop, centred), so the card never stretches and every conversion below agrees.
  const baseCrop = normalizeCrop(project.crop, fullMeta);
  const crop: Rect = framed
    ? mode === "custom" ? customWindow(baseCrop, out.width / out.height, project.output.framingRect) : fillWindow(baseCrop, out.width / out.height)
    : cardCrop(baseCrop, out, project);
  const meta = cropMeta(fullMeta, crop);
  const events = cropEvents(rawEvents, crop);
  const masks = project.masks.map((m) => ({ ...m, rect: cropRect(m.rect, crop), keys: m.keys?.map((k) => ({ tMs: k.tMs, rect: cropRect(k.rect, crop) })) }));
  const sourceAspect = meta.width / meta.height;

  // 1. Source-time tracks at output fps.
  const cursor: CursorSample[] = buildCursorTrack(events, meta, project.cursor, fps, project.overrides);
  const zoomSegments = effectiveZoomSegments(zoomableEvents(events, crop), meta, { ...project.zoom, segments: cropZoomSegments(project.zoom.segments, crop) });
  const staticLayout = layoutFor(project.camera.enabled ? "camera-overlay" : "screen-only", out, sourceAspect, project);
  // Fill mode (Windows bug #8): crop in to fill a differently shaped output and pan with the action.
  // A custom card owns the placement: fill mode (and its pan-follow) is off while one is set.
  // Old projects: fit "fill" is framing "follow" (framingMode), so they take this same path.
  const fill = !validCard(project.card) && mode === "follow" && Math.abs(out.width / out.height - sourceAspect) > 0.01;
  const camera: CameraSample[] = buildCameraTrack(cursor, zoomSegments, meta, {
    spring: project.zoom.spring,
    followDeadzone: project.zoom.followDeadzone,
    avoid: fill || keyed ? null : overlayAvoidRect(staticLayout),
  });
  const pan = fill ? buildPanTrack(cursor, camera, zoomSegments, meta, out, sourceAspect, project.zoom.spring) : [];

  // 2. Edit timeline (cuts, manual speed, typing speed-up).
  const speed = [...project.edits.speed];
  if (project.edits.speedUpTyping.enabled) {
    for (const r of detectTyping(events, DEFAULT_TYPING)) speed.push({ ...r, rate: project.edits.speedUpTyping.rate });
  }
  // Transcript cleanup (E03): filler + long-pause cuts from word timings, in source time.
  const cl = project.edits.cleanup;
  // Pauses are cut from measured silences even with no transcript (Windows #17); fillers need words.
  const autoCuts = cl.enabled && (words.length || pauses?.length)
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
  const shownWords = captionWords(applyWordEdits(words, project.captions.wordEdits), cl.enabled && cl.removeFillers, cl.fillers).filter((w) => !insideRanges(allCuts, (w.startMs + w.endMs) / 2));
  // Translated captions (demand #8): the selected language's track, re-timed onto the speech that survives the cuts.
  const track = project.translations.language ? project.translations.tracks.find((tr) => tr.language === project.translations.language) : undefined;
  const capWords = track ? trackWords(track, words.length ? words : null, allCuts) : shownWords;
  const capChars = project.captions.style.maxCharsPerLine;
  const capMotion = { progress: captionNeedsProgress(project.captions.style), reveal: project.captions.style.reveal === true };
  // hand-written cues (Windows bug #15) replace the transcript blocks they overlap
  const captions = project.captions.enabled ? mergeCaptionCues(captionBlocks(capWords, project.captions.maxWordsPerBlock, project.captions.maxBlockMs, capChars), project.captions.cues) : [];
  const capRtl = !!track?.rtl;
  const capFonts = track && captions.some((b) => b.words.some((w) => hasArabicScript(w.text))) ? [ARABIC_FONT] : [];

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
    let camOut: { cx: number; cy: number; scale: number } = c;
    const k = sampleTrack(cursor, src, lerpCursor);
    let layout = layoutAt(src, project.camera.layouts, out, sourceAspect, project);
    if (blend.length) {
      const b = sampleTrack(blend, src, (p, q, u) => ({ t: p.t + (q.t - p.t) * u, v: p.v + (q.v - p.v) * u })).v;
      layout = scaleCameraRect(layout, 1 + (project.camera.zoomedSize - 1) * b, layout.corner ?? project.camera.corner, layout.corner ? false : !!project.camera.position);
    }
    if (fill && pan.length && (layout.kind === "screen-only" || layout.kind === "camera-overlay" || layout.kind === "camera-cutout")) {
      const p = sampleTrack(pan, src, (a, b, u) => ({ t: a.t + (b.t - a.t) * u, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }));
      const vw = meta.width / c.scale;
      const vh = meta.height / c.scale;
      const view = { x0: c.cx - vw / 2, vw, y0: c.cy - vh / 2, vh };
      // Follow keeps the cursor (and a fixed zoom target, when both fit or by widening) in frame (demand #15)
      const keepCursor = k.opacity > 0.001 && insideCrop(k, crop) ? k : null;
      const f = followFrame(out, meta, view, p, keepCursor, keepCursor ? followTargetAt(zoomSegments, src, c.scale) : null, () => fillScreenRect(out, sourceAspect, view, p));
      layout = { ...layout, screen: f.screen };
      if (f.cam) camOut = f.cam;
    }
    if (keyed && (layout.kind === "screen-only" || layout.kind === "camera-overlay" || layout.kind === "camera-cutout")) {
      const w = framingWindowAt(baseCrop, out.width / out.height, project.output, src);
      const vw = meta.width / c.scale;
      const vh = meta.height / c.scale;
      const win = { x: w.x - crop.x, y: w.y - crop.y, w: w.w, h: w.h };
      layout = { ...layout, screen: windowScreenRect(out, meta, win, { x0: c.cx - vw / 2, vw, y0: c.cy - vh / 2, vh }) };
    }
    // freeze frame (demand #20): the screen holds on the frame at its start; the cursor stays live or hides
    const fz = freezeAt(project.freezes, src);
    const vid = fz && Math.abs(fz.startMs - src) > 1e-6 ? fz.startMs : undefined;
    const curHidden = fz?.cursor === "hide";
    const curVisible = !curHidden && project.cursor.visible && k.opacity > 0.001 && insideCrop(k, crop);
    const activeClicks = project.cursor.clickEffect === "none" || curHidden
      ? []
      : clickList
          .filter((cl) => src >= cl.t && src - cl.t < project.cursor.clickEffectMs && !cursorOverrideAt(project.overrides, cl.t).hidden)
          .map((cl) => [r2(cl.x), r2(cl.y), r4((src - cl.t) / project.cursor.clickEffectMs)] as [number, number, number]);
    // during a slide the source holds still: no clicks, shortcut or caption from the frozen moment
    const sc = span ? undefined : shortcuts.find((s) => src >= s.startMs && src < s.endMs);
    const cap = span ? undefined : captions.find((b) => src >= b.startMs && src < b.endMs);
    const m3 = project.motion3d.length ? motion3dAt(project.motion3d, src) : null;
    const screenR: [number, number, number, number] = [r2(layout.screen.x), r2(layout.screen.y), r2(layout.screen.w), r2(layout.screen.h)];
    planFrames.push({
      t: r2(t),
      src: r2(src),
      ...(vid !== undefined ? { vid: r2(vid) } : {}),
      cam: [r2(camOut.cx), r2(camOut.cy), r4(camOut.scale)],
      camVel: span ? [0, 0, 0] : [r2(c.vx), r2(c.vy), r4(c.vScale)],
      cur: curVisible ? [r2(k.x), r2(k.y), r4(k.opacity), r4(k.scale), k.shape] : null,
      clicks: span ? [] : activeClicks,
      layout: {
        screen: screenR,
        screenOpacity: r4(layout.screenOpacity),
        camera: layout.camera ? [r2(layout.camera.x), r2(layout.camera.y), r2(layout.camera.w), r2(layout.camera.h)] : null,
        cameraOpacity: r4(layout.cameraOpacity),
        cutout: layout.cameraCutout,
      },
      masks: masksAt(masks, vid ?? src),
      shortcut: sc ? sc.label : null,
      caption: cap ? captionFrame(cap, src, project.captions.style.maxWordsPerLine, project.captions.wordHighlight && !cap.manual, capChars, capRtl, capMotion) : null,
      annotations: annotationsAt(project.annotations, src, annSpace, numbers),
      slide: slide && span && slide.kind !== "freeze" ? slideFrame(slide, t - span.outStart, out.width, out.height, resScale, theme.palette) : null,
      ...(m3 ? { m3d: motion3dFrame(m3, screenR, out, resScale) } : {}),
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
      ...(project.background.kind === "image" && project.background.imagePath && backdropById(project.background.imagePath) ? { backdropArt: backdropById(project.background.imagePath)! } : {}),
      // Fill / Custom framing covers the canvas edge to edge: no rounded corners or shadow to show
      radius: project.background.kind === "hidden" || framed || keyed ? 0 : project.frame.radius * resScale,
      shadow: { ...project.frame.shadow, ...(project.background.kind === "hidden" || framed || keyed ? { opacity: 0 } : {}), blur: project.frame.shadow.blur * resScale, offsetY: project.frame.shadow.offsetY * resScale },
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
        ...(capFonts.length ? { scriptFont: ARABIC_FONT.family } : {}),
        ...(track ? { language: track.language } : {}),
      },
    },
    export: project.export,
    audio: buildAudioPlan(project, timeline, durationMs, clicks(rawEvents).map((c) => c.t), { words, pauses, sourceMs: meta.durationMs }),
    cuts: allCuts.map((c) => ({ startMs: r2(Math.max(0, c.startMs)), endMs: r2(Math.min(meta.durationMs, c.endMs)) })),
    cleanupCuts: autoCuts.map((c) => ({ startMs: r2(c.startMs), endMs: r2(c.endMs) })),
    takes: takes.groups,
    takeCuts: takes.cuts.map((c) => ({ startMs: r2(c.startMs), endMs: r2(c.endMs) })),
    zoomSegments,
    subtitles: subtitleCues(captions, project.captions.style.maxWordsPerLine, capChars, (src) => sourceToOutput(timeline, src) ?? sourceToOutput(timeline, src - 1)),
    slides: slideSpans.map((sp) => ({ id: sp.id, outStart: r2(sp.outStart), outEnd: r2(sp.outEnd), srcAt: r2(sp.srcAt) })),
    ...(theme.fonts.length || capFonts.length ? { fonts: [...theme.fonts, ...capFonts] } : {}),
    ...(theme.watermark ? { watermark: theme.watermark } : {}),
    ...(project.chapters && project.chapters.items.length
      ? { chapters: { title: project.chapters.title, description: project.chapters.description, embed: project.chapters.embed, items: outputChapters(project.chapters.items, timeline, durationMs) } }
      : {}),
    frames: planFrames,
  };
}

/** Source time of the screen picture a plan frame shows (a freeze frame holds it; else src). */
export function videoTime(f: Pick<PlanFrame, "src" | "vid">): number {
  return f.vid ?? f.src;
}

/**
 * Fill-mode pan focus per cursor sample (source px, cropped space): a fixed zoom target when one is
 * active, else the cursor with a deadzone of half the visible half-width, spring-smoothed with the
 * zoom spring so the crop glides rather than jumps.
 */
function buildPanTrack(
  cursor: CursorSample[],
  camera: CameraSample[],
  segments: ZoomSegment[],
  meta: RecordingMeta,
  out: { width: number; height: number },
  sourceAspect: number,
  spring: ProjectConfig["zoom"]["spring"],
): Array<{ t: number; x: number; y: number }> {
  const coverW = Math.max(out.height * sourceAspect, out.width);
  const coverH = coverW / sourceAspect;
  const visX = out.width / coverW;
  const visY = out.height / coverH;
  const res: Array<{ t: number; x: number; y: number }> = [];
  let fx = cursor[0]?.x ?? meta.width / 2;
  let fy = cursor[0]?.y ?? meta.height / 2;
  let sx: SpringState = { x: fx, v: 0 };
  let sy: SpringState = { x: fy, v: 0 };
  for (let i = 0; i < cursor.length; i++) {
    const cur = cursor[i]!;
    const cam = camera[Math.min(i, camera.length - 1)];
    const scale = cam ? cam.scale : 1;
    const seg = activeSegment(segments, cur.t);
    if (seg && seg.focus !== "follow") {
      fx = seg.focus.x;
      fy = seg.focus.y;
    } else {
      const dzX = ((visX * meta.width) / scale / 2) * 0.5;
      const dzY = ((visY * meta.height) / scale / 2) * 0.5;
      if (Math.abs(cur.x - fx) > dzX) fx += cur.x - fx - Math.sign(cur.x - fx) * dzX;
      if (Math.abs(cur.y - fy) > dzY) fy += cur.y - fy - Math.sign(cur.y - fy) * dzY;
    }
    if (i === 0) {
      sx = { x: fx, v: 0 };
      sy = { x: fy, v: 0 };
    } else {
      const dt = cur.t - cursor[i - 1]!.t;
      sx = stepSpring(sx, fx, dt, spring);
      sy = stepSpring(sy, fy, dt, spring);
    }
    res.push({ t: cur.t, x: sx.x, y: sy.x });
  }
  return res;
}

/**
 * The plan with `missing` font families replaced by the default font (Windows v0.1.3, imported fonts):
 * a font whose files are gone (a project copied without its fonts/ folder, a deleted library font, a
 * built-in that was not fetched) falls back to DejaVu Sans in the caption, text slides and annotation
 * text instead of stopping the export. Both export paths and the preview apply it, so they still agree;
 * the editor shows the families in `fontFallbacks` as a warning.
 */
export function withFontFallback(plan: RenderPlan, missing: string[]): RenderPlan {
  const gone = new Set(missing.filter((f) => f && f !== DEFAULT_FONT));
  if (!gone.size) return plan;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!(k === "font" && typeof x === "string" && gone.has(x))) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const caps = { ...plan.style.captions };
  if (caps.font && gone.has(caps.font)) delete caps.font;
  if (caps.scriptFont && gone.has(caps.scriptFont)) delete caps.scriptFont;
  const fonts = (plan.fonts ?? []).filter((f) => !gone.has(f.family));
  const used = [...gone].filter((f) => plan.style.captions.font === f || (plan.fonts ?? []).some((x) => x.family === f));
  return {
    ...plan,
    style: { ...plan.style, captions: caps },
    fonts,
    frames: plan.frames.map((f) => walk(f) as PlanFrame),
    fontFallbacks: [...new Set([...(plan.fontFallbacks ?? []), ...used])],
  };
}
