import { describe, expect, it } from "vitest";
import {
  buildRenderPlan,
  defaultProject,
  ease3d,
  IDENTITY_POSE,
  motion3dAt,
  motion3dFrame,
  MOTION3D_TEMPLATES,
  project3d,
  quadArea,
  resolveProject,
  segmentFromTemplate,
  segmentPoseAt,
  templateFromSegment,
  cardOutline,
  ProjectValidationError,
  type Motion3DSegment,
  type ProjectConfig,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const seg = (o: Partial<Motion3DSegment>): Motion3DSegment => ({ id: "m", startMs: 1000, endMs: 2000, template: "custom", from: {}, to: {}, easing: "linear", perspective: 2000, ...o });

function plan(p: ProjectConfig, fps: 30 | 60 = 30) {
  return buildRenderPlan({ meta: META, events: demoSession(), project: { ...p, output: { ...p.output, fps } } });
}

describe("motion3d interpolation", () => {
  it("easings start at 0 and land exactly on 1; spring overshoots a little", () => {
    for (const e of ["spring", "ease-in-out", "ease-out", "ease-in", "linear"] as const) {
      expect(ease3d(e, 0)).toBe(0);
      expect(ease3d(e, 1)).toBe(1);
    }
    let peak = 0;
    for (let i = 0; i <= 200; i++) peak = Math.max(peak, ease3d("spring", i / 200));
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.08);
    expect(ease3d("ease-in-out", 0.5)).toBeCloseTo(0.5, 9);
  });

  it("linear from/to at start, middle, end; identity outside the segment", () => {
    const s = seg({ from: { rx: 25 }, to: { rx: 0, ry: 10 } });
    expect(motion3dAt([s], 999)).toBeNull();
    expect(motion3dAt([s], 1000)!.pose.rx).toBeCloseTo(25, 9);
    const mid = motion3dAt([s], 1500)!.pose;
    expect(mid.rx).toBeCloseTo(12.5, 9);
    expect(mid.ry).toBeCloseTo(5, 9);
    expect(motion3dAt([s], 2000)).toBeNull(); // no hold: back to flat after the end
  });

  it("custom angles beyond the templates are not clamped (-360..360 and more)", () => {
    const s = seg({ from: { rx: -360, ry: 270, rz: -315 }, to: { rx: 360, ry: -270, rz: 720 } });
    const a = motion3dAt([s], 1000)!.pose;
    expect([a.rx, a.ry, a.rz]).toEqual([-360, 270, -315]);
    const b = segmentPoseAt(s, 2000);
    expect([b.rx, b.ry, b.rz]).toEqual([360, -270, 720]);
    expect(motion3dAt([s], 1250)!.pose.rz).toBeCloseTo(-315 + 0.25 * 1035, 9);
    expect(() => resolveProject({ motion3d: [s] })).not.toThrow();
  });

  it("3-keyframe segment 0 -> 90 -> 180 passes through the middle key at its time", () => {
    const s = seg({ from: { ry: 0 }, to: { ry: 180 }, keys: [{ at: 0.5, pose: { ry: 90 } }] });
    expect(motion3dAt([s], 1250)!.pose.ry).toBeCloseTo(45, 9);
    expect(motion3dAt([s], 1500)!.pose.ry).toBeCloseTo(90, 9);
    expect(motion3dAt([s], 1750)!.pose.ry).toBeCloseTo(135, 9);
    // uneven key time and per-span easing
    const u = seg({ from: {}, to: { rx: 30 }, keys: [{ at: 0.25, pose: { rx: 60 }, easing: "ease-in" }] });
    expect(segmentPoseAt(u, 1125).rx).toBeCloseTo(60 * 0.125, 9); // ease-in(0.5) = 0.125
    expect(segmentPoseAt(u, 1250).rx).toBeCloseTo(60, 9);
    expect(segmentPoseAt(u, 1625).rx).toBeCloseTo(45, 9);
    // keys out of order are sorted
    const v = seg({ to: { rz: 40 }, keys: [{ at: 0.75, pose: { rz: 10 } }, { at: 0.25, pose: { rz: 30 } }] });
    expect(segmentPoseAt(v, 1250).rz).toBeCloseTo(30, 9);
    expect(segmentPoseAt(v, 1750).rz).toBeCloseTo(10, 9);
  });

  it("4 keyframes on several axes", () => {
    const s = seg({ from: {}, to: { rx: 0, ry: 0 }, keys: [{ at: 1 / 3, pose: { rx: 20, ry: -40 } }, { at: 2 / 3, pose: { rx: -20, ry: 40, tz: 100 } }] });
    const p = segmentPoseAt(s, 1000 + 2000 / 3);
    expect(p.rx).toBeCloseTo(-20, 6);
    expect(p.ry).toBeCloseTo(40, 6);
    expect(p.tz).toBeCloseTo(100, 6);
  });

  it("hold keeps the final pose until the next segment starts", () => {
    const a = seg({ id: "a", from: {}, to: { rx: 25 }, hold: true });
    const b = seg({ id: "b", startMs: 4000, endMs: 5000, from: { rx: 25 }, to: {} });
    expect(motion3dAt([a, b], 3000)!.pose.rx).toBe(25);
    expect(motion3dAt([a, b], 3999)!.seg).toBe("a");
    expect(motion3dAt([a, b], 4500)!.pose.rx).toBeCloseTo(12.5, 9);
    expect(motion3dAt([a, b], 6000)).toBeNull();
  });

  it("blendMs eases in from flat and out again; loop drifts on an ellipse", () => {
    const iso = seg({ from: { rx: 30, rz: -30 }, to: { rx: 30, rz: -30 }, blendMs: 200 });
    expect(motion3dAt([iso], 1000)).toBeNull();
    expect(motion3dAt([iso], 1100)!.pose.rx).toBeCloseTo(15, 6);
    expect(motion3dAt([iso], 1500)!.pose.rx).toBeCloseTo(30, 9);
    expect(motion3dAt([iso], 1900)!.pose.rx).toBeCloseTo(15, 6);
    const fl = seg({ endMs: 9000, from: { rx: 5, ry: -6 }, to: { rx: -5, ry: 6 }, easing: "loop", periodMs: 4000 });
    for (const t of [1000, 2000, 3000, 4500]) {
      const p = segmentPoseAt(fl, t);
      expect((p.rx / 5) ** 2 + (p.ry / 6) ** 2).toBeCloseTo(1, 9);
    }
  });

  it("the latest-starting overlapping segment wins", () => {
    const a = seg({ id: "a", startMs: 0, endMs: 5000, from: { rx: 10 }, to: { rx: 10 } });
    const b = seg({ id: "b", startMs: 2000, endMs: 3000, from: { ry: 20 }, to: { ry: 20 } });
    expect(motion3dAt([a, b], 2500)!.seg).toBe("b");
    expect(motion3dAt([b, a], 2500)!.seg).toBe("b");
    expect(motion3dAt([a, b], 3500)!.seg).toBe("a");
  });
});

describe("motion3d projection", () => {
  const out = { width: 1920, height: 1080 };
  const screen: [number, number, number, number] = [160, 90, 1600, 900];

  it("identity pose maps the card onto itself", () => {
    const m = motion3dFrame({ pose: { ...IDENTITY_POSE, rx: 1e-9 }, perspective: 2000, backface: "card", seg: "x" }, screen, out, 1);
    expect(m.quad).toEqual([160, 90, 1760, 90, 1760, 990, 160, 990]);
  });

  it("rx > 0 tilts the top edge away: top edge shorter than the bottom; hand-computed corner", () => {
    const m = motion3dFrame({ pose: { ...IDENTITY_POSE, rx: 30 }, perspective: 2000, backface: "card", seg: "x" }, screen, out, 1);
    const [tlx, tly, trx, , brx, bry, blx] = m.quad;
    expect(trx - tlx).toBeLessThan(brx - blx);
    // TL local (-800, -450): y' = -450 cos30, z' = -450 sin30 = -225, k = 2000/2225
    const k = 2000 / 2225;
    expect(tlx).toBeCloseTo(960 - 800 * k, 1);
    expect(tly).toBeCloseTo(540 - 450 * Math.cos(Math.PI / 6) * k, 1);
    // BL: z' = +225 (toward the eye), k = 2000/1775
    expect(bry).toBeCloseTo(540 + 450 * Math.cos(Math.PI / 6) * (2000 / 1775), 1);
    expect(m.face).toBe("front");
  });

  it("ry 180 shows the back with backface card, the front again (relabelled) with backface front", () => {
    const back = motion3dFrame({ pose: { ...IDENTITY_POSE, ry: 180 }, perspective: 2000, backface: "card", seg: "x" }, screen, out, 1);
    expect(back.face).toBe("back");
    expect(quadArea(back.quad)).toBeLessThan(0);
    const fr = motion3dFrame({ pose: { ...IDENTITY_POSE, ry: 180 }, perspective: 2000, backface: "front", seg: "x" }, screen, out, 1);
    expect(fr.face).toBe("front");
    expect(fr.mirrored).toBe("x");
    expect(quadArea(fr.quad)).toBeGreaterThan(0);
    // ry 180 + front = ry 0: the card reads exactly as unrotated
    for (let i = 0; i < 8; i++) expect(fr.quad[i]).toBeCloseTo([160, 90, 1760, 90, 1760, 990, 160, 990][i]!, 6);
    const fy = motion3dFrame({ pose: { ...IDENTITY_POSE, rx: 150 }, perspective: 2000, backface: "front", seg: "x" }, screen, out, 1);
    expect(fy.mirrored).toBe("y");
    expect(fy.quad[1]).toBeLessThan(fy.quad[7]); // top still above bottom
  });

  it("tx/ty scale with the output, tz and perspective with resolution", () => {
    const m = motion3dFrame({ pose: { ...IDENTITY_POSE, tx: 0.1, ty: -0.05 }, perspective: 2000, backface: "card", seg: "x" }, screen, out, 1);
    expect(m.quad[0]).toBeCloseTo(160 + 192, 6);
    expect(m.quad[1]).toBeCloseTo(90 - 54, 6);
    const half = motion3dFrame({ pose: { ...IDENTITY_POSE, tz: 200 }, perspective: 2000, backface: "card", seg: "x" }, [80, 45, 800, 450], { width: 960, height: 540 }, 0.5);
    const full = motion3dFrame({ pose: { ...IDENTITY_POSE, tz: 200 }, perspective: 2000, backface: "card", seg: "x" }, screen, out, 1);
    for (let i = 0; i < 8; i++) expect(half.quad[i]! * 2).toBeCloseTo(full.quad[i]!, 1);
  });

  it("projected outline follows the tilt and closes around the quad", () => {
    const m = motion3dFrame({ pose: { ...IDENTITY_POSE, ry: 25 }, perspective: 2000, backface: "card", seg: "x" }, screen, out, 1);
    const pts = cardOutline(m, 160, 90, 1600, 900, 14);
    expect(pts.length).toBe(24);
    const xs = pts.map((p) => p[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(Math.min(m.quad[0], m.quad[6]) - 0.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(Math.max(m.quad[2], m.quad[4]) + 0.01);
    const p = project3d(m, 960, 540);
    expect(p[0]).toBeCloseTo(960, 6);
  });
});

describe("motion3d in the render plan", () => {
  it("defaults unchanged: no motion3d -> no m3d field, plan identical to a project without the key", () => {
    const p = defaultProject();
    expect(p.motion3d).toEqual([]);
    const a = plan(p);
    expect(a.frames.every((f) => !("m3d" in f))).toBe(true);
    const legacy = { ...p } as Partial<ProjectConfig>;
    delete legacy.motion3d;
    const b = plan(resolveProject(legacy));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("frames inside a segment carry m3d; flat frames do not", () => {
    const p = { ...defaultProject(), motion3d: [seg({ from: { rx: 30 }, to: {}, easing: "ease-out" })] };
    const pl = plan(p);
    const at = (ms: number) => pl.frames[Math.round((ms / 1000) * 30)]!;
    expect(at(500).m3d).toBeUndefined();
    expect(at(1000).m3d!.pose[0]).toBeCloseTo(30, 3);
    expect(at(1500).m3d!.pose[0]).toBeGreaterThan(0);
    expect(at(2500).m3d).toBeUndefined();
  });

  it("composes with 2D zoom: the camera inside the card is untouched by motion3d", () => {
    const base = defaultProject();
    const zoomed = { ...base, zoom: { ...base.zoom, auto: false, segments: [{ id: "z", startMs: 500, endMs: 3000, scale: 2, focus: { x: 400, y: 300 }, style: "classic" as const, auto: false }] } };
    const a = plan(zoomed);
    const b = plan({ ...zoomed, motion3d: [seg({ from: { ry: 35 }, to: {} })] });
    for (let i = 0; i < a.frames.length; i++) {
      expect(b.frames[i]!.cam).toEqual(a.frames[i]!.cam);
      expect(b.frames[i]!.layout).toEqual(a.frames[i]!.layout);
    }
    const f = b.frames[Math.round(1.2 * 30)]!;
    expect(f.cam[2]).toBeGreaterThan(1.2); // zoomed inside...
    expect(f.m3d!.pose[1]).toBeGreaterThan(0); // ...while swinging
  });

  it("respects cuts and speed retiming like zoom (source time)", () => {
    const base = defaultProject();
    const s = seg({ startMs: 2000, endMs: 4000, from: { rx: 40 }, to: { rx: 0 } });
    // a 1 s cut before the segment shifts it 1 s earlier on the output clock
    const cut = plan({ ...base, motion3d: [s], edits: { ...base.edits, cuts: [{ startMs: 0, endMs: 1000 }] } });
    const f1 = cut.frames.find((f) => f.m3d);
    expect(f1!.t).toBeCloseTo(1000, 0);
    expect(f1!.src).toBeCloseTo(2000, 0);
    // 2x speed across the segment: 2 s of source plays in 1 s of output, mid-pose at src 3000
    const fast = plan({ ...base, motion3d: [s], edits: { ...base.edits, speed: [{ startMs: 2000, endMs: 4000, rate: 2 }] } });
    const with3d = fast.frames.filter((f) => f.m3d);
    expect(with3d.length).toBeGreaterThanOrEqual(29);
    expect(with3d.length).toBeLessThanOrEqual(31);
    const mid = fast.frames.find((f) => Math.abs(f.src - 3000) < 1)!;
    expect(mid.m3d!.pose[0]).toBeCloseTo(20, 1);
    // a cut covering the start skips into the animation
    const skip = plan({ ...base, motion3d: [s], edits: { ...base.edits, cuts: [{ startMs: 1500, endMs: 3000 }] } });
    const g = skip.frames.find((f) => f.m3d)!;
    expect(g.src).toBeCloseTo(3000, 0);
    expect(g.m3d!.pose[0]).toBeCloseTo(20, 1);
  });

  it("validation rejects bad segments, accepts any finite angle", () => {
    expect(() => resolveProject({ motion3d: [seg({ easing: "bounce" as never })] })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ motion3d: [seg({ endMs: 500 })] })).toThrow(/ends before/);
    expect(() => resolveProject({ motion3d: [seg({ perspective: 10 })] })).toThrow(/perspective/);
    expect(() => resolveProject({ motion3d: [seg({ to: { scale: 0 } })] })).toThrow(/scale/);
    expect(() => resolveProject({ motion3d: [seg({ keys: [{ at: 1.5, pose: {} }] })] })).toThrow(/key at/);
    expect(() => resolveProject({ motion3d: [seg({ from: { rx: Number.NaN } })] })).toThrow(/number/);
    expect(() => resolveProject({ motion3d: [seg({ from: { rx: 1080, ry: -720 } })] })).not.toThrow();
  });
});

describe("motion3d templates", () => {
  it("at least 10 animated templates plus Custom, unique ids, every one valid", () => {
    const ids = MOTION3D_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("custom");
    expect(ids.length - 1).toBeGreaterThanOrEqual(10);
    const segs = MOTION3D_TEMPLATES.map((t, i) => segmentFromTemplate(t, 1000 * i, `s${i}`));
    expect(() => resolveProject({ motion3d: segs })).not.toThrow();
  });

  it("Custom starts at identity", () => {
    const c = segmentFromTemplate(MOTION3D_TEMPLATES.find((t) => t.id === "custom")!, 0, "c");
    expect(motion3dAt([c], 500)).toBeNull();
  });

  it("every non-custom template moves the card somewhere inside its duration", () => {
    for (const t of MOTION3D_TEMPLATES.filter((x) => x.id !== "custom")) {
      const s = segmentFromTemplate(t, 0, "s");
      const moved = [0.1, 0.3, 0.5].some((u) => motion3dAt([s], u * t.durationMs) !== null);
      expect(moved, t.id).toBe(true);
    }
  });

  it("templates that end flat land on identity; the flip ends reading correctly", () => {
    for (const id of ["tilt-in", "swing-left", "swing-right", "perspective-reveal", "roll", "push-in", "dolly-up", "flip-reveal"]) {
      const t = MOTION3D_TEMPLATES.find((x) => x.id === id)!;
      const s = segmentFromTemplate(t, 0, "s");
      const p = segmentPoseAt(s, t.durationMs);
      expect(Math.abs(p.rx) + Math.abs(p.ry) + Math.abs(p.rz) + Math.abs(p.tz), id).toBeLessThan(1e-9);
    }
    const flip = segmentFromTemplate(MOTION3D_TEMPLATES.find((x) => x.id === "flip")!, 0, "f");
    const screen: [number, number, number, number] = [160, 90, 1600, 900];
    for (let ms = 0; ms < 1400; ms += 50) {
      const st = motion3dAt([flip], ms);
      if (st) expect(motion3dFrame(st, screen, { width: 1920, height: 1080 }, 1).face).toBe("front");
    }
  });

  it("save as template round-trips a custom multi-key segment, edited values kept", () => {
    const s = seg({ startMs: 500, endMs: 2500, from: { rx: 0 }, to: { ry: 180 }, keys: [{ at: 0.5, pose: { ry: 90, rx: -15 } }], easing: "spring", backface: "front", perspective: 1500 });
    const t = templateFromSegment(s, "my-flip", "My flip");
    expect(t.user).toBe(true);
    const back = segmentFromTemplate(t, 7000, "n");
    expect(back.template).toBe("user:my-flip");
    expect(back.endMs - back.startMs).toBe(2000);
    expect(back.keys).toEqual(s.keys);
    expect(segmentPoseAt(back, 8000)).toEqual(segmentPoseAt(s, 1500));
    // editing the template copy does not touch the source segment
    back.keys![0]!.pose.ry = 45;
    expect(s.keys![0]!.pose.ry).toBe(90);
  });
});
