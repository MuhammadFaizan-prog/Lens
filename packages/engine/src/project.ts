import { normalizeMusic, validateMusic, type MusicSettings } from "./music.js";
import { CURSOR_SHAPES } from "./cursorShapes.js";
import type {
  AudioTrack,
  CameraLayoutSegment,
  MaskRegion,
  Rect,
  SegmentOverride,
  CursorShape,
  SpeedRange,
  SpringParams,
  TimeRange,
  ZoomSegment,
  ZoomStyle,
} from "./types.js";
import { springFromSettle } from "./spring.js";
import { DEFAULT_CLEANUP, DEFAULT_FILLERS } from "./transcript.js";
import { DEFAULT_TAKES, type TakeSettings } from "./takes.js";
import { defaultPrivacy, validateKeys, validatePrivacy, type PrivacySettings } from "./privacy.js";
import { normalizeFreeze, validateFreezes, type FreezeFrame } from "./freeze.js";
import { normalizeAnnotation, normalizeSlide, validateAnnotations, type Annotation, type StepLabelSettings, type TextSlide } from "./annotations.js";
import { defaultBrand, validateBrand, type BrandKit } from "./brand.js";
import { isColorValue } from "./palette.js";
import { validateTranslations, type TranslationSettings } from "./translation.js";
import { defaultTheme, validateTheme, type ThemeSettings } from "./themeSettings.js";
import { defaultDemo, validateDemo, type DemoSettings } from "./demo.js";
import type { CardTransform } from "./layout.js";
import { validateMotion3d, type Motion3DSegment } from "./motion3d.js";
import { validateExportVideo, type ExportVideoSettings } from "./exportPresets.js";
import { validateChapters, type ChapterSettings } from "./chapters.js";
import { validateExportTargets, validateFramingKeys, type ExportTargets, type FramingKey } from "./exportTargets.js";
import { validateVoiceover, type VoiceoverSettings } from "./voiceover.js";
import { CAMERA_ANIM_KINDS, validateElementAnim, validateTransitions, type CameraAnimKind, type CutTransition, type ElementAnim, type TransitionsConfig } from "./transitions.js";

/**
 * The editable project document (project.json inside a .lens bundle). Every visual default lives
 * here so the gauntlet loop can tune numbers against measured targets without touching code.
 * Defaults are starting points; research/measurements/*.json overrides them once measured.
 */
export interface ProjectConfig {
  version: 1;
  output: {
    /**
     * Aspect ratio as w:h, e.g. "16:9", "1:1", "9:16", "4:5", "4:3", or "auto": the canvas follows
     * the (user-cropped) recording's own shape, resolution being its short side.
     */
    aspect: string;
    /**
     * Custom canvas size in output px (16..8192 each side, rounded to even). Wins over aspect and
     * resolution when set. Absent / null = aspect x resolution.
     */
    size?: { w: number; h: number } | null;
    /** Height of the output for 16:9, or the short side for other aspects. */
    resolution: 360 | 480 | 720 | 1080 | 1440 | 2160;
    fps: 24 | 30 | 60;
    /**
     * How the recording fills an output whose aspect differs from it (9:16 for a 16:9 screen):
     * "fit" (default) letterboxes the whole screen inside the padding; "fill" crops in to fill the
     * frame and pans to follow the cursor or a fixed zoom target (Windows bug #8).
     */
    fit?: "fit" | "fill";
    /**
     * Framing (fix/aspect-framing-014): fit (whole, letterboxed, centred), fill (cover the canvas,
     * centred crop), follow (fill + pan with the cursor / zoom target), custom (the framingRect
     * window). Absent = derived from fit ("fill" = follow), so older projects render as before.
     */
    framing?: "fit" | "fill" | "follow" | "custom";
    /** Custom framing window in source px (same space as crop); its aspect is locked to the canvas. */
    framingRect?: Rect | null;
    /**
     * Custom framing keyframes (demand #15, exportTargets.ts): the window animates between keys
     * (source ms, recording clock). Absent / empty = the static framingRect, as before.
     */
    framingKeys?: FramingKey[];
  };
  background: {
    /** "hidden": no backdrop at all, the recording fills the frame (no padding, corners or shadow). */
    kind: "solid" | "gradient" | "image" | "hidden";
    colors: string[];
    /** Gradient angle in degrees. */
    angle: number;
    /**
     * Gradient stop positions (0..1 along the gradient), one per colour, in any order: the user drags
     * them freely. Absent (or a length that does not match colors) = evenly spaced.
     */
    stops?: number[];
    /** kind image: a bundle-relative / absolute file, or "builtin:<id>" for Lens's own procedural art. */
    imagePath?: string;
    /** kind image: scale to cover the frame (crop) or fit inside it (colors[0] around). Default cover. */
    fit?: "cover" | "contain";
    blur: number;
    /**
     * Follow the theme backdrop (preset palette < brand kit, see palette.ts) instead of kind / colors /
     * angle above. On for new projects; off as soon as a backdrop is picked by hand, and off for
     * project files that set their own backdrop.
     */
    inherit: boolean;
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
    /** Calm-camera zoom budget for auto zooms (demand #2). Off by default: defaults do not change. */
    budget: { enabled: boolean; maxPerMinute: number; minHoldMs: number };
    /** Which intensity preset produced these numbers ("custom" once a value is edited by hand). */
    preset: ZoomPresetName | "custom";
    /**
     * Sharper text in zooms (demand #22): above 1.5x the screen is resampled with Lanczos-3 and
     * unsharp-masked (edge-aware, no halos) in the preview and the export. amount 0..1.5 (0.6 is a
     * good default). Absent (projects made before this) = off, rendering exactly as before.
     */
    sharpen?: { enabled: boolean; amount: number };
  };
  cursor: {
    visible: boolean;
    size: number;
    shape: CursorShape | "system";
    /**
     * Demand #12, match the UI's cursor type. true: the logged cursor types (desktop recorder, where the
     * OS reports them) or, when none were logged, types inferred from the input (I-beam on a field the
     * user clicked and typed into), swapped with a short crossfade. false: always the arrow. Absent
     * (projects made before this): logged types only, hard swap, exactly as before.
     */
    matchHover?: boolean;
    /** Cursor art colours: "classic" (white outline, dark fill; the default) or "light" (dark outline, white fill). */
    theme?: "classic" | "light";
    smoothing: { enabled: boolean; spring: SpringParams; prefilter: boolean };
    hideWhenIdle: boolean;
    idleMs: number;
    fadeMs: number;
    loopToStart: boolean;
    loopMs: number;
    clickEffect: "none" | "ripple" | "circle" | "highlight";
    clickEffectMs: number;
    clickSound: boolean;
    /** Linear gain of the synthesized click sound (CUR-08), 0..2. */
    clickSoundVolume: number;
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
    /** Flip the webcam horizontally (CAM-04). */
    mirror: boolean;
    /** Crop of the webcam frame in camera px, applied before it is fitted into its slot (CAM-06). */
    crop: Rect | null;
    /**
     * Overlay size multiplier while a zoom is active (CAM-05). 1 = unchanged, 0.6 = shrink to 60%.
     * Animated with the zoom spring so the webcam shrinks as the camera zooms in.
     */
    zoomedSize: number;
    /**
     * Free position of the webcam overlay (on-canvas drag): its centre as fractions of the output
     * width / height. Absent = the corner. Normalized so it survives aspect changes.
     */
    position?: { x: number; y: number } | null;
    /**
     * How the webcam overlay appears / leaves where a layout segment shows or hides it (demand #14).
     * Absent = the legacy grow-from-centre over transitionMs.
     */
    enter?: ElementAnim<CameraAnimKind> | null;
    exit?: ElementAnim<CameraAnimKind> | null;
  };
  /**
   * Cut transitions (demand #14): the default for every cut join (edits.cuts[i].transition overrides it
   * per cut). Absent = hard cuts, as before.
   */
  transitions?: TransitionsConfig | null;
  edits: {
    /** Removed source ranges; a cut may carry its own transition (kind / duration / easing). */
    cuts: Array<TimeRange & { transition?: CutTransition | null }>;
    speed: SpeedRange[];
    /** Auto speed-up for detected typing stretches (E04). */
    speedUpTyping: { enabled: boolean; rate: number };
    /**
     * Transcript cleanup (E03 / AUD filler + pause removal) from word timings: cut filler words and
     * shorten pauses longer than maxPauseMs to keepPauseMs. Needs words (lens-transcribe output or
     * hand-written timings).
     */
    cleanup: {
      enabled: boolean;
      removeFillers: boolean;
      shortenPauses: boolean;
      fillers: string[];
      maxPauseMs: number;
      keepPauseMs: number;
      padMs: number;
    };
    /**
     * Multi-take (demand #1): find retakes in the transcript, keep one take per group (the last, or
     * the best by completeness / fillers / pauses / confidence), cut the others. choices pick a
     * take per group, marked adds user-marked retakes, ignored dismisses detected groups.
     */
    takes: TakeSettings;
  };
  captions: {
    enabled: boolean;
    maxWordsPerBlock: number;
    maxBlockMs: number;
    /** Highlight the word being spoken (AI-03 word-by-word). */
    wordHighlight: boolean;
    style: CaptionStyle;
    /**
     * Captions written by hand (Windows bug #15), source time. Each cue is one caption block; transcript
     * blocks that overlap a cue are replaced by it. Works with no transcript at all.
     */
    cues?: CaptionCue[];
    /** Inline corrections of transcript words: word index -> new text ("" hides the word in captions). */
    wordEdits?: Record<string, string>;
  };
  /**
   * Caption translation (demand #8): one caption track per language (translated per segment by
   * lens-translate, editable), and the language the preview and burned-in captions use.
   */
  translations: TranslationSettings;
  shortcuts: { enabled: boolean; displayMs: number };
  /**
   * Local speech-to-text (AI-01). Read by the render pipeline (compositor/pipeline.py), not by the
   * engine: when captions or cleanup need words and none are given, the pipeline transcribes an
   * audio track on-device and passes the transcript to lens-plan.
   * auto = transcribe only when captions or cleanup are on and no words were supplied.
   */
  transcription: {
    mode: "auto" | "off";
    /** Audio track id to transcribe; null = first unmuted mic track, else first track. */
    track: string | null;
    model: string;
    /** Language code, or null to detect (multilingual models only). */
    language: string | null;
  };
  /** Source crop rect in source px (LOOK-14). Everything downstream works in cropped space. */
  crop: Rect | null;
  /**
   * Free placement of the screen card (feat/canvas-layout): top-left and size as fractions of the
   * canvas width / height. Absent / null = today's placement (the source fitted in the padding).
   * A card whose shape differs from the crop trims the crop, centred (cardCrop), never stretches.
   * Fill mode and its pan-follow are off while a card is set.
   */
  card?: CardTransform | null;
  /** Timed spotlight / blur / pixelate regions in source px (TXT-04/05); tracked when they have keys. */
  masks: MaskRegion[];
  /**
   * 3D motion of the screen card (feat/motion-3d), source time: rotate / move the card on X, Y, Z
   * with perspective, composed outside the 2D zoom. Empty by default = the flat card as before.
   */
  motion3d: Motion3DSegment[];
  /** Automatic privacy redaction (demand #3): the scan's detections and their review state. */
  privacy: PrivacySettings;
  /** Per-segment overrides of cursor and audio volume, source time (CUR-01, EDT-05/06). */
  overrides: SegmentOverride[];
  /** Text, arrows, highlights, step badges and callouts (demand #4); later items draw on top. */
  annotations: Annotation[];
  /** Full-frame title cards inserted into the output at a source time (demand #4), images and pauses (#20). */
  slides: TextSlide[];
  /** Freeze frames (demand #20): source ranges where the screen holds on one frame; absent in older projects. */
  freezes?: FreezeFrame[];
  /** Auto step-label drafts from clicks + local OCR and their review state (demand #4). */
  stepLabels: StepLabelSettings;
  audio: {
    tracks: AudioTrack[];
    /** FFT denoise (ffmpeg afftdn); amountDb is the noise reduction in dB. */
    noiseReduction: { enabled: boolean; amountDb: number };
    /** Two-pass EBU R128 loudness normalisation (ffmpeg loudnorm). */
    loudness: { enabled: boolean; targetLufs: number; truePeakDb: number; lra: number };
    sampleRate: 44100 | 48000;
    /** Music bed with automatic ducking (demand #23, music.ts); absent in older projects. */
    music?: MusicSettings;
  };
  export: {
    gif: { fps: number; width: number; loop: boolean };
    /**
     * Platform export preset and its overrides (demand #24, exportPresets.ts). Absent in projects
     * written before it: the export is then exactly the old one (crf 18 / Settings bitrate, no cap).
     */
    video?: ExportVideoSettings;
  };
  /** The applied style preset and its palette / annotation-style layer (demand #9, docs/Presets.md). */
  theme: ThemeSettings;
  /** Brand kit: colours, logo watermark, fonts, intro / outro cards (demand #9). */
  brand: BrandKit;
  /** Fonts the user imported for captions ("My fonts"); absent in older projects. */
  customFonts?: ProjectFont[];
  /** Interactive demo + step guide export (demand #7, docs/InteractiveDemo.md). */
  demo: DemoSettings;
  /**
   * Title, description and chapters drafted from the transcript (demand #27, chapters.ts); absent in
   * older projects. Never changes the picture; exported as a YouTube list, WebVTT and MP4 chapters.
   */
  chapters?: ChapterSettings;
  /**
   * Several export sizes from one project (demand #15, docs/MultiAspect.md): one target per shape,
   * each with its own framing / crop keys; absent in older projects (one size, project.output).
   */
  exportTargets?: ExportTargets;
  /** Voiceover clips (demand #17, docs/Voiceover.md): imported or recorded per transcript line; absent in older projects. */
  voiceover?: VoiceoverSettings;
}

export type ZoomPresetName = "calm" | "default" | "punchy";

/**
 * Zoom intensity presets (demand #2, "Calm / Default / Punchy"). Default is exactly the engine
 * defaults (Rules.md 4: defaults unchanged). Calm and Punchy are design choices, not measurements:
 * Calm settles slower (1.4 s), zooms less (1.6x, max 2.5x), holds longer, merges clicks up to 4 s
 * apart, pans later (70% deadzone) and turns the budget on (4 zooms/min, 3 s min hold). Punchy
 * settles in 0.6 s, zooms to 2.4x, holds 1 s and pans sooner.
 */
export function zoomPreset(name: ZoomPresetName): Pick<ProjectConfig["zoom"], "defaultScale" | "maxScale" | "holdMs" | "mergeGapMs" | "followDeadzone" | "spring" | "budget" | "preset"> {
  switch (name) {
    case "calm":
      return { defaultScale: 1.6, maxScale: 2.5, holdMs: 2200, mergeGapMs: 4000, followDeadzone: 0.7, spring: springFromSettle(1400, 1),
        budget: { enabled: true, maxPerMinute: 4, minHoldMs: 3000 }, preset: "calm" };
    case "punchy":
      return { defaultScale: 2.4, maxScale: 4, holdMs: 1000, mergeGapMs: 1800, followDeadzone: 0.35, spring: springFromSettle(600, 1),
        budget: { enabled: false, maxPerMinute: 6, minHoldMs: 2000 }, preset: "punchy" };
    default: {
      const d = defaultProject().zoom;
      return { defaultScale: d.defaultScale, maxScale: d.maxScale, holdMs: d.holdMs, mergeGapMs: d.mergeGapMs, followDeadzone: d.followDeadzone,
        spring: d.spring, budget: d.budget, preset: "default" };
    }
  }
}

/** Return a copy of the project with a zoom preset applied (manual segments and auto on/off kept). */
export function applyZoomPreset(p: ProjectConfig, name: ZoomPresetName): ProjectConfig {
  return { ...p, zoom: { ...p.zoom, ...zoomPreset(name) } };
}

export interface CaptionCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionStyle {
  /** Font size in px at 1080p (scaled with resolution). */
  fontSize: number;
  textColor: string;
  /** #rrggbb, or "@highlight" (default): the theme's caption highlight (preset palette < brand kit). */
  highlightColor: string;
  background: { enabled: boolean; color: string; opacity: number };
  position: "top" | "bottom" | "custom";
  /** Vertical center of the caption as a fraction of output height, used when position = custom. */
  y: number;
  maxWordsPerLine: number;
  /** Most characters on one caption line (0 = no limit); a longer single word gets its own line. */
  maxCharsPerLine: number;
  /** Font family, or "@font" / absent: the theme font. */
  font?: string;
  /*
   * Caption styling (Windows request "diff diff fonts for the captions"). Every field below is
   * optional and absent in projects saved before it: absent = the look captions always had (bold,
   * as typed, no outline, highlighted word recoloured), so old project.json files render unchanged.
   */
  /** Font weight; absent = "bold". */
  weight?: CaptionWeight;
  /** Draw the caption in capitals (display only: SRT / VTT keep the words as spoken). */
  uppercase?: boolean;
  /** Outline around every glyph; width is a fraction of the font size (0.02..0.25). Absent = none. */
  stroke?: { enabled: boolean; color: string; width: number };
  /**
   * How the spoken word is marked: "color" (absent) recolours it, "box" puts it on a highlight-coloured
   * box, "pill" on a fully rounded pill, "underline" sweeps a bar under it, "karaoke" colours every word
   * spoken so far, "pop" draws it larger, "bounce" lifts it (pop / bounce / underline follow the word's
   * progress, CaptionFrame.progress).
   */
  highlightStyle?: CaptionHighlightStyle;
  /*
   * Second batch of caption styling (Windows v0.1.3 request "add more styles"). Every field is optional
   * and absent in older projects; absent = exactly the look above.
   */
  /** Only the words already spoken are drawn (word-by-word build, typewriter); the layout is the full caption's. */
  reveal?: boolean;
  /** Background per caption (absent = "block"), per line, or per word. */
  boxMode?: CaptionBoxMode;
  /** Background corners: rounded (absent), square, or a full-width bar (lower third). */
  boxShape?: CaptionBoxShape;
  /** Accent stripe along the background's left edge (#rrggbb or a theme slot), or absent. */
  accent?: string;
  /** Vertical gradient fill for the words (top colour to bottom colour, per line); the spoken word keeps its highlight. */
  gradient?: { enabled: boolean; from: string; to: string };
  /** Soft glow around the glyphs; radius is the blur sigma as a fraction of the font size (0..0.5). */
  glow?: { enabled: boolean; color: string; radius: number };
  /** Drop shadow; dx / dy / blur (sigma) are fractions of the font size. */
  shadow?: { enabled: boolean; color: string; opacity: number; dx: number; dy: number; blur: number };
  /** Frosted background: the picture under the caption background is blurred (sigma, fraction of the font size, 0..1). */
  backdropBlur?: number;
  /** Text colour of the second and later lines (two-line split colour), or absent. */
  line2Color?: string;
  /** Last one-click style applied (CAPTION_PRESETS), for the picker; cleared by nothing, purely informative. */
  preset?: string;
}

export type CaptionWeight = "regular" | "bold";
export type CaptionHighlightStyle = "color" | "box" | "pill" | "underline" | "karaoke" | "pop" | "bounce";
export const CAPTION_HIGHLIGHT_STYLES: CaptionHighlightStyle[] = ["color", "box", "pill", "underline", "karaoke", "pop", "bounce"];
export type CaptionBoxMode = "block" | "line" | "word";
export type CaptionBoxShape = "rounded" | "square" | "bar";

/**
 * A font the user imported (from a file, a URL or Google Fonts). Its files are copied into the
 * project folder (fonts/...), so the project renders offline and on another machine; the user
 * brings the licence.
 */
export interface ProjectFont {
  family: string;
  /** Paths relative to the bundle (fonts/<file>). Single-weight fonts name the same file twice. */
  regular: string;
  bold: string;
  /** Where it came from (shown with the licence reminder). */
  source?: { kind: "file" | "url" | "google" | "library"; url?: string; name?: string };
}

export function defaultProject(): ProjectConfig {
  return {
    version: 1,
    output: { aspect: "16:9", resolution: 1080, fps: 60 },
    background: { kind: "gradient", colors: ["#3a1c71", "#d76d77", "#ffaf7b"], angle: 135, blur: 0, inherit: true },
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
      budget: { enabled: false, maxPerMinute: 6, minHoldMs: 2000 },
      preset: "default",
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
      clickSoundVolume: 0.5,
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
      mirror: false,
      crop: null,
      zoomedSize: 1,
    },
    edits: {
      cuts: [],
      speed: [],
      speedUpTyping: { enabled: false, rate: 3 },
      cleanup: {
        enabled: false,
        removeFillers: true,
        shortenPauses: true,
        fillers: [...DEFAULT_FILLERS],
        maxPauseMs: DEFAULT_CLEANUP.maxPauseMs,
        keepPauseMs: DEFAULT_CLEANUP.keepPauseMs,
        padMs: DEFAULT_CLEANUP.padMs,
      },
      takes: { ...DEFAULT_TAKES, choices: [], marked: [], ignored: [] },
    },
    captions: {
      enabled: false,
      maxWordsPerBlock: 7,
      maxBlockMs: 2800,
      wordHighlight: true,
      style: {
        fontSize: 44,
        textColor: "#ffffff",
        highlightColor: "@highlight",
        background: { enabled: true, color: "#000000", opacity: 0.66 },
        position: "bottom",
        y: 0.88,
        maxWordsPerLine: 5,
        maxCharsPerLine: 42,
      },
    },
    translations: { language: null, tracks: [] },
    shortcuts: { enabled: true, displayMs: 1200 },
    transcription: { mode: "auto", track: null, model: "base.en", language: null },
    crop: null,
    masks: [],
    motion3d: [],
    privacy: defaultPrivacy(),
    overrides: [],
    annotations: [],
    slides: [],
    stepLabels: { drafts: [], generatedAt: null },
    audio: {
      tracks: [],
      noiseReduction: { enabled: false, amountDb: 12 },
      loudness: { enabled: true, targetLufs: -16, truePeakDb: -1.5, lra: 11 },
      sampleRate: 48000,
    },
    export: { gif: { fps: 15, width: 640, loop: true } },
    theme: defaultTheme(),
    brand: defaultBrand(),
    demo: defaultDemo(),
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
  // a project file that sets its own backdrop (written before presets, or by hand) keeps it
  const rawBg = isPlainObject(partial) && isPlainObject(partial.background) ? partial.background : null;
  if (rawBg && rawBg.inherit === undefined && (rawBg.kind !== undefined || rawBg.colors !== undefined || rawBg.imagePath !== undefined)) p.background.inherit = false;
  // annotations / slides written by hand may leave out style and animation fields
  if (Array.isArray(p.annotations)) p.annotations = p.annotations.map((a) => (a && typeof a === "object" && typeof a.id === "string" && typeof a.kind === "string" ? normalizeAnnotation(a) : a));
  if (Array.isArray(p.slides)) p.slides = p.slides.map((s) => (s && typeof s === "object" && typeof s.id === "string" ? normalizeSlide(s) : s));
  if (Array.isArray(p.freezes)) p.freezes = p.freezes.map((f) => (f && typeof f === "object" && typeof f.id === "string" ? normalizeFreeze(f) : f));
  // a music block written by hand may leave out levels, duck and fades; null / absent = no music
  if (p.audio.music === null) delete p.audio.music;
  else if (isPlainObject(p.audio.music) && typeof p.audio.music.path === "string") p.audio.music = normalizeMusic(p.audio.music);
  if (p.version !== 1) errs.push(`unsupported project version ${String(p.version)}`);
  if (p.output.aspect !== "auto" && !(/^\d+:\d+$/.test(p.output.aspect) && p.output.aspect.split(":").every((v) => Number(v) > 0)))
    errs.push(`output.aspect must look like 16:9 or be auto, got ${p.output.aspect}`);
  const osz = p.output.size;
  if (osz !== undefined && osz !== null && !(isPlainObject(osz) && [osz.w, osz.h].every((v) => Number.isFinite(v) && v >= 16 && v <= 8192)))
    errs.push("output.size must be {w, h} with each side within 16..8192 px");
  const cd = p.card;
  if (cd !== undefined && cd !== null && !(isPlainObject(cd) && [cd.x, cd.y, cd.w, cd.h].every(Number.isFinite) && cd.w > 0 && cd.h > 0 && cd.w <= 4 && cd.h <= 4 && Math.abs(cd.x) <= 4 && Math.abs(cd.y) <= 4))
    errs.push("card must be {x, y, w, h} canvas fractions with 0 < w, h <= 4 and |x|, |y| <= 4");
  if (![24, 30, 60].includes(p.output.fps)) errs.push("output.fps must be 24, 30 or 60");
  if (p.frame.padding < 0 || p.frame.padding > 0.4) errs.push("frame.padding must be within 0..0.4");
  if (p.zoom.minScale < 1 || p.zoom.maxScale < p.zoom.minScale) errs.push("zoom scale range invalid");
  if (p.zoom.defaultScale < p.zoom.minScale || p.zoom.defaultScale > p.zoom.maxScale)
    errs.push("zoom.defaultScale outside min..max");
  if (p.zoom.budget.maxPerMinute < 1) errs.push("zoom.budget.maxPerMinute must be >= 1");
  if (p.zoom.budget.minHoldMs < 0) errs.push("zoom.budget.minHoldMs must be >= 0");
  if (p.zoom.sharpen !== undefined && !(typeof p.zoom.sharpen.enabled === "boolean" && Number.isFinite(p.zoom.sharpen.amount) && p.zoom.sharpen.amount >= 0 && p.zoom.sharpen.amount <= 1.5))
    errs.push("zoom.sharpen must be {enabled, amount 0..1.5}");
  if (!["calm", "default", "punchy", "custom"].includes(p.zoom.preset)) errs.push(`zoom.preset ${String(p.zoom.preset)} unknown`);
  for (const s of p.zoom.segments) {
    if (s.endMs <= s.startMs) errs.push(`zoom segment ${s.id} ends before it starts`);
    if (s.scale < 1) errs.push(`zoom segment ${s.id} scale < 1`);
  }
  for (const r of p.edits.speed) if (r.rate <= 0) errs.push("speed rate must be > 0");
  for (const r of [...p.edits.cuts, ...p.edits.speed]) if (r.endMs <= r.startMs) errs.push("edit range ends before it starts");
  const validRect = (r: Rect | null | undefined) => !r || (r.w > 0 && r.h > 0 && [r.x, r.y, r.w, r.h].every(Number.isFinite));
  if (!validRect(p.crop)) errs.push("crop must have positive w and h");
  if (!validRect(p.camera.crop)) errs.push("camera.crop must have positive w and h");
  if (!(p.camera.zoomedSize > 0 && p.camera.zoomedSize <= 2)) errs.push("camera.zoomedSize must be within (0, 2]");
  // camera scenes (demand #18)
  const KINDS = ["screen-only", "camera-overlay", "split", "fullscreen-camera", "camera-cutout"];
  const CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"];
  for (const s of p.camera.layouts ?? []) {
    if (!s || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.endMs <= s.startMs || !KINDS.includes(s.kind)) {
      errs.push("camera.layouts[] must be {startMs, endMs > startMs, kind: screen-only | camera-overlay | split | fullscreen-camera | camera-cutout}");
      break;
    }
    if (s.corner !== undefined && !CORNERS.includes(s.corner)) errs.push("camera.layouts[].corner must be a corner");
    if (s.transitionMs !== undefined && !(Number.isFinite(s.transitionMs) && s.transitionMs >= 0 && s.transitionMs <= 5000)) errs.push("camera.layouts[].transitionMs must be within 0..5000");
  }
  if (p.cursor.clickSoundVolume < 0 || p.cursor.clickSoundVolume > 2) errs.push("cursor.clickSoundVolume must be within 0..2");
  for (const m of p.masks) {
    if (!["spotlight", "blur", "pixelate"].includes(m.kind)) errs.push(`mask ${m.id} has unknown kind ${String(m.kind)}`);
    if (m.endMs <= m.startMs) errs.push(`mask ${m.id} ends before it starts`);
    if (!validRect(m.rect)) errs.push(`mask ${m.id} rect invalid`);
    const ke = validateKeys(m.keys);
    if (ke) errs.push(`mask ${m.id} ${ke}`);
  }
  errs.push(...validateMotion3d(p.motion3d));
  errs.push(...validateVoiceover(p.voiceover));
  errs.push(...validateTransitions(p.transitions, p.edits.cuts));
  errs.push(...validateElementAnim(p.camera.enter, CAMERA_ANIM_KINDS, "camera.enter"), ...validateElementAnim(p.camera.exit, CAMERA_ANIM_KINDS, "camera.exit"));
  errs.push(...validatePrivacy(p.privacy));
  errs.push(...validateAnnotations(p.annotations, p.slides, p.stepLabels));
  errs.push(...validateFreezes(p.freezes));
  for (const o of p.overrides) {
    if (o.endMs <= o.startMs) errs.push("override ends before it starts");
    if (o.volume !== undefined && o.volume < 0) errs.push("override volume must be >= 0");
    if (o.cursor?.size !== undefined && o.cursor.size <= 0) errs.push("override cursor size must be > 0");
    if (o.cursor?.shape !== undefined && !CURSOR_SHAPES.includes(o.cursor.shape)) errs.push(`override cursor shape ${String(o.cursor.shape)} unknown`);
  }
  errs.push(...validateMusic(p.audio.music));
  if (p.cursor.shape !== "system" && !CURSOR_SHAPES.includes(p.cursor.shape)) errs.push(`cursor.shape ${String(p.cursor.shape)} unknown`);
  if (p.cursor.theme !== undefined && p.cursor.theme !== "classic" && p.cursor.theme !== "light") errs.push(`cursor.theme ${String(p.cursor.theme)} unknown`);
  for (const tr of p.audio.tracks) {
    if (!tr.path) errs.push(`audio track ${tr.id} has no path`);
    if (tr.volume < 0) errs.push(`audio track ${tr.id} volume must be >= 0`);
  }
  const cl = p.edits.cleanup;
  if (cl.maxPauseMs <= 0 || cl.keepPauseMs < 0 || cl.keepPauseMs >= cl.maxPauseMs) errs.push("edits.cleanup needs 0 <= keepPauseMs < maxPauseMs");
  if (cl.padMs < 0) errs.push("edits.cleanup.padMs must be >= 0");
  if (!Array.isArray(cl.fillers)) errs.push("edits.cleanup.fillers must be a list of words");
  const tk = p.edits.takes;
  if (!["last", "best"].includes(tk.strategy)) errs.push(`edits.takes.strategy must be last or best, got ${String(tk.strategy)}`);
  if (!(tk.padMs >= 0)) errs.push("edits.takes.padMs must be >= 0");
  if (!Array.isArray(tk.choices) || tk.choices.some((c) => !Number.isFinite(c?.atMs) || !Number.isInteger(c?.keep) || c.keep < 0))
    errs.push("edits.takes.choices must be [{atMs, keep >= 0}]");
  if (!Array.isArray(tk.marked) || tk.marked.some((r) => !Number.isFinite(r?.startMs) || !(r.endMs > r.startMs)))
    errs.push("edits.takes.marked must be ranges with endMs > startMs");
  if (!Array.isArray(tk.ignored) || tk.ignored.some((t) => !Number.isFinite(t))) errs.push("edits.takes.ignored must be a list of times");
  if (!["auto", "off"].includes(p.transcription.mode)) errs.push("transcription.mode must be auto or off");
  if (p.transcription.track !== null && !p.audio.tracks.some((t) => t.id === p.transcription.track))
    errs.push(`transcription.track ${String(p.transcription.track)} is not an audio track id`);
  if (p.output.fit !== undefined && p.output.fit !== "fit" && p.output.fit !== "fill") errs.push("output.fit must be fit or fill");
  if (p.output.framing !== undefined && !["fit", "fill", "follow", "custom"].includes(p.output.framing)) errs.push("output.framing must be fit, fill, follow or custom");
  const fr = p.output.framingRect;
  if (fr !== undefined && fr !== null && !(isPlainObject(fr) && [fr.x, fr.y, fr.w, fr.h].every(Number.isFinite) && fr.w > 0 && fr.h > 0)) errs.push("output.framingRect must be {x, y, w, h} source px with positive w and h");
  errs.push(...validateFramingKeys(p.output.framingKeys));
  errs.push(...validateExportTargets(p.exportTargets));
  const cp = p.camera.position;
  if (cp && !(Number.isFinite(cp.x) && Number.isFinite(cp.y))) errs.push("camera.position must be {x, y} fractions");
  for (const c of p.captions.cues ?? []) {
    if (!c || typeof c.id !== "string" || typeof c.text !== "string" || !Number.isFinite(c.startMs) || !(c.endMs > c.startMs)) errs.push("captions.cues must be [{id, startMs, endMs > startMs, text}]");
  }
  if (p.captions.wordEdits !== undefined && (typeof p.captions.wordEdits !== "object" || p.captions.wordEdits === null || Object.values(p.captions.wordEdits).some((v) => typeof v !== "string")))
    errs.push("captions.wordEdits must map word indices to text");
  if (p.captions.style.maxWordsPerLine < 1) errs.push("captions.style.maxWordsPerLine must be >= 1");
  if (!(p.captions.style.maxCharsPerLine >= 0)) errs.push("captions.style.maxCharsPerLine must be >= 0");
  errs.push(...validateTranslations(p.translations));
  if (!isColorValue(p.captions.style.highlightColor) || !isColorValue(p.captions.style.textColor)) errs.push("caption colours must be #rrggbb or a theme slot (@highlight)");
  {
    const cs = p.captions.style;
    if (cs.weight !== undefined && cs.weight !== "regular" && cs.weight !== "bold") errs.push('captions.style.weight must be "regular" or "bold"');
    if (cs.highlightStyle !== undefined && !CAPTION_HIGHLIGHT_STYLES.includes(cs.highlightStyle)) errs.push(`captions.style.highlightStyle must be one of ${CAPTION_HIGHLIGHT_STYLES.join(", ")}`);
    if (cs.reveal !== undefined && typeof cs.reveal !== "boolean") errs.push("captions.style.reveal must be a boolean");
    if (cs.boxMode !== undefined && !["block", "line", "word"].includes(cs.boxMode)) errs.push("captions.style.boxMode must be block, line or word");
    if (cs.boxShape !== undefined && !["rounded", "square", "bar"].includes(cs.boxShape)) errs.push("captions.style.boxShape must be rounded, square or bar");
    if (cs.accent !== undefined && !isColorValue(cs.accent)) errs.push("captions.style.accent must be #rrggbb or a theme slot");
    if (cs.line2Color !== undefined && !isColorValue(cs.line2Color)) errs.push("captions.style.line2Color must be #rrggbb or a theme slot");
    if (cs.gradient !== undefined && !(isPlainObject(cs.gradient) && typeof cs.gradient.enabled === "boolean" && isColorValue(cs.gradient.from) && isColorValue(cs.gradient.to)))
      errs.push("captions.style.gradient must be { enabled, from, to } colours");
    if (cs.glow !== undefined && !(isPlainObject(cs.glow) && typeof cs.glow.enabled === "boolean" && isColorValue(cs.glow.color) && cs.glow.radius >= 0 && cs.glow.radius <= 0.5))
      errs.push("captions.style.glow must be { enabled, color, radius 0..0.5 }");
    const sh = cs.shadow;
    if (sh !== undefined && !(isPlainObject(sh) && typeof sh.enabled === "boolean" && isColorValue(sh.color) && sh.opacity >= 0 && sh.opacity <= 1 && Math.abs(sh.dx) <= 0.5 && Math.abs(sh.dy) <= 0.5 && sh.blur >= 0 && sh.blur <= 0.5))
      errs.push("captions.style.shadow must be { enabled, color, opacity 0..1, dx / dy within ±0.5, blur 0..0.5 }");
    if (cs.backdropBlur !== undefined && !(cs.backdropBlur >= 0 && cs.backdropBlur <= 1)) errs.push("captions.style.backdropBlur must be within 0..1");
    if (cs.uppercase !== undefined && typeof cs.uppercase !== "boolean") errs.push("captions.style.uppercase must be a boolean");
    if (cs.stroke !== undefined && (typeof cs.stroke !== "object" || cs.stroke === null || !isColorValue(cs.stroke.color) || !(cs.stroke.width >= 0 && cs.stroke.width <= 0.25)))
      errs.push("captions.style.stroke must be { enabled, color #rrggbb, width 0..0.25 }");
    if (cs.font !== undefined && (typeof cs.font !== "string" || !cs.font)) errs.push("captions.style.font must be a font family name");
  }
  if (!["solid", "gradient", "image", "hidden"].includes(p.background.kind)) errs.push("background.kind must be solid, gradient, image or hidden");
  const st = p.background.stops;
  if (st !== undefined && !(Array.isArray(st) && st.length === p.background.colors.length && st.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)))
    errs.push("background.stops must give one position in 0..1 per colour");
  if (p.background.kind === "image" && !p.background.imagePath) errs.push("background.imagePath is required for an image backdrop");
  if (p.background.fit !== undefined && p.background.fit !== "cover" && p.background.fit !== "contain") errs.push("background.fit must be cover or contain");
  if (typeof p.background.inherit !== "boolean") errs.push("background.inherit must be true or false");
  errs.push(...validateTheme(p.theme));
  errs.push(...validateBrand(p.brand));
  if (p.customFonts !== undefined && !(Array.isArray(p.customFonts) && p.customFonts.every((f) => isPlainObject(f) && typeof f.family === "string" && !!f.family && typeof f.regular === "string" && !!f.regular && typeof f.bold === "string" && !!f.bold)))
    errs.push("customFonts must be [{family, regular, bold}] with bundle-relative paths");
  errs.push(...validateDemo(p.demo));
  if (p.export.gif.fps < 1 || p.export.gif.fps > 50) errs.push("export.gif.fps must be within 1..50");
  if (p.export.gif.width < 16) errs.push("export.gif.width must be >= 16");
  errs.push(...validateExportVideo(p.export.video));
  errs.push(...validateChapters(p.chapters));
  if (errs.length) throw new ProjectValidationError(errs.join("; "));
  return p;
}
