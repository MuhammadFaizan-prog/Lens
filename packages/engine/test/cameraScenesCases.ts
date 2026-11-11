/**
 * Camera scenes (demand #18): old-style projects (camera.layouts without the new corner / transitionMs
 * fields) whose render plans must stay byte-identical to the engine before scenes (7d1a5db). The
 * golden hashes in cameraScenes.test.ts were produced by running planHashes() against that engine.
 */
import crypto from "node:crypto";
import { buildRenderPlan, resolveProject } from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

type Seg = { startMs: number; endMs: number; kind: string };

export const OLD_CASES: Array<{ name: string; camera: Record<string, unknown>; output?: Record<string, unknown> }> = [
  { name: "no layouts, webcam on", camera: { enabled: true } },
  { name: "split 1-5 s", camera: { enabled: true, layouts: [{ startMs: 1000, endMs: 5000, kind: "split" }] as Seg[] } },
  {
    name: "every kind back to back",
    camera: {
      enabled: true,
      corner: "top-left",
      layouts: [
        { startMs: 500, endMs: 2000, kind: "fullscreen-camera" },
        { startMs: 2000, endMs: 3500, kind: "split" },
        { startMs: 3500, endMs: 5000, kind: "screen-only" },
        { startMs: 5000, endMs: 7000, kind: "camera-cutout" },
        { startMs: 8000, endMs: 9000, kind: "camera-overlay" },
      ] as Seg[],
    },
  },
  { name: "overlapping, 9:16, no transition", camera: { enabled: true, transitionMs: 0, layouts: [{ startMs: 1000, endMs: 6000, kind: "split" }, { startMs: 3000, endMs: 4000, kind: "fullscreen-camera" }] as Seg[] }, output: { aspect: "9:16" } },
  { name: "free position + zoom shrink", camera: { enabled: true, position: { x: 0.3, y: 0.7 }, zoomedSize: 0.6, layouts: [{ startMs: 2000, endMs: 4000, kind: "camera-cutout" }] as Seg[] } },
  { name: "webcam off with layouts", camera: { enabled: false, layouts: [{ startMs: 1000, endMs: 5000, kind: "fullscreen-camera" }] as Seg[] } },
];

/** sha256 of each case's full plan JSON at 360p30. */
export function planHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of OLD_CASES) {
    const project = resolveProject({ output: { resolution: 360, fps: 30, ...(c.output ?? {}) }, camera: c.camera });
    const plan = buildRenderPlan({ meta: META, events: demoSession(), project });
    out[c.name] = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  }
  return out;
}
