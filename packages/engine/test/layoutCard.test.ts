/**
 * Screen card transform, aspect "auto" and custom canvas size (feat/canvas-layout): the default plan
 * is unchanged, a custom card places the screen where it says, Fill / Centre math, cardCrop trims
 * instead of stretching, canvasSize for custom / auto, and project + preset validation.
 */
import { describe, expect, it } from "vitest";
import {
  applyPreset,
  buildRenderPlan,
  builtinPresets,
  canvasSize,
  cardCrop,
  cardFromRect,
  cardRect,
  centerCard,
  defaultProject,
  fillCard,
  fittedCardRect,
  outputSize,
  resolveProject,
  validatePreset,
  ProjectValidationError,
  type CardTransform,
  type Preset,
  type ProjectConfig,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const plan = (patch: unknown = {}) => buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject(patch) });

describe("default placement is unchanged", () => {
  it("no card: 1920x1080 canvas, source fitted inside the 8% padding", () => {
    const p = plan();
    expect(p.output.width).toBe(1920);
    expect(p.output.height).toBe(1080);
    expect(p.source.crop).toEqual([0, 0, 1920, 1080]);
    // pad = 0.08 * 1080 = 86.4; area 1747.2 x 907.2; 16:9 fitted -> 1612.8 x 907.2, centred
    expect(p.frames[0]!.layout.screen).toEqual([153.6, 86.4, 1612.8, 907.2]);
  });

  it("card null and card absent give the identical plan", () => {
    expect(JSON.stringify(plan({ card: null }))).toBe(JSON.stringify(plan()));
  });

  it("cardRect without a card is fittedCardRect", () => {
    const cfg = defaultProject();
    const out = { width: 1920, height: 1080 };
    expect(cardRect(out, 16 / 9, cfg)).toEqual(fittedCardRect(out, 16 / 9, cfg));
    expect(cardRect(out, 16 / 9, { ...cfg, card: null })).toEqual(fittedCardRect(out, 16 / 9, cfg));
  });

  it("a card equal to the fitted rect reproduces the default frames (to rounding)", () => {
    const out = { width: 1920, height: 1080 };
    const card = cardFromRect(fittedCardRect(out, 16 / 9, defaultProject()), out);
    const a = plan();
    const b = plan({ card });
    for (const i of [0, 60, 300, 600]) {
      const sa = a.frames[i]!.layout.screen;
      const sb = b.frames[i]!.layout.screen;
      sa.forEach((v, k) => expect(sb[k]!).toBeCloseTo(v, 1));
      expect(b.frames[i]!.cam).toEqual(a.frames[i]!.cam);
    }
    expect(b.source.crop).toEqual(a.source.crop);
  });
});

describe("custom card", () => {
  it("places the screen at the card's fractions of the canvas", () => {
    const card: CardTransform = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
    const p = plan({ card });
    expect(p.frames[0]!.layout.screen).toEqual([192, 216, 960, 540]);
    // 0.5 x 0.5 of a 16:9 canvas is still 16:9: the crop is untouched
    expect(p.source.crop).toEqual([0, 0, 1920, 1080]);
  });

  it("cardRect / cardFromRect round trip", () => {
    const out = { width: 1080, height: 1920 };
    const r = { x: 54, y: 300, w: 972, h: 546.75 };
    const c = cardFromRect(r, out);
    const back = cardRect(out, 16 / 9, { ...defaultProject(), card: c });
    expect(back.x).toBeCloseTo(r.x, 1);
    expect(back.y).toBeCloseTo(r.y, 1);
    expect(back.w).toBeCloseTo(r.w, 1);
    expect(back.h).toBeCloseTo(r.h, 1);
  });

  it("fill covers the canvas; centre keeps the size", () => {
    expect(fillCard()).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(centerCard({ x: 0, y: 0.7, w: 0.6, h: 0.3 })).toEqual({ x: 0.2, y: 0.35, w: 0.6, h: 0.3 });
    expect(centerCard(fillCard())).toEqual(fillCard());
  });

  it("a card turns fill mode (and its pan-follow) off", () => {
    const base = { output: { aspect: "9:16", fit: "fill" } };
    const filled = plan(base);
    // fill mode: the screen overflows the 1080-wide canvas
    expect(filled.frames[0]!.layout.screen[2]).toBeGreaterThan(1080);
    const carded = plan({ ...base, card: { x: 0, y: 0.25, w: 1, h: 0.5 } });
    for (const f of carded.frames.filter((_, i) => i % 97 === 0)) expect(f.layout.screen).toEqual([0, 480, 1080, 960]);
  });
});

describe("cardCrop never stretches", () => {
  const crop = { x: 0, y: 0, w: 1920, h: 1080 };
  const out = { width: 1920, height: 1080 };

  it("no card or same shape: crop unchanged", () => {
    expect(cardCrop(crop, out, {})).toEqual(crop);
    expect(cardCrop(crop, out, { card: null })).toEqual(crop);
    expect(cardCrop(crop, out, { card: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } })).toEqual(crop);
  });

  it("square card trims the sides, centred", () => {
    const c = cardCrop(crop, out, { card: { x: 0, y: 0, w: 0.5625, h: 1 } }); // 1080 x 1080 px
    expect(c).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
  });

  it("wide card trims top and bottom, centred", () => {
    const c = cardCrop(crop, out, { card: { x: 0, y: 0.25, w: 1, h: 0.25 } }); // 1920 x 270 px
    expect(c).toEqual({ x: 0, y: 405, w: 1920, h: 270 });
  });

  it("keeps the card's aspect within a user crop", () => {
    const user = { x: 100, y: 50, w: 800, h: 600 };
    const c = cardCrop(user, out, { card: fillCard() });
    expect(c.w / c.h).toBeCloseTo(16 / 9, 2);
    expect(c.x).toBe(100);
    expect(c.y + c.h / 2).toBeCloseTo(350, 0);
  });

  it("plan: Fill on a 9:16 canvas trims the source, screen = canvas, no stretch", () => {
    const p = plan({ output: { aspect: "9:16" }, card: fillCard() });
    expect(p.output).toMatchObject({ width: 1080, height: 1920 });
    expect(p.frames[0]!.layout.screen).toEqual([0, 0, 1080, 1920]);
    const [, , cw, ch] = p.source.crop;
    expect(cw / ch).toBeCloseTo(1080 / 1920, 2);
    expect(ch).toBe(1080);
    expect(p.source.crop[0]).toBe(Math.round((1920 - cw) / 2));
  });
});

describe("canvasSize", () => {
  const src = { width: 1920, height: 1080 };
  const o = (patch: Partial<ProjectConfig["output"]>): ProjectConfig["output"] => ({ ...defaultProject().output, ...patch });

  it("aspect x resolution by default (= outputSize)", () => {
    expect(canvasSize(o({}), src)).toEqual(outputSize("16:9", 1080));
    expect(canvasSize(o({ aspect: "9:16" }), src)).toEqual({ width: 1080, height: 1920 });
  });

  it("custom size wins and rounds to even", () => {
    expect(canvasSize(o({ size: { w: 1201, h: 677 } }), src)).toEqual({ width: 1202, height: 678 });
    expect(canvasSize(o({ aspect: "9:16", size: { w: 800, h: 600 } }), src)).toEqual({ width: 800, height: 600 });
    expect(canvasSize(o({ size: null }), src)).toEqual({ width: 1920, height: 1080 });
  });

  it("auto follows the source / crop shape, resolution as the short side", () => {
    expect(canvasSize(o({ aspect: "auto" }), src)).toEqual({ width: 1920, height: 1080 });
    expect(canvasSize(o({ aspect: "auto", resolution: 720 }), { width: 1000, height: 1000 })).toEqual({ width: 720, height: 720 });
    expect(canvasSize(o({ aspect: "auto", resolution: 720 }), { width: 600, height: 1200 })).toEqual({ width: 720, height: 1440 });
  });

  it("outputSize falls back to 16:9 for auto", () => {
    expect(outputSize("auto", 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it("plan: auto follows the user crop, custom size sets the canvas", () => {
    const a = plan({ output: { aspect: "auto" }, crop: { x: 0, y: 0, w: 1080, h: 1080 } });
    expect(a.output).toMatchObject({ width: 1080, height: 1080 });
    const s = plan({ output: { size: { w: 1280, h: 1024 } } });
    expect(s.output).toMatchObject({ width: 1280, height: 1024 });
  });
});

describe("validation", () => {
  const bad = (patch: unknown, msg: RegExp) => expect(() => resolveProject(patch)).toThrowError(msg);
  const ok = (patch: unknown) => expect(() => resolveProject(patch)).not.toThrow();

  it("aspect: w:h or auto", () => {
    ok({ output: { aspect: "auto" } });
    ok({ output: { aspect: "21:9" } });
    bad({ output: { aspect: "wide" } }, /output.aspect/);
    bad({ output: { aspect: "0:9" } }, /output.aspect/);
  });

  it("size: 16..8192 each side", () => {
    ok({ output: { size: { w: 16, h: 8192 } } });
    ok({ output: { size: null } });
    bad({ output: { size: { w: 15, h: 100 } } }, /output.size/);
    bad({ output: { size: { w: 100, h: 9000 } } }, /output.size/);
    bad({ output: { size: { w: 100 } } }, /output.size/);
  });

  it("card: finite fractions, positive size", () => {
    ok({ card: { x: 0, y: 0, w: 1, h: 1 } });
    ok({ card: { x: -0.2, y: 0.1, w: 1.4, h: 0.8 } });
    ok({ card: null });
    bad({ card: { x: 0, y: 0, w: 0, h: 1 } }, /card/);
    bad({ card: { x: 0, y: 0, w: 1 } }, /card/);
    bad({ card: { x: Number.NaN, y: 0, w: 1, h: 1 } }, /card/);
    expect(() => resolveProject({ card: { x: 0, y: 0, w: -1, h: 1 } })).toThrow(ProjectValidationError);
  });
});

describe("presets and the card", () => {
  const withLook = (aspect: string): Preset => {
    const p = builtinPresets()[0]!;
    return { ...p, sections: { ...p.sections, look: { ...p.sections.look, aspect } } };
  };

  it("a preset that changes the aspect clears the card (and custom size)", () => {
    const proj = resolveProject({ card: { x: 0, y: 0, w: 1, h: 1 }, output: { size: { w: 800, h: 600 } } });
    const next = applyPreset(proj, withLook("9:16"), ["look"]);
    expect(next.output.aspect).toBe("9:16");
    expect(next.card ?? null).toBeNull();
    expect(next.output.size).toBeUndefined();
  });

  it("a preset with the same aspect keeps the card", () => {
    const card = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    const proj = resolveProject({ card });
    const next = applyPreset(proj, withLook("16:9"), ["look"]);
    expect(next.card).toEqual(card);
  });

  it("presets may use aspect auto", () => {
    const pr = withLook("auto");
    expect(validatePreset(pr).errors).toEqual([]);
    expect(applyPreset(defaultProject(), pr, ["look"]).output.aspect).toBe("auto");
    expect(validatePreset(withLook("tall")).errors.join()).toMatch(/aspect/);
  });
});
