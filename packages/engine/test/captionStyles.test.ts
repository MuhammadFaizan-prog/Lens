/**
 * Caption fonts and styles (Windows request "diff diff fonts for the captions"): schema, backward-
 * compatible defaults (Rules §4: an old project.json renders exactly as before), presets, and the
 * bundled font files with their licences.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyCaptionPreset, boxHighlightText, buildRenderPlan, BUILTIN_FONTS, captionLook, captionStrokePx, CAPTION_FONTS, CAPTION_PRESETS, DEFAULT_FONT,
  defaultProject, resolveProject, ProjectValidationError, ARABIC_FONT,
} from "../src/index.js";
import type { InputEvent } from "../src/index.js";

const FONTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "fonts");
const meta = { width: 1280, height: 720, fps: 30, durationMs: 2000, pixelRatio: 1 };
const events: InputEvent[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 100, type: "move", x: 600, y: 300 }) as InputEvent);
const cues = [{ id: "a", startMs: 200, endMs: 1800, text: "Caption fonts" }];
const NEW_KEYS = ["weight", "uppercase", "stroke", "highlightStyle", "preset"];

describe("caption style schema and defaults", () => {
  it("the default style has none of the new fields, so the default look is unchanged", () => {
    const cs = defaultProject().captions.style;
    for (const k of NEW_KEYS) expect(cs).not.toHaveProperty(k);
    expect(cs.font).toBeUndefined();
    expect(captionLook(cs)).toEqual({ weight: "bold", uppercase: false, stroke: { enabled: false, color: "#000000", width: 0.08 }, highlightStyle: "color" });
  });

  it("a project.json written before caption styles loads and plans exactly as before (no new keys in the plan)", () => {
    // the shape v0.1.2 wrote
    const old = { captions: { enabled: true, cues, style: { fontSize: 44, textColor: "#ffffff", highlightColor: "@highlight", background: { enabled: true, color: "#000000", opacity: 0.66 }, position: "bottom", y: 0.88, maxWordsPerLine: 5, maxCharsPerLine: 42 } }, output: { fps: 30, resolution: 360 } };
    const p = resolveProject(old);
    const plan = buildRenderPlan({ meta, events, project: p });
    const pc = plan.style.captions as Record<string, unknown>;
    for (const k of NEW_KEYS) expect(pc).not.toHaveProperty(k);
    expect(pc.font).toBeUndefined();
    expect(plan.fonts ?? []).toEqual([]);
    const base = buildRenderPlan({ meta, events, project: resolveProject({ captions: { enabled: true, cues }, output: { fps: 30, resolution: 360 } }) });
    expect(JSON.stringify(plan.style.captions)).toBe(JSON.stringify(base.style.captions));
  });

  it("new fields round-trip through project.json and reach the plan; the chosen font's files are in plan.fonts", () => {
    const style = { ...defaultProject().captions.style, font: "Poppins", weight: "regular" as const, uppercase: true, stroke: { enabled: true, color: "@highlight", width: 0.1 }, highlightStyle: "box" as const };
    const p = resolveProject(JSON.parse(JSON.stringify({ captions: { enabled: true, cues, style }, output: { fps: 30, resolution: 360 } })));
    expect(p.captions.style).toMatchObject({ font: "Poppins", weight: "regular", uppercase: true, highlightStyle: "box" });
    const plan = buildRenderPlan({ meta, events, project: p });
    expect(plan.style.captions).toMatchObject({ font: "Poppins", weight: "regular", uppercase: true, highlightStyle: "box" });
    // theme slot in the outline colour is resolved like the other caption colours
    expect(plan.style.captions.stroke!.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(plan.fonts).toEqual([{ family: "Poppins", regular: "builtin:Poppins-Regular.ttf", bold: "builtin:Poppins-Bold.ttf" }]);
    // the caption text itself is not changed by capitals (SRT keeps the spoken words)
    expect(plan.subtitles[0]!.text).toBe("Caption fonts");
  });

  it("rejects bad style values", () => {
    const bad = (style: Record<string, unknown>) => () => resolveProject({ captions: { style } });
    expect(bad({ weight: "heavy" })).toThrow(ProjectValidationError);
    expect(bad({ highlightStyle: "glow" })).toThrow(/highlightStyle/);
    expect(bad({ stroke: { enabled: true, color: "red", width: 0.1 } })).toThrow(/stroke/);
    expect(bad({ stroke: { enabled: true, color: "#000000", width: 0.5 } })).toThrow(/stroke/);
    expect(bad({ uppercase: "yes" })).toThrow(/uppercase/);
  });
});

describe("caption presets", () => {
  it("has 4-6 presets with distinct looks; Clean is the default look", () => {
    expect(CAPTION_PRESETS.length).toBeGreaterThanOrEqual(4);
    expect(CAPTION_PRESETS.length).toBeLessThanOrEqual(6);
    const d = defaultProject().captions.style;
    const clean = applyCaptionPreset(d, "clean");
    const { preset, weight, uppercase, stroke, highlightStyle, ...rest } = clean;
    expect(preset).toBe("clean");
    expect(rest).toEqual(d);
    expect({ weight, uppercase, stroke, highlightStyle }).toEqual(captionLook(d));
    const looks = new Set(CAPTION_PRESETS.map((pr) => JSON.stringify(applyCaptionPreset(d, pr.id))));
    expect(looks.size).toBe(CAPTION_PRESETS.length);
  });

  it("applying a preset keeps position and line breaking, and every preset validates", () => {
    const d = { ...defaultProject().captions.style, position: "custom" as const, y: 0.3, maxWordsPerLine: 3, maxCharsPerLine: 20 };
    for (const pr of CAPTION_PRESETS) {
      const s = applyCaptionPreset(d, pr.id);
      expect([s.position, s.y, s.maxWordsPerLine, s.maxCharsPerLine]).toEqual(["custom", 0.3, 3, 20]);
      expect(() => resolveProject({ captions: { style: s } })).not.toThrow();
    }
    // switching presets leaves nothing behind from the previous one
    const a = applyCaptionPreset(applyCaptionPreset(d, "bold-pop"), "clean");
    expect(a.font).toBeUndefined();
    expect(a.uppercase).toBe(false);
    expect(a.stroke!.enabled).toBe(false);
    expect(applyCaptionPreset(d, "nope")).toBe(d);
  });

  it("helpers: outline px rounding and box text contrast", () => {
    expect(captionStrokePx(44, 0.08)).toBe(4);
    expect(captionStrokePx(10, 0.02)).toBe(1);
    expect(boxHighlightText("#ffd23f")).toBe("#111318");
    expect(boxHighlightText("#1d2027")).toBe("#ffffff");
  });
});

describe("bundled caption fonts", () => {
  it("offers 8-12 fonts, every one with Regular + Bold files and an OFL licence on disk", () => {
    const picks = CAPTION_FONTS.filter((f) => f.family !== "@font");
    expect(picks.length).toBeGreaterThanOrEqual(8);
    expect(picks.length).toBeLessThanOrEqual(12);
    for (const o of picks) {
      if (o.family === DEFAULT_FONT) continue; // the system DejaVu Sans the renderers always used
      const f = BUILTIN_FONTS.find((x) => x.family === o.family);
      expect(f, o.family).toBeDefined();
      for (const ref of [f!.regular, f!.bold]) {
        expect(ref.startsWith("builtin:")).toBe(true);
        const file = path.join(FONTS, ref.slice(8));
        expect(fs.existsSync(file), file).toBe(true);
        expect(fs.readFileSync(file).readUInt32BE(0)).toBe(0x00010000); // TrueType
        const lic = path.join(FONTS, `${ref.slice(8).split("-")[0]}-OFL.txt`);
        expect(fs.readFileSync(lic, "utf8")).toContain("SIL Open Font License, Version 1.1");
      }
      expect(o.bold).toBe(f!.regular !== f!.bold);
    }
    // the Arabic script font stays bundled for right-to-left captions
    expect(fs.existsSync(path.join(FONTS, ARABIC_FONT.regular.slice(8)))).toBe(true);
  });

  it("all bundled fonts together stay under 5 MB", () => {
    const total = fs.readdirSync(FONTS).filter((f) => f.endsWith(".ttf")).reduce((a, f) => a + fs.statSync(path.join(FONTS, f)).size, 0);
    console.log("assets/fonts TTF total", (total / 1e6).toFixed(2), "MB");
    expect(total).toBeLessThan(5e6);
  });

  it("every preset's font is a bundled family", () => {
    for (const pr of CAPTION_PRESETS) if (pr.style.font) expect(BUILTIN_FONTS.some((f) => f.family === pr.style.font), pr.id).toBe(true);
  });
});
