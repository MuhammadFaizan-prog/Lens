/**
 * Windows bug #1 on the packaged app: "Scan for sensitive info" and "Generate step labels" run in-app
 * (Node + tesseract.js on a worker thread, model from resources/lens/assets/models), with no Python on
 * PATH. Bounds (set before measuring): both jobs finish without error; the scan finds >= 1 planted
 * secret on the 15 s privacy sample (scripts/make_sample.py --privacy: fake secrets, dev variant);
 * step labels return one draft per click (2 clicks added to the events).
 */
import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, RUNS, appLaunchOptions, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 97);
let xvfb: ChildProcess | null = null;
test.beforeAll(async () => (xvfb = await startXvfb(DISPLAY, 1600, 1000)));
test.afterAll(() => xvfb?.kill());

test("privacy scan and step labels without Python (packaged app)", async () => {
  test.setTimeout(900_000);
  const bundle = path.join(RUNS, "pkg-redact", "bundle");
  fs.rmSync(bundle, { recursive: true, force: true });
  execFileSync("python3", [path.join(REPO, "apps", "editor", "scripts", "make_sample.py"), "--privacy", "--out", bundle]); // test fixture only
  fs.appendFileSync(path.join(bundle, "events.jsonl"), ['{"t":3000,"type":"down","x":400,"y":300,"button":"left"}', '{"t":3060,"type":"up","x":400,"y":300,"button":"left"}',
    '{"t":9000,"type":"down","x":900,"y":500,"button":"left"}', '{"t":9060,"type":"up","x":900,"y":500,"button":"left"}'].join("\n") + "\n");
  // no python3 for the app: PATH without any directory holding python
  const PATH = (process.env.PATH ?? "").split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, "python3")) && !fs.existsSync(path.join(d, "python"))).join(path.delimiter);
  const app = await electron.launch({
    ...appLaunchOptions(),
    env: { ...process.env, PATH, DISPLAY: `:${DISPLAY}`, LENS_LOWMEM: "1", LENS_OCR_WORKERS: "1", LENS_NO_UPDATE: "1", LENS_OPEN_BUNDLE: bundle, LENS_USER_DATA: path.join(os.tmpdir(), `lens-ud-${Date.now()}`) },
  });
  try {
    let ed = null;
    for (let i = 0; i < 120 && !ed; i++) {
      ed = app.windows().find((p) => p.url().includes("dir=")) ?? null;
      if (!ed) await sleep(500);
    }
    expect(ed, "editor window").toBeTruthy();
    await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
    const t0 = Date.now();
    await ed!.evaluate(() => (window as any).__lens.store.scanPrivacy(true));
    const scan = await ed!.evaluate(() => (window as any).__lens.store.get().privacyScan);
    const dets = await ed!.evaluate(() => (window as any).__lens.store.get().project.privacy.detections.length);
    const scanS = (Date.now() - t0) / 1000;
    await ed!.evaluate(() => (window as any).__lens.store.generateSteps());
    const steps = await ed!.evaluate(() => (window as any).__lens.store.get().stepRun);
    const drafts = await ed!.evaluate(() => (window as any).__lens.store.get().project.stepLabels.drafts.length);
    const report = { packaged: !!process.env.LENS_PACKAGED_APP, scan: { state: scan.state, error: scan.error, detections: dets, seconds: scanS }, steps: { state: steps.state, error: steps.error, drafts } };
    fs.writeFileSync(path.join(RUNS, "pkg-redact", "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    expect(scan.state, scan.error).toBe("done");
    expect(dets).toBeGreaterThanOrEqual(1);
    expect(steps.state, steps.error).toBe("done");
    expect(drafts).toBe(2);
  } finally {
    await app.close().catch(() => undefined);
  }
});
