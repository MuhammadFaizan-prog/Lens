import { describe, expect, it } from "vitest";
import { applyWordEdits, buildRenderPlan, cueBlock, fillScreenRect, mergeCaptionCues, mergeCues, parseSubtitles, resolveProject, splitCue, toSrt, watermarkRect, defaultBrand, layoutFor, defaultProject } from "../src/index.js";
import type { InputEvent } from "../src/index.js";

const meta = { width: 1280, height: 720, fps: 30, durationMs: 4000, pixelRatio: 1 };
const moves = (x: number, y: number): InputEvent[] => Array.from({ length: 40 }, (_, i) => ({ t: i * 100, type: "move", x, y }) as InputEvent);

describe("hand-written captions (Windows bug #15)", () => {
  it("cues work with no transcript, replace overlapping transcript blocks and burn at their times", () => {
    const p = resolveProject({ captions: { enabled: true, cues: [{ id: "a", startMs: 500, endMs: 1500, text: "Hello there" }, { id: "b", startMs: 2000, endMs: 3000, text: "Second line" }] }, output: { fps: 30, resolution: 360 } });
    const plan = buildRenderPlan({ meta, events: moves(600, 300), project: p });
    const at = (ms: number) => plan.frames[Math.round((ms * 30) / 1000)]!.caption?.text ?? null;
    expect(at(400)).toBeNull();
    expect(at(1000)).toBe("Hello there");
    expect(at(1700)).toBeNull();
    expect(at(2500)).toBe("Second line");
    expect(plan.frames[30]!.caption!.active).toBe(-1); // no fake word highlight
    expect(plan.subtitles.map((s) => [s.startMs, s.endMs, s.text])).toEqual([[500, 1500, "Hello there"], [2000, 3000, "Second line"]]);
    expect(toSrt(plan.subtitles)).toContain("00:00:00,500 --> 00:00:01,500");
    const words = [{ text: "x", startMs: 1000, endMs: 1200 }, { text: "y", startMs: 3500, endMs: 3700 }];
    const blocks = mergeCaptionCues([{ startMs: 1000, endMs: 1200, text: "x", words: [words[0]!] }, { startMs: 3500, endMs: 3700, text: "y", words: [words[1]!] }], p.captions.cues);
    expect(blocks.map((b) => b.text)).toEqual(["Hello there", "Second line", "y"]);
  });
  it("splits, merges, edits words and parses SRT / VTT", () => {
    const c = { id: "c", startMs: 0, endMs: 2000, text: "one two three four" };
    const [a, b] = splitCue(c, 1000, ["c", "d"])!;
    expect([a.text, a.endMs, b.text, b.startMs]).toEqual(["one two", 1000, "three four", 1000]);
    expect(mergeCues(a, b)).toEqual(c);
    expect(cueBlock(c)!.words).toHaveLength(4);
    expect(applyWordEdits([{ text: "teh", startMs: 0, endMs: 1 }, { text: "um", startMs: 1, endMs: 2 }], { "0": "the", "1": "" }).map((w) => w.text)).toEqual(["the"]);
    let n = 0;
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nHi <i>you</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n";
    expect(parseSubtitles(srt, () => `s${n++}`)).toEqual([{ id: "s0", startMs: 1000, endMs: 2500, text: "Hi you" }, { id: "s1", startMs: 3000, endMs: 4000, text: "Bye" }]);
    const vtt = "WEBVTT\n\n00:01.200 --> 00:02.000 align:center\nHello\n";
    expect(parseSubtitles(vtt, () => "v")).toEqual([{ id: "v", startMs: 1200, endMs: 2000, text: "Hello" }]);
  });
});

describe("9:16 fill and follow (Windows bug #8)", () => {
  it("fill covers the output and centres the focus, clamped at the edges", () => {
    const view = { x0: 0, vw: 1280, y0: 0, vh: 720 };
    const r = fillScreenRect({ width: 1080, height: 1920 }, 16 / 9, view, { x: 900, y: 360 });
    expect(r.h).toBe(1920);
    expect(r.w).toBeCloseTo(1920 * 16 / 9, 6);
    expect(r.x + (900 / 1280) * r.w).toBeCloseTo(540, 6);
    const edge = fillScreenRect({ width: 1080, height: 1920 }, 16 / 9, view, { x: 1279, y: 360 });
    expect(edge.x + edge.w).toBeCloseTo(1080, 6);
  });
  it("Social Vertical follows the cursor; fit keeps the letterbox", () => {
    const fill = resolveProject({ output: { aspect: "9:16", resolution: 360, fps: 30, fit: "fill" }, zoom: { auto: false } });
    const plan = buildRenderPlan({ meta, events: moves(1100, 360), project: fill });
    const f = plan.frames[plan.frames.length - 1]!;
    const [sx, , sw, sh] = f.layout.screen;
    expect(sh).toBe(plan.output.height);
    expect(Math.abs(sx + (1100 / 1280) * sw - plan.output.width / 2)).toBeLessThan(plan.output.width * 0.3);
    const fit = buildRenderPlan({ meta, events: moves(1100, 360), project: resolveProject({ output: { aspect: "9:16", resolution: 360, fps: 30 }, zoom: { auto: false } }) });
    expect(fit.frames[0]!.layout.screen[2]).toBeLessThanOrEqual(fit.output.width);
  });
  it("a fixed zoom target is the crop centre in fill mode", () => {
    const p = resolveProject({ output: { aspect: "9:16", resolution: 360, fps: 30, fit: "fill" }, zoom: { auto: false, segments: [{ id: "z", startMs: 0, endMs: 4000, scale: 2, focus: { x: 900, y: 250 }, style: "classic", auto: false }] } });
    const plan = buildRenderPlan({ meta, events: moves(200, 600), project: p });
    const f = plan.frames[plan.frames.length - 1]!;
    const [cx, cy, s] = f.cam;
    expect([Math.round(cx), Math.round(cy), s]).toEqual([900, 250, 2]);
    const [sx, sy, sw, sh] = f.layout.screen;
    const vw = 1280 / s, vh = 720 / s;
    expect(sx + ((900 - (cx - vw / 2)) / vw) * sw).toBeCloseTo(plan.output.width / 2, 0);
    expect(sy + ((250 - (cy - vh / 2)) / vh) * sh).toBeCloseTo(plan.output.height / 2, 0);
  });
});

describe("free overlay positions (Windows bug #12)", () => {
  it("logo and webcam positions are output fractions, clamped inside the frame", () => {
    const logo = { ...defaultBrand().logo, path: "l.png", aspect: 2, position: { x: 0.5, y: 0.5 } };
    expect(watermarkRect(logo, 1920, 1080)).toMatchObject({ x: 960 - 96, y: 540 - 48, w: 192, h: 96 });
    expect(watermarkRect({ ...logo, position: { x: 1, y: 1 } }, 1920, 1080)).toMatchObject({ x: 1920 - 192, y: 1080 - 96 });
    const cfg = { ...defaultProject(), camera: { ...defaultProject().camera, enabled: true, position: { x: 0.25, y: 0.5 } } };
    const l = layoutFor("camera-overlay", { width: 1920, height: 1080 }, 16 / 9, cfg);
    expect(l.camera!.x + l.camera!.w / 2).toBeCloseTo(480, 6);
    expect(l.camera!.y + l.camera!.h / 2).toBeCloseTo(540, 6);
  });
});

