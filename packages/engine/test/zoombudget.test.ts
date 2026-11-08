import { describe, expect, it } from "vitest";
import { applyZoomBudget, applyZoomPreset, defaultProject, maxZoomsPerMinute, planAutoZoom, resolveProject, zoomPreset } from "../src/index.js";
import type { InputEvent, RecordingMeta, ZoomSegment } from "../src/types.js";
import { click } from "./fixtures.js";

const META: RecordingMeta = { width: 1920, height: 1080, fps: 30, durationMs: 90000, pixelRatio: 1 };

/** A busy session: a click every 3.2 s, alternating between far-apart corners so each is its own zoom. */
function busySession(): InputEvent[] {
  const ev: InputEvent[] = [];
  const spots: Array<[number, number]> = [[200, 200], [1700, 900], [1700, 200], [200, 900]];
  for (let i = 0; i < 27; i++) {
    const t = 500 + i * 3200;
    const [x, y] = spots[i % 4]!;
    ev.push({ t: t - 200, type: "move", x, y }, ...click(x, y, t));
  }
  // A double click burst at 40 s is worth more than a single click.
  ev.push(...click(1710, 905, 40100), ...click(1720, 910, 40300));
  return ev.sort((a, b) => a.t - b.t);
}

describe("zoom budget (calm camera)", () => {
  const ev = busySession();

  it("without a budget the busy session zooms far more than 4 times a minute", () => {
    const segs = planAutoZoom(ev, META, { ...defaultProject().zoom, mergeGapMs: 1000 });
    expect(maxZoomsPerMinute(segs)).toBeGreaterThan(8);
  });

  it("caps zoom starts per 60 s window and holds every zoom at least minHold", () => {
    const zoom = { ...defaultProject().zoom, mergeGapMs: 1000, budget: { enabled: true, maxPerMinute: 4, minHoldMs: 2500 } };
    const segs = planAutoZoom(ev, META, zoom);
    expect(segs.length).toBeGreaterThan(0);
    expect(maxZoomsPerMinute(segs)).toBeLessThanOrEqual(4);
    for (const s of segs) expect(s.endMs - s.startMs).toBeGreaterThanOrEqual(2500 - 1e-6);
    // ordered and non-overlapping
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.startMs).toBeGreaterThanOrEqual(segs[i - 1]!.endMs);
  });

  it("keeps the most valuable zoom inside a crowded minute", () => {
    const segs = planAutoZoom(ev, META, { ...defaultProject().zoom, mergeGapMs: 1000, budget: { enabled: true, maxPerMinute: 2, minHoldMs: 1000 } });
    // the burst with three clicks near (1710, 905) around 40 s survives
    expect(segs.some((s) => s.startMs <= 40100 && s.endMs >= 40300)).toBe(true);
  });

  it("merges zooms that the minimum hold makes overlap, keeping the wider scale", () => {
    const a: ZoomSegment = { id: "a", startMs: 0, endMs: 800, scale: 2, focus: "follow", style: "classic", auto: true };
    const b: ZoomSegment = { id: "b", startMs: 1500, endMs: 2200, scale: 1.5, focus: "follow", style: "classic", auto: true };
    const out = applyZoomBudget([a, b], [1, 1], { enabled: true, maxPerMinute: 10, minHoldMs: 2000 }, 10000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startMs: 0, endMs: 3500, scale: 1.5 });
  });

  it("is off by default, so default output is unchanged", () => {
    const p = defaultProject();
    expect(p.zoom.budget.enabled).toBe(false);
    expect(planAutoZoom(ev, META, p.zoom)).toEqual(planAutoZoom(ev, META, { ...p.zoom, budget: { ...p.zoom.budget, enabled: false, maxPerMinute: 1 } }));
  });
});

describe("zoom presets", () => {
  it("Default preset equals the engine defaults", () => {
    const d = defaultProject();
    const z = applyZoomPreset(d, "default").zoom;
    expect(z).toEqual(d.zoom);
  });

  it("Calm is slower, smaller and budgeted; Punchy is faster and bigger", () => {
    const calm = zoomPreset("calm");
    const def = zoomPreset("default");
    const punchy = zoomPreset("punchy");
    expect(calm.spring.stiffness).toBeLessThan(def.spring.stiffness);
    expect(punchy.spring.stiffness).toBeGreaterThan(def.spring.stiffness);
    expect(calm.defaultScale).toBeLessThan(def.defaultScale);
    expect(punchy.defaultScale).toBeGreaterThan(def.defaultScale);
    expect(calm.budget.enabled).toBe(true);
    const p = resolveProject(applyZoomPreset(defaultProject(), "calm"));
    expect(p.zoom.preset).toBe("calm");
  });

  it("Calm produces fewer zooms per minute than Punchy on the same session", () => {
    const ev = busySession();
    const calm = planAutoZoom(ev, META, applyZoomPreset(defaultProject(), "calm").zoom);
    const punchy = planAutoZoom(ev, META, applyZoomPreset(defaultProject(), "punchy").zoom);
    expect(maxZoomsPerMinute(calm)).toBeLessThanOrEqual(4);
    expect(maxZoomsPerMinute(calm)).toBeLessThan(maxZoomsPerMinute(punchy));
  });

  it("rejects an invalid budget", () => {
    expect(() => resolveProject({ zoom: { budget: { enabled: true, maxPerMinute: 0, minHoldMs: 100 } } })).toThrow(/maxPerMinute/);
  });
});
