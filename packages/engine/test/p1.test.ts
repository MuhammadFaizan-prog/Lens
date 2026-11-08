import { describe, expect, it } from "vitest";
import {
  activeWordIndex,
  audioPieces,
  buildCursorTrack,
  buildRenderPlan,
  buildTimeline,
  clickSoundTimes,
  defaultProject,
  masksAt,
  normalizeCrop,
  resolveProject,
  ProjectValidationError,
  volumeAt,
  wrapWords,
  type Word,
} from "../src/index.js";
import { META, demoSession, move, click } from "./fixtures.js";

const words: Word[] = [
  { text: "Lens", startMs: 500, endMs: 800 },
  { text: "turns", startMs: 850, endMs: 1100 },
  { text: "raw", startMs: 1150, endMs: 1400 },
  { text: "recordings", startMs: 1450, endMs: 2000 },
  { text: "into", startMs: 2050, endMs: 2200 },
  { text: "demos.", startMs: 2250, endMs: 2700 },
];

describe("audio plan (AUD-04/06, EDT-05)", () => {
  const project = resolveProject({
    output: { fps: 30 },
    edits: { cuts: [{ startMs: 2000, endMs: 3000 }], speed: [{ startMs: 4000, endMs: 6000, rate: 2 }] },
    audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }, { id: "sys", kind: "system", path: "sys.wav", offsetMs: 0, volume: 1, muted: true }] },
  });
  const plan = buildRenderPlan({ meta: META, events: demoSession(), project });

  it("pieces tile the output timeline and follow cuts and speed", () => {
    const a = plan.audio!;
    expect(a).not.toBeNull();
    expect(a.tracks.map((t) => t.id)).toEqual(["mic"]); // muted track dropped
    expect(a.pieces[0]!.outStart).toBe(0);
    for (let i = 1; i < a.pieces.length; i++) expect(a.pieces[i]!.outStart).toBeCloseTo(a.pieces[i - 1]!.outEnd, 9);
    expect(a.pieces[a.pieces.length - 1]!.outEnd).toBeCloseTo(plan.output.durationMs, 6);
    expect(a.pieces.some((p) => p.srcStart < 2500 && p.srcEnd > 2500)).toBe(false); // cut
    const fast = a.pieces.find((p) => p.srcStart === 4000)!;
    expect(fast.rate).toBe(2);
    expect(fast.outEnd - fast.outStart).toBeCloseTo(1000, 6);
    expect(plan.output.durationMs).toBeCloseTo(12000 - 1000 - 1000, 6);
  });

  it("is null when there is nothing to hear", () => {
    expect(buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ output: { fps: 30 } }) }).audio).toBeNull();
  });

  it("per-segment volume splits pieces and later overrides win", () => {
    const tl = buildTimeline(10000, [], [{ startMs: 6000, endMs: 8000, rate: 2 }]);
    const ov = [{ startMs: 1000, endMs: 7000, volume: 0.5 }, { startMs: 2000, endMs: 3000, volume: 0 }];
    expect(volumeAt(ov, 2500)).toBe(0);
    expect(volumeAt(ov, 1500)).toBe(0.5);
    expect(volumeAt(ov, 9000)).toBe(1);
    const ps = audioPieces(tl, ov);
    const at = (s: number) => ps.find((p) => s >= p.srcStart && s < p.srcEnd)!;
    expect(at(500).gain).toBe(1);
    expect(at(2500).gain).toBe(0);
    expect(at(6500).gain).toBe(0.5);
    expect(at(6500).rate).toBe(2);
    expect(at(7500).gain).toBe(1);
    expect(at(7500).outStart).toBeCloseTo(6000 + 500, 9);
  });

  it("click sounds land at the output time of each surviving click", () => {
    const tl = buildTimeline(10000, [{ startMs: 1000, endMs: 2000 }], [{ startMs: 5000, endMs: 7000, rate: 2 }]);
    expect(clickSoundTimes(tl, [500, 1500, 3000, 6000, 8000])).toEqual([500, 2000, 4500, 6000]);
    const p = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ output: { fps: 30 }, cursor: { clickSound: true, clickSoundVolume: 0.8 }, edits: { cuts: [{ startMs: 1000, endMs: 1200 }] } }) });
    expect(p.audio!.tracks).toEqual([]);
    expect(p.audio!.clickSound).toEqual({ enabled: true, volume: 0.8, times: [900, 1400, 5800] });
  });

  it("carries cleanup settings with -16 LUFS default", () => {
    expect(plan.audio!.loudness.targetLufs).toBe(-16);
    expect(plan.audio!.noiseReduction.enabled).toBe(false);
  });
});

describe("crop (LOOK-14)", () => {
  const crop = { x: 200, y: 100, w: 960, h: 540 };
  const events = [...move([300, 200], [700, 500], 0, 400), ...click(700, 500, 800), ...move([700, 500], [1500, 900], 1500, 400), ...click(1500, 900, 2500)];
  const project = resolveProject({ output: { fps: 30 }, crop, cursor: { smoothing: { enabled: false }, hideWhenIdle: false } });
  const plan = buildRenderPlan({ meta: { ...META, durationMs: 4000 }, events, project });

  it("normalizes and clamps the crop", () => {
    expect(normalizeCrop(null, META)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(normalizeCrop({ x: 1800, y: -5, w: 500, h: 300.4 }, META)).toEqual({ x: 1800, y: 0, w: 120, h: 300 });
    expect(plan.source.crop).toEqual([200, 100, 960, 540]);
    expect(plan.source.width).toBe(1920);
  });

  it("maps cursor and clicks into cropped space", () => {
    const f = plan.frames.find((fr) => fr.src >= 1000 && fr.src < 1100)!;
    expect(f.cur![0]).toBeCloseTo(700 - 200, 0);
    expect(f.cur![1]).toBeCloseTo(500 - 100, 0);
    const c = plan.frames.find((fr) => fr.clicks.length > 0)!;
    expect(c.clicks[0]![0]).toBe(500);
    expect(c.clicks[0]![1]).toBe(400);
  });

  it("hides the cursor and click effects outside the crop and keeps the camera inside it", () => {
    const outside = plan.frames.filter((fr) => fr.src >= 2000 && fr.src < 3000);
    expect(outside.every((fr) => fr.cur === null)).toBe(true); // (1300, 800) in cropped space > 960x540
    expect(outside.every((fr) => fr.clicks.length === 0)).toBe(true);
    for (const fr of plan.frames) {
      const [cx, cy, s] = fr.cam;
      expect(cx - 960 / (2 * s)).toBeGreaterThanOrEqual(-0.01);
      expect(cx + 960 / (2 * s)).toBeLessThanOrEqual(960.01);
      expect(cy - 540 / (2 * s)).toBeGreaterThanOrEqual(-0.01);
      expect(cy + 540 / (2 * s)).toBeLessThanOrEqual(540.01);
    }
    // only the in-crop click produces an auto zoom
    expect(plan.zoomSegments.length).toBe(1);
    expect(plan.zoomSegments[0]!.startMs).toBeLessThan(800);
  });

  it("fits the screen to the crop aspect and translates fixed zoom focus points", () => {
    const sq = resolveProject({ output: { fps: 30 }, crop: { x: 0, y: 0, w: 1080, h: 1080 }, zoom: { auto: false, segments: [{ id: "m", startMs: 0, endMs: 4000, scale: 2, focus: { x: 1500, y: 600 }, style: "classic", auto: false }] } });
    const p2 = buildRenderPlan({ meta: { ...META, durationMs: 4000 }, events, project: { ...sq, crop: { x: 840, y: 0, w: 1080, h: 1080 } } });
    const [, , w, h] = p2.frames[0]!.layout.screen;
    expect(w / h).toBeCloseTo(1, 2);
    const focus = p2.zoomSegments[0]!.focus as { x: number; y: number };
    expect(focus).toEqual({ x: 660, y: 600 });
  });
});

describe("masks (TXT-04/05)", () => {
  it("fades in and out and fills default strength per kind", () => {
    const m = [{ id: "a", kind: "blur" as const, rect: { x: 10, y: 20, w: 100, h: 50 }, startMs: 1000, endMs: 3000, feather: 8, fadeMs: 200 }];
    expect(masksAt(m, 900)).toEqual([]);
    expect(masksAt(m, 1100)[0]!.opacity).toBeCloseTo(0.5, 2);
    expect(masksAt(m, 2000)[0]).toEqual({ kind: "blur", rect: [10, 20, 100, 50], feather: 8, strength: 12, opacity: 1 });
    expect(masksAt(m, 3000)).toEqual([]);
  });

  it("are carried per frame in cropped source coords", () => {
    const project = resolveProject({
      output: { fps: 30 },
      crop: { x: 100, y: 50, w: 1600, h: 900 },
      masks: [{ id: "s", kind: "spotlight", rect: { x: 300, y: 250, w: 400, h: 200 }, startMs: 0, endMs: 2000, feather: 10, fadeMs: 0, strength: 0.7 }],
    });
    const plan = buildRenderPlan({ meta: META, events: demoSession(), project });
    expect(plan.frames[10]!.masks).toEqual([{ kind: "spotlight", rect: [200, 200, 400, 200], feather: 10, strength: 0.7, opacity: 1 }]);
    expect(plan.frames[90]!.masks).toEqual([]);
  });

  it("validation rejects bad masks", () => {
    expect(() => resolveProject({ masks: [{ id: "x", kind: "blur", rect: { x: 0, y: 0, w: 0, h: 5 }, startMs: 0, endMs: 10, feather: 0, fadeMs: 0 }] })).toThrow(ProjectValidationError);
  });
});

describe("webcam (CAM-04/05/06)", () => {
  const base = { output: { fps: 30 as const }, camera: { enabled: true, mirror: true, crop: { x: 160, y: 0, w: 960, h: 720 }, zoomedSize: 0.6 } };
  const plan = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject(base) });
  const flat = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ ...base, camera: { ...base.camera, zoomedSize: 1 } }) });

  it("carries mirror and crop to the compositor", () => {
    expect(plan.style.cameraMirror).toBe(true);
    expect(plan.style.cameraCrop).toEqual([160, 0, 960, 720]);
  });

  it("shrinks about its corner while zoomed, animated by the zoom spring", () => {
    const full = flat.frames[0]!.layout.camera!;
    const sizes = plan.frames.map((f) => f.layout.camera![2] / full[2]);
    expect(sizes[0]).toBeCloseTo(1, 3);
    const zoomed = plan.frames.find((f) => f.cam[2] > 1.9)!;
    const zr = zoomed.layout.camera!;
    expect(zr[2] / full[2]).toBeLessThan(0.7);
    expect(zr[2] / full[2]).toBeGreaterThanOrEqual(0.6 - 1e-6);
    // bottom-right corner stays anchored
    expect(zr[0] + zr[2]).toBeCloseTo(full[0] + full[2], 1);
    expect(zr[1] + zr[3]).toBeCloseTo(full[1] + full[3], 1);
    // smooth: no frame-to-frame jump bigger than 4% of full size
    for (let i = 1; i < sizes.length; i++) expect(Math.abs(sizes[i]! - sizes[i - 1]!)).toBeLessThan(0.04);
    // returns to full size after the session idles
    expect(sizes[sizes.length - 1]).toBeCloseTo(1, 2);
    // in-between frames exist (animated, not a snap)
    expect(sizes.some((s) => s > 0.65 && s < 0.95)).toBe(true);
  });

  it("leaves split layouts alone", () => {
    const p = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ ...base, camera: { ...base.camera, layouts: [{ startMs: 0, endMs: 12000, kind: "split" }] } }) });
    const q = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ ...base, camera: { ...base.camera, zoomedSize: 1, layouts: [{ startMs: 0, endMs: 12000, kind: "split" }] } }) });
    expect(p.frames.map((f) => f.layout.camera)).toEqual(q.frames.map((f) => f.layout.camera));
  });
});

describe("caption styling (AI-03)", () => {
  it("wraps words into balanced lines", () => {
    expect(wrapWords(6, 5)).toEqual([3, 3]);
    expect(wrapWords(4, 5)).toEqual([4]);
    expect(wrapWords(7, 3)).toEqual([3, 2, 2]);
  });

  it("plan carries the active word index at the right times", () => {
    const project = resolveProject({ output: { fps: 30 }, captions: { enabled: true, style: { maxWordsPerLine: 3, position: "top", fontSize: 50 } } });
    const plan = buildRenderPlan({ meta: META, events: demoSession(), project, words });
    const at = (ms: number) => plan.frames[Math.round((ms * 30) / 1000)]!;
    expect(at(400).caption).toBeNull();
    expect(at(600).caption!.active).toBe(0);
    expect(at(1000).caption!.active).toBe(1);
    expect(at(1120).caption!.active).toBe(1); // gap keeps the last spoken word
    expect(at(1600).caption!.active).toBe(3);
    expect(at(2400).caption!.active).toBe(5);
    expect(at(2400).caption!.lines).toEqual([3, 3]);
    expect(at(2400).caption!.words[3]).toBe("recordings");
    expect(plan.style.captions.position).toBe("top");
    expect(plan.style.captions.fontSize).toBe(50);
    expect(activeWordIndex(words, 0)).toBe(-1);
  });

  it("active is -1 with highlighting off, and timing follows the edit", () => {
    const off = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ output: { fps: 30 }, captions: { enabled: true, wordHighlight: false } }), words });
    expect(off.frames[30]!.caption!.active).toBe(-1);
    const cut = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ output: { fps: 30 }, captions: { enabled: true }, edits: { cuts: [{ startMs: 0, endMs: 1000 }] } }), words });
    // out 500 = src 1500: "recordings" is highlighted. Words inside the cut ("Lens", "turns") are no
    // longer part of the caption (editor change: deleted words leave captions), so check by text.
    const c = cut.frames[Math.round((500 * 30) / 1000)]!.caption!;
    expect(c.words[c.active]).toBe("recordings");
    expect(c.words).not.toContain("Lens");
  });
});

describe("per-segment overrides (CUR-01, EDT-06)", () => {
  const events = [...move([200, 200], [1700, 900], 0, 3000, 6), ...click(1700, 900, 3500)];
  const meta = { ...META, durationMs: 5000 };
  const cfg = { ...defaultProject().cursor, hideWhenIdle: false };

  it("hides the cursor inside the range with a fade", () => {
    const tr = buildCursorTrack(events, meta, cfg, 60, [{ startMs: 1000, endMs: 2000, cursor: { hidden: true } }]);
    const at = (ms: number) => tr[Math.round((ms * 60) / 1000)]!;
    expect(at(900).opacity).toBe(1);
    expect(at(1500).opacity).toBe(0);
    expect(at(1100).opacity).toBeGreaterThan(0); // fading, not snapped
    expect(at(2500).opacity).toBe(1);
  });

  it("turns smoothing off in the range (raw path), blending at the edges", () => {
    const smooth = buildCursorTrack(events, meta, cfg, 60);
    const ov = buildCursorTrack(events, meta, cfg, 60, [{ startMs: 1000, endMs: 2000, cursor: { smoothing: false } }]);
    const raw = buildCursorTrack(events, meta, { ...cfg, smoothing: { ...cfg.smoothing, enabled: false } }, 60);
    const i = Math.round((1500 * 60) / 1000);
    expect(Math.hypot(ov[i]!.x - raw[i]!.x, ov[i]!.y - raw[i]!.y)).toBeLessThan(0.01);
    expect(Math.hypot(smooth[i]!.x - raw[i]!.x, smooth[i]!.y - raw[i]!.y)).toBeGreaterThan(1);
    const j = Math.round((500 * 60) / 1000);
    expect(ov[j]!.x).toBeCloseTo(smooth[j]!.x, 6);
    for (let k = 1; k < ov.length; k++) expect(Math.hypot(ov[k]!.x - ov[k - 1]!.x, ov[k]!.y - ov[k - 1]!.y)).toBeLessThan(60);
  });

  it("changes cursor size in the range and reaches the plan", () => {
    const project = resolveProject({ output: { fps: 30 }, cursor: { hideWhenIdle: false }, overrides: [{ startMs: 1000, endMs: 2000, cursor: { size: 3 } }, { startMs: 2500, endMs: 3000, cursor: { hidden: true } }] });
    const plan = buildRenderPlan({ meta, events, project });
    const at = (ms: number) => plan.frames[Math.round((ms * 30) / 1000)]!;
    expect(at(1500).cur![3]).toBeCloseTo(2, 3); // 3 / default 1.5
    expect(at(500).cur![3]).toBeCloseTo(1, 3);
    expect(at(2800).cur).toBeNull();
  });

  it("validation rejects bad overrides", () => {
    expect(() => resolveProject({ overrides: [{ startMs: 5, endMs: 1 }] })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ overrides: [{ startMs: 0, endMs: 1, volume: -1 }] })).toThrow(ProjectValidationError);
  });
});

describe("gif export settings (EXP-04)", () => {
  it("defaults and validation", () => {
    const p = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ output: { fps: 30 }, export: { gif: { fps: 12, width: 480 } } }) });
    expect(p.export.gif).toEqual({ fps: 12, width: 480, loop: true });
    expect(() => resolveProject({ export: { gif: { fps: 0 } } })).toThrow(ProjectValidationError);
  });
});
