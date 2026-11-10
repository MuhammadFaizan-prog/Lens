/**
 * What the Inspector's Webcam tab shows (Windows v0.1.2 report: "no webcam track" and a Show webcam
 * toggle that did nothing). A bundle without cam.mp4 gets a plain empty state with its controls
 * disabled; a camera the recorder could not save is named, so the user knows why it is missing.
 */
export interface WebcamPanelInput {
  /** The bundle's camera track (cam.mp4), or null when the recording has none. */
  camera: { frames: number } | null;
  /** The recorder's camera warning for this bundle (recording.json), or null. */
  cameraWarning?: string | null;
}

export interface WebcamPanelState {
  hasCamera: boolean;
  /** Show webcam / Corner / Size / Shape / Mirror / Shrink are inert without a camera track. */
  controlsDisabled: boolean;
  empty: { title: string; hint: string } | null;
  /** The recorder's reason the camera is missing or broken, shown under the empty state. */
  warning: string | null;
}

export const NO_CAMERA_TITLE = "No camera in this recording";
export const NO_CAMERA_HINT = "Turn on a camera in the recorder before you start recording.";

export function webcamPanelState(b: WebcamPanelInput | null | undefined): WebcamPanelState {
  const hasCamera = !!b?.camera && b.camera.frames > 0;
  const warning = b?.cameraWarning ? b.cameraWarning : null;
  return {
    hasCamera,
    controlsDisabled: !hasCamera,
    empty: hasCamera ? null : { title: NO_CAMERA_TITLE, hint: NO_CAMERA_HINT },
    warning,
  };
}

/** The camera-related warning out of a recording.json (finalize.cameraError, else a camera warning). */
export function cameraWarningOf(rec: { finalize?: { cameraError?: string | null } | null; warnings?: unknown } | null | undefined): string | null {
  if (!rec) return null;
  const e = rec.finalize?.cameraError;
  if (typeof e === "string" && e) return e;
  const w = Array.isArray(rec.warnings) ? rec.warnings.find((x): x is string => typeof x === "string" && /camera|webcam/i.test(x)) : undefined;
  return w ?? null;
}
