/**
 * Editor File menu (Windows report 2026-11-09: no way to import a video from inside the editor).
 * Bounds: the editor header has File ▾ with Import Video…, History…, New Recording; importing a clip
 * from an open editor opens it in a new editor window that reaches "ready" with the clip's duration;
 * History lists the bundles; New Recording shows the (hidden) recorder.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNS, appLaunchOptions, makeBundle, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

test("editor File menu: import a video from an open editor, history, new recording", async () => {
  test.setTimeout(240_000);
  const run = path.join(RUNS, `editor-file-${Date.now()}`);
  const recDir = path.join(run, "rec");
  fs.mkdirSync(recDir, { recursive: true });
  const first = makeBundle(path.join(recDir, "Lens-2026-01-01_10-00-00"), { seconds: 2 });
  const clip = path.join(run, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", clip]);
  xvfb = await startXvfb(DISPLAY, 1280, 720);
  app = await electron.launch({
    ...appLaunchOptions(),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: recDir, LENS_USER_DATA: path.join(run, "ud"), LENS_NO_UPDATE: "1" },
    timeout: 60_000,
  });
  const rec = await app.firstWindow();
  await rec.waitForFunction(() => !!(window as any).lensRecorder, null, { timeout: 30_000 });
  const report: Record<string, any> = { packaged: !!process.env.LENS_PACKAGED_APP };
  const editorFor = async (dir: string): Promise<Page> => {
    let ed: Page | undefined;
    for (let i = 0; i < 300 && !ed; i++) {
      ed = app!.windows().find((p) => p.url().includes(encodeURIComponent(dir)));
      if (!ed) await sleep(100);
    }
    expect(ed, `editor for ${dir}`).toBeTruthy();
    await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 60_000 });
    return ed!;
  };
  void rec.evaluate((d) => (window as any).lensDesktop.historyOpen(d), first);
  const ed = await editorFor(first);
  // the recorder is hidden (tray) while we work in the editor
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("recorder.html"))?.hide());

  await ed.click('[data-testid="editor-file-menu"]');
  report.items = await ed.locator('[data-testid="editor-file-items"] button').allTextContents();
  await ed.click('[data-testid="editor-file-menu"]');

  const t0 = Date.now();
  const r = await ed.evaluate((f) => (window as any).__lensFile.importVideo(f), clip);
  report.import = r;
  const imported = await editorFor(r.dir);
  report.importToReadyMs = Date.now() - t0;
  report.importedDuration = await imported.evaluate(() => (window as any).__lens.state().durationMs);
  report.firstEditorStillOpen = !ed.isClosed();
  report.status = await ed.locator('[data-testid="editor-file-status"]').textContent();

  await ed.bringToFront();
  await ed.click('[data-testid="editor-file-menu"]');
  await ed.click('[data-testid="editor-history"]');
  await ed.waitForSelector('[data-testid="editor-history-item"]', { timeout: 15_000 });
  report.historyRows = await ed.locator('[data-testid="editor-history-item"]').count();
  await ed.screenshot({ path: path.join(run, "editor-history.png") });
  await ed.keyboard.press("Escape");
  await ed.locator(".history-sheet .sheet-actions .btn").click();

  const recVisible = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("recorder.html") && w.isVisible()));
  report.recorderBefore = await recVisible();
  await ed.click('[data-testid="editor-file-menu"]');
  await ed.click('[data-testid="editor-new-recording"]');
  await sleep(800);
  report.recorderAfter = await recVisible();
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("editor-file report", JSON.stringify(report));

  expect(report.items).toEqual(["Import Video…", "History…", "New Recording"]);
  expect(report.import.video).toBe("copy");
  expect(Math.abs(report.importedDuration - 3000)).toBeLessThanOrEqual(100);
  expect(report.firstEditorStillOpen).toBe(true);
  expect(report.status).toMatch(/Imported/);
  expect(report.historyRows).toBe(2);
  expect(report.recorderBefore).toBe(false);
  expect(report.recorderAfter).toBe(true);
});
