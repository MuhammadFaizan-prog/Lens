/**
 * Windows #1b: caption translation needs the Python lens-translate + models the desktop app does not
 * ship. In the packaged app it must say so instead of failing with "python3: can't open file".
 * Bounds: /api/bundle translateUnavailable is the reason; POST /api/translate answers state "error"
 * with that reason (no python spawned); the Captions tab shows the reason and Translate is disabled.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { RUNS, appLaunchOptions, makeBundle, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

test("caption translation is shown as unavailable in the desktop app", async () => {
  test.setTimeout(180_000);
  const run = path.join(RUNS, `translate-off-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  const bundle = makeBundle(path.join(run, "bundle"), { seconds: 2 });
  xvfb = await startXvfb(DISPLAY, 1440, 900);
  app = await electron.launch({ ...appLaunchOptions(), env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_NO_UPDATE: "1", LENS_USER_DATA: path.join(run, "ud"), LENS_OPEN_BUNDLE: bundle } as Record<string, string>, timeout: 60_000 });
  let ed: Page | undefined;
  for (let i = 0; i < 240 && !ed; i++) {
    ed = app.windows().find((p) => p.url().includes("dir="));
    if (!ed) await sleep(250);
  }
  expect(ed).toBeTruthy();
  await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
  const api = await ed!.evaluate(async () => {
    const q = location.search;
    const b = await (await fetch(`/api/bundle${q}`)).json();
    const t = await (await fetch(`/api/translate${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ langs: ["es"] }) })).json();
    return { reason: b.translateUnavailable, post: t };
  });
  await ed!.getByRole("tab", { name: "Captions" }).or(ed!.locator("text=Captions").first()).first().click();
  await ed!.waitForSelector('[data-testid="translate-unavailable"]', { timeout: 10_000 });
  const ui = { hint: await ed!.locator('[data-testid="translate-unavailable"]').textContent(), goDisabled: await ed!.locator('[data-testid="translate-go"]').isDisabled() };
  await ed!.screenshot({ path: path.join(run, "captions.png") });
  const report = { packaged: !!process.env.LENS_PACKAGED_APP, api, ui };
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("translate-off report", JSON.stringify(report));
  expect(api.reason).toContain("not available in the desktop app");
  expect(api.post.state).toBe("error");
  expect(api.post.error).toBe(api.reason);
  expect(ui.hint).toBe(api.reason);
  expect(ui.goDisabled).toBe(true);
});
