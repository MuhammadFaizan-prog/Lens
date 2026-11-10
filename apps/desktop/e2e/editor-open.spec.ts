/**
 * Windows report 2026-11-09 (v0.1.2): after a recording saved, the editor stayed blank for good: black
 * preview, 00:00.01, "no microphone track", empty timeline. /api/bundle decoded every frame of
 * screen.mp4 to JPEG before answering (37 s for a 1080p60 minute on the 2-core box, minutes on Windows)
 * while the UI showed its empty defaults. Now: frame count without decoding, JPEG pass in the
 * background, on-demand frames, a loading state, and load errors in a banner + lens.log.
 * Windows conditions simulated: no ffprobe (LENS_FFPROBE -> a missing binary), a long path with spaces.
 * Bounds: 60 s 1080p bundle: loading state shown, first source frame painted <= 5 s after the window's
 * page start, duration 60 000 ms +- 50, plan frames > 0; a playhead jump to 50 s paints within 3 s;
 * a broken screen.mp4 shows the load-error banner with a reason and lens.log has it.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNS, appLaunchOptions, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

function bundle(dir: string, seconds: number): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=1920x1080:r=30:d=${seconds}`, "-f", "lavfi", "-i", `sine=f=440:d=${seconds}:sample_rate=48000`,
    "-map", "0:v", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p", path.join(dir, "screen.mp4"), "-map", "1:a", "-ac", "2", "-c:a", "pcm_s16le", path.join(dir, "mic.wav")]);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: 1920, height: 1080, fps: 30, durationMs: seconds * 1000, pixelRatio: 1 }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), `# lens-events v1 ${JSON.stringify({ capture: { width: 1920, height: 1080 }, source: "screen", platform: "win32", displayId: null })}\n`);
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }] } }));
}

test("editor opens a 60 s 1080p recording fast, shows a loading state, and reports load errors", async () => {
  test.setTimeout(300_000);
  const run = path.join(RUNS, `editor-open-${Date.now()}`);
  const recDir = path.join(run, "Users", "Faizi Ali", "Videos", "Lens");
  const good = path.join(recDir, "Lens-2026-11-09_21-00-00 long name with spaces");
  const bad = path.join(recDir, "Lens-2026-11-09_21-05-00 broken");
  bundle(good, 60);
  bundle(bad, 2);
  fs.writeFileSync(path.join(bad, "screen.mp4"), "truncated: not a video");
  const ud = path.join(run, "ud");
  xvfb = await startXvfb(DISPLAY, 1280, 720);
  app = await electron.launch({
    ...appLaunchOptions(),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: recDir, LENS_USER_DATA: ud, LENS_NO_UPDATE: "1", LENS_FFPROBE: path.join(run, "no-such", "ffprobe.exe") },
    timeout: 60_000,
  });
  const rec = await app.firstWindow();
  await rec.waitForFunction(() => !!(window as any).lensRecorder, null, { timeout: 30_000 });
  const report: Record<string, any> = { packaged: !!process.env.LENS_PACKAGED_APP };

  const editorFor = async (dir: string): Promise<Page> => {
    const t0 = Date.now();
    void rec.evaluate((d) => (window as any).lensDesktop.historyOpen(d), dir);
    let ed: Page | undefined;
    for (let i = 0; i < 300 && !ed; i++) {
      ed = app!.windows().find((p) => p.url().includes(encodeURIComponent(dir)));
      if (!ed) await sleep(50);
    }
    expect(ed, `editor window for ${dir}`).toBeTruthy();
    report[`windowMs_${path.basename(dir).slice(0, 26)}`] = Date.now() - t0;
    return ed!;
  };

  const ed = await editorFor(good);
  const tOpen = Date.now();
  await ed.waitForLoadState("domcontentloaded");
  report.loadingShown = (await ed.waitForSelector('[data-testid="loading"]', { timeout: 10_000 }).then(() => 1).catch(() => 0));
  report.noMicMessageWhileLoading = await ed.getByText("no microphone track").count();
  await ed.waitForFunction(() => (window as any).__lens?.store && (window as any).__lens.state().firstPaintMs != null, null, { timeout: 60_000, polling: 100 });
  report.wallToFirstPaintMs = Date.now() - tOpen;
  const st = await ed.evaluate(() => (window as any).__lens.state());
  report.readyMs = st.readyMs;
  report.firstPaintMs = st.firstPaintMs;
  report.durationMs = st.durationMs;
  report.frames = st.frames;
  report.status = st.status;
  report.durationLabel = await ed.locator(".transport, [data-testid=transport]").first().textContent().catch(() => null);
  // jump far ahead of the background JPEG pass
  const t1 = Date.now();
  const before = await ed.evaluate(() => (window as any).__lens.store.screen ? 1 : 0);
  void before;
  await ed.evaluate(() => (window as any).__lens.store.seekSource ? (window as any).__lens.store.seekSource(50_000) : (window as any).__lens.store.set({ frame: Math.round(50 * (window as any).__lens.state().fps) }));
  await ed.waitForFunction(() => { const s = (window as any).__lens.store; const i = s.screen.indexAt(50_000); return !!s.screen.peek(i); }, null, { timeout: 30_000, polling: 50 });
  report.seek50sMs = Date.now() - t1;
  await ed.screenshot({ path: path.join(run, "editor-60s.png") });

  // broken bundle: a banner with the reason, logged
  const ed2 = await editorFor(bad);
  await ed2.waitForFunction(() => (window as any).__lens?.state().status === "error", null, { timeout: 60_000 });
  report.errorBanner = await ed2.locator('[data-testid="load-error"]').textContent();
  await ed2.screenshot({ path: path.join(run, "editor-broken.png") });
  await sleep(500);
  const logFile = path.join(ud, "logs", "lens.log");
  report.logExists = fs.existsSync(logFile);
  report.logHasError = report.logExists && /api\/bundle.*broken/.test(fs.readFileSync(logFile, "utf8"));
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("editor-open report", JSON.stringify(report));

  expect(report.loadingShown).toBe(1);
  expect(report.noMicMessageWhileLoading).toBe(0);
  expect(report.status).toBe("ready");
  expect(report.firstPaintMs).toBeLessThanOrEqual(5000);
  expect(Math.abs(report.durationMs - 60_000)).toBeLessThanOrEqual(50);
  expect(report.frames).toBeGreaterThan(0);
  expect(report.seek50sMs).toBeLessThanOrEqual(3000);
  expect(report.errorBanner).toMatch(/Could not open the recording: .+/);
  expect(report.logHasError).toBe(true);
});
