/**
 * Caption fonts (Windows request "diff diff fonts for the captions"): pick three different fonts in the
 * Captions inspector, export each, and compare the burned-in caption with the preview.
 *
 * Bounds, set before the first run. Caption on an opaque black pill (white text, 84 px at 1080p, 720p
 * output) so its pixels do not depend on the recording behind it; the caption band is the part of the
 * frame that changes when captions are turned off (preview pixels, RGB sum > 90). Glyph pixels = luma
 * > 128 inside that band.
 *  - preview vs export, per font: mean |RGB| difference over the band <= 12 (JPEG q0.95 + H.264 noise
 *    only) and glyph-mask IoU >= 0.85;
 *  - font vs font (exports): glyph masks differ, IoU <= 0.6 for every pair, and >= 1500 band pixels
 *    differ by RGB sum > 90; also the band width changes (the pill hugs each font's advance widths);
 *  - every option of the font picker is drawn in its own face (the button's computed font-family names
 *    that family, and the page has the face loaded);
 *  - a style preset click + Save writes its fields to project.json (read back from disk).
 */
import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { editProject, exportMp4, frameAt, proj, seekSrc, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const FONTS = [
  { family: "Poppins", id: "poppins" },
  { family: "Bebas Neue", id: "bebas-neue" },
  { family: "Caveat", id: "caveat" },
];
const T_MS = 500; // source == output time here (no cuts before it)

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

const diff3 = (a: Buffer, b: Buffer, i: number) => Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
const luma = (a: Buffer, i: number) => 0.299 * a[i]! + 0.587 * a[i + 1]! + 0.114 * a[i + 2]!;

/** Pixels of `cap` that differ from the caption-free band `bare` (the pill + text). */
function captionMask(cap: Band, bare: Band): Uint8Array {
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

function bboxW(m: Uint8Array, w: number): number {
  let x0 = w, x1 = -1;
  for (let p = 0; p < m.length; p++) if (m[p]) { const x = p % w; if (x < x0) x0 = x; if (x > x1) x1 = x; }
  return x1 - x0 + 1;
}

test("three caption fonts: export differs per font and matches the preview", async () => {
  test.setTimeout(600_000);
  const dir = uxBundle("caption-fonts", {
    zoom: { auto: false },
    output: { resolution: 720, fps: 30 },
    edits: { cuts: [{ startMs: 1000, endMs: 6000 }] },
    captions: { enabled: true, wordHighlight: false, cues: [{ id: "c1", startMs: 0, endMs: 1000, text: "Lens fonts Hg 42" }], style: { fontSize: 84, background: { enabled: true, color: "#000000", opacity: 1 } } },
  });
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  await page.getByTestId("tab-captions").click();
  // the picker renders after the tab switch; on a loaded box the $$eval below can run before it does
  await page.getByTestId("caption-font-poppins").waitFor({ timeout: 30_000 });
  const H = await page.evaluate(() => (window as any).__lens.store.get().plan.output.height);
  const y0 = Math.round(H * 0.62);

  // every picker option is drawn in its own face
  const opts = await page.$$eval('[data-testid^="caption-font-"]', (bs) => bs.map((b) => ({ id: b.getAttribute("data-testid"), ff: getComputedStyle(b).fontFamily })));
  console.log("picker options", opts.length, opts.map((o) => `${o.id}: ${o.ff.split(",")[0]}`).join(" | "));
  expect(opts.length).toBeGreaterThanOrEqual(9);
  for (const f of FONTS) {
    const o = opts.find((x) => x.id === `caption-font-${f.id}`)!;
    expect(o.ff).toContain(`Lens ${f.family}`);
  }
  await page.waitForFunction((fams) => fams.every((f: string) => document.fonts.check(`bold 20px "Lens ${f}"`)), FONTS.map((f) => f.family), { timeout: 30_000 });

  // caption-free reference band (preview) for the caption mask
  await editProject(page, "Captions off", "(p) => ({ ...p, captions: { ...p.captions, enabled: false } })");
  await seekSrc(page, T_MS);
  const bare = await previewBand(page, y0);
  await editProject(page, "Captions on", "(p) => ({ ...p, captions: { ...p.captions, enabled: true } })");

  const res: Array<{ family: string; prev: Band; exp: Band; gPrev: Uint8Array; gExp: Uint8Array; meanDiff: number; iouPE: number; width: number }> = [];
  for (const f of FONTS) {
    await page.getByTestId(`caption-font-${f.id}`).click();
    expect((await proj(page)).captions.style.font).toBe(f.family);
    await page.waitForFunction((fam) => document.fonts.check(`bold 20px "Lens ${fam}"`), f.family);
    await seekSrc(page, T_MS + 100);
    await seekSrc(page, T_MS);
    const prev = await previewBand(page, y0);
    const mp4 = await exportMp4(page, dir);
    // the "Export ready" sheet covers the inspector (the next font click) and keeps exporting.state at "done"
    await page.evaluate(() => (window as any).__lens.store.closeExport());
    const exp = exportBand(mp4, y0);
    expect([exp.w, exp.h]).toEqual([prev.w, prev.h]);
    const region = captionMask(prev, bare);
    let n = 0, s = 0;
    for (let p = 0; p < region.length; p++) if (region[p]) { n++; s += diff3(prev.rgb, exp.rgb, p * 3) / 3; }
    const meanDiff = n ? s / n : 0;
    const gPrev = glyphs(prev, region);
    const gExp = glyphs(exp, region);
    const iouPE = iou(gPrev, gExp);
    const width = bboxW(region, prev.w);
    console.log(`${f.family}: band px ${n}, glyph px ${gPrev.reduce((a, b) => a + b, 0)}, preview-vs-export mean |RGB| ${meanDiff.toFixed(2)} (bound 12), glyph IoU ${iouPE.toFixed(3)} (bound >= 0.85), pill width ${width} px`);
    expect(n).toBeGreaterThan(2000);
    expect(meanDiff).toBeLessThanOrEqual(12);
    expect(iouPE).toBeGreaterThanOrEqual(0.85);
    res.push({ family: f.family, prev, exp, gPrev, gExp, meanDiff, iouPE, width });
  }
  await shot(page, `caption-fonts${PACKAGED ? "-app" : ""}`);
  for (let a = 0; a < res.length; a++)
    for (let b = a + 1; b < res.length; b++) {
      const A = res[a]!, B = res[b]!;
      let changed = 0;
      for (let p = 0; p < A.exp.w * A.exp.h; p++) if (diff3(A.exp.rgb, B.exp.rgb, p * 3) > 90) changed++;
      const gi = iou(A.gExp, B.gExp);
      console.log(`${A.family} vs ${B.family} (exports): ${changed} band px differ (bound >= 1500), glyph IoU ${gi.toFixed(3)} (bound <= 0.6), pill width ${A.width} vs ${B.width}`);
      expect(changed).toBeGreaterThanOrEqual(1500);
      expect(gi).toBeLessThanOrEqual(0.6);
      expect(A.width).not.toBe(B.width);
    }

  // a one-click style persists in project.json
  await page.getByTestId("caption-preset-bold-pop").click();
  await page.getByTestId("save").click();
  await page.waitForFunction(() => !(window as any).__lens.store.get().dirty);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  console.log("saved style", JSON.stringify(saved.captions.style));
  expect(saved.captions.style).toMatchObject({ preset: "bold-pop", font: "Montserrat", uppercase: true, stroke: { enabled: true } });
  await lens.close();
});
