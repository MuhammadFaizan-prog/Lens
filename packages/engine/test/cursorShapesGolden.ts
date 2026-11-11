/**
 * Projects whose plans must not change with demand #12 (cursor types): no cursor-type events at all,
 * logged cursor-shape events (the hard swap they always had), a fixed project cursor shape, cursor
 * overrides without a shape. Hashes computed from main 7d1a5db (before this change) and asserted in
 * cursorShapes.test.ts.
 */
import { createHash } from "node:crypto";
import { buildRenderPlan, resolveProject } from "../src/index.js";
import type { InputEvent } from "../src/index.js";
import { META, demoSession } from "./fixtures.js";

const LEGACY_SHAPES: InputEvent[] = [
  { t: 1000, type: "cursor-shape", shape: "pointer" },
  { t: 2500, type: "cursor-shape", shape: "text" },
  { t: 4000, type: "cursor-shape", shape: "arrow" },
  { t: 7000, type: "cursor-shape", shape: "crosshair" },
];

export function goldenCases(): Array<{ name: string; project: unknown; events: InputEvent[] }> {
  const base = { output: { resolution: 360, fps: 30 }, cursor: { hideWhenIdle: false } };
  return [
    { name: "no types", project: base, events: demoSession() },
    { name: "logged types (legacy)", project: base, events: [...demoSession(), ...LEGACY_SHAPES].sort((a, b) => a.t - b.t) },
    { name: "fixed shape", project: { ...base, cursor: { hideWhenIdle: false, shape: "pointer" } }, events: demoSession() },
    {
      name: "overrides without shape",
      project: { ...base, overrides: [{ startMs: 2000, endMs: 3000, cursor: { size: 3 } }, { startMs: 5000, endMs: 6000, cursor: { hidden: true } }, { startMs: 8000, endMs: 9000, volume: 0.5 }] },
      events: demoSession(),
    },
  ];
}

export function planHashOf(project: unknown, events: InputEvent[]): string {
  const plan = buildRenderPlan({ meta: META, events, project: resolveProject(project) });
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
