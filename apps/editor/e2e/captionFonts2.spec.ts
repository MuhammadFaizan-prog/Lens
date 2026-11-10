/**
 * Caption fonts and styles, second batch (Windows v0.1.3: "add more styles n fonts and add option they
 * can import custom fonts too"), through the Captions tab:
 *
 *  - the font picker has 41+ fonts, a search box and categories, each option drawn in its own face;
 *  - three new one-click styles (line boxes, neon glow, lower-third bar): each is exported and the
 *    burned-in caption is compared with the preview;
 *  - a font file imported from this computer (input[type=file]; the fixture is the SHA-256-pinned
 *    Lobster TTF that assets/fonts/fetch_extra_fonts.mjs fetched, nothing committed) is copied into the
 *    project's fonts/ folder, listed under "My fonts" with the licence reminder, used by the captions,
 *    exported and compared with the preview;
 *  - with its file gone the font falls back to the default with a visible warning; "remove" takes it out.
 *
 * Bounds, set before the first run (as ux-caption-fonts): caption region = the pixels that differ from the
 * caption-free preview (RGB sum > 90). Preview vs export, per look: mean |RGB| over the region <= 12
 * (JPEG / H.264 noise only); glyph-mask IoU >= 0.8 for looks with a solid text colour; the region has
 * > 2000 px. The imported font differs from the default face (glyph IoU <= 0.6).
 */
import { test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, shot, EDITOR } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { editProject, exportMp4, frameAt, proj, seekSrc, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const T_MS = 500;
const FIXTURE = path.resolve(EDITOR, "..", "..", "assets", "fonts", "Lobster-Regular.ttf");
const STYLES = ["classic-subtitle", "neon", "lower-third"];

interface Band { w: number; h: number; y0: number; rgb: Buffer }

async function previewBand(page: import("@playwright/test").Page, y0: number): Promise<Band> {
  const r = await page.evaluate((yy) => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, yy, c.width, c.height - yy).data;
    const rgb = new Uint8Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]!; rgb[j + 1] = d[i + 1]!; rgb[j + 2] = d[i + 2]!; }
    let s = "";
    for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode(...rgb.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height - yy, b64: btoa(s) };
  }, y0);
  return { w: r.w, h: r.h, y0, rgb: Buffer.from(r.b64, "base64") };
}

function exportBand(mp4: string, y0: number): Band {
  const f = frameAt(mp4, T_MS / 1000);
  return { w: f.w, h: f.h - y0, y0, rgb: f.rgb.subarray(y0 * f.w * 3) };
}

const OUT = path.join(EDITOR, "test-results", "caption-fonts2");
/** Keep a band as PNG (preview / export side by side material for the report). */
function saveBand(name: string, b: Band): void {
  fs.mkdirSync(OUT, { recursive: true });
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${b.w}x${b.h}`, "-i", "pipe:0", "-frames:v", "1", path.join(OUT, `${name}.png`)], { input: b.rgb });
}

const diff3 = (a: Buffer, b: Buffer, i: number) => Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
const luma = (a: Buffer, i: number) => 0.299 * a[i]! + 0.587 * a[i + 1]! + 0.114 * a[i + 2]!;

function regionOf(cap: Band, bare: Band): Uint8Array {
  const m = new Uint8Array(cap.w * cap.h);
  for (let p = 0; p < m.length; p++) if (diff3(cap.rgb, bare.rgb, p * 3) > 90) m[p] = 1;
  return m;
}
function glyphs(b: Band, region: Uint8Array): Uint8Array {
  const m = new Uint8Array(b.w * b.h);
  for (let p = 0; p < m.length; p++) if (region[p] && luma(b.rgb, p * 3) > 128) m[p] = 1;
  return m;
}
function iou(a: Uint8Array, b: Uint8Array): number {
  let i = 0, u = 0;
  for (let p = 0; p < a.length; p++) { if (a[p] && b[p]) i++; if (a[p] || b[p]) u++; }
  return u ? i / u : 1;
}

test("new caption styles and an imported font: exports match the preview; My fonts, licence note, fallback", async () => {
  test.setTimeout(900_000);
  expect(fs.existsSync(FIXTURE), `${FIXTURE} (node assets/fonts/fetch_extra_fonts.mjs)`).toBe(true);
  const dir = uxBundle("caption-fonts2", {
    zoom: { auto: false },
    output: { resolution: 720, fps: 30 },
    edits: { cuts: [{ startMs: 1000, endMs: 6000 }] },
    captions: { enabled: true, wordHighlight: false, cues: [{ id: "c1", startMs: 0, endMs: 1000, text: "Lens fonts Hg 42" }], style: { fontSize: 84 } },
  });
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  await page.getByTestId("tab-captions").click();
  await page.getByTestId("caption-font-poppins").waitFor({ timeout: 30_000 });
  const H = await page.evaluate(() => (window as any).__lens.store.get().plan.output.height);
  const y0 = Math.round(H * 0.55);

  // picker: 41+ fonts, each in its own face; search and category filter
  const fontButtons = () => page.$$eval('[data-testid="caption-font-list"] button[role="radio"]', (bs) => bs.map((b) => ({ id: b.getAttribute("data-testid"), ff: getComputedStyle(b).fontFamily, text: b.textContent })));
  const all = await fontButtons();
  console.log("picker options", all.length);
  expect(all.length).toBeGreaterThanOrEqual(42); // theme + 41 families
  for (const fam of ["Lobster", "Space Mono", "Pacifico", "Anton"]) expect(all.find((o) => o.text === fam)?.ff, fam).toContain(`Lens ${fam}`);
  await page.waitForFunction(() => ["Lobster", "Anton", "Pacifico"].every((f) => document.fonts.check(`20px "Lens ${f}"`)), null, { timeout: 30_000 });
  await page.getByTestId("caption-font-search").fill("mono");
  const mono = (await fontButtons()).map((o) => o.text);
  console.log("search 'mono':", mono.join(", "));
  expect(mono).toEqual(expect.arrayContaining(["JetBrains Mono", "Space Mono", "IBM Plex Mono"]));
  expect(mono.every((t) => /mono/i.test(t ?? ""))).toBe(true);
  await page.getByTestId("caption-font-search").fill("");
  await page.getByTestId("caption-font-cat-hand").click();
  const hand = (await fontButtons()).map((o) => o.text);
  console.log("Handwriting:", hand.join(", "));
  expect(hand).toEqual(expect.arrayContaining(["Caveat", "Pacifico", "Permanent Marker"]));
  expect(hand).not.toContain("Poppins");
  await page.getByTestId("caption-font-cat-all").click();
  expect(await page.locator('[data-testid^="caption-preset-"]').count()).toBeGreaterThanOrEqual(24);

  // caption-free reference band
  await editProject(page, "Captions off", "(p) => ({ ...p, captions: { ...p.captions, enabled: false } })");
  await seekSrc(page, T_MS);
  const bare = await previewBand(page, y0);
  await editProject(page, "Captions on", "(p) => ({ ...p, captions: { ...p.captions, enabled: true } })");

  const compare = async (label: string, glyphIou: boolean) => {
    await seekSrc(page, T_MS + 100);
    await seekSrc(page, T_MS);
    const prev = await previewBand(page, y0);
    const mp4 = await exportMp4(page, dir);
    await page.evaluate(() => (window as any).__lens.store.closeExport());
    const exp = exportBand(mp4, y0);
    expect([exp.w, exp.h]).toEqual([prev.w, prev.h]);
    const tag = label.split(" (")[0]!.replace(/[^a-z0-9]+/gi, "-");
    saveBand(`${tag}-preview`, prev);
    saveBand(`${tag}-export`, exp);
    const region = regionOf(prev, bare);
    let n = 0, s = 0;
    for (let p = 0; p < region.length; p++) if (region[p]) { n++; s += diff3(prev.rgb, exp.rgb, p * 3) / 3; }
    const mean = n ? s / n : 0;
    const gi = iou(glyphs(prev, region), glyphs(exp, region));
    console.log(`${label}: caption px ${n}, preview-vs-export mean |RGB| ${mean.toFixed(2)} (bound 12), glyph IoU ${gi.toFixed(3)}${glyphIou ? " (bound >= 0.8)" : ""}`);
    expect(n).toBeGreaterThan(2000);
    expect(mean).toBeLessThanOrEqual(12);
    if (glyphIou) expect(gi).toBeGreaterThanOrEqual(0.8);
    return { prev, exp, region };
  };

  for (const id of STYLES) {
    await page.getByTestId(`caption-preset-${id}`).click();
    const st = (await proj(page)).captions.style;
    expect(st.preset).toBe(id);
    await page.waitForFunction((fam) => document.fonts.check(`20px "Lens ${fam}"`), st.font);
    await compare(`style ${id} (${st.font})`, id !== "neon");
  }
  await shot(page, `caption-styles2${PACKAGED ? "-app" : ""}`);

  // import a font file from this computer
  await page.getByTestId("caption-preset-clean").click();
  const before = await compare("default font (reference for the import)", true);
  await page.getByTestId("caption-font-import").click();
  await page.getByTestId("caption-font-import-file").click();
  await page.getByTestId("caption-font-file").setInputFiles(FIXTURE);
  await page.waitForFunction(() => (window as any).__lens.store.get().project.captions.style.font === "Lobster (imported)", null, { timeout: 30_000 });
  const p1 = await proj(page);
  expect(p1.customFonts).toEqual([expect.objectContaining({ family: "Lobster (imported)", regular: "fonts/Lobster-imported-400.ttf", bold: "fonts/Lobster-imported-400.ttf", source: expect.objectContaining({ kind: "file" }) })]);
  expect(fs.readFileSync(path.join(dir, "fonts", "Lobster-imported-400.ttf")).equals(fs.readFileSync(FIXTURE))).toBe(true);
  await expect(page.getByTestId("caption-myfont-lobster-imported")).toBeVisible();
  await expect(page.getByTestId("caption-font-licence")).toContainText("licence");
  await page.waitForFunction(() => document.fonts.check('20px "Lens Lobster (imported)"'));
  const imp = await compare("imported Lobster", true);
  const gi = iou(glyphs(before.exp, before.region), glyphs(imp.exp, imp.region));
  console.log(`imported font vs default (exports): glyph IoU ${gi.toFixed(3)} (bound <= 0.6)`);
  expect(gi).toBeLessThanOrEqual(0.6);
  await shot(page, `caption-font-imported${PACKAGED ? "-app" : ""}`);
  // a bad file is refused with a reason, nothing changes
  const bad = path.join(dir, "not-a-font.ttf");
  fs.writeFileSync(bad, "<html>nope</html>");
  await page.getByTestId("caption-font-file").setInputFiles(bad);
  await expect(page.getByTestId("caption-font-import-error")).toContainText("not a font file");
  expect((await proj(page)).customFonts).toHaveLength(1);

  // saved, then the font file disappears: the project still opens, captions fall back with a warning
  await page.getByTestId("save").click();
  await page.waitForFunction(() => !(window as any).__lens.store.get().dirty);
  fs.renameSync(path.join(dir, "fonts"), path.join(dir, "fonts-moved"));
  await page.reload();
  await page.getByTestId("tab-captions").click();
  await expect(page.getByTestId("caption-font-missing")).toContainText("Lobster (imported)", { timeout: 30_000 });
  const fb = await page.evaluate(() => (window as any).__lens.store.get().plan);
  expect(fb.fontFallbacks).toEqual(["Lobster (imported)"]);
  expect(fb.style.captions.font).toBeUndefined();
  await shot(page, `caption-font-missing${PACKAGED ? "-app" : ""}`);
  // remove it from My fonts: captions go back to the theme font
  await page.getByTestId("caption-myfont-remove-lobster-imported").click();
  await page.waitForFunction(() => !(window as any).__lens.store.get().project.captions.style.font);
  expect((await proj(page)).customFonts ?? []).toEqual([]);
  await lens.close();
});
