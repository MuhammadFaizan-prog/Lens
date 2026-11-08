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
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface SpeedRange extends TimeRange {
  rate: number;
}
