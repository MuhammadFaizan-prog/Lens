/**
 * Preview == export: the browser renderer draws N frames of the sample project's plan, the reference
 * compositor (compositor/render.py) renders the same plan, and every frame is compared by SSIM.
 *
 * Thresholds (set before the first measurement, see docs/Tracker.md): luma SSIM >= 0.95 on every
 * frame and >= 0.97 mean. Frames are chosen to cover zoom in / hold / pan, motion blur, the blur and
 * spotlight masks, click ripples, webcam shrink-on-zoom and captions with word highlight.
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.resolve(HERE, "..");
const OUT = path.join(EDITOR, "test-results", "parity");
const FRAMES = [0, 15, 24, 32, 48, 75, 110, 150, 172, 190, 205, 230, 262, 290];
const MIN_SSIM = 0.95;
const MEAN_SSIM = 0.97;

async function parityRun(page: import("@playwright/test").Page, OUT: string, FRAMES: number[], dir?: string) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  await page.goto(`/parity.html${q}`);
  await page.evaluate(() => window.lensParity.ready);
  const plan = await page.evaluate(() => window.lensParity.plan());
  fs.writeFileSync(path.join(OUT, "plan.json"), JSON.stringify(plan));
  for (const i of FRAMES) {
    const url = await page.evaluate((n) => window.lensParity.render(n), i);
    fs.writeFileSync(path.join(OUT, `frame-${i}.png`), Buffer.from(url.split(",")[1]!, "base64"));
  }
  const bundle = await (await page.request.get(`/api/bundle${q}`)).json();
  const args = [path.join(EDITOR, "scripts", "parity_ssim.py"), "--plan", path.join(OUT, "plan.json"), "--screen", path.join(bundle.dir, "screen.mp4"),
    "--pngs", OUT, "--frames", FRAMES.join(","), "--out", path.join(OUT, "ssim.json"), "--diff-dir", path.join(OUT, "diff"), "--assets", bundle.dir];
  if (plan.frames.some((f) => f.layout.camera) && bundle.camera) args.push("--camera", path.join(bundle.dir, "cam.mp4"));
  execFileSync("python3", args, { stdio: "inherit", timeout: 240_000 });
  const res = JSON.parse(fs.readFileSync(path.join(OUT, "ssim.json"), "utf8")) as { frames: Array<{ frame: number; ssim: number }>; mean: number; min: number };
  console.log(`parity SSIM ${dir ? path.basename(dir) : "sample"}: mean ${res.mean} min ${res.min} over ${res.frames.length} frames`);
  for (const r of res.frames) expect(r.ssim, `frame ${r.frame}`).toBeGreaterThanOrEqual(MIN_SSIM);
  expect(res.mean).toBeGreaterThanOrEqual(MEAN_SSIM);
  return { plan, res };
}

test("browser preview matches compositor/render.py frame for frame", async ({ page }) => {
  test.setTimeout(300_000);
  await parityRun(page, OUT, FRAMES);
});

/**
 * Annotations (demand #4) at parity: the annotations sample (apps/editor/sample-annotations) has every
 * kind (title pop, arrow draw-on, box draw-on, badge pop, lower-third typewriter, ellipse draw-on +
 * pop-out, callout pop), screen-anchored items under a zoom, the cursor, and a text slide with
 * cross-fades. Same thresholds as above.
 */
const ANN_FRAMES = [6, 20, 45, 90, 120, 140, 170, 184, 200, 223, 270, 290, 320, 350];

test("annotations and text slides: browser preview matches compositor/render.py", async ({ page }) => {
  test.setTimeout(400_000);
  const { plan } = await parityRun(page, path.join(EDITOR, "test-results", "parity-annotations"), ANN_FRAMES, path.join(EDITOR, "sample-annotations"));
  // the chosen frames really cover every kind, both anchors, a zoom and the slide
  const kinds = new Set<string>();
  const spaces = new Set<string>();
  for (const i of ANN_FRAMES) for (const a of plan.frames[i]!.annotations) {
    kinds.add(a.kind);
    spaces.add(a.space);
  }
  expect([...kinds].sort()).toEqual(["arrow", "badge", "callout", "ellipse", "rect", "text"]);
  expect([...spaces].sort()).toEqual(["frame", "screen"]);
  expect(ANN_FRAMES.some((i) => plan.frames[i]!.slide && plan.frames[i]!.slide!.opacity > 0 && plan.frames[i]!.slide!.opacity < 1)).toBe(true);
  expect(ANN_FRAMES.some((i) => plan.frames[i]!.annotations.some((a) => a.space === "screen") && plan.frames[i]!.cam[2] > 1.3)).toBe(true);
});
