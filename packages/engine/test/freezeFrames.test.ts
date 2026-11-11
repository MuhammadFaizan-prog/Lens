/**
 * Freeze frames, image slides and brand title cards (demand #20).
 * Bounds were written before the first run:
 *  - a project without freezes / new slide kinds plans byte-identically to before (no vid, same JSON);
 *  - inside a hold freeze every frame's screen time (videoTime) equals the freeze start, src keeps
 *    running at 1 ms per ms, the cursor keeps moving (live) or is null with no clicks (hide);
 *    output length and the audio pieces are unchanged by a hold;
 *  - a freeze pause inserts exactly durationMs of output, holds src, draws no slide, shifts the audio;
 *  - image slides: contain keeps the picture's aspect within 1 px inside a 6 % margin; cover fills
 *    the frame on both axes; a title moves the picture up and adds a text op under it;
 *  - brand: a slide with brand: true takes the theme backdrop, the brand font and primary accent, and
 *    follows a later brand colour change without editing the slide.
 */
import { describe, expect, it } from "vitest";
import {
  buildRenderPlan,
  defaultFreezeSlide,
  defaultImageSlide,
  freezeAt,
  normalizeSlide,
  resolveProject,
  slideFrame,
  videoTime,
  type ProjectConfig,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const base = (over: Record<string, unknown> = {}): ProjectConfig =>
  resolveProject({ output: { aspect: "16:9", resolution: 1080, fps: 30 }, zoom: { auto: false }, audio: { tracks: [{ id: "mic", path: "mic.wav", kind: "mic", volume: 1 }] }, ...over });

const plan = (p: ProjectConfig) => buildRenderPlan({ meta: META, events: demoSession(), project: p });

describe("hold freeze", () => {
  it("projects without freezes plan exactly as before", () => {
    const a = plan(base());
    const b = plan(base({ freezes: [] }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.frames.some((f) => "vid" in f)).toBe(false);
  });

  it("holds the screen picture on the start frame while src, cursor and audio keep running", () => {
    const p0 = base({ cursor: { visible: true } });
    const p1 = base({ cursor: { visible: true }, freezes: [{ id: "f1", startMs: 4900, endMs: 6900 }] });
    const a = plan(p0);
    const b = plan(p1);
    expect(b.output.frames).toBe(a.output.frames);
    expect(JSON.stringify(b.audio)).toBe(JSON.stringify(a.audio));
    const inside = b.frames.filter((f) => f.src >= 4900 && f.src < 6900);
    expect(inside.length).toBe(60);
    for (const f of inside) expect(videoTime(f)).toBe(4900);
    // src keeps advancing frame by frame
    for (let i = 1; i < inside.length; i++) expect(inside[i]!.src - inside[i - 1]!.src).toBeCloseTo(1000 / 30, 1);
    // live cursor: the demo session moves 420,360 -> 1600,900 over 5000-5700 ms inside the hold
    const xs = inside.map((f) => f.cur?.[0] ?? NaN);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(800);
    // click at 6000 still shows (cursor live)
    expect(inside.some((f) => f.clicks.length > 0)).toBe(true);
    // outside the freeze nothing changes
    const outside = b.frames.filter((f) => f.src < 4900 || f.src >= 6900);
    for (const f of outside) expect(f.vid).toBeUndefined();
    expect(JSON.stringify(outside)).toBe(JSON.stringify(a.frames.filter((f) => f.src < 4900 || f.src >= 6900)));
  });

  it("cursor hide removes the cursor and its clicks during the hold only", () => {
    const b = plan(base({ cursor: { visible: true }, freezes: [{ id: "f1", startMs: 4900, endMs: 6900, cursor: "hide" }] }));
    const inside = b.frames.filter((f) => f.src >= 4900 && f.src < 6900);
    expect(inside.every((f) => f.cur === null && f.clicks.length === 0)).toBe(true);
    expect(b.frames.filter((f) => f.src < 4900).some((f) => f.cur !== null)).toBe(true);
  });

  it("masks follow the held picture, not src", () => {
    const masks = [{ id: "m", kind: "blur", startMs: 0, endMs: 5000, rect: { x: 100, y: 100, w: 200, h: 100 }, feather: 0, strength: 10 }];
    const b = plan(base({ masks, freezes: [{ id: "f1", startMs: 4000, endMs: 7000 }] }));
    const f = b.frames.find((x) => x.src >= 6000)!;
    expect(f.masks.length).toBe(1); // the blur over the held 4000 ms picture stays
  });

  it("overlapping freezes never step the held frame backwards", () => {
    const fz = [
      { id: "a", startMs: 1000, endMs: 4000, cursor: "live" as const },
      { id: "b", startMs: 2000, endMs: 3000, cursor: "live" as const },
    ];
    expect(freezeAt(fz, 2500)?.id).toBe("a");
    const b = plan(base({ freezes: fz }));
    let last = -1;
    for (const f of b.frames) {
      expect(videoTime(f)).toBeGreaterThanOrEqual(last - 1e-6);
      last = videoTime(f);
    }
  });

  it("validation", () => {
    expect(() => resolveProject({ freezes: [{ id: "x", startMs: 2000, endMs: 1000 }] })).toThrow(/startMs < endMs/);
    expect(() => resolveProject({ freezes: [{ id: "x", startMs: 0, endMs: 1000, cursor: "spin" }] })).toThrow(/cursor/);
    expect(resolveProject({ freezes: [{ id: "x", startMs: 0, endMs: 1000 }] }).freezes![0]!.cursor).toBe("live");
  });
});

describe("freeze pause (slide kind freeze)", () => {
  it("inserts durationMs, holds src, draws no slide, shifts audio", () => {
    const a = plan(base());
    const b = plan(base({ slides: [defaultFreezeSlide("p", 3000, 1500)] }));
    expect(b.output.durationMs - a.output.durationMs).toBeCloseTo(1500, 0);
    const span = b.slides[0]!;
    expect([span.outStart, span.outEnd]).toEqual([3000, 4500]);
    const inside = b.frames.filter((f) => f.t >= 3000 && f.t < 4500);
    expect(inside.length).toBe(45);
    expect(inside.every((f) => f.src === 3000 && f.slide === null)).toBe(true);
    // audio: source 3000 plays at output 4500
    const pcs = b.audio!.pieces;
    expect(pcs.some((p) => p.outStart < 4500 - 1e-6 && p.outEnd > 3000 + 1e-6)).toBe(false);
    expect(pcs.find((p) => p.srcStart === 3000)!.outStart).toBeCloseTo(4500, 3);
  });
});

describe("image slides", () => {
  it("contain keeps the aspect inside the margin; a title moves it up", () => {
    const sl = defaultImageSlide("i", 0, "media/pic.png", 4 / 3);
    const f = slideFrame(sl, 1000, 1920, 1080, 1);
    const im = f.ops.find((o) => o.op === "image") as Extract<(typeof f.ops)[number], { op: "image" }>;
    expect(Math.abs(im.w / im.h - 4 / 3)).toBeLessThan(1 / im.h + 1e-9);
    const m = Math.round(1080 * 0.06);
    expect(im.y).toBeGreaterThanOrEqual(m - 1);
    expect(im.y + im.h).toBeLessThanOrEqual(1080 - m + 1);
    expect(Math.abs(im.x + im.w / 2 - 960)).toBeLessThanOrEqual(1);
    expect(f.ops.some((o) => o.op === "text")).toBe(false);
    const t = slideFrame({ ...sl, title: "Architecture" }, 1000, 1920, 1080, 1);
    const im2 = t.ops.find((o) => o.op === "image") as typeof im;
    const tx = t.ops.find((o) => o.op === "text") as Extract<(typeof f.ops)[number], { op: "text" }>;
    expect(im2.h).toBeLessThan(im.h);
    expect(tx.y).toBeGreaterThan(im2.y + im2.h);
  });

  it("cover fills the frame", () => {
    const f = slideFrame({ ...defaultImageSlide("i", 0, "media/pic.png", 1), image: { path: "media/pic.png", aspect: 1, fit: "cover" } }, 1000, 1920, 1080, 1);
    const im = f.ops.find((o) => o.op === "image") as Extract<(typeof f.ops)[number], { op: "image" }>;
    expect(im.x).toBeLessThanOrEqual(0);
    expect(im.y).toBeLessThanOrEqual(0);
    expect(im.x + im.w).toBeGreaterThanOrEqual(1920);
    expect(im.y + im.h).toBeGreaterThanOrEqual(1080);
  });

  it("image slides reach the plan with their image op; old slides normalise to text", () => {
    const b = plan(base({ slides: [defaultImageSlide("i", 2000, "media/pic.png", 16 / 9)] }));
    const f = b.frames.find((x) => x.slide)!;
    expect(f.slide!.ops.some((o) => o.op === "image" && o.path === "media/pic.png")).toBe(true);
    expect(normalizeSlide({ id: "old", atMs: 0 }).kind).toBeUndefined();
    expect(() => resolveProject({ slides: [{ id: "s", atMs: 0, durationMs: 1000, kind: "video" }] })).toThrow(/kind/);
  });
});

describe("brand title cards", () => {
  it("brand: true follows the brand kit live", () => {
    const brand = (primary: string) => ({ brand: { enabled: true, name: "Acme", colors: { primary, accent: "#ffffff", background: { mode: "derived", colors: [] } }, font: "Inter" } });
    const sl = { id: "t", atMs: 2000, durationMs: 2000, title: "Chapter 1", brand: true };
    const p1 = plan(base({ ...brand("#2255ee"), slides: [sl] }));
    const p2 = plan(base({ ...brand("#ee2255"), slides: [sl] }));
    const s1 = p1.frames.find((f) => f.slide?.id === "t")!.slide!;
    const s2 = p2.frames.find((f) => f.slide?.id === "t")!.slide!;
    expect(s1.ops[0]!.op).toBe("background");
    const accent = (s: typeof s1) => (s.ops.filter((o) => o.op === "fill").pop() as { color: string }).color.toLowerCase();
    expect(accent(s1)).toBe("#2255ee");
    expect(accent(s2)).toBe("#ee2255");
    const text = s1.ops.find((o) => o.op === "text") as { font?: string };
    expect(text.font).toBe("Inter");
    // the same slide without brand keeps its own solid look
    const p3 = plan(base({ ...brand("#2255ee"), slides: [{ ...sl, brand: undefined }] }));
    expect(p3.frames.find((f) => f.slide?.id === "t")!.slide!.ops[0]!.op).toBe("fill");
  });
});
