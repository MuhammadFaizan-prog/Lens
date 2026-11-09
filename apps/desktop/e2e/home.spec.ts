/**
 * Windows #7: recorder home. Mode cards (Full Screen / Custom / Window / Device-disabled), a Devices
 * column (camera with preview, mic with a level meter, system audio, teleprompter). Chromium's fake
 * capture devices stand in for a webcam and a mic (a beeping tone).
 * Bounds: 4 mode cards, Device disabled; Window mode lists windows (or its empty state); >= 1 camera
 * and >= 1 mic listed; mic meter peak > 5% within 2 s; camera preview playing; Custom: a drag from
 * (200,150) to (840,510) on the 1280x720 screen gives region within 1% and project.json crop within
 * 4 px of {200,150,640,360}; a 3 s take writes cam.mp4 (frames = duration x fps +- 2), mic.wav and
 * camera.enabled; system audio is offered on Windows only; the teleprompter opens always-on-top and
 * content-protected (Windows / macOS; Electron has no content protection on Linux).
 */
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNS, appLaunchOptions, ffprobeJson, sleep, startXvfb, xdo } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

test("recorder home: modes, devices, custom region, webcam take, teleprompter", async () => {
  test.setTimeout(300_000);
  const run = path.join(RUNS, `home-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  xvfb = await startXvfb(DISPLAY, 1280, 720);
  app = await electron.launch({
    ...appLaunchOptions(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: path.join(run, "rec"), LENS_USER_DATA: path.join(run, "ud"), LENS_NO_UPDATE: "1" },
    timeout: 60_000,
  });
  const rec = await app.firstWindow();
  await rec.waitForFunction(() => (window as any).lensRecorder?.state().sources.some((s: any) => s.kind === "screen"), null, { timeout: 30_000 });
  const report: Record<string, any> = { packaged: !!process.env.LENS_PACKAGED_APP };
  await rec.screenshot({ path: path.join(run, "home.png") });

  report.modes = await rec.locator(".mode").count();
  report.deviceDisabled = await rec.locator('[data-testid="mode-device"]').isDisabled();
  await rec.click('[data-testid="mode-window"]');
  report.windowTitle = await rec.locator("#pick-title").textContent();
  report.windowItems = await rec.locator('[data-testid="sources"] > *').count();
  await rec.click('[data-testid="mode-screen"]');

  // devices
  await rec.waitForFunction(() => (window as any).lensRecorder.devices().cams.length > 1, null, { timeout: 10_000 });
  const dev0 = await rec.evaluate(() => (window as any).lensRecorder.devices());
  report.cams = dev0.cams.length - 1;
  report.mics = dev0.mics.length - 1;
  await rec.selectOption('[data-testid="mic-device"]', { index: 1 });
  await sleep(2000);
  await rec.selectOption('[data-testid="cam-device"]', { index: 1 });
  await rec.waitForFunction(() => ((document.getElementById("cam-preview") as HTMLVideoElement).videoWidth ?? 0) > 0, null, { timeout: 10_000 });
  const dev1 = await rec.evaluate(() => (window as any).lensRecorder.devices());
  report.micPeak = dev1.micPeak;
  report.webcamOpen = dev1.webcamOpen;
  report.sysAudioDisabled = await rec.locator('[data-testid="sys-audio"]').isDisabled();
  await rec.screenshot({ path: path.join(run, "home-devices.png") });

  // Custom region: pick the screen, drag on the overlay
  await rec.click('[data-testid="mode-region"]');
  await rec.click('[data-testid="sources"] button.src');
  for (let i = 0; i < 50; i++) {
    const has = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.getTitle() === "Lens region" && w.isVisible()));
    if (has) break;
    await sleep(100);
  }
  await sleep(500);
  report.windowsAtDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => [w.getTitle(), w.isVisible(), w.getBounds()]));
  console.log("windows at drag", JSON.stringify(report.windowsAtDrag));
  app.on("window", (p) => p.on("console", (m) => console.log("[win]", m.text())));
  xdo(DISPLAY, "mousemove", "200", "150");
  xdo(DISPLAY, "mousedown", "1");
  for (let i = 1; i <= 10; i++) {
    xdo(DISPLAY, "mousemove", String(200 + 64 * i), String(150 + 36 * i));
    await sleep(30);
  }
  xdo(DISPLAY, "mouseup", "1");
  await rec.waitForFunction(() => !!(window as any).lensRecorder.devices().region, null, { timeout: 10_000 });
  report.region = (await rec.evaluate(() => (window as any).lensRecorder.devices())).region;

  // a 3 s take with webcam + mic + region
  await rec.evaluate(() => (window as any).lensRecorder.start());
  await sleep(3000);
  await rec.evaluate(() => (window as any).lensRecorder.stop());
  let result: any = null;
  for (let i = 0; i < 600 && !result; i++) {
    result = await app.evaluate(() => (globalThis as any).lensLastResult ?? null);
    if (!result) await sleep(200);
  }
  expect(result, "recording saved").toBeTruthy();
  const dir = result.dir;
  const proj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  report.project = { crop: proj.crop, camera: proj.camera, tracks: proj.audio?.tracks?.map((t: any) => t.id) };
  report.camMp4 = fs.existsSync(path.join(dir, "cam.mp4"));
  if (report.camMp4) {
    const p = ffprobeJson(["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", path.join(dir, "cam.mp4")]);
    report.camFrames = Number(p.streams[0].nb_read_frames);
    report.expectFrames = Math.round((meta.durationMs / 1000) * meta.fps);
  }
  report.micWav = fs.existsSync(path.join(dir, "mic.wav"));

  // teleprompter
  const recWin = await app.browserWindow(rec);
  void recWin;
  await rec.click('[data-testid="teleprompter"]');
  await sleep(1500);
  report.prompter = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Lens Teleprompter");
    return w ? { open: true, alwaysOnTop: w.isAlwaysOnTop(), contentProtected: typeof (w as any).isContentProtected === "function" ? (w as any).isContentProtected() : "n/a" } : { open: false };
  });
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("home report", JSON.stringify(report));
  try {
    execFileSync("true");
  } catch {
    // noop
  }

  expect(report.modes).toBe(4);
  expect(report.deviceDisabled).toBe(true);
  expect(report.windowTitle).toBe("Windows");
  expect(report.windowItems).toBeGreaterThanOrEqual(1);
  expect(report.cams).toBeGreaterThanOrEqual(1);
  expect(report.mics).toBeGreaterThanOrEqual(1);
  expect(report.micPeak).toBeGreaterThan(5);
  expect(report.webcamOpen).toBe(true);
  expect(report.sysAudioDisabled).toBe(process.platform !== "win32");
  const r = report.region;
  for (const [k, v] of [["x", 200 / 1280], ["y", 150 / 720], ["w", 640 / 1280], ["h", 360 / 720]] as const) expect(Math.abs(r[k] - v), `region.${k}`).toBeLessThanOrEqual(0.01);
  const c = report.project.crop;
  for (const [k, v] of [["x", 200], ["y", 150], ["w", 640], ["h", 360]] as const) expect(Math.abs(c[k] - v), `crop.${k}`).toBeLessThanOrEqual(4);
  expect(report.project.camera?.enabled).toBe(true);
  expect(report.camMp4).toBe(true);
  expect(Math.abs(report.camFrames - report.expectFrames)).toBeLessThanOrEqual(2);
  expect(report.micWav).toBe(true);
  expect(report.prompter.open).toBe(true);
  expect(report.prompter.alwaysOnTop).toBe(true);
  // setContentProtection is a no-op on Linux (Electron supports it on Windows and macOS only)
  if (process.platform !== "linux" && report.prompter.contentProtected !== "n/a") expect(report.prompter.contentProtected).toBe(true);
});
