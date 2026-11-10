/**
 * Caption fonts and styles, second batch (Windows v0.1.3: "add more styles n fonts and add option they
 * can import custom fonts too"): the pinned font catalog, the new style fields (old projects unchanged),
 * font file validation (TTF / OTF / WOFF / WOFF2, non-fonts rejected, size cap), imported fonts in the
 * project (embedding and resolution), the missing-font fallback, and the CSS / Google Fonts helpers.
 *
 * Fixtures are built in the test from the committed first-batch TTFs (assets/fonts): no font binary is
 * added to the repository.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyCaptionPreset, buildRenderPlan, BUILTIN_FONTS, captionEffects, captionMotion, captionNeedsProgress, catalogFiles, CAPTION_FONTS, CAPTION_PRESETS, cleanFamilyName,
  defaultProject, EXTRA_FONTS, familyFromFileName, filterCaptionFonts, FontFileError, fontFiles, fontUrlKind, GOOGLE_FONTS_COMMIT, googleFontsCssUrl, importedFontFileName,
  MAX_FONT_BYTES, parseFontFaceCss, parseFontInfo, pickFontFaces, resolveProject, sniffFontFormat, withFontFallback,
} from "../src/index.js";
import type { InputEvent } from "../src/index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FONTS = path.join(REPO, "assets", "fonts");
const TTF = new Uint8Array(fs.readFileSync(path.join(FONTS, "Poppins-Regular.ttf")));
const DZ = { inflate: (b: Uint8Array) => new Uint8Array(zlib.inflateSync(b)), brotli: (b: Uint8Array) => new Uint8Array(zlib.brotliDecompressSync(b)) };
const meta = { width: 1280, height: 720, fps: 30, durationMs: 2000, pixelRatio: 1 };
const events: InputEvent[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 100, type: "move", x: 600, y: 300 }) as InputEvent);
const words = [
  { text: "Caption", startMs: 200, endMs: 700 },
  { text: "fonts", startMs: 800, endMs: 1300 },
  { text: "again", startMs: 1400, endMs: 1800 },
];

/** sfnt tables of a TTF: [tag, bytes]. */
function tables(sfnt: Uint8Array): Array<[string, Uint8Array]> {
  const d = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const n = d.getUint16(4);
  const out: Array<[string, Uint8Array]> = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(...sfnt.subarray(o, o + 4));
    out.push([tag, sfnt.subarray(d.getUint32(o + 8), d.getUint32(o + 8) + d.getUint32(o + 12))]);
  }
  return out;
}

/** WOFF 1.0 container of a TTF (every table zlib-compressed). */
function toWoff(sfnt: Uint8Array): Uint8Array {
  const ts = tables(sfnt).map(([tag, b]) => ({ tag, orig: b, comp: new Uint8Array(zlib.deflateSync(b)) }));
  const n = ts.length;
  let off = 44 + n * 20;
  const parts: Uint8Array[] = [];
  const dir = new Uint8Array(n * 20);
  const dv = new DataView(dir.buffer);
  ts.forEach((t, i) => {
    const data = t.comp.length < t.orig.length ? t.comp : t.orig;
    for (let k = 0; k < 4; k++) dir[i * 20 + k] = t.tag.charCodeAt(k);
    dv.setUint32(i * 20 + 4, off);
    dv.setUint32(i * 20 + 8, data.length);
    dv.setUint32(i * 20 + 12, t.orig.length);
    const pad = (4 - (data.length % 4)) % 4;
    parts.push(data, new Uint8Array(pad));
    off += data.length + pad;
  });
  const head = new Uint8Array(44);
  const hv = new DataView(head.buffer);
  head.set([0x77, 0x4f, 0x46, 0x46]); // wOFF
  hv.setUint32(4, 0x00010000);
  hv.setUint32(8, off);
  hv.setUint16(12, n);
  return Buffer.concat([head, dir, ...parts]);
}

const WOFF2_KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep"];
/** WOFF2 container of a TTF with the null transform on every table (valid per the spec, flags 0xC0 on glyf / loca). */
function toWoff2(sfnt: Uint8Array): Uint8Array {
  const ts = tables(sfnt);
  const dir: number[] = [];
  const b128 = (v: number) => {
    const out: number[] = [];
    do {
      out.unshift(v & 0x7f);
      v >>>= 7;
    } while (v);
    return out.map((x, i) => (i < out.length - 1 ? x | 0x80 : x));
  };
  for (const [tag, b] of ts) {
    const k = WOFF2_KNOWN.indexOf(tag);
    const tv = tag === "glyf" || tag === "loca" ? 3 : 0;
    if (k >= 0) dir.push((tv << 6) | k);
    else dir.push((tv << 6) | 63, ...[...tag].map((c) => c.charCodeAt(0)));
    dir.push(...b128(b.length));
  }
  const stream = new Uint8Array(zlib.brotliCompressSync(Buffer.concat(ts.map(([, b]) => b))));
  const head = new Uint8Array(48);
  const hv = new DataView(head.buffer);
  head.set([0x77, 0x4f, 0x46, 0x32]); // wOF2
  hv.setUint32(4, 0x00010000);
  hv.setUint32(8, 48 + dir.length + stream.length);
  hv.setUint16(12, ts.length);
  hv.setUint32(16, sfnt.length);
  hv.setUint32(20, stream.length);
  return Buffer.concat([head, new Uint8Array(dir), stream]);
}

describe("font catalog (second batch)", () => {
  it("adds 30+ families, each pinned by SHA-256 with an OFL / Apache licence, from one google/fonts commit", () => {
    expect(EXTRA_FONTS.length).toBeGreaterThanOrEqual(30);
    expect(GOOGLE_FONTS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    const families = new Set<string>();
    for (const f of EXTRA_FONTS) {
      expect(families.has(f.family), f.family).toBe(false);
      families.add(f.family);
      expect(["OFL-1.1", "Apache-2.0"]).toContain(f.licence);
      expect(f.dir.startsWith(f.licence === "OFL-1.1" ? "ofl/" : "apache/")).toBe(true);
      for (const file of [f.regular, f.bold, f.licenceFile]) if (file) expect(file.sha256, `${f.family} ${file.src}`).toMatch(/^[0-9a-f]{64}$/);
      expect(f.stem).toMatch(/^[A-Za-z0-9]+$/);
    }
    // every category of the picker has fonts
    for (const k of ["sans", "serif", "display", "rounded", "mono", "hand", "condensed"]) expect(EXTRA_FONTS.some((f) => f.kind === k), k).toBe(true);
    // none collides with the first batch
    for (const f of EXTRA_FONTS) expect(BUILTIN_FONTS.filter((b) => b.family === f.family)).toHaveLength(1);
  });

  it("the fetched files on disk match their pins and carry the family the catalog names", () => {
    const { fonts } = { fonts: EXTRA_FONTS };
    for (const f of fonts) {
      const files = catalogFiles(f);
      const want = [[files.regular, f.regular.sha256], ...(f.bold ? [[files.bold, f.bold.sha256]] : []), [files.licence, f.licenceFile.sha256]] as Array<[string, string]>;
      for (const [name, sha] of want) {
        const p = path.join(FONTS, name);
        expect(fs.existsSync(p), `${p} (run node assets/fonts/fetch_extra_fonts.mjs)`).toBe(true);
        expect(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"), name).toBe(sha);
      }
      const info = parseFontInfo(new Uint8Array(fs.readFileSync(path.join(FONTS, files.regular))));
      expect(info.family, files.regular).toBe(f.family);
    }
  });

  it("the picker lists every family once with its category, filters by name and category", () => {
    for (const f of EXTRA_FONTS) expect(CAPTION_FONTS.find((o) => o.family === f.family)?.kind).toBe(f.kind);
    expect(filterCaptionFonts(CAPTION_FONTS, "mono", "all").map((o) => o.family)).toEqual(expect.arrayContaining(["JetBrains Mono", "Space Mono", "IBM Plex Mono"]));
    const hand = filterCaptionFonts(CAPTION_FONTS, "", "hand");
    expect(hand.length).toBeGreaterThanOrEqual(8);
    expect(hand.every((o) => o.kind === "hand")).toBe(true);
    expect(filterCaptionFonts(CAPTION_FONTS, "LOBSTER", "display").map((o) => o.family)).toEqual(["Lobster"]);
    expect(filterCaptionFonts(CAPTION_FONTS, "lobster", "serif")).toEqual([]);
  });
});

describe("caption styles (second batch)", () => {
  const NEW = CAPTION_PRESETS.slice(6);
  it("adds 18+ presets, each a distinct look on a bundled font, each validating", () => {
    expect(NEW.length).toBeGreaterThanOrEqual(18);
    const d = defaultProject().captions.style;
    const looks = new Set(NEW.map((pr) => JSON.stringify({ ...applyCaptionPreset(d, pr.id), preset: null })));
    expect(looks.size).toBe(NEW.length);
    for (const pr of NEW) {
      expect(BUILTIN_FONTS.some((f) => f.family === pr.style.font), pr.id).toBe(true);
      expect(() => resolveProject({ captions: { style: applyCaptionPreset(d, pr.id) } }), pr.id).not.toThrow();
    }
    // the style kinds the request names are all there
    const fx = NEW.map((pr) => ({ id: pr.id, s: applyCaptionPreset(d, pr.id) }));
    const has = (fn: (s: ReturnType<typeof applyCaptionPreset>) => boolean) => fx.filter((x) => fn(x.s)).map((x) => x.id);
    for (const h of ["pill", "underline", "karaoke", "pop", "bounce"]) expect(has((s) => s.highlightStyle === h).length, h).toBeGreaterThan(0);
    expect(has((s) => s.reveal === true).length).toBeGreaterThanOrEqual(2);
    expect(has((s) => s.boxMode === "word")).toContain("word-boxes");
    expect(has((s) => s.boxMode === "line")).toContain("classic-subtitle");
    expect(has((s) => s.boxShape === "bar")).toContain("lower-third");
    expect(has((s) => !!s.gradient?.enabled)).toContain("gradient");
    expect(has((s) => !!s.glow?.enabled)).toContain("neon");
    expect(has((s) => !!s.shadow?.enabled)).toEqual(expect.arrayContaining(["soft-shadow", "comic"]));
    expect(has((s) => (s.backdropBlur ?? 0) > 0)).toContain("glass");
    expect(has((s) => !!s.line2Color)).toContain("two-tone");
  });

  it("switching from a second-batch style back to Clean leaves none of its fields behind", () => {
    const d = defaultProject().captions.style;
    for (const pr of NEW) {
      const back = applyCaptionPreset(applyCaptionPreset(d, pr.id), "clean");
      for (const k of ["reveal", "boxMode", "boxShape", "accent", "gradient", "glow", "shadow", "backdropBlur", "line2Color", "font"]) expect(back, `${pr.id} ${k}`).not.toHaveProperty(k);
      expect(back.highlightStyle).toBe("color");
    }
  });

  it("an old project plans byte-identically (no new keys in the style or the caption frames)", () => {
    const old = { captions: { enabled: true, style: { fontSize: 44, textColor: "#ffffff", highlightColor: "@highlight", background: { enabled: true, color: "#000000", opacity: 0.66 }, position: "bottom", y: 0.88, maxWordsPerLine: 5, maxCharsPerLine: 42, font: "Poppins", highlightStyle: "box" } }, output: { fps: 30, resolution: 360 } };
    const plan = buildRenderPlan({ meta, events, project: resolveProject(old), words });
    const cs = plan.style.captions as Record<string, unknown>;
    for (const k of ["reveal", "boxMode", "boxShape", "accent", "gradient", "glow", "shadow", "backdropBlur", "line2Color"]) expect(cs).not.toHaveProperty(k);
    expect(plan).not.toHaveProperty("fontFallbacks");
    const caps = plan.frames.map((f) => f.caption).filter(Boolean);
    expect(caps.length).toBeGreaterThan(10);
    for (const c of caps) {
      expect(c).not.toHaveProperty("shown");
      expect(c).not.toHaveProperty("progress");
    }
    expect(resolveProject(old)).not.toHaveProperty("customFonts");
  });

  it("reveal carries how many words are shown; pop / bounce / underline carry the spoken word's progress", () => {
    const at = (style: Record<string, unknown>, ms: number) => {
      const p = resolveProject({ captions: { enabled: true, style }, output: { fps: 30, resolution: 360 } });
      const plan = buildRenderPlan({ meta, events, project: p, words });
      return plan.frames.find((f) => f.src >= ms)!.caption!;
    };
    expect(at({ reveal: true }, 250).shown).toBe(1);
    expect(at({ reveal: true }, 900).shown).toBe(2);
    expect(at({ reveal: true }, 900).progress).toBeUndefined();
    const c = at({ highlightStyle: "pop" }, 950);
    expect(c.active).toBe(1);
    expect(c.progress!).toBeGreaterThan(0.25);
    expect(c.progress!).toBeLessThan(0.45);
    expect(at({ highlightStyle: "box" }, 950)).not.toHaveProperty("progress");
    expect(captionNeedsProgress({ highlightStyle: "underline" })).toBe(true);
    // motion curves: pop settles from 1.25 to 1.1, bounce returns to 0, underline sweeps to full width
    expect(captionMotion("pop", 0).scale).toBeCloseTo(1.25);
    expect(captionMotion("pop", 0.5).scale).toBeCloseTo(1.1);
    expect(captionMotion("bounce", 0.225).lift).toBeCloseTo(0.18);
    expect(captionMotion("bounce", 0.9).lift).toBeCloseTo(0);
    expect(captionMotion("underline", 0).sweep).toBe(0);
    expect(captionMotion("underline", 0.6).sweep).toBe(1);
    expect(captionMotion("color", 0)).toEqual({ scale: 1, lift: 0, sweep: 1 });
  });

  it("theme slots in the new colour fields resolve; bad values are refused", () => {
    const style = { ...applyCaptionPreset(defaultProject().captions.style, "lower-third"), gradient: { enabled: true, from: "@highlight", to: "#000000" } };
    const plan = buildRenderPlan({ meta, events, project: resolveProject({ captions: { enabled: true, style }, output: { fps: 30, resolution: 360 } }), words });
    expect(plan.style.captions.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(plan.style.captions.gradient!.from).toMatch(/^#[0-9a-f]{6}$/i);
    const bad = (s: Record<string, unknown>) => () => resolveProject({ captions: { style: s } });
    expect(bad({ boxMode: "cell" })).toThrow(/boxMode/);
    expect(bad({ glow: { enabled: true, color: "#fff", radius: 0.1 } })).toThrow(/glow/);
    expect(bad({ shadow: { enabled: true, color: "#000000", opacity: 2, dx: 0, dy: 0, blur: 0 } })).toThrow(/shadow/);
    expect(bad({ backdropBlur: 3 })).toThrow(/backdropBlur/);
    expect(captionEffects({})).toEqual({ reveal: false, boxMode: "block", boxShape: "rounded", accent: null, gradient: null, glow: null, shadow: null, backdropBlur: 0, line2Color: null });
  });
});

describe("font file validation", () => {
  it("reads TrueType, WOFF and WOFF2 (with the decompressors) and their family / weight", () => {
    const ttf = parseFontInfo(TTF);
    expect(ttf).toMatchObject({ format: "ttf", family: "Poppins", weight: 400, outlines: "truetype" });
    const bold = parseFontInfo(new Uint8Array(fs.readFileSync(path.join(FONTS, "Poppins-Bold.ttf"))));
    expect(bold.weight).toBe(700);
    const woff = toWoff(TTF);
    expect(sniffFontFormat(woff)).toBe("woff");
    expect(parseFontInfo(woff, DZ)).toMatchObject({ format: "woff", family: "Poppins", weight: 400 });
    const woff2 = toWoff2(TTF);
    expect(sniffFontFormat(woff2)).toBe("woff2");
    expect(parseFontInfo(woff2, DZ)).toMatchObject({ format: "woff2", family: "Poppins", weight: 400 });
    // without a decompressor the container is still checked, the name just is not read
    expect(parseFontInfo(woff2).family).toBe("");
  });

  it("rejects what is not a font, a damaged font, a collection and anything over 10 MB", () => {
    const err = (b: Uint8Array, re: RegExp) => expect(() => parseFontInfo(b, DZ)).toThrow(re);
    err(new TextEncoder().encode("<!doctype html><html>not a font</html>"), /not a font file/);
    err(new Uint8Array(0), /empty/);
    err(new Uint8Array(fs.readFileSync(path.join(REPO, "assets", "fonts", "Poppins-OFL.txt"))), /not a font file/);
    // PNG signature
    err(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), /not a font file/);
    // truncated: the table directory points past the end
    err(TTF.subarray(0, 2000), /past the end|damaged/);
    // a valid header with the head table's magic broken
    const broken = new Uint8Array(TTF);
    const head = tables(broken).find(([t]) => t === "head")![1];
    head[12] = 0;
    err(broken, /head table/);
    const ttc = new Uint8Array(64);
    ttc.set([0x74, 0x74, 0x63, 0x66]);
    err(ttc, /collections/);
    const big = new Uint8Array(MAX_FONT_BYTES + 1);
    big.set(TTF.subarray(0, 12));
    err(big, /larger than 10 MB/);
    expect(() => parseFontInfo(TTF.subarray(0, 2000))).toThrow(FontFileError);
  });

  it("names: cleaned family, file names, family from a file name", () => {
    expect(cleanFamilyName(' My "Font"; </style> ')).toBe("My Font style");
    expect(importedFontFileName("Lobster Two", 700, "woff2")).toBe("Lobster-Two-700.woff2");
    expect(familyFromFileName("Grand_Hotel-Regular.ttf")).toBe("Grand Hotel");
    expect(familyFromFileName("Acme-700.woff2")).toBe("Acme");
  });
});

describe("imported fonts in the project", () => {
  const imported = { family: "Acme Sans", regular: "fonts/Acme-Sans-400.ttf", bold: "fonts/Acme-Sans-700.ttf", source: { kind: "file" as const, name: "Acme.ttf" } };

  it("customFonts round-trips, resolves before the built-ins, and its files reach plan.fonts (bundle-relative)", () => {
    const raw = JSON.parse(JSON.stringify({ customFonts: [imported], captions: { enabled: true, style: { font: "Acme Sans" } }, output: { fps: 30, resolution: 360 } }));
    const p = resolveProject(raw);
    expect(p.customFonts).toEqual([imported]);
    expect(fontFiles("Acme Sans", p.brand, p.customFonts)).toEqual({ family: "Acme Sans", regular: imported.regular, bold: imported.bold });
    expect(fontFiles("Poppins", p.brand, p.customFonts)!.regular).toBe("builtin:Poppins-Regular.ttf");
    const plan = buildRenderPlan({ meta, events, project: p, words });
    expect(plan.style.captions.font).toBe("Acme Sans");
    expect(plan.fonts).toEqual([{ family: "Acme Sans", regular: imported.regular, bold: imported.bold }]);
    expect(() => resolveProject({ customFonts: [{ family: "x", regular: "" }] })).toThrow(/customFonts/);
  });

  it("a missing font falls back to the default font everywhere in the plan and is named", () => {
    const p = resolveProject({ customFonts: [imported], captions: { enabled: true, style: { font: "Acme Sans" } }, output: { fps: 30, resolution: 360 },
      slides: [{ id: "s", atMs: 100, durationMs: 400, title: "Hi", font: "Acme Sans" }] });
    const plan = buildRenderPlan({ meta, events, project: p, words });
    expect(JSON.stringify(plan.frames)).toContain('"font":"Acme Sans"');
    const fb = withFontFallback(plan, ["Acme Sans"]);
    expect(fb.style.captions.font).toBeUndefined();
    expect(fb.fonts).toEqual([]);
    expect(fb.fontFallbacks).toEqual(["Acme Sans"]);
    expect(JSON.stringify(fb.frames)).not.toContain("Acme Sans");
    expect(fb.frames.length).toBe(plan.frames.length);
    // nothing missing: the same object
    expect(withFontFallback(plan, [])).toBe(plan);
    expect(withFontFallback(plan, ["DejaVu Sans"])).toBe(plan);
  });
});

describe("CSS @font-face and Google Fonts helpers", () => {
  const css = `/* latin-ext */
@font-face { font-family: 'Lobster Two'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/x/ext.woff2) format('woff2'); unicode-range: U+0100-02AF, U+1E00-1EFF; }
/* latin */
@font-face { font-family: 'Lobster Two'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/x/latin400.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }
@font-face { font-family: 'Lobster Two'; font-style: italic; font-weight: 700; src: url(/s/x/italic700.ttf) format('truetype'); }
@font-face { font-family: "Lobster Two"; font-style: normal; font-weight: 700; src: local('x'), url("../s/x/latin700.ttf") format("truetype"); }`;

  it("parses faces, makes urls absolute, and picks the Latin regular + bold", () => {
    const faces = parseFontFaceCss(css, "https://fonts.example.com/css/fonts.css");
    expect(faces).toHaveLength(4);
    expect(faces[3]).toMatchObject({ family: "Lobster Two", weight: 700, style: "normal", url: "https://fonts.example.com/s/x/latin700.ttf" });
    expect(faces[2]!.url).toBe("https://fonts.example.com/s/x/italic700.ttf");
    const pick = pickFontFaces(faces)!;
    expect(pick.regular.url).toBe("https://fonts.gstatic.com/s/x/latin400.woff2");
    expect(pick.bold!.url).toBe("https://fonts.example.com/s/x/latin700.ttf");
    expect(pickFontFaces(faces.slice(0, 2))!.bold).toBeNull();
    expect(pickFontFaces([])).toBeNull();
  });

  it("builds the css2 request and tells font URLs from stylesheets", () => {
    expect(googleFontsCssUrl("Lobster Two")).toBe("https://fonts.googleapis.com/css2?family=Lobster+Two:wght@400;700&display=swap");
    expect(googleFontsCssUrl("Lobster", [])).toBe("https://fonts.googleapis.com/css2?family=Lobster&display=swap");
    expect(fontUrlKind("https://fonts.googleapis.com/css2?family=Lobster")).toBe("css");
    expect(fontUrlKind("https://example.com/a/Font.WOFF2?v=3")).toBe("font");
    expect(fontUrlKind("https://example.com/fonts")).toBe("css");
    expect(fontUrlKind("https://example.com/fonts", "font/ttf")).toBe("font");
  });
});
