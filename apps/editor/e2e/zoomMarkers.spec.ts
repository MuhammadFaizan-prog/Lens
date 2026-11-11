/**
 * Hotkey zoom markers (demand #19): a recording whose marker log (markers.jsonl) has two "zoom here"
 * markers opens with one zoom block per marker, and the export is zoomed there.
 * Bounds (set before the first run):
 *  - two manual zoom blocks (ids marker-*), each starting within 1 frame (33.3 ms at 30 fps) of its
 *    marker, aimed at the logged cursor (within 0.5 source px); the Zoom lane shows them at those times;
 *  - plan: the camera is at scale 1 (<= 1.001) on every frame before the first marker, starts zooming
 *    within 1 frame of each marker, and is >= 1.9x 1.2 s after each marker;
 *  - export (MP4 decoded): 1.2 s after each marker the sample's red dot (= the marker point) sits within
 *    4 output px of the screen's centre (the crop is centred on the marker) and the dot covers 3.2x-4.8x
 *    the pixels it covers unzoomed (2x zoom = 4x area); before the first marker the dot is at its
 *    unzoomed spot (>= 40 px from the centre).
 * Harness changes after the first runs (bounds unchanged): run 1 took the centroid of both sample dots
 * before the zoom (now a box around the first one); run 2 measured the zoom by the grey square's area,
 * but at 360p the 8 px checkerboard averages to the same grey, so the count was not the square's (now
 * the red dot's own pixel count, at 720p so the unzoomed dot is ~8 px wide).
 */
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { editProject, exportMp4, frameAt, proj, redCentroid, UX_SAMPLE } from "./uxHelpers";
import { EDITOR } from "./helpers";

test.afterAll(() => closeAll());

const MARKERS = [
  { t: 1000, x: 900, y: 250 },
  { t: 3500, x: 320, y: 520 },
];
const FPS = 30;
const FRAME = 1000 / FPS;

/** The UX sample with no project.json yet (a fresh recording) and a marker log. */
function markerBundle(): string {
  if (!fs.existsSync(path.join(UX_SAMPLE, "screen.mp4"))) execFileSync("python3", [path.join(EDITOR, "scripts", "make_ux_sample.py"), UX_SAMPLE]);
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `markers-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["screen.mp4", "meta.json", "events.jsonl"]) fs.copyFileSync(path.join(UX_SAMPLE, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "markers.jsonl"), ["# lens-markers v1", ...MARKERS.map((m) => JSON.stringify({ t: m.t, kind: "zoom", x: m.x, y: m.y }))].join("\n") + "\n");
  return dir;
}

/** Red pixels (the sample's marker dot) inside a box. */
function redCount(f: { w: number; h: number; rgb: Buffer }, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(f.h, y1); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(f.w, x1); x++) {
      const i = (y * f.w + x) * 3;
      const r = f.rgb[i]!, g = f.rgb[i + 1]!, b = f.rgb[i + 2]!;
      if (r > 150 && g < 90 && b < 90) n++;
    }
  return n;
}

test("markers become zoom blocks at their times; the export is zoomed there", async () => {
  test.setTimeout(420_000);
  const dir = markerBundle();
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  const p0 = await proj(page);
  const segs = p0.zoom.segments.filter((s: { id: string }) => s.id.startsWith("marker-"));
  console.log("marker blocks", JSON.stringify(segs));
  expect(segs).toHaveLength(MARKERS.length);
  for (const [i, m] of MARKERS.entries()) {
    expect(Math.abs(segs[i].startMs - m.t)).toBeLessThanOrEqual(FRAME);
    expect(segs[i].auto).toBe(false);
    expect(Math.abs(segs[i].focus.x - m.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(segs[i].focus.y - m.y)).toBeLessThanOrEqual(0.5);
  }
  // the Zoom lane shows them (discoverable, editable like any zoom block)
  for (const [i, m] of MARKERS.entries()) {
    const b = page.getByTestId(`block-zoom-${i}`);
    await expect(b).toBeVisible();
    expect(Math.abs(Number(await b.getAttribute("data-start")) - m.t)).toBeLessThanOrEqual(FRAME);
    await expect(b).toHaveClass(/marker/);
  }
  await shot(page, `zoom-markers${PACKAGED ? "-app" : ""}`);
  // deterministic export: 720p30, no cursor drawn over the dot
  await editProject(page, "Export settings", "(p) => ({ ...p, output: { ...p.output, resolution: 720, fps: 30 }, cursor: { ...p.cursor, visible: false } })");
  const plan = await page.evaluate(() => (window as any).__lens.store.get().plan.frames.map((f: any) => ({ src: f.src, cam: f.cam, lay: f.layout.screen })));
  const firstIdx = Math.round(MARKERS[0]!.t / FRAME);
  const before = plan.slice(0, firstIdx - 1).map((f: any) => f.cam[2]);
  console.log("max scale before first marker", Math.max(...before));
  expect(Math.max(...before)).toBeLessThanOrEqual(1.001);
  for (const m of MARKERS) {
    const mi = Math.round(m.t / FRAME);
    // onset: the first frame (from one frame before the marker) whose camera moves (scale, or the pan
    // from one marker's point to the next when the zoom is already in)
    const base = plan[mi - 2].cam as number[];
    let onset = -1;
    for (let i = mi - 1; i < mi + 10; i++) {
      const c = plan[i].cam as number[];
      if (Math.abs(c[2]! - base[2]!) > 0.001 || Math.hypot(c[0]! - base[0]!, c[1]! - base[1]!) > 0.05) { onset = i; break; }
    }
    const settled = plan[Math.round((m.t + 1200) / FRAME)].cam[2];
    console.log(`marker ${m.t} ms: frame ${mi}, onset frame ${onset}, scale +1.2 s ${settled.toFixed(3)}`);
    expect(Math.abs(onset - mi)).toBeLessThanOrEqual(1);
    expect(settled).toBeGreaterThanOrEqual(1.9);
  }
  const mp4 = await exportMp4(page, dir, 360_000);
  const lay = plan[0].lay as number[];
  const [lx, ly, lw, lh] = lay;
  const centre = { x: lx! + lw! / 2, y: ly! + lh! / 2 };
  const pre = frameAt(mp4, 0.5);
  // the first marker's dot at its unzoomed spot (a box around it: the sample has two dots)
  const preExp = { x: lx! + (MARKERS[0]!.x / 1280) * lw!, y: ly! + (MARKERS[0]!.y / 720) * lh! };
  const preDot = redCentroid(pre, preExp.x - 20, preExp.y - 20, preExp.x + 20, preExp.y + 20)!;
  expect(Math.hypot(preDot.x - preExp.x, preDot.y - preExp.y)).toBeLessThanOrEqual(4);
  const unzoomedRed = MARKERS.map((m) => {
    const ox = lx! + (m.x / 1280) * lw!, oy = ly! + (m.y / 720) * lh!;
    return redCount(pre, ox - 20, oy - 20, ox + 20, oy + 20);
  });
  console.log("before: dot", preDot, "red px unzoomed", unzoomedRed, "centre", centre);
  expect(Math.hypot(preDot.x - centre.x, preDot.y - centre.y)).toBeGreaterThanOrEqual(40);
  for (const [i, m] of MARKERS.entries()) {
    const t = (m.t + 1200) / 1000;
    const img = frameAt(mp4, t);
    const box = { x0: centre.x - 60, y0: centre.y - 60, x1: centre.x + 60, y1: centre.y + 60 };
    const dot = redCentroid(img, box.x0, box.y0, box.x1, box.y1);
    const red = redCount(img, box.x0, box.y0, box.x1, box.y1);
    const ratio = red / unzoomedRed[i]!;
    console.log(`export ${t}s: dot ${JSON.stringify(dot)} off centre ${dot ? Math.hypot(dot.x - centre.x, dot.y - centre.y).toFixed(2) : "-"} px, red px ${red} (x${ratio.toFixed(2)})`);
    expect(dot, "marker point visible at the centre").not.toBeNull();
    expect(Math.hypot(dot!.x - centre.x, dot!.y - centre.y)).toBeLessThanOrEqual(4);
    expect(ratio).toBeGreaterThanOrEqual(3.2);
    expect(ratio).toBeLessThanOrEqual(4.8);
  }
  await lens.close();
});
