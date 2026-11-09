/**
 * Hand-written captions (Windows bug #15), with no transcript at all.
 * Bounds (set before the first run): the Captions lane "+" adds a cue at the playhead and the
 * Captions tab button adds a second; text edits from the selection card; dragging a cue's right edge
 * on the lane by +60 px lengthens it by 60 / px-per-ms (+-1 frame); Split at the playhead gives two
 * cues and Merge next joins them back; the export burns cue 1's text only inside cue 1's time and
 * cue 2's only inside cue 2's (OCR of the caption pill, located where the band differs from the
 * caption-free frame at 2.0 s, when tesseract is installed) and >= 1000 band pixels differ from the
 * caption-free frame (RGB sum > 90) inside each cue, < 50 outside (0.2 s; first run used a band mean
 * >= 20, which the ~5 % caption pill cannot reach: measured 3.8 / 5.2 with the text OCR'd correctly); the SRT export lists both cues with the right
 * times (+-1 ms); an imported SRT replaces the cues.
 */
import { test } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { drag, exportMp4, frameAt, proj, seekSrc, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

/**
 * OCR of the caption in the band y0..y1. The sample's 8 px checkerboard defeats tesseract on the whole
 * band, so the band is cropped to the box where it differs from a caption-free frame (the caption pill).
 */
function ocrBand(f: { w: number; h: number; rgb: Buffer }, y0: number, y1: number, bare: { rgb: Buffer }): string {
  const tmp = path.join(os.tmpdir(), `lens-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const ya = Math.round(y0), yb = Math.round(y1);
  let bx0 = f.w, bx1 = -1, by0 = yb, by1 = -1;
  for (let y = ya; y < yb; y++)
    for (let x = 0; x < f.w; x++) {
      const i = (y * f.w + x) * 3;
      if (Math.abs(f.rgb[i]! - bare.rgb[i]!) + Math.abs(f.rgb[i + 1]! - bare.rgb[i + 1]!) + Math.abs(f.rgb[i + 2]! - bare.rgb[i + 2]!) > 90) {
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      }
    }
  if (bx1 < 0) return "";
  const x0 = Math.max(0, bx0 - 2), cy0 = Math.max(ya, by0 - 2);
  const w = Math.min(f.w, bx1 + 3) - x0, h = Math.min(yb, by1 + 3) - cy0;
  const band = f.rgb.subarray(cy0 * f.w * 3, (cy0 + h) * f.w * 3);
  fs.writeFileSync(`${tmp}.rgb`, band);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${f.w}x${h}`, "-i", `${tmp}.rgb`, "-vf", `crop=${w}:${h}:${x0}:0,scale=iw*3:ih*3,format=gray,negate`, `${tmp}.png`]);
  const r = spawnSync("tesseract", [`${tmp}.png`, "-", "--psm", "7"], { encoding: "utf8" });
  fs.rmSync(`${tmp}.rgb`, { force: true });
  fs.rmSync(`${tmp}.png`, { force: true });
  return (r.stdout ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

test("two hand-written captions burn in at the right times", async () => {
  const dir = uxBundle("captions");
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  await smallExport(page, 4000);
  // 1: Captions lane "+" at 0.5 s
  await seekSrc(page, 500);
  await page.getByTestId("add-caption").scrollIntoViewIfNeeded();
  await page.getByTestId("add-caption").click();
  let cues = (await proj(page)).captions.cues;
  expect(cues).toHaveLength(1);
  expect((await proj(page)).captions.enabled).toBe(true);
  await page.getByTestId("sel-cue-text").fill("HELLO LENS");
  await page.getByTestId("sel-cue-text").blur();
  // drag its right edge +60 px on the lane
  const blk = page.getByTestId(`block-caption-${cues[0].id}`);
  const bb = (await blk.boundingBox())!;
  const pps = await page.evaluate(() => { const l = document.querySelector('[data-testid="lane-caption"]')!.getBoundingClientRect(); return l.width; });
  void pps;
  const end0 = (await proj(page)).captions.cues[0].endMs;
  await page.keyboard.down("Alt"); // no snapping for an exact delta
  await drag(page, { x: bb.x + bb.width - 2, y: bb.y + bb.height / 2 }, { x: bb.x + bb.width - 2 + 60, y: bb.y + bb.height / 2 });
  await page.keyboard.up("Alt");
  cues = (await proj(page)).captions.cues;
  const pxPerMs = bb.width / (end0 - cues[0].startMs);
  console.log("edge drag end", end0, "->", cues[0].endMs, "expected +", (60 / pxPerMs).toFixed(0));
  expect(Math.abs(cues[0].endMs - end0 - 60 / pxPerMs)).toBeLessThanOrEqual(34);
  expect(cues[0].text).toBe("HELLO LENS");
  // set exact times for the burn-in check: cue 1 0.5-1.5 s
  await page.evaluate(() => (window as any).__lens.store.updateCue((window as any).__lens.store.get().project.captions.cues[0].id, { startMs: 500, endMs: 1500 }));
  // 2: Captions tab button at 2.5 s
  await seekSrc(page, 2500);
  await page.getByTestId("tab-captions").click();
  await page.getByTestId("cue-add").click();
  cues = (await proj(page)).captions.cues;
  expect(cues).toHaveLength(2);
  await page.getByTestId("cue-text-1").fill("SECOND CAPTION");
  await page.getByTestId("cue-text-1").press("Enter");
  await page.evaluate(() => { const s = (window as any).__lens.store; s.updateCue(s.get().project.captions.cues[1].id, { startMs: 2500, endMs: 3500 }); });
  // split + merge round trip on cue 2
  await page.evaluate(() => (window as any).__lens.store.select({ track: "caption", index: 1 }));
  await seekSrc(page, 3000);
  await page.getByTestId("sel-cue-split").click();
  expect((await proj(page)).captions.cues).toHaveLength(3);
  await page.evaluate(() => (window as any).__lens.store.select({ track: "caption", index: 1 }));
  await page.getByTestId("sel-cue-merge").click();
  cues = (await proj(page)).captions.cues;
  expect(cues.map((c: any) => [c.startMs, c.endMs, c.text])).toEqual([[500, 1500, "HELLO LENS"], [2500, 3500, "SECOND CAPTION"]]);
  // SRT export
  const srt = await page.evaluate(() => (window as any).__lens.store.subtitleFile(null, "srt").text);
  expect(srt).toContain("00:00:00,500 --> 00:00:01,500");
  expect(srt).toContain("00:00:02,500 --> 00:00:03,500");
  await shot(page, `captions${PACKAGED ? "-app" : ""}`);
  // export and look for the texts
  const mp4 = await exportMp4(page, dir);
  const H = 360;
  const band = await page.evaluate(() => { const s = (window as any).__lens.store.get(); const f = s.plan.frames.find((x: any) => x.caption); return f ? f.caption : null; });
  expect(band).not.toBeNull();
  const y0 = H * 0.7, y1 = H;
  const bare = frameAt(mp4, 2.0);
  const res: Record<string, string> = {};
  for (const t of [1.0, 2.0, 3.0]) res[String(t)] = ocrBand(frameAt(mp4, t), y0, y1, bare);
  console.log("OCR", res);
  const hasOcr = spawnSync("tesseract", ["--version"]).status === 0;
  if (hasOcr) {
    expect(res["1"]).toContain("HELLO");
    expect(res["1"]).not.toContain("SECOND");
    expect(res["3"]).toContain("SECOND");
    expect(res["2"]).not.toMatch(/HELLO|SECOND/);
  }
  // band pixels differ from the caption-free frame only inside the cues: count the pixels whose RGB
  // differs by > 90 (the caption pill; a mean over the whole band dilutes a ~5 % pill to ~4)
  const changed = (a: { rgb: Buffer; w: number }, b: { rgb: Buffer }) => { let n = 0; for (let i = Math.round(y0) * a.w * 3; i < Math.round(y1) * a.w * 3; i += 3) if (Math.abs(a.rgb[i]! - b.rgb[i]!) + Math.abs(a.rgb[i + 1]! - b.rgb[i + 1]!) + Math.abs(a.rgb[i + 2]! - b.rgb[i + 2]!) > 90) n++; return n; };
  const d1 = changed(frameAt(mp4, 1.0), bare), d3 = changed(frameAt(mp4, 3.0), bare), d0 = changed(frameAt(mp4, 0.2), bare);
  console.log("band pixels changed vs 2.0 s: 1.0 s", d1, "3.0 s", d3, "0.2 s", d0, "of", Math.round(y1 - y0) * 640);
  expect(d1).toBeGreaterThanOrEqual(1000);
  expect(d3).toBeGreaterThanOrEqual(1000);
  expect(d0).toBeLessThan(50);
  // SRT import replaces the cues (no captions yet would also work)
  await page.evaluate(() => (window as any).__lens.store.importSubtitles("1\n00:00:00,250 --> 00:00:00,900\nImported one\n\n2\n00:00:01,000 --> 00:00:02,000\nImported two\n", true));
  expect((await proj(page)).captions.cues.map((c: any) => c.text)).toEqual(["Imported one", "Imported two"]);
  await lens.close();
});
