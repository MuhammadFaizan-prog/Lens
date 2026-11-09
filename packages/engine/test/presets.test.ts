/**
 * Presets + brand kit (demand #9): precedence (built-in default < preset < brand < per-item
 * override), schema validation, migration of a version-1 preset, partial apply, round trips,
 * watermark geometry and brand cards. Expectations were written before the first run
 * (docs/Tracker.md).
 */
import { describe, expect, it } from "vitest";
import {
  applyPreset,
  applyTheme,
  brandPalette,
  BUILTIN_PALETTE,
  builtinPresets,
  buildRenderPlan,
  defaultBrand,
  defaultProject,
  derivedBackground,
  normalizeAnnotation,
  parsePreset,
  PRESET_SECTIONS,
  PresetError,
  presetFromProject,
  projectPalette,
  resolvePalette,
  resolveProject,
  resolveThemed,
  serializePreset,
  validatePreset,
  watermarkRect,
  type Annotation,
  type AnnOp,
  type Preset,
  type ProjectConfig,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const D = BUILTIN_PALETTE;
const PRESET_P = { primary: "#3d63f5", highlight: "#9fc2ff", font: "Inter" };
const BRAND_P = { primary: "#12b886", highlight: "#12b886", font: "JetBrains Mono" };

function boxAnn(over: Partial<Annotation> = {}): Annotation {
  return normalizeAnnotation({ id: "box", kind: "rect", startMs: 0, endMs: 12000, rect: { x: 400, y: 300, w: 300, h: 200 }, ...over });
}

function withBrand(p: ProjectConfig, primary = "#12b886"): ProjectConfig {
  const b = defaultBrand();
  return { ...p, brand: { ...b, enabled: true, colors: { ...b.colors, primary }, font: "JetBrains Mono" } };
}

function strokeColour(plan: ReturnType<typeof buildRenderPlan>, i = 0): string {
  const a = plan.frames[i]!.annotations.find((x) => x.id === "box")!;
  return (a.ops.find((o) => o.op === "stroke") as Extract<AnnOp, { op: "stroke" }>).color;
}

const plan = (p: ProjectConfig) => buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject(p), onlyFrames: [30] });

describe("precedence: built-in default < preset < brand < per-item override", () => {
  it("resolveThemed walks the layers in order for every combination", () => {
    const cases: Array<[string, { preset?: boolean; brand?: boolean; item?: string }, string]> = [
      ["default only", {}, D.primary],
      ["preset", { preset: true }, PRESET_P.primary],
      ["brand", { brand: true }, BRAND_P.primary],
      ["preset + brand", { preset: true, brand: true }, BRAND_P.primary],
      ["item over default", { item: "#abcdef" }, "#abcdef"],
      ["item over preset", { preset: true, item: "#abcdef" }, "#abcdef"],
      ["item over brand", { brand: true, item: "#abcdef" }, "#abcdef"],
      ["item over preset + brand", { preset: true, brand: true, item: "#abcdef" }, "#abcdef"],
      ["item slot reference falls through", { preset: true, brand: true, item: "@primary" }, BRAND_P.primary],
    ];
    for (const [name, c, want] of cases) {
      const got = resolveThemed("primary", { preset: c.preset ? PRESET_P : null, brand: c.brand ? BRAND_P : null, item: c.item });
      expect(got, name).toBe(want);
    }
    // a reference to another slot resolves that slot through the same layers
    expect(resolveThemed("primary", { preset: { accent: "#111111" }, item: "@accent" })).toBe("#111111");
    expect(resolveThemed("font", { preset: PRESET_P, brand: BRAND_P })).toBe("JetBrains Mono");
    expect(resolveThemed("font", { preset: PRESET_P })).toBe("Inter");
    expect(resolveThemed("font", {})).toBe("DejaVu Sans");
    // a layer that leaves a slot out does not hide the layer below
    expect(resolvePalette({ preset: PRESET_P, brand: { font: "X" } }).primary).toBe(PRESET_P.primary);
  });

  it("built-in palette reproduces the pre-preset defaults exactly", () => {
    expect(D.primary).toBe("#ff5a36");
    expect(D.highlight).toBe("#ffd23f");
    expect(D.background).toEqual({ kind: "gradient", colors: ["#3a1c71", "#d76d77", "#ffaf7b"], angle: 135 });
    const p = resolveProject({ annotations: [boxAnn()] });
    const pl = plan(p);
    expect(strokeColour(pl)).toBe("#ff5a36");
    expect(pl.style.captions.highlightColor).toBe("#ffd23f");
    expect(pl.style.background.colors).toEqual(["#3a1c71", "#d76d77", "#ffaf7b"]);
    expect(pl.fonts).toBeUndefined();
    expect(pl.watermark).toBeUndefined();
    expect(JSON.stringify(pl.frames[0]!.annotations)).not.toContain('"font"');
  });

  it("the same chain holds end to end in the render plan (annotation, caption highlight, backdrop, font)", () => {
    const base = resolveProject({ annotations: [boxAnn({ id: "txt", kind: "text", text: "Hi", rect: { x: 400, y: 300, w: 0, h: 0 } }), boxAnn({ id: "box" })] });
    const demo = builtinPresets().find((p) => p.id === "clean-product-demo")!;
    // 1. default
    let pl = plan(base);
    expect(strokeColour(pl)).toBe(D.primary);
    // 2. preset
    const pre = applyPreset(base, demo);
    pl = plan(pre);
    expect(strokeColour(pl)).toBe("#3d63f5");
    expect(pl.style.captions.highlightColor).toBe("#9fc2ff");
    expect(pl.style.background.colors).toEqual(["#f1f4fa", "#d9e1f1", "#bccbe8"]);
    expect(pl.fonts?.map((f) => f.family)).toEqual(["Inter"]);
    // 3. brand over preset
    const br = withBrand(pre);
    pl = plan(br);
    expect(strokeColour(pl)).toBe("#12b886");
    expect(pl.style.captions.highlightColor).toBe("#12b886");
    expect(pl.style.background.colors).toEqual(derivedBackground("#12b886").colors);
    const textOp = pl.frames[0]!.annotations.find((a) => a.kind === "text")!.ops.find((o) => o.op === "text") as Extract<AnnOp, { op: "text" }>;
    expect(textOp.font).toBe("JetBrains Mono");
    // 4. per-item override over brand
    const own = { ...br, annotations: br.annotations.map((a) => (a.id === "box" ? { ...a, style: { ...a.style, color: "#abcdef" } } : a)) };
    own.captions = { ...own.captions, style: { ...own.captions.style, highlightColor: "#fedcba" } };
    own.background = { ...own.background, kind: "solid", colors: ["#202020"], inherit: false };
    pl = plan(own);
    expect(strokeColour(pl)).toBe("#abcdef");
    expect(pl.style.captions.highlightColor).toBe("#fedcba");
    expect(pl.style.background.colors).toEqual(["#202020"]);
  });

  it("a project file that sets its own backdrop keeps it (no inherit), a new one inherits", () => {
    expect(resolveProject({}).background.inherit).toBe(true);
    expect(resolveProject({ background: { colors: ["#000000", "#ffffff"] } }).background.inherit).toBe(false);
    expect(resolveProject({ background: { colors: ["#000000", "#ffffff"], inherit: true } }).background.inherit).toBe(true);
    expect(resolveProject({ background: { blur: 4 } }).background.inherit).toBe(true);
  });
});

describe("built-in presets", () => {
  const all = builtinPresets();
  it("ships 5 presets with distinct ids, every one valid and applicable", () => {
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.length).toBeLessThanOrEqual(6);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) {
      const v = validatePreset(JSON.parse(serializePreset(p)));
      expect(v.errors, p.id).toEqual([]);
      for (const s of PRESET_SECTIONS) expect(p.sections[s], `${p.id}.${s}`).toBeDefined();
      const proj = resolveProject(applyPreset(defaultProject(), p));
      expect(proj.theme.preset?.id).toBe(p.id);
    }
    const sv = applyPreset(defaultProject(), all.find((p) => p.id === "social-vertical")!);
    expect(sv.output.aspect).toBe("9:16");
  });

  it("serialize -> parse -> serialize is byte-identical", () => {
    for (const p of all) {
      const a = serializePreset(p);
      const b = serializePreset(parsePreset(a));
      expect(b).toBe(a);
    }
  });
});

describe("apply", () => {
  const dark = builtinPresets().find((p) => p.id === "dark-dev")!;
  it("partial apply changes only the checked sections", () => {
    const base = resolveProject({ cursor: { size: 3.3 }, zoom: { holdMs: 2600 }, captions: { enabled: true }, annotations: [boxAnn()] });
    const p = applyPreset(base, dark, ["look"]);
    expect(p.cursor).toEqual(base.cursor);
    expect(p.zoom).toEqual(base.zoom);
    expect(p.captions).toEqual(base.captions);
    expect(p.audio).toEqual(base.audio);
    expect(p.camera).toEqual(base.camera);
    expect(p.annotations).toEqual(base.annotations);
    expect(p.theme.palette.primary).toBe("#2ee6a6");
    expect(p.frame.radius).toBe(10);
    expect(p.theme.preset?.sections).toEqual(["look"]);
    const q = applyPreset(base, dark, ["cursor", "zoom"]);
    expect(q.cursor.size).toBe(1.3);
    expect(q.frame).toEqual(base.frame);
    expect(q.theme.palette).toEqual(base.theme.palette);
  });

  it("applying is deterministic: the same preset gives the same project from any starting state", () => {
    const a = applyPreset(resolveProject({ cursor: { size: 3 }, frame: { padding: 0.2 } }), dark);
    const b = applyPreset(defaultProject(), dark);
    for (const k of ["cursor", "frame", "motionBlur", "captions", "background"] as const) expect(a[k], k).toEqual(b[k]);
  });

  it("zoom segments, webcam on/off and layouts, audio tracks and the transcript edits survive", () => {
    const base = resolveProject({
      zoom: { segments: [{ id: "z1", startMs: 1000, endMs: 3000, scale: 2, auto: false }] },
      camera: { enabled: true, layouts: [] },
      audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }] },
      edits: { cuts: [{ startMs: 100, endMs: 200 }] },
    });
    const p = applyPreset(base, dark);
    expect(p.zoom.segments).toEqual(base.zoom.segments);
    expect(p.camera.enabled).toBe(true);
    expect(p.audio.tracks).toEqual(base.audio.tracks);
    expect(p.edits).toEqual(base.edits);
  });

  it("annotation styles restyle existing items but keep colours set by hand", () => {
    const base = resolveProject({ annotations: [boxAnn(), boxAnn({ id: "mine", style: { color: "#00ff00" } as Annotation["style"] })] });
    const p = applyPreset(base, dark, ["annotations"]);
    const [a, mine] = p.annotations;
    expect(a!.style.strokeWidth).toBe(3);
    expect(a!.style.radius).toBe(6);
    expect(a!.style.color).toBe("@primary");
    expect(mine!.style.color).toBe("#00ff00");
    expect(mine!.style.strokeWidth).toBe(3);
  });

  it("save current -> apply to a fresh project reproduces every section", () => {
    const tut = builtinPresets().find((p) => p.id === "tutorial")!;
    const src = applyPreset(resolveProject({}), tut);
    src.cursor = { ...src.cursor, size: 2.2 }; // hand edit after applying
    src.captions = { ...src.captions, style: { ...src.captions.style, highlightColor: "#00e5ff" } };
    const saved = presetFromProject(src, "My tutorial");
    expect(validatePreset(JSON.parse(serializePreset(saved))).errors).toEqual([]);
    const round = parsePreset(serializePreset(saved));
    expect(round).toEqual(JSON.parse(serializePreset(saved)));
    const fresh = applyPreset(defaultProject(), round);
    for (const k of ["cursor", "frame", "motionBlur", "audio", "output"] as const) expect(fresh[k], k).toEqual(src[k]);
    const { segments: _a, ...zf } = fresh.zoom;
    const { segments: _b, ...zs } = src.zoom;
    expect(zf).toEqual(zs);
    expect(fresh.camera).toEqual(src.camera);
    // the literal highlight moved into the palette, and resolves to the same colour
    expect(plan(fresh).style.captions.highlightColor).toBe("#00e5ff");
    expect(fresh.captions.style.highlightColor).toBe("@highlight");
    expect(plan(fresh).style.background).toEqual(plan(src).style.background);
  });
});

describe("schema validation", () => {
  const good = (): Record<string, unknown> => JSON.parse(serializePreset(builtinPresets()[0]!));
  const errs = (mut: (o: Record<string, unknown>) => void) => {
    const o = good();
    mut(o);
    return validatePreset(o).errors.join(" | ");
  };
  it("accepts a valid file and rejects each kind of broken one with a specific message", () => {
    expect(validatePreset(good()).errors).toEqual([]);
    expect(errs((o) => (o.format = "lens-project"))).toMatch(/format must be "lens-preset"/);
    expect(errs((o) => (o.version = 3))).toMatch(/newer than this Lens/);
    expect(errs((o) => (o.id = "Bad Id!"))).toMatch(/id must be/);
    expect(errs((o) => (o.name = ""))).toMatch(/name must be/);
    expect(errs((o) => ((o.sections as Record<string, unknown>).lighting = {}))).toMatch(/unknown section lighting/);
    expect(errs((o) => (((o.sections as { look: { frame: Record<string, unknown> } }).look.frame).paddng = 0.1))).toMatch(/sections\.look\.frame\.paddng is not a known field/);
    expect(errs((o) => ((o.sections as { cursor: Record<string, unknown> }).cursor.size = "big"))).toMatch(/sections\.cursor\.size must be a number/);
    expect(errs((o) => ((o.sections as { look: { frame: Record<string, unknown> } }).look.frame.padding = 0.9))).toMatch(/out of range: frame\.padding/);
    expect(errs((o) => ((o.sections as { look: { palette: Record<string, unknown> } }).look.palette.primary = "red"))).toMatch(/palette\.primary must be #rrggbb/);
    expect(errs((o) => ((o.sections as { captions: { style: Record<string, unknown> } }).captions.style.highlightColor = "#ff0000"))).toMatch(/highlightColor must be a theme slot/);
    expect(errs((o) => ((o.sections as { annotations: { styles: Record<string, Record<string, unknown>> } }).annotations.styles.rect!.color = "blue"))).toMatch(/styles\.rect\.color must be/);
    expect(errs((o) => ((o.sections as { zoom: Record<string, unknown> }).zoom.defaultScale = 9))).toMatch(/out of range/);
    expect(() => parsePreset("{not json")).toThrow(PresetError);
    expect(validatePreset([1, 2]).errors).toEqual(["a preset must be a JSON object"]);
  });
});

describe("migration from version 1", () => {
  const v1 = {
    format: "lens-preset",
    version: 1,
    name: "Team Look 2025",
    accentColor: "#e03131",
    look: { background: { kind: "gradient", colors: ["#101010", "#404040"], angle: 90 }, padding: 0.1, radius: 20, shadow: { opacity: 0.3 }, motionBlur: false, aspect: "1:1" },
    zoom: { preset: "calm", auto: true },
    cursor: { size: 2.5, clickEffect: "circle", smoothing: false },
    captions: { enabled: true, fontSize: 52, position: "top", highlightColor: "#00d1b2" },
  };
  it("migrates to version 2 sections and applies the same look", () => {
    const p = parsePreset(JSON.stringify(v1));
    expect(p.version).toBe(2);
    expect(p.id).toBe("team-look-2025");
    expect(p.name).toBe("Team Look 2025");
    expect(p.sections.look?.palette).toEqual({ primary: "#e03131", background: { kind: "gradient", colors: ["#101010", "#404040"], angle: 90 }, highlight: "#00d1b2" });
    const proj = resolveProject(applyPreset(defaultProject(), p));
    expect(proj.output.aspect).toBe("1:1");
    expect(proj.frame.padding).toBe(0.1);
    expect(proj.frame.radius).toBe(20);
    expect(proj.frame.shadow.opacity).toBe(0.3);
    expect(proj.frame.shadow.blur).toBe(defaultProject().frame.shadow.blur);
    expect(proj.motionBlur.enabled).toBe(false);
    expect(proj.zoom.preset).toBe("calm");
    expect(proj.zoom.defaultScale).toBe(1.6);
    expect(proj.cursor.size).toBe(2.5);
    expect(proj.cursor.clickEffect).toBe("circle");
    expect(proj.cursor.smoothing.enabled).toBe(false);
    expect(proj.captions.enabled).toBe(true);
    expect(proj.captions.style.fontSize).toBe(52);
    expect(proj.captions.style.position).toBe("top");
    const pl = buildRenderPlan({ meta: META, events: demoSession(), project: proj, onlyFrames: [0] });
    expect(pl.style.captions.highlightColor).toBe("#00d1b2");
    expect(pl.style.background.colors).toEqual(["#101010", "#404040"]);
    // and a migrated preset saves as version 2
    expect(JSON.parse(serializePreset(p)).version).toBe(2);
  });
  it("rejects a version-1 file whose values are out of range", () => {
    expect(validatePreset({ ...v1, look: { ...v1.look, padding: 0.9 } }).errors.join()).toMatch(/frame\.padding/);
  });
});

describe("brand kit", () => {
  it("watermark sits in its corner at the safe margin, whole pixels", () => {
    const logo = { ...defaultBrand().logo, path: "logo.png", aspect: 2, size: 0.1, margin: 0.05, opacity: 0.6 };
    // 1920x1080: w = 192, h = 96, margin = 54
    expect(watermarkRect({ ...logo, corner: "bottom-right" }, 1920, 1080)).toEqual({ path: "logo.png", x: 1920 - 54 - 192, y: 1080 - 54 - 96, w: 192, h: 96, opacity: 0.6 });
    expect(watermarkRect({ ...logo, corner: "top-left" }, 1920, 1080)).toMatchObject({ x: 54, y: 54 });
    expect(watermarkRect({ ...logo, corner: "top-right" }, 1080, 1920)).toMatchObject({ x: 1080 - 54 - 108, y: 54, w: 108, h: 54 });
    expect(watermarkRect({ ...logo, path: null }, 1920, 1080)).toBeNull();
    expect(watermarkRect({ ...logo, watermark: false }, 1920, 1080)).toBeNull();
  });

  it("brand primary drives annotations, step badges, caption highlight, backdrop and slide accents", () => {
    const base = resolveProject({ annotations: [boxAnn(), normalizeAnnotation({ id: "b1", kind: "badge", startMs: 0, endMs: 9000, at: { x: 100, y: 100 } })], slides: [{ id: "s1", atMs: 5000 }] });
    for (const primary of ["#e03131", "#1c7ed6"]) {
      const p = withBrand(base, primary);
      const pal = projectPalette(p);
      expect(pal.primary).toBe(primary);
      const th = applyTheme(p, META.durationMs);
      expect(th.project.annotations[0]!.style.color).toBe(primary);
      expect(th.project.annotations[1]!.style.fill).toBe(primary);
      expect(th.project.captions.style.highlightColor).toBe(primary);
      expect(th.project.background.colors).toEqual(derivedBackground(primary).colors);
      expect(th.project.slides.find((s) => s.id === "s1")!.accent).toBe(primary);
    }
    // turning the kit off restores the layers below
    expect(brandPalette({ ...defaultBrand(), enabled: false })).toBeNull();
  });

  it("intro and outro cards: inserted first and last with their durations, theme backdrop, logo, brand font", () => {
    const b = defaultBrand();
    const p = resolveProject({
      brand: { ...b, enabled: true, logo: { ...b.logo, path: "logo.png", aspect: 3 }, intro: { ...b.intro, enabled: true, title: "Acme", durationMs: 1500 }, outro: { ...b.outro, enabled: true, title: "acme.dev", durationMs: 1000 } },
    });
    const pl = buildRenderPlan({ meta: META, events: demoSession(), project: p });
    expect(pl.slides.map((s) => s.id)).toEqual(["brand-intro", "brand-outro"]);
    expect(pl.slides[0]).toMatchObject({ outStart: 0, outEnd: 1500 });
    expect(pl.slides[1]!.outEnd - pl.slides[1]!.outStart).toBe(1000);
    expect(pl.output.durationMs).toBe(META.durationMs + 2500);
    const f = pl.frames[Math.round(0.75 * 60)]!;
    expect(f.slide?.id).toBe("brand-intro");
    expect(f.slide!.ops[0]).toEqual({ op: "background" });
    const img = f.slide!.ops.find((o) => o.op === "image") as Extract<AnnOp, { op: "image" }>;
    expect(img).toMatchObject({ path: "logo.png" });
    expect(img.w).toBe(img.h * 3);
    const title = f.slide!.ops.find((o) => o.op === "text") as Extract<AnnOp, { op: "text" }>;
    expect(title.text).toBe("Acme");
    expect(title.font).toBe("Inter");
    expect(pl.fonts?.map((x) => x.family)).toEqual(["Inter"]);
    expect(pl.watermark).toMatchObject({ path: "logo.png" });
  });

  it("validates the kit", () => {
    const b = defaultBrand();
    expect(() => resolveProject({ brand: { ...b, colors: { ...b.colors, primary: "blue" } } })).toThrow(/brand colours/);
    expect(() => resolveProject({ brand: { ...b, font: "Comic Nope" } })).toThrow(/brand\.font/);
    expect(() => resolveProject({ brand: { ...b, logo: { ...b.logo, opacity: 2 } } })).toThrow(/opacity/);
    expect(resolveProject({ brand: { ...b, font: "Mine", customFonts: [{ family: "Mine", regular: "fonts/m.ttf", bold: "fonts/m-b.ttf" }] } }).brand.font).toBe("Mine");
  });
});

describe("onlyFrames", () => {
  it("builds just the asked frames, identical to the full plan's", () => {
    const p = resolveProject({ annotations: [boxAnn()] });
    const full = buildRenderPlan({ meta: META, events: demoSession(), project: p });
    const some = buildRenderPlan({ meta: META, events: demoSession(), project: p, onlyFrames: [5, 300, 600] });
    expect(some.frames).toEqual([full.frames[5], full.frames[300], full.frames[600]]);
    expect(some.output).toEqual(full.output);
  });
});

export type { Preset };
