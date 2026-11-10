/**
 * Webcam tab (Windows v0.1.2 report: "no webcam track", Show webcam did nothing, Shape label cut to "Rou...").
 * Bounds (set before the first run):
 *  - bundle without cam.mp4: the tab shows "No camera in this recording" plus the recorder hint; Show
 *    webcam, Corner, Size, Shape, Mirror and Shrink are disabled, and clicking Show webcam leaves
 *    project.camera.enabled unchanged; a recorder camera warning (recording.json finalize.cameraError)
 *    is shown in the tab;
 *  - bundle with a synthetic camera track (ffmpeg testsrc, saturated colour bars): no empty state, controls
 *    enabled; inside the plan's webcam rect on the preview canvas, the share of saturated pixels
 *    (max - min channel > 80) is >= 0.30 with Show webcam on and <= 0.02 with it off (the screen is a
 *    black / white checkerboard on #203040); toggled through the UI switch, both ways;
 *  - export follows the toggle: same saturated-share bounds in the exported frame's webcam rect;
 *  - Shape buttons and the tab's control labels are not truncated (scrollWidth <= clientWidth for each) at
 *    1280x720 and 1366x768.
 */
import { test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, shot } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { exportMp4, frameAt, proj, seekSrc, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const CAM_CACHE = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), "test-results", "webcam-cam.mp4");

/** 6 s, 30 fps testsrc camera (640x360), made once per run. */
function camTrack(): string {
  if (!fs.existsSync(CAM_CACHE)) {
    fs.mkdirSync(path.dirname(CAM_CACHE), { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", CAM_CACHE]);
  }
  return CAM_CACHE;
}

function camBundle(name: string): string {
  const dir = uxBundle(name, { camera: { enabled: false, corner: "bottom-right", size: 0.3, shape: "rounded", mirror: false, zoomedSize: 1 } });
  fs.copyFileSync(camTrack(), path.join(dir, "cam.mp4"));
  return dir;
}

/** Share of saturated pixels inside the current frame's webcam rect (the "on" layout's rect) on the preview canvas. */
async function previewCamShare(page: Page, rect: [number, number, number, number]): Promise<number> {
  return page.evaluate(([x, y, w, h]) => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(Math.round(x + w * 0.2), Math.round(y + h * 0.2), Math.round(w * 0.6), Math.round(h * 0.6)).data;
    let sat = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!) > 80) sat++;
    return sat / (d.length / 4);
  }, rect);
}

function fileCamShare(f: { w: number; h: number; rgb: Buffer }, rect: [number, number, number, number], outW: number): number {
  const k = f.w / outW;
  const [x, y, w, h] = rect.map((v) => v * k) as [number, number, number, number];
  let n = 0, sat = 0;
  for (let yy = Math.round(y + h * 0.2); yy < Math.round(y + h * 0.8); yy++)
    for (let xx = Math.round(x + w * 0.2); xx < Math.round(x + w * 0.8); xx++) {
      const i = (yy * f.w + xx) * 3;
      const r = f.rgb[i]!, g = f.rgb[i + 1]!, b = f.rgb[i + 2]!;
      n++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 80) sat++;
    }
  return sat / n;
}

async function shapeTruncation(page: Page): Promise<Array<{ text: string; sw: number; cw: number }>> {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="cam-shape"] button')].map((b) => ({ text: b.textContent ?? "", sw: (b as HTMLElement).scrollWidth, cw: (b as HTMLElement).clientWidth })));
}

test("no camera track: empty state, controls disabled, recorder warning shown", async () => {
  const dir = uxBundle("webcam-none");
  fs.writeFileSync(path.join(dir, "recording.json"), JSON.stringify({ app: "lens-desktop", warnings: ["camera video could not be converted: synthetic failure"], finalize: { cameraError: "camera video could not be converted: synthetic failure" } }));
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  await page.getByTestId("tab-camera").click();
  await expect(page.getByTestId("cam-empty")).toBeVisible();
  await expect(page.getByTestId("cam-empty-title")).toHaveText("No camera in this recording");
  await expect(page.getByTestId("cam-empty-hint")).toContainText("camera in the recorder");
  await expect(page.getByTestId("cam-warning")).toContainText("synthetic failure");
  for (const id of ["cam-enabled", "cam-corner", "cam-size", "cam-mirror", "cam-shrink"]) await expect(page.getByTestId(id)).toBeDisabled();
  for (const b of await page.getByTestId("cam-shape").locator("button").all()) await expect(b).toBeDisabled();
  const before = (await proj(page)).camera.enabled;
  await page.getByTestId("cam-enabled").click({ force: true });
  await page.waitForTimeout(200);
  expect((await proj(page)).camera.enabled).toBe(before);
  const trunc = await shapeTruncation(page);
  console.log("no-cam 1280x720 shape buttons", JSON.stringify(trunc));
  for (const t of trunc) expect(t.sw, `"${t.text}" truncated`).toBeLessThanOrEqual(t.cw);
  await shot(page, "webcam-empty-1280x720");
  await lens.close();
});

test("camera track: Show webcam toggles the preview and the export; Shape labels fit", async () => {
  test.setTimeout(480_000);
  const dir = camBundle("webcam-cam");
  for (const [w, h] of [[1366, 768], [1280, 720]] as const) {
    const lens = await openLens(dir, { w, h });
    const page = lens.page;
    await page.getByTestId("tab-camera").click();
    await expect(page.getByTestId("cam-empty")).toHaveCount(0);
    await expect(page.getByTestId("cam-enabled")).toBeEnabled();
    const trunc = await shapeTruncation(page);
    console.log(`cam ${w}x${h} shape buttons`, JSON.stringify(trunc));
    expect(trunc.map((t) => t.text)).toEqual(["Round", "Circle", "Square"]);
    for (const t of trunc) expect(t.sw, `"${t.text}" truncated at ${w}x${h}`).toBeLessThanOrEqual(t.cw);
    // every control label in the Webcam tab fits too ("Shrink on zo..." in v0.1.2)
    const labels = await page.evaluate(() => [...document.querySelectorAll(".insp-section .ctl-label")].map((l) => ({ text: l.textContent ?? "", sw: (l as HTMLElement).scrollWidth, cw: (l as HTMLElement).clientWidth })));
    console.log(`cam ${w}x${h} labels`, JSON.stringify(labels));
    for (const l of labels) expect(l.sw, `label "${l.text}" truncated at ${w}x${h}`).toBeLessThanOrEqual(l.cw);
    await shot(page, `webcam-panel-${w}x${h}`);
    if (w === 1366) {
      await lens.close();
      continue;
    }

    // preview: off -> on -> off through the UI switch
    await seekSrc(page, 1000);
    const sw = page.getByTestId("cam-enabled");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await seekSrc(page, 1000);
    const rect = await page.evaluate(() => {
      const s = (window as any).__lens.store.get();
      return s.plan.frames[s.frame].layout.camera as [number, number, number, number] | null;
    });
    expect(rect).not.toBeNull();
    const on = await previewCamShare(page, rect!);
    await shot(page, "webcam-preview-on");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await seekSrc(page, 1000);
    const camOff = await page.evaluate(() => {
      const s = (window as any).__lens.store.get();
      return s.plan.frames[s.frame].layout.camera;
    });
    const off = await previewCamShare(page, rect!);
    console.log("preview saturated share in webcam rect", { rect, on, off, camOff });
    expect(on).toBeGreaterThanOrEqual(0.3);
    expect(off).toBeLessThanOrEqual(0.02);
    expect(camOff).toBeNull();

    // export follows the toggle
    await smallExport(page, 1500);
    const outW = await page.evaluate(() => (window as any).__lens.store.get().plan.output.width);
    const rect360 = await page.evaluate(() => {
      const s = (window as any).__lens.store.get();
      return s.plan.frames[0].layout.camera;
    });
    expect(rect360).toBeNull();
    const offFile = frameAt(await exportMp4(page, dir), 0.5);
    await page.evaluate(() => (window as any).__lens.store.closeExport());
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    const camRect = await page.evaluate(() => (window as any).__lens.store.get().plan.frames[15].layout.camera as [number, number, number, number]);
    const onFile = frameAt(await exportMp4(page, dir), 0.5);
    const eOn = fileCamShare(onFile, camRect, outW);
    const eOff = fileCamShare(offFile, camRect, outW);
    console.log("export saturated share in webcam rect", { outW, camRect, eOn, eOff });
    expect(eOn).toBeGreaterThanOrEqual(0.3);
    expect(eOff).toBeLessThanOrEqual(0.02);
    await lens.close();
  }
});
