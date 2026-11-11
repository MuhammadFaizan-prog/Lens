/**
 * Projects whose plans must not change with demand #14 (transitions + enter / exit): cuts, speed, a text
 * slide, brand intro / outro, webcam layout segments that show / hide the camera, annotations. Their plan
 * hashes were computed from main 7d1a5db (before transitions existed) and are asserted in transitions.test.ts.
 */
import { createHash } from "node:crypto";
import { buildRenderPlan, resolveProject } from "../src/index.js";
import { META, demoSession } from "./fixtures.js";

export function goldenProjects(): Array<{ name: string; project: unknown }> {
  return [
    { name: "cuts+speed", project: { output: { resolution: 360, fps: 30 }, edits: { cuts: [{ startMs: 1000, endMs: 1500 }, { startMs: 3000, endMs: 4200 }, { startMs: 9000, endMs: 9600 }], speed: [{ startMs: 5000, endMs: 6000, rate: 2 }] } } },
    {
      name: "slides+brand+camera+annotations",
      project: {
        output: { resolution: 360, fps: 30 },
        edits: { cuts: [{ startMs: 2000, endMs: 2600 }] },
        slides: [{ id: "s1", atMs: 4000, durationMs: 1500, title: "Hello", subtitle: "World", background: "#11131a", textColor: "#ffffff", accent: "@primary", fadeMs: 250, titleSize: 84, subtitleSize: 40 }],
        brand: { enabled: true, intro: { enabled: true, title: "Intro", subtitle: "", durationMs: 1200, logo: false }, outro: { enabled: true, title: "Bye", subtitle: "", durationMs: 1000, logo: false } },
        camera: { enabled: true, layouts: [{ startMs: 6000, endMs: 8000, kind: "screen-only" }, { startMs: 9000, endMs: 10000, kind: "split" }] },
        annotations: [
          { id: "a1", kind: "rect", startMs: 1000, endMs: 3500, anchor: "screen", rect: { x: 300, y: 200, w: 300, h: 160 } },
          { id: "a2", kind: "text", role: "title", startMs: 5000, endMs: 7000, text: "Title text", rect: { x: 0.1, y: 0.08, w: 0.8, h: 0 } },
        ],
      },
    },
  ];
}

export function planHash(project: unknown): string {
  const plan = buildRenderPlan({ meta: { ...META, camera: { width: 640, height: 480 } }, events: demoSession(), project: resolveProject(project) });
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
