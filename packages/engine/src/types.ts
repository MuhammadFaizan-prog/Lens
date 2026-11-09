/**
 * Core data types shared by the Lens engine, the compositor and the harness.
 * All times are milliseconds on the recording's monotonic clock (t=0 at first frame).
 * All positions are source-screen pixels unless a name says otherwise.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MouseButton = "left" | "right" | "middle";

/** One line of the input-event log written alongside the cursorless screen capture (feature A13). */
export type InputEvent =
  | { t: number; type: "move"; x: number; y: number }
  | { t: number; type: "down"; x: number; y: number; button: MouseButton }
  | { t: number; type: "up"; x: number; y: number; button: MouseButton }
  | { t: number; type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { t: number; type: "key"; key: string; modifiers: Modifier[] }
  | { t: number; type: "cursor-shape"; shape: CursorShape };

export type Modifier = "cmd" | "ctrl" | "alt" | "shift" | "meta";

export type CursorShape = "arrow" | "pointer" | "text" | "grab" | "grabbing" | "crosshair" | "resize-ew" | "resize-ns";

export interface RecordingMeta {
  /** Source capture size in pixels (already in physical pixels, HiDPI included). */
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  /** Ratio of physical to logical pixels, used to size the re-rendered cursor. */
  pixelRatio: number;
  /** Optional webcam track size. */
  camera?: { width: number; height: number };
}

export interface SpringParams {
  /** Stiffness k (N/m with unit mass). */
  stiffness: number;
  /** Damping c. Critical damping is 2*sqrt(k*m). */
  damping: number;
  mass: number;
}

export type ZoomStyle = "classic" | "loupe";

export interface ZoomSegment {
  id: string;
  startMs: number;
  endMs: number;
  /** Magnification, 1 = no zoom. */
  scale: number;
  /** Fixed focus point in source px, or follow the smoothed cursor. */
  focus: Vec2 | "follow";
  style: ZoomStyle;
  /** true when created by the auto-zoom planner, false when placed by the user. */
  auto: boolean;
}

export type CameraLayoutKind = "screen-only" | "camera-overlay" | "split" | "fullscreen-camera" | "camera-cutout";

export interface CameraLayoutSegment {
  startMs: number;
  endMs: number;
  kind: CameraLayoutKind;
}

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  /** Recogniser confidence 0..1 (speech-to-text output; absent for hand-written timings). */
  confidence?: number;
  /** A hesitation (um, uh, ...). Set by the transcriber; text-matched fillers count too. */
  filler?: boolean;
  /**
   * Found by voice-activity detection, not written by the recogniser: voiced audio between two
   * pauses that the recogniser produced no word for. Text is a placeholder ("[filler]"), so it is
   * never shown in captions.
   */
  inferred?: boolean;
  /** Translated caption words (demand #8): index of the segment the word belongs to; caption blocks never cross segments. */
  segment?: number;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface SpeedRange extends TimeRange {
  rate: number;
}

/** One audio input aligned to the recording clock (REC-08/09, AUD-04/06). */
export interface AudioTrack {
  id: string;
  kind: "mic" | "system";
  path: string;
  /** Recording time (ms) at which the file's first sample plays. Negative skips into the file. */
  offsetMs: number;
  /** Linear gain. */
  volume: number;
  muted: boolean;
}

export type MaskKind = "spotlight" | "blur" | "pixelate";

/** Timed highlight or privacy region in source px (TXT-04/05). */
export interface MaskRegion {
  id: string;
  kind: MaskKind;
  rect: Rect;
  startMs: number;
  endMs: number;
  /** Edge softness in source px. */
  feather: number;
  /** Fade in/out time in ms. */
  fadeMs: number;
  /**
   * spotlight: how much the outside is dimmed, 0..1 (default 0.6);
   * blur: Gaussian sigma in source px (default 12); pixelate: block size in source px (default 16).
   */
  strength?: number;
  /**
   * Tracked mask: the rect per source time, sorted by tMs (one key per source frame where the box
   * moved; runs of identical rects keep only their first and last key). Between two keys the mask
   * covers both rects (their union), so it is never behind the content whichever frame a renderer
   * shows. Before the first / after the last key the end key holds. `rect` stays the first key's rect.
   */
  keys?: MaskKey[];
  /** Set on masks created by accepting a privacy detection (privacy.detections[].id). */
  privacyId?: string;
}

export interface MaskKey {
  tMs: number;
  rect: Rect;
}

/** Time range (source ms) overriding cursor behaviour and audio volume (CUR-01 / EDT-05/06). */
export interface SegmentOverride {
  startMs: number;
  endMs: number;
  cursor?: { hidden?: boolean; smoothing?: boolean; size?: number };
  /** Gain multiplier applied to all audio tracks in this range (not click sounds). */
  volume?: number;
}
