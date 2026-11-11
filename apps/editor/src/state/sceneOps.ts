/**
 * Camera scenes (demand #18): ranges of the recording that switch the webcam layout (screen only,
 * camera full frame, side by side, picture-in-picture in a chosen corner), each with its own
 * transition. They are project.camera.layouts blocks on the timeline's Scenes lane; the engine lays
 * them out (layoutAt), so the preview, the in-app (browser) export and the Python export all draw the
 * same rects. Pure helpers here (no React), unit-tested in test/sceneOps.test.ts.
 */
import type { CameraLayoutKind, CameraLayoutSegment, ProjectConfig } from "@lens/engine";

export type SceneCorner = NonNullable<CameraLayoutSegment["corner"]>;

/** The layouts a scene offers, in inspector order (camera-cutout stays readable on old projects). */
export const SCENE_KINDS: Array<{ value: CameraLayoutKind; label: string; hint: string }> = [
  { value: "screen-only", label: "Screen only", hint: "Hide the camera" },
  { value: "fullscreen-camera", label: "Camera full", hint: "Only the camera, full frame" },
  { value: "split", label: "Side by side", hint: "Screen and camera next to each other" },
  { value: "camera-overlay", label: "PiP", hint: "Camera bubble over the screen" },
];

export const SCENE_CORNERS: Array<{ value: SceneCorner; label: string; short: string }> = [
  { value: "top-left", label: "Top left", short: "↖" },
  { value: "top-right", label: "Top right", short: "↗" },
  { value: "bottom-left", label: "Bottom left", short: "↙" },
  { value: "bottom-right", label: "Bottom right", short: "↘" },
];

export const SCENE_TRANSITION_MAX_MS = 2000;

const KIND_LABEL: Record<CameraLayoutKind, string> = {
  "screen-only": "Screen only",
  "fullscreen-camera": "Camera full",
  split: "Side by side",
  "camera-overlay": "PiP",
  "camera-cutout": "Cutout",
};

export function isPip(kind: CameraLayoutKind): boolean {
  return kind === "camera-overlay" || kind === "camera-cutout";
}

/** Label of a scene block on the lane: "Camera full", "PiP ↗". */
export function sceneLabel(s: Pick<CameraLayoutSegment, "kind" | "corner">): string {
  const base = KIND_LABEL[s.kind] ?? s.kind;
  if (!isPip(s.kind) || !s.corner) return base;
  return `${base} ${SCENE_CORNERS.find((c) => c.value === s.corner)?.short ?? ""}`.trim();
}

function mapScene(p: ProjectConfig, i: number, fn: (s: CameraLayoutSegment) => CameraLayoutSegment): ProjectConfig {
  return { ...p, camera: { ...p.camera, layouts: p.camera.layouts.map((s, j) => (j === i ? fn(s) : s)) } };
}

/** Switch a scene's layout; a corner is kept only for picture-in-picture layouts. */
export function setSceneKind(p: ProjectConfig, i: number, kind: CameraLayoutKind): ProjectConfig {
  return mapScene(p, i, (s) => {
    const { corner, ...rest } = s;
    return isPip(kind) && corner ? { ...rest, kind, corner } : { ...rest, kind };
  });
}

/** A scene's own corner, or null for the project's webcam corner / free position. */
export function setSceneCorner(p: ProjectConfig, i: number, corner: SceneCorner | null): ProjectConfig {
  return mapScene(p, i, (s) => {
    const { corner: _old, ...rest } = s;
    return corner ? { ...rest, corner } : rest;
  });
}

/** A scene's transition in ms (clamped to 0..2000), or null for the project's camera transition. */
export function setSceneTransition(p: ProjectConfig, i: number, ms: number | null): ProjectConfig {
  return mapScene(p, i, (s) => {
    const { transitionMs: _old, ...rest } = s;
    return ms === null || !Number.isFinite(ms) ? rest : { ...rest, transitionMs: Math.round(Math.min(SCENE_TRANSITION_MAX_MS, Math.max(0, ms))) };
  });
}

/** Scenes only show while Show webcam is on: adding one to a recording with a camera turns it on. */
export function withCameraForScenes(p: ProjectConfig, hasCamera: boolean): ProjectConfig {
  return hasCamera && !p.camera.enabled ? { ...p, camera: { ...p.camera, enabled: true } } : p;
}
