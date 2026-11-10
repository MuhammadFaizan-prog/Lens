/**
 * Camera capture path (Windows v0.1.2 report: the editor said "no webcam track"). Chromium's fake
 * capture device stands in for the webcam (--use-fake-device-for-media-stream). Packaged app when
 * LENS_PACKAGED_APP is set, else the built app.
 * Bounds (set before the first run):
 *  - take 1 with the fake camera selected: the bundle has cam.webm and cam.mp4, cam.mp4 frames =
 *    duration x fps +- 2, project.json camera.enabled, recording.json has no camera warning;
 *  - lens.log (userData/logs) names the camera device at start and "cam.mp4 written" at the end;
 *  - the recorder window main replaces after each take comes back with the same camera selected and its
 *    preview open (it used to come back with "No camera", so take 2 silently had none), and take 2
 *    also writes cam.mp4.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNS, appLaunchOptions, ffprobeJson, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

async function take(a: ElectronApplication, rec: Page, seconds: number): Promise<any> {
  await a.evaluate(() => ((globalThis as any).lensLastResult = null));
  await rec.evaluate(() => (window as any).lensRecorder.start());
  await rec.waitForFunction(() => (window as any).lensRecorder.state().state === "recording", null, { timeout: 30_000 });
  await sleep(seconds * 1000);
  await rec.evaluate(() => (window as any).lensRecorder.stop());
  let result: any = null;
  for (let i = 0; i < 600 && !result; i++) {
    result = await a.evaluate(() => (globalThis as any).lensLastResult ?? null);
    if (!result) await sleep(200);
  }
  expect(result, "recording saved").toBeTruthy();
  const dir = result.dir as string;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const out: any = {
    dir,
    warnings: result.warnings,
    camWebm: fs.existsSync(path.join(dir, "cam.webm")) ? fs.statSync(path.join(dir, "cam.webm")).size : 0,
    camMp4: fs.existsSync(path.join(dir, "cam.mp4")),
    camera: JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).camera ?? null,
    finalize: JSON.parse(fs.readFileSync(path.join(dir, "recording.json"), "utf8")).finalize,
    expectFrames: Math.round((meta.durationMs / 1000) * meta.fps),
  };
  if (out.camMp4) out.camFrames = Number(ffprobeJson(["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", path.join(dir, "cam.mp4")]).streams[0].nb_read_frames);
  return out;
}

async function recorderWindow(a: ElectronApplication, not?: Page): Promise<Page> {
  for (let i = 0; i < 150; i++) {
    const p = a.windows().find((w) => w.url().includes("recorder.html") && w !== not && !w.isClosed());
    if (p) {
      await p.waitForFunction(() => (window as any).lensRecorder?.state().sources.some((s: any) => s.kind === "screen"), null, { timeout: 30_000 });
      return p;
    }
    await sleep(200);
  }
  throw new Error("no recorder window");
}

test("fake camera: cam.mp4 in the bundle, logged, and still selected for the next take", async () => {
  test.setTimeout(400_000);
  const run = path.join(RUNS, `camera-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  const ud = path.join(run, "ud");
  xvfb = await startXvfb(DISPLAY, 1280, 720);
  app = await electron.launch({
    ...appLaunchOptions(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_NO_EDITOR: "1", LENS_RECORDINGS_DIR: path.join(run, "rec"), LENS_USER_DATA: ud, LENS_NO_UPDATE: "1" },
    timeout: 60_000,
  });
  const rec = await recorderWindow(app);
  const report: Record<string, any> = { packaged: !!process.env.LENS_PACKAGED_APP };
  await rec.waitForFunction(() => (window as any).lensRecorder.devices().cams.length > 1, null, { timeout: 10_000 });
  await rec.selectOption('[data-testid="cam-device"]', { index: 1 });
  await rec.waitForFunction(() => ((document.getElementById("cam-preview") as HTMLVideoElement).videoWidth ?? 0) > 0, null, { timeout: 10_000 });
  report.selected = (await rec.evaluate(() => (window as any).lensRecorder.devices())).cam;

  report.take1 = await take(app, rec, 3);
  // main replaces the recorder window 1.5 s after a take
  const rec2 = await recorderWindow(app, rec);
  await rec2.waitForFunction(() => (window as any).lensRecorder.devices().webcamOpen, null, { timeout: 15_000 }).catch(() => undefined);
  report.afterRecycle = await rec2.evaluate(() => { const d = (window as any).lensRecorder.devices(); return { cam: d.cam, webcamOpen: d.webcamOpen }; });
  report.take2 = await take(app, rec2, 2);

  const log = fs.readFileSync(path.join(ud, "logs", "lens.log"), "utf8");
  report.logLines = log.split("\n").filter((l) => /camera/i.test(l));
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("camera report", JSON.stringify(report, null, 1));

  for (const t of [report.take1, report.take2]) {
    expect(t.camWebm).toBeGreaterThan(0);
    expect(t.camMp4).toBe(true);
    expect(Math.abs(t.camFrames - t.expectFrames)).toBeLessThanOrEqual(2);
    expect(t.camera?.enabled).toBe(true);
    expect(t.finalize.cameraError).toBeNull();
    expect((t.warnings as string[]).filter((w) => /camera/i.test(w))).toEqual([]);
  }
  expect(report.afterRecycle.cam).toBe(report.selected);
  expect(report.afterRecycle.webcamOpen).toBe(true);
  expect(report.logLines.filter((l: string) => /recording started: camera "/.test(l)).length).toBe(2);
  expect(report.logLines.filter((l: string) => /cam\.mp4 written/.test(l)).length).toBe(2);
});
