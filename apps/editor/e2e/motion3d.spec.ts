/**
 * 3D motion (feat/motion-3d): the whole flow through the UI, preview vs export, and perf numbers.
 *
 * Bounds, set before the first run (sample-ux: 6 s static 8 px checkerboard, output 360p30, clip cut
 * to the first 3 s so the export is 90 frames):
 *  - WebGL2 exists in the page (OffscreenCanvas) and no toast / canvas error mentions WebGL at any point;
 *  - the 3D lane "+" adds one block at the playhead (1.0 s), the Tilt in template button applies;
 *  - inside the block (frame 33, 1.1 s) the plan frame carries m3d whose projected quad has a corner
 *    >= 3 px away from the flat card rect, and the preview differs from the flat preview at the same
 *    frame: mean |RGB| over an 8 px grid >= 3;
 *  - Rotate Y slider (Start key) to 30 deg: the pose has ry 30 and the preview changes again (>= 3);
 *  - Add keyframe at 1.5 s: 3 keys (Start, Key 1, End);
 *  - Save as template "E2E Tilt": a user template button with that name appears in the grid;
 *  - undo until the lane is empty removes the block and the frame-33 preview is the flat one again
 *    (mean |RGB| <= 1); redo the same number of steps restores it (3 keys, ry 30);
 *  - browser export (LENS_EXPORT=browser) of the 3 s clip: the export frame 33 vs the preview frame 33,
 *    mean |RGB| per pixel <= 12 (JPEG q0.95 + H.264 noise; same bound as the caption parity specs),
 *    and the export frame 33 is not flat: mean |RGB| vs the 3D-free export's frame 33 >= 3;
 *  - perf, reported not asserted: preview fps while playing the 3 s clip with no 3D vs a 3D block over
 *    the whole clip (requestAnimationFrame ticks and preview frames drawn per second over 3 s), and
 *    browser export seconds for the 3 s clip with no 3D, with the 1 s block, and with a 3 s block.
 */
import { test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, meanAbsDiff, canvasPixels, seek, settle, shot } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { editProject, exportMp4, frameAt, proj, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const F = 33; // output frame inside the block (1.1 s at 30 fps)
const tMid = (f: number) => (f + 0.5) / 30;

/** Memory trail in the log (the shared 8 GB box OOM-kills test workers): MemAvailable + chromium RSS. */
function mem(label: string): void {
  try {
    const avail = Math.round(Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))![1]) / 1024);
    const rss = execSync("ps -C chromium -o rss= || true", { encoding: "utf8" }).split("\n").reduce((a, b) => a + (Number(b) || 0), 0);
    console.log(`[mem] ${label}: available ${avail} MB, chromium RSS ${Math.round(rss / 1024)} MB`);
  } catch {
    // diagnostics only
  }
}

/** Full preview canvas as RGB. */
async function previewRgb(page: Page): Promise<{ w: number; h: number; rgb: Buffer }> {
  const r = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb = new Uint8Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]!; rgb[j + 1] = d[i + 1]!; rgb[j + 2] = d[i + 2]!; }
    let s = "";
    for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode(...rgb.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height, b64: btoa(s) };
  });
  return { w: r.w, h: r.h, rgb: Buffer.from(r.b64, "base64") };
}

function meanRgbDiff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

/** Play the clip from frame 0 for 3 s: rAF ticks/s and preview frames drawn/s. */
async function measureFps(page: Page): Promise<{ raf: number; drawn: number }> {
  await seek(page, 0);
  return page.evaluate(async () => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    let drawn = 0, ticks = 0, on = true;
    const mo = new MutationObserver(() => drawn++);
    mo.observe(c, { attributes: true, attributeFilter: ["data-frame"] });
    const tick = () => { ticks++; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    (window as any).__lens.store.play(1);
    await new Promise((r) => setTimeout(r, 3000));
    on = false;
    const dt = (performance.now() - t0) / 1000;
    (window as any).__lens.store.pause();
    mo.disconnect();
    return { raf: ticks / dt, drawn: drawn / dt };
  });
}

async function timedExport(page: Page, dir: string): Promise<{ mp4: string; seconds: number; wall: number }> {
  const t0 = Date.now();
  const mp4 = await exportMp4(page, dir, 400_000);
  const wall = (Date.now() - t0) / 1000;
  const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  expect(ex.path).toBe("browser");
  return { mp4, seconds: ex.seconds ?? wall, wall };
}

test("3D motion: lane add, template, slider, keyframe, save template, undo, export matches preview", async () => {
  test.setTimeout(1_200_000);
  const dir = uxBundle("motion3d");
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  const gl = await page.evaluate(() => {
    const g = new OffscreenCanvas(4, 4).getContext("webgl2") as WebGL2RenderingContext | null;
    if (!g) return null;
    const dbg = g.getExtension("WEBGL_debug_renderer_info");
    return { renderer: String(g.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : g.RENDERER)), version: String(g.getParameter(g.VERSION)) };
  });
  console.log("WebGL2:", JSON.stringify(gl));
  expect(gl, "headless Chromium has no WebGL2").not.toBeNull();
  // record every toast
  await page.evaluate(() => {
    const w = window as any;
    w.__toasts = [];
    let last = 0;
    w.__lens.store.subscribe(() => {
      const t = w.__lens.store.get().toast;
      if (t && t.id !== last) { last = t.id; w.__toasts.push(t.text); }
    });
  });
  const noGlError = async () => {
    const toasts: string[] = await page.evaluate(() => (window as any).__toasts);
    const err = await page.getByTestId("preview").getAttribute("data-error");
    expect(toasts.filter((t) => /webgl|3d motion needs/i.test(t)), `toasts: ${toasts.join(" | ")}`).toEqual([]);
    expect(err).toBeNull();
  };
  await smallExport(page, 3000);
  const frames = await page.evaluate(() => (window as any).__lens.store.get().plan.frames.length);
  expect(frames).toBe(90);

  // ---- baseline: no 3D
  const fpsFlat = await measureFps(page);
  console.log("preview fps, no 3D:", JSON.stringify(fpsFlat));
  mem("before flat export");
  const expFlat = await timedExport(page, dir);
  mem("after flat export");
  await page.waitForTimeout(1500);
  console.log("export 3 s, no 3D:", expFlat.seconds.toFixed(1), "s (wall", expFlat.wall.toFixed(1), "s)");
  await seek(page, F);
  const flatGrid = await canvasPixels(page);
  const flatRect = await page.evaluate((f) => (window as any).__lens.store.get().plan.frames[f].layout.screen, F);

  mem("before 3D");
  // ---- 1: lane "+" at the playhead (1.0 s)
  await seek(page, 30);
  await page.getByTestId("add-motion3d").scrollIntoViewIfNeeded();
  await page.getByTestId("add-motion3d").click();
  let m3 = (await proj(page)).motion3d;
  expect(m3).toHaveLength(1);
  console.log("block", m3[0].startMs, "-", m3[0].endMs, m3[0].template);
  expect(Math.abs(m3[0].startMs - 1000)).toBeLessThanOrEqual(34);
  await expect(page.getByTestId(`block-motion3d-${m3[0].id}`)).toBeVisible();
  mem("block added");
  // ---- 2: pick a template
  await page.getByTestId("m3d-tpl-swing-left").click();
  expect((await proj(page)).motion3d[0].template).toBe("swing-left");
  await page.getByTestId("m3d-tpl-tilt-in").click();
  m3 = (await proj(page)).motion3d;
  expect(m3[0].template).toBe("tilt-in");
  expect(m3[0].from.rx).toBe(25);

  // ---- 3: inside the block the card is in 3D
  await seek(page, F);
  const fr = await page.evaluate((f) => (window as any).__lens.store.get().plan.frames[f], F);
  expect(fr.m3d, "plan frame inside the block has no m3d").toBeTruthy();
  const [x, y, w, h] = flatRect;
  const flatQuad = [x, y, x + w, y, x + w, y + h, x, y + h];
  const cornerMove = Math.max(...fr.m3d.quad.map((v: number, i: number) => Math.abs(v - flatQuad[i]!)));
  console.log("m3d pose", fr.m3d.pose, "quad", fr.m3d.quad.map((v: number) => v.toFixed(1)).join(","), "flat", flatQuad.join(","), "max corner move", cornerMove.toFixed(1), "px");
  expect(cornerMove).toBeGreaterThanOrEqual(3);
  const tiltGrid = await canvasPixels(page);
  const dTilt = meanAbsDiff(tiltGrid, flatGrid);
  console.log("preview frame 33 vs flat:", dTilt.toFixed(2));
  expect(dTilt).toBeGreaterThanOrEqual(3);
  await noGlError();
  await shot(page, "motion3d-tilt");

  mem("3D drawn");
  // ---- 4: Rotate Y slider (Start key)
  await page.getByTestId("m3d-ry").fill("30");
  await settle(page);
  await seek(page, F);
  expect((await proj(page)).motion3d[0].from.ry).toBe(30);
  const ryGrid = await canvasPixels(page);
  const dRy = meanAbsDiff(ryGrid, tiltGrid);
  console.log("preview frame 33 after Rotate Y 30 vs before:", dRy.toFixed(2));
  expect(dRy).toBeGreaterThanOrEqual(3);

  // ---- 5: keyframe at 1.5 s
  await seek(page, 45);
  await page.getByTestId("m3d-key-add").click();
  await expect(page.getByTestId("m3d-key-2")).toBeVisible();
  expect((await proj(page)).motion3d[0].keys).toHaveLength(1);

  // ---- 6: save as template, it shows in the grid
  await page.getByTestId("m3d-save-name").fill("E2E Tilt");
  await page.getByTestId("m3d-save").click();
  await expect(page.locator('[data-testid^="m3d-tpl-user:"]', { hasText: "E2E Tilt" })).toBeVisible();

  // ---- 7: undo removes the block, redo brings it back
  let undos = 0;
  while ((await proj(page)).motion3d.length && undos < 12) {
    await page.evaluate(() => (window as any).__lens.store.undo());
    undos++;
  }
  expect((await proj(page)).motion3d).toHaveLength(0);
  console.log("undo steps to remove the block:", undos);
  await seek(page, F);
  const undoneGrid = await canvasPixels(page);
  expect(meanAbsDiff(undoneGrid, flatGrid)).toBeLessThanOrEqual(1);
  for (let i = 0; i < undos; i++) await page.evaluate(() => (window as any).__lens.store.redo());
  m3 = (await proj(page)).motion3d;
  expect(m3).toHaveLength(1);
  expect(m3[0].keys).toHaveLength(1);
  expect(m3[0].from.ry).toBe(30);
  await noGlError();

  mem("before 3D export");
  // ---- 8: export, frame 33 vs preview frame 33
  await seek(page, F + 1);
  await seek(page, F);
  const prev = await previewRgb(page);
  const exp3d = await timedExport(page, dir);
  console.log("export 3 s, 1 s 3D block:", exp3d.seconds.toFixed(1), "s (wall", exp3d.wall.toFixed(1), "s)");
  const ef = frameAt(exp3d.mp4, tMid(F));
  expect([ef.w, ef.h]).toEqual([prev.w, prev.h]);
  const dPar = meanRgbDiff(prev.rgb, ef.rgb);
  const dNotFlat = meanRgbDiff(ef.rgb, frameAt(expFlat.mp4, tMid(F)).rgb);
  console.log(`export frame ${F} vs preview: mean |RGB| ${dPar.toFixed(2)} (bound 12); vs 3D-free export: ${dNotFlat.toFixed(2)} (bound >= 3)`);
  expect(dPar).toBeLessThanOrEqual(12);
  expect(dNotFlat).toBeGreaterThanOrEqual(3);
  await noGlError();

  mem("after 3D export");
  // ---- perf with a 3D block over the whole clip
  await editProject(page, "3D over the clip", "(p) => ({ ...p, motion3d: [{ id: 'perf', startMs: 0, endMs: 3000, template: 'custom', from: { rx: 20, ry: -25 }, to: { rx: -10, ry: 25 }, easing: 'linear', perspective: 1600 }] })");
  const fps3d = await measureFps(page);
  console.log("preview fps, 3D over the clip:", JSON.stringify(fps3d));
  const expFull = await timedExport(page, dir);
  console.log("export 3 s, 3 s 3D block:", expFull.seconds.toFixed(1), "s (wall", expFull.wall.toFixed(1), "s)");
  await noGlError();
  const perf = { gl, fpsFlat, fps3d, exportFlat: expFlat.seconds, export3d1s: exp3d.seconds, export3dFull: expFull.seconds, parity: dPar, notFlat: dNotFlat, cornerMove, dTilt, dRy, undos };
  fs.mkdirSync(path.join(EDITOR, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(EDITOR, "test-results", "motion3d-perf.json"), JSON.stringify(perf, null, 1));
  console.log("PERF", JSON.stringify(perf));
  await lens.close();
});
