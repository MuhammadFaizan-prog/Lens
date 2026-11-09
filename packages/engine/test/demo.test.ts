/**
 * Steps export (demand #7): which steps, in what order, with which hotspot and tooltip, and the
 * still-frame project / plan the exporter renders. Bounds written before the first run.
 */
import { describe, expect, it } from "vitest";
import {
  defaultDemo,
  demoStillFrames,
  demoStillProject,
  demoSteps,
  demoTitle,
  ProjectValidationError,
  resolveProject,
  reviewSteps,
  setDemoHotspot,
  stepsExportInput,
  type StepDraft,
} from "../src/index.js";
import { click, demoSession, META } from "./fixtures.js";

const draft = (id: string, clickMs: number, x: number, y: number, label: string, state: StepDraft["state"] = "accepted"): StepDraft => ({
  id, clickMs, x, y, label, target: label.split(" ").slice(1).join(" "), verb: "Click", confidence: 0.9, state,
});

function project(extra: Record<string, unknown> = {}) {
  return resolveProject({
    stepLabels: { drafts: [draft("b", 3000, 500, 300, "Click Save"), draft("a", 1000, 200, 100, "Open Settings"), draft("c", 2000, 50, 50, "Click Nope", "dismissed"), draft("d", 4000, 900, 600, "Click Export", "pending")], generatedAt: null },
    ...extra,
  });
}

describe("demo steps", () => {
  it("accepted drafts only, in click order, numbered 1..n, still before the click", () => {
    const s = demoSteps(project());
    expect(s.map((x) => [x.n, x.stepId, x.label])).toEqual([[1, "a", "Open Settings"], [2, "b", "Click Save"]]);
    expect(s[0]!.stillMs).toBe(1000 - defaultDemo().leadMs);
    expect(s[0]!.box).toBeNull();
  });

  it("hotspot editor: move and retitle one step; clear goes back; the video's labels do not change", () => {
    let p = project();
    p = reviewSteps(p, null, "accepted");
    p = setDemoHotspot(p, "b", { x: 520, y: 310, tooltip: "Save your work" });
    let s = demoSteps(p).find((x) => x.stepId === "b")!;
    expect([s.x, s.y, s.clickX, s.clickY, s.label]).toEqual([520, 310, 500, 300, "Save your work"]);
    expect(p.annotations.find((a) => a.stepId === "b")!.text).toBe("Click Save");
    p = setDemoHotspot(p, "b", { tooltip: undefined, x: undefined, y: 305 });
    s = demoSteps(p).find((x) => x.stepId === "b")!;
    expect([s.x, s.y, s.label]).toEqual([520, 305, "Save your work"]);
    p = setDemoHotspot(p, "b", null);
    expect(p.demo.hotspots).toEqual([]);
    expect(() => setDemoHotspot(p, "zz", { x: 1 })).toThrow();
  });

  it("title falls back to the brand name, then a default", () => {
    expect(demoTitle(project())).toBe("Interactive demo");
    expect(demoTitle(project({ brand: { enabled: true, name: "Acme" } }))).toBe("Acme");
    expect(demoTitle(project({ brand: { enabled: true, name: "Acme" }, demo: { title: "Tour" } }))).toBe("Tour");
  });

  it("validation: CTA links must be http(s) or mailto; ranges", () => {
    expect(() => project({ demo: { cta: { url: "javascript:alert(1)" } } })).toThrow(ProjectValidationError);
    expect(() => project({ demo: { cta: { url: "https://x.example/a b" } } })).toThrow(ProjectValidationError);
    expect(() => project({ demo: { maxWidth: 100 } })).toThrow(ProjectValidationError);
    expect(() => project({ demo: { zoom: "wide" } })).toThrow(ProjectValidationError);
    expect(project({ demo: { cta: { url: "mailto:sales@example.com" } } }).demo.cta.url).toBe("mailto:sales@example.com");
  });
});

describe("still-frame project and plan", () => {
  it("keeps look, crop and masks; drops motion, cursor, captions, edits, slides, step badges", () => {
    let p = project({
      crop: { x: 10, y: 20, w: 1800, h: 1000 },
      masks: [{ id: "m", kind: "blur", rect: { x: 1, y: 2, w: 30, h: 40 }, startMs: 0, endMs: 5000, feather: 4, fadeMs: 0, strength: 8 }],
      edits: { cuts: [{ startMs: 500, endMs: 900 }] },
      captions: { enabled: true },
      slides: [{ id: "s", atMs: 1500, durationMs: 1000, title: "Hi" }],
      brand: { enabled: true, intro: { enabled: true } },
    });
    p = reviewSteps(p, null, "accepted");
    expect(p.annotations.some((a) => a.stepId)).toBe(true);
    const q = demoStillProject(p);
    expect(q.crop).toEqual(p.crop);
    expect(q.masks).toEqual(p.masks);
    expect(q.frame).toEqual(p.frame);
    expect(q.zoom.auto).toBe(false);
    expect(q.cursor.visible).toBe(false);
    expect(q.captions.enabled).toBe(false);
    expect(q.edits.cuts).toEqual([]);
    expect(q.slides).toEqual([]);
    expect(q.brand.intro.enabled).toBe(false);
    expect(q.annotations.some((a) => a.stepId)).toBe(false);
  });

  it("output time = source time, one plan frame per still, manifest steps point at them", () => {
    const events = [...demoSession(), ...click(200, 100, 1000), ...click(500, 300, 3000)];
    const p = reviewSteps(project({ edits: { cuts: [{ startMs: 100, endMs: 600 }] } }), null, "accepted");
    const { plan, manifest } = stepsExportInput({ meta: META, events, project: p });
    expect(manifest.steps.map((s) => s.stepId)).toEqual(["a", "c", "b", "d"]);
    expect(plan.frames.length).toBe(4);
    for (const s of manifest.steps) {
      const f = plan.frames[s.frame]!;
      expect(Math.abs(f.src - s.stillMs)).toBeLessThanOrEqual(1000 / plan.output.fps / 2 + 1e-6);
      expect(f.t).toBeCloseTo(f.src, 6);
      expect(f.cur).toBeNull();
      expect(f.caption).toBeNull();
    }
    expect(manifest.cta.url).toBe("");
    expect(demoStillFrames(demoSteps(p), 60, 100)).toEqual([55, 99, 99, 99]);
  });

  it("no accepted steps is an error", () => {
    const p = resolveProject({});
    expect(() => stepsExportInput({ meta: META, events: demoSession(), project: p })).toThrow(/no accepted steps/);
  });
});
