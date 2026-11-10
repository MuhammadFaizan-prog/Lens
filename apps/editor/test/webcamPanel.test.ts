/** Webcam tab empty state (Windows v0.1.2: "no webcam track", Show webcam did nothing) and the toggle's plan wiring. */
import { describe, expect, it } from "vitest";
import { buildRenderPlan, resolveProject } from "@lens/engine";
import { cameraWarningOf, NO_CAMERA_HINT, NO_CAMERA_TITLE, webcamPanelState } from "../src/state/webcamPanel";

describe("webcam panel state", () => {
  it("a bundle without a camera track shows the empty state and disables the controls", () => {
    for (const b of [{ camera: null }, { camera: { frames: 0 } }, null, undefined]) {
      const s = webcamPanelState(b);
      expect(s.hasCamera).toBe(false);
      expect(s.controlsDisabled).toBe(true);
      expect(s.empty).toEqual({ title: NO_CAMERA_TITLE, hint: NO_CAMERA_HINT });
    }
    expect(NO_CAMERA_TITLE).toBe("No camera in this recording");
    expect(NO_CAMERA_HINT).toMatch(/camera in the recorder before/i);
  });

  it("a bundle with a camera track enables the controls and has no empty state", () => {
    const s = webcamPanelState({ camera: { frames: 120 } });
    expect(s).toEqual({ hasCamera: true, controlsDisabled: false, empty: null, warning: null });
  });

  it("carries the recorder's camera warning", () => {
    const s = webcamPanelState({ camera: null, cameraWarning: "camera video could not be converted: x" });
    expect(s.warning).toBe("camera video could not be converted: x");
    expect(s.empty).not.toBeNull();
  });

  it("reads the camera warning out of recording.json", () => {
    expect(cameraWarningOf(null)).toBeNull();
    expect(cameraWarningOf({ finalize: { cameraError: null }, warnings: [] })).toBeNull();
    expect(cameraWarningOf({ finalize: { cameraError: "camera video could not be converted: boom" } })).toBe("camera video could not be converted: boom");
    expect(cameraWarningOf({ warnings: ["microphone was on but mic.webm is empty: no mic track", 'camera "USB Cam" could not be opened: NotReadableError'] })).toBe('camera "USB Cam" could not be opened: NotReadableError');
    expect(cameraWarningOf({ warnings: ["hardware encoder h264_nvenc failed"] })).toBeNull();
  });
});

describe("Show webcam toggle reaches the plan", () => {
  const meta = { width: 1920, height: 1080, fps: 30, durationMs: 12000, pixelRatio: 1 };
  const plan = (enabled: boolean, layouts: Array<{ startMs: number; endMs: number; kind: "split" | "fullscreen-camera" }> = []) =>
    buildRenderPlan({ meta, events: [], project: resolveProject({ camera: { enabled, layouts } }) });

  it("on: every frame has a webcam rect; off: none", () => {
    expect(plan(true).frames.every((f) => f.layout.camera && f.layout.cameraOpacity > 0)).toBe(true);
    expect(plan(false).frames.every((f) => f.layout.camera === null || f.layout.cameraOpacity === 0)).toBe(true);
  });

  it("off also wins over layout segments (split / fullscreen camera)", () => {
    const layouts = [{ startMs: 0, endMs: 6000, kind: "split" as const }, { startMs: 6000, endMs: 12000, kind: "fullscreen-camera" as const }];
    expect(plan(true, layouts).frames.some((f) => f.layout.camera)).toBe(true);
    const off = plan(false, layouts);
    expect(off.frames.every((f) => !f.layout.camera || f.layout.cameraOpacity === 0)).toBe(true);
    expect(off.frames.every((f) => f.layout.screenOpacity === 1)).toBe(true);
  });
});
