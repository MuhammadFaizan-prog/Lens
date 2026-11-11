/**
 * Camera scenes (demand #18): built through the UI (Scenes lane "+", the scene card's Layout / Corner /
 * Transition, the Webcam tab's scene list), then the preview and the export are compared frame by frame.
 *
 * Bounds (set before the first run), on the 1280x720 UX sample with a synthetic 640x360 camera
 * (red / green / blue bars and a moving magenta square, every camera pixel saturated; the screen is a
 * black / white checkerboard on #203040 with a few small red marker dots), output 360p30, scenes:
 *   S1 0.5-1.5 s Camera full · S2 1.5-2.5 s Side by side · S3 2.5-3.5 s PiP top-left, transition 0.25 s ·
 *   S4 3.5-6 s Screen only · before 0.5 s the Webcam tab's own PiP (bottom right).
 *  - UI: the Scenes lane holds 4 blocks labelled "Camera full", "Side by side", "PiP ↖", "Screen only";
 *    the Webcam tab lists 4 scenes; project.camera.layouts has those kinds, S3 corner "top-left",
 *    S3 transitionMs 250;
 *  - plan per sample time (0.3, 1.25, 2.25, 3.25, 4.5 s, plus 2.625 s = S3's transition midpoint):
 *    0.3 s camera centre in the bottom-right quadrant; 1.25 s camera rect covers >= 60 % of the canvas
 *    and screenOpacity 0; 2.25 s camera centre right of the canvas centre and the screen left of it;
 *    3.25 s camera centre in the top-left quadrant; 4.5 s no camera;
 *  - camera rect per scene, export vs preview: the saturated-pixel masks (max - min channel > 80) of the
 *    exported frame and of the preview canvas at the same plan frame have IoU >= 0.95 (frames where both
 *    masks are < 0.2 % of the canvas count as a match: Screen only); at the five scene times (not the
 *    transition midpoint) the preview mask's bounding box vs the plan's camera rect IoU >= 0.90;
 *  - whole-frame mean absolute RGB difference, export vs preview, <= 12 levels at every sample time;
 *  - Screen only (4.5 s): saturated share <= 0.2 % in both.
 */
import { test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, shot } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { editProject, exportMp4, frameAt, proj, seekSrc, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const CAM = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), "test-results", "scenes-cam.mp4");

function camBundle(): string {
  if (!fs.existsSync(CAM)) {
    fs.mkdirSync(path.dirname(CAM), { recursive: true });
    // red / green / blue bars at full saturation and a moving magenta square (every pixel max - min >= 180)
    const src = "color=c=0x00b400:s=640x360:r=30:d=6,drawbox=x=0:y=0:w=640:h=120:color=0xdc1414:t=fill,drawbox=x=0:y=240:w=640:h=120:color=0x1414dc:t=fill,drawbox=x='40+60*t':y=150:w=60:h=60:color=0xdc14dc:t=fill";
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", CAM]);
  }
  const dir = uxBundle("camera-scenes", { camera: { enabled: false, corner: "bottom-right", size: 0.3, shape: "rounded", mirror: false, zoomedSize: 1, transitionMs: 500 } });
  fs.copyFileSync(CAM, path.join(dir, "cam.mp4"));
  return dir;
}

type Img = { w: number; h: number; rgb: Uint8Array | Buffer };
type R = [number, number, number, number];

const sat = (f: Img, i: number) => Math.max(f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!) - Math.min(f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!) > 80;

/**
 * Saturated-pixel mask, and the camera's bounding box: the rows / columns holding >= 12 saturated pixels
 * (the screen's red marker dots are ~5 px wide and stay out of it; the smallest bubble is ~108 px).
 */
function mask(f: Img): { m: Uint8Array; n: number; box: R | null } {
  const m = new Uint8Array(f.w * f.h);
  const rows = new Uint32Array(f.h), cols = new Uint32Array(f.w);
  let n = 0;
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++) {
      if (!sat(f, (y * f.w + x) * 3)) continue;
      m[y * f.w + x] = 1;
      n++;
      rows[y]++; cols[x]++;
    }
  const span = (a: Uint32Array) => {
    let lo = -1, hi = -1;
    for (let i = 0; i < a.length; i++) if (a[i]! >= 12) { if (lo < 0) lo = i; hi = i; }
    return lo < 0 ? null : [lo, hi - lo + 1];
  };
  const sx = span(cols), sy = span(rows);
  return { m, n, box: sx && sy ? [sx[0]!, sy[0]!, sx[1]!, sy[1]!] : null };
}

function maskIoU(a: Uint8Array, b: Uint8Array): number {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] && b[k]) i++;
    if (a[k] || b[k]) u++;
  }
  return u ? i / u : 1;
}

function rectIoU(a: R, b: R): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy;
  return i / (a[2] * a[3] + b[2] * b[3] - i);
}

function meanAbs(a: Img, b: Img): number {
  let s = 0;
  for (let k = 0; k < a.w * a.h * 3; k++) s += Math.abs(a.rgb[k]! - b.rgb[k]!);
  return s / (a.w * a.h * 3);
}

/** The preview canvas as RGB at the plan's output size. */
async function previewRgb(page: Page): Promise<Img> {
  const { w, h, data } = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb: number[] = new Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]!; rgb[j + 1] = d[i + 1]!; rgb[j + 2] = d[i + 2]!; }
    return { w: c.width, h: c.height, data: rgb };
  });
  return { w, h, rgb: Uint8Array.from(data) };
}

async function frameInfo(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__lens.store.get();
    const f = s.plan.frames[s.frame];
    return { frame: s.frame as number, t: f.t as number, src: f.src as number, camera: f.layout.camera as R | null, screen: f.layout.screen as R, screenOpacity: f.layout.screenOpacity as number, W: s.plan.output.width as number, H: s.plan.output.height as number, fps: s.plan.output.fps as number };
  });
}

/** Seek the playhead to source ms, then press the Scenes lane "+". */
async function addSceneAt(page: Page, ms: number) {
  await seekSrc(page, ms);
  await page.getByTestId("add-scene").click();
  await expect(page.getByTestId("scene-card")).toBeVisible();
}

/** Drag scene i's right edge to source ms (the playhead sits there, so the edge snaps onto it). */
async function trimEnd(page: Page, i: number, ms: number) {
  await seekSrc(page, ms);
  const b = page.getByTestId(`block-scene-${i}`);
  const box = (await b.boundingBox())!;
  const s0 = Number(await b.getAttribute("data-start")), e0 = Number(await b.getAttribute("data-end"));
  const x = box.x + ((ms - s0) / (e0 - s0)) * box.width;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 3, y);
  await page.mouse.down();
  await page.mouse.move((box.x + box.width + x) / 2, y, { steps: 6 });
  await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

test("camera scenes: built in the UI, camera rect per scene matches between preview and export", async () => {
  test.setTimeout(600_000);
  const dir = camBundle();
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  // small, fast export on the 2-core box (same code path)
  await editProject(page, "Small export", "(p) => ({ ...p, output: { ...p.output, resolution: 360, fps: 30 } })");

  // ---- build the scenes left to right: "+" at the playhead, then trim the block's end onto the next start
  await expect(page.getByTestId("lane-scene")).toBeVisible();
  await expect(page.getByTestId("lane-name-scene")).toHaveText("Scenes");
  await addSceneAt(page, 500); // S1: Camera full (the default kind)
  // the lane "+" turned the webcam on (the bundle has a camera)
  expect((await proj(page)).camera.enabled).toBe(true);
  await trimEnd(page, 0, 1500);
  await addSceneAt(page, 1500); // S2: Side by side
  await page.getByTestId("scene-kind").getByRole("radio", { name: "Side by side" }).click();
  await trimEnd(page, 1, 2500);
  await addSceneAt(page, 2500); // S3: PiP, top left, 0.25 s
  await page.getByTestId("scene-kind").getByRole("radio", { name: "PiP" }).click();
  await page.getByTestId("scene-corner").selectOption("top-left");
  const tr = page.getByTestId("scene-transition-value");
  await tr.click();
  await tr.fill("0.25");
  await tr.press("Enter");
  await trimEnd(page, 2, 3500);
  await addSceneAt(page, 3500); // S4: Screen only, to the end
  await page.getByTestId("scene-kind").getByRole("radio", { name: "Screen only" }).click();

  const p = await proj(page);
  const L = p.camera.layouts as Array<{ startMs: number; endMs: number; kind: string; corner?: string; transitionMs?: number }>;
  console.log("scenes", JSON.stringify(L));
  expect(L.map((s) => s.kind)).toEqual(["fullscreen-camera", "split", "camera-overlay", "screen-only"]);
  expect(L.map((s) => [s.startMs, s.endMs])).toEqual([[500, 1500], [1500, 2500], [2500, 3500], [3500, 6000]]);
  expect(L[2]!.corner).toBe("top-left");
  expect(L[2]!.transitionMs).toBe(250);
  const labels = await page.locator('[data-testid="lane-scene"] .block-label').allTextContents();
  expect(labels).toEqual(["Camera full", "Side by side", "PiP ↖", "Screen only"]);
  await page.getByTestId("tab-camera").click();
  await expect(page.getByTestId("cam-scenes").locator("li")).toHaveCount(4);
  await shot(page, "camera-scenes-ui");

  // ---- preview frames
  const times = [300, 1250, 2250, 2625, 3250, 4500];
  const prev: Array<{ ms: number; info: Awaited<ReturnType<typeof frameInfo>>; img: Img }> = [];
  for (const ms of times) {
    await seekSrc(page, ms);
    prev.push({ ms, info: await frameInfo(page), img: await previewRgb(page) });
  }
  const { W, H, fps } = prev[0]!.info;
  const cen = (r: R) => ({ x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 });
  const at = (ms: number) => prev.find((x) => x.ms === ms)!.info;
  console.log("plan rects", JSON.stringify(prev.map((x) => ({ ms: x.ms, frame: x.info.frame, cam: x.info.camera, screenOpacity: x.info.screenOpacity }))));
  expect(cen(at(300).camera!).x).toBeGreaterThan(W / 2);
  expect(cen(at(300).camera!).y).toBeGreaterThan(H / 2);
  expect((at(1250).camera![2] * at(1250).camera![3]) / (W * H)).toBeGreaterThanOrEqual(0.6);
  expect(at(1250).screenOpacity).toBe(0);
  expect(cen(at(2250).camera!).x).toBeGreaterThan(W / 2);
  expect(cen(at(2250).screen).x).toBeLessThan(W / 2);
  expect(cen(at(3250).camera!).x).toBeLessThan(W / 2);
  expect(cen(at(3250).camera!).y).toBeLessThan(H / 2);
  expect(at(4500).camera).toBeNull();

  // ---- export (in-app browser path when LENS_EXPORT=browser) and compare
  const file = await exportMp4(page, dir);
  const rows: unknown[] = [];
  for (const x of prev) {
    // ffmpeg's input seek returns the first frame whose pts >= the time: aim a quarter frame before frame t
    const e = frameAt(file, x.info.t / 1000 - 0.25 / fps);
    expect([e.w, e.h]).toEqual([x.img.w, x.img.h]);
    const mp = mask(x.img), me = mask(e);
    const tiny = (n: number) => n / (e.w * e.h) < 0.002;
    const iou = tiny(mp.n) && tiny(me.n) ? 1 : maskIoU(mp.m, me.m);
    const k = x.img.w / W;
    const planBox: R | null = x.info.camera ? (x.info.camera.map((v) => v * k) as R) : null;
    const planIoU = planBox && mp.box ? rectIoU(planBox, mp.box) : planBox || mp.box ? (tiny(mp.n) && !planBox ? 1 : 0) : 1;
    const mad = meanAbs(x.img, e);
    if (x.ms === 2625) {
      // diagnostic only (no bound): the export's neighbouring frames, to tell a timing offset from a drawing difference
      const near: Record<string, number> = {};
      for (const d of [-3, -2, -1, 1, 2, 3]) near[d] = +meanAbs(x.img, frameAt(file, (x.info.t + (d * 1000) / fps) / 1000 - 0.25 / fps)).toFixed(2);
      console.log("transition midpoint: preview vs export frame offset by d -> mean abs", JSON.stringify(near));
      const dump = (f: Img, name: string) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${f.w}x${f.h}`, "-i", "pipe:0", path.join(path.dirname(CAM), name)], { input: Buffer.from(f.rgb) });
      dump(x.img, "scenes-2625-preview.png");
      dump(e, "scenes-2625-export.png");
    }
    rows.push({ ms: x.ms, iou: +iou.toFixed(4), planIoU: +planIoU.toFixed(4), mad: +mad.toFixed(2), prevSat: mp.n, expSat: me.n, prevBox: mp.box, expBox: me.box, planBox });
  }
  console.log("measured", JSON.stringify(rows, null, 1));
  for (const r of rows as Array<{ ms: number; iou: number; planIoU: number; mad: number; prevSat: number; expSat: number }>) {
    expect(r.iou, `mask IoU at ${r.ms} ms`).toBeGreaterThanOrEqual(0.95);
    expect(r.mad, `mean abs diff at ${r.ms} ms`).toBeLessThanOrEqual(12);
    if (r.ms !== 2625) expect(r.planIoU, `preview vs plan rect at ${r.ms} ms`).toBeGreaterThanOrEqual(0.9);
  }
  const so = rows.find((r: any) => r.ms === 4500) as { prevSat: number; expSat: number };
  expect(so.prevSat / (W * H * (prev[0]!.img.w / W) ** 2)).toBeLessThanOrEqual(0.002);
  expect(so.expSat / (W * H * (prev[0]!.img.w / W) ** 2)).toBeLessThanOrEqual(0.002);
  await lens.close();
});
