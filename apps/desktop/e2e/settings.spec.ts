/**
 * Windows #19: Settings window (gear on the recorder home). Changing the save location sends the
 * next recording there; rebinding start/stop to Ctrl+Alt+K works from anywhere and the old Ctrl+Shift+R
 * no longer does; a clash between two shortcuts is refused; everything survives a restart.
 * Bounds: settings window opens from the gear with the 4 tabs; clash -> error, nothing saved;
 * Ctrl+Shift+R after the rebind leaves the recorder idle for 1.5 s; Ctrl+Alt+K starts (<= 5 s) and
 * stops a take whose bundle is inside the new save folder; after relaunch the settings read back
 * equal and Ctrl+Alt+K records into the new folder again.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNS, appLaunchOptions, sleep, startXvfb, xdo } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

async function launch(env: Record<string, string>): Promise<{ a: ElectronApplication; rec: Page }> {
  const a = await electron.launch({ ...appLaunchOptions(), env: { ...process.env, ...env } as Record<string, string>, timeout: 60_000 });
  const rec = await a.firstWindow();
  await rec.waitForFunction(() => (window as any).lensRecorder?.state().sources.some((s: any) => s.kind === "screen"), null, { timeout: 30_000 });
  return { a, rec };
}

async function recorder(a: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    for (const p of a.windows()) {
      if (p.url().endsWith("recorder.html") && (await p.evaluate(() => !!(window as any).lensRecorder).catch(() => false))) return p;
    }
    await sleep(100);
  }
  throw new Error("no recorder window");
}

async function takeWithHotkey(a: ElectronApplication): Promise<string> {
  await a.evaluate(() => ((globalThis as any).lensLastResult = null));
  const rec = await recorder(a);
  xdo(DISPLAY, "key", "ctrl+alt+k");
  await rec.waitForFunction(() => (window as any).lensRecorder.state().state === "recording", null, { timeout: 5_000, polling: 50 });
  await sleep(1500);
  xdo(DISPLAY, "key", "ctrl+alt+k");
  let result: any = null;
  for (let i = 0; i < 600 && !result; i++) {
    result = await a.evaluate(() => (globalThis as any).lensLastResult ?? null);
    if (!result) await sleep(200);
  }
  expect(result, "recording saved").toBeTruthy();
  return result.dir as string;
}

test("settings: save location, hotkey rebind + conflict, persistence across restart", async () => {
  test.setTimeout(300_000);
  const run = path.join(RUNS, `settings-${Date.now()}`);
  const newSave = path.join(run, "new-save");
  fs.mkdirSync(run, { recursive: true });
  xvfb = await startXvfb(DISPLAY, 1280, 720);
  const env = { DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: path.join(run, "rec"), LENS_USER_DATA: path.join(run, "ud"), LENS_NO_UPDATE: "1" };
  const report: Record<string, any> = { packaged: !!process.env.LENS_PACKAGED_APP };

  let { a, rec } = await launch(env);
  app = a;
  await rec.click('[data-testid="settings"]');
  let sw: Page | undefined;
  for (let i = 0; i < 100 && !sw; i++) {
    sw = a.windows().find((p) => p.url().endsWith("settings.html"));
    if (!sw) await sleep(100);
  }
  expect(sw, "settings window").toBeTruthy();
  await sw!.waitForFunction(() => (document.getElementById("saveDir") as HTMLInputElement).value.length > 0);
  report.tabs = await sw!.locator("nav button").allTextContents();
  report.gpu = await sw!.locator('[data-testid="gpu"]').textContent();
  await sw!.fill('[data-testid="saveDir"]', newSave);
  await sw!.click('[data-testid="tab-shortcuts"]');
  await sw!.focus('[data-testid="sc-startStop"]');
  await sw!.keyboard.press("Control+Alt+KeyK");
  await sw!.focus('[data-testid="sc-region"]');
  await sw!.keyboard.press("Control+Alt+KeyK");
  await sw!.click('[data-testid="save"]');
  await sw!.waitForFunction(() => (document.getElementById("msg")!.textContent ?? "").length > 0);
  report.clash = await sw!.locator('[data-testid="msg"]').textContent();
  report.afterClash = await a.evaluate(() => (globalThis as any).lensSettingsNow?.() ?? null);
  await sw!.focus('[data-testid="sc-region"]');
  await sw!.keyboard.press("Backspace");
  await sw!.click('[data-testid="save"]');
  await sw!.waitForFunction(() => (document.getElementById("msg")!.textContent ?? "").startsWith("Saved"));
  report.saved = await sw!.locator('[data-testid="msg"]').textContent();
  await sw!.close();

  // old hotkey does nothing now
  rec = await recorder(a);
  xdo(DISPLAY, "key", "ctrl+shift+r");
  await sleep(1500);
  report.oldKeyState = await rec.evaluate(() => (window as any).lensRecorder.state().state);

  const dir1 = await takeWithHotkey(a);
  report.take1 = dir1;
  await a.close();
  app = null;

  // restart: same userData
  ({ a, rec } = await launch(env));
  app = a;
  const st = await rec.evaluate(() => (window as any).lensDesktop.settingsGet());
  report.afterRestart = { saveDir: st.settings.general.saveDir, startStop: st.settings.shortcuts.startStop, region: st.settings.shortcuts.region, hotkeyLabel: await rec.locator("#hotkey").textContent() };
  const dir2 = await takeWithHotkey(a);
  report.take2 = dir2;
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("settings report", JSON.stringify(report));

  expect(report.tabs).toEqual(["General", "Record", "Shortcut Keys", "Export"]);
  expect(report.clash).toContain("same keys");
  expect(report.saved).toMatch(/^Saved/);
  expect(report.oldKeyState).toBe("idle");
  expect(path.dirname(dir1)).toBe(newSave);
  expect(fs.existsSync(path.join(dir1, "screen.mp4"))).toBe(true);
  expect(report.afterRestart).toMatchObject({ saveDir: newSave, startStop: "CommandOrControl+Alt+K", region: "" });
  expect(path.dirname(dir2)).toBe(newSave);
  expect(fs.existsSync(path.join(dir2, "screen.mp4"))).toBe(true);
});
