/**
 * Interactive demo + step guide (demand #7).
 *
 * 1. The exported demo (lens export demo on a synthetic session whose recording carries a magenta
 *    marker at every click point), opened from disk with every non-file request blocked and the
 *    context offline: the hotspot sits on the marker within 2 px of the rendered image size at two
 *    viewport sizes; clicking the hotspot advances; ArrowRight / ArrowLeft / Home / End work; the step
 *    count equals the accepted steps; the call-to-action slide shows with the project's link; no
 *    console errors; no network request at all.
 * 2. The editor's Export dialog: build the demo, live preview in the iframe, drag a hotspot in the
 *    hotspot editor (project data changes, the iframe's hotspot moves without a rebuild), edit the
 *    tooltip (the iframe's tooltip changes live), undo; build the guide (PDF link).
 * Bounds written before the first run: hotspot error <= 2 px on each axis; 0 console errors; 0
 * network requests.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, openEditor, shot, state } from "./helpers";

const ROOT = path.resolve(EDITOR, "..", "..");
const SESSION = path.join(EDITOR, "test-results", "steps-session");
const HOTSPOT_TOL = 2;
let demoDir = "";
let accepted = 0;

test.beforeAll(() => {
  fs.rmSync(SESSION, { recursive: true, force: true });
  execFileSync("python3", ["-m", "lensharness.demo_synth", "--out", SESSION], { cwd: path.join(ROOT, "research", "harness") });
  const out = execFileSync("node", [path.join(ROOT, "packages", "cli", "dist", "cli.js"), "export", "demo", "-C", SESSION, "--json"], { cwd: ROOT }).toString();
  const r = JSON.parse(out.trim().split("\n").pop()!);
  expect(r.ok).toBe(true);
  demoDir = r.result.out;
  accepted = JSON.parse(fs.readFileSync(path.join(SESSION, "project.json"), "utf8")).stepLabels.drafts.filter((d: { state: string }) => d.state === "accepted").length;
});

/** Hotspot centre vs the magenta marker found in the displayed still, both in CSS px of the page. */
async function hotspotError(page: Page): Promise<{ dx: number; dy: number }> {
  return page.evaluate(async () => {
    const img = document.getElementById("ld-img") as HTMLImageElement;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sx = 0, sy = 0, sw = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = d[i]!, gg = d[i + 1]!, b = d[i + 2]!;
        if (r > 170 && b > 170 && gg < 110) {
          const w = (r + b) / 2 - gg;
          sx += x * w; sy += y * w; sw += w;
        }
      }
    if (!sw) return { dx: NaN, dy: NaN };
    const ir = img.getBoundingClientRect();
    const mx = ir.left + ((sx / sw + 0.5) / c.width) * ir.width;
    const my = ir.top + ((sy / sw + 0.5) / c.height) * ir.height;
    const h = document.getElementById("ld-hot")!.getBoundingClientRect();
    // the hotspot's centre point is its image-px position (+0.5: pixel centres -> CSS edges)
    const hx = h.left + h.width / 2, hy = h.top + h.height / 2;
    return { dx: hx - mx, dy: hy - my };
  });
}

test("exported demo: hotspots on the clicks, navigation, CTA, offline with no requests", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const requests: string[] = [];
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("file:") || u.startsWith("data:")) return route.continue();
    requests.push(u);
    return route.abort();
  });
  ctx.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("file:") && !u.startsWith("data:")) requests.push(u);
  });
  await ctx.setOffline(true);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + path.join(demoDir, "index.html"));
  const count = page.locator("#ld-count");
  await expect(count).toHaveText(`Step 1 of ${accepted}`);
  const steps = JSON.parse(fs.readFileSync(path.join(demoDir, "demo.json"), "utf8")).steps.length;
  expect(steps).toBe(accepted);

  let worst = 0;
  for (const vp of [{ width: 1600, height: 1000 }, { width: 900, height: 700 }]) {
    await page.setViewportSize(vp);
    await page.keyboard.press("Home");
    for (let i = 0; i < accepted; i++) {
      await expect(count).toHaveText(`Step ${i + 1} of ${accepted}`);
      const e = await hotspotError(page);
      expect(Number.isFinite(e.dx), `marker visible on step ${i + 1}`).toBe(true);
      worst = Math.max(worst, Math.abs(e.dx), Math.abs(e.dy));
      expect(Math.abs(e.dx), `step ${i + 1} at ${vp.width}x${vp.height}: dx`).toBeLessThanOrEqual(HOTSPOT_TOL);
      expect(Math.abs(e.dy), `step ${i + 1} at ${vp.width}x${vp.height}: dy`).toBeLessThanOrEqual(HOTSPOT_TOL);
      if (i === 2 && vp.width === 1600) await shot(page, "steps-demo-step3");
      // clicking the hotspot advances
      const bar0 = await page.locator("#ld-bar").evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
      await page.locator("#ld-hot").click();
      const bar1 = await page.locator("#ld-bar").evaluate((el) => (el as HTMLElement).style.width);
      expect(parseFloat(bar1)).toBeGreaterThan(0);
      expect(bar0).toBeGreaterThanOrEqual(0);
    }
    // after the last step: the call-to-action slide
    await expect(page.getByTestId("cta")).toBeVisible();
    await expect(count).toHaveText("Done");
  }
  console.log(`hotspot worst axis error ${worst.toFixed(3)} px (bound ${HOTSPOT_TOL})`);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const link = page.getByTestId("cta-link");
  await expect(link).toHaveAttribute("href", "https://example.com/start");
  await expect(link).toHaveText("Start free trial");
  await shot(page, "steps-demo-cta");
  // keys
  await page.keyboard.press("Home");
  await expect(count).toHaveText(`Step 1 of ${accepted}`);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(count).toHaveText(`Step 3 of ${accepted}`);
  await page.keyboard.press("ArrowLeft");
  await expect(count).toHaveText(`Step 2 of ${accepted}`);
  await expect(page.locator("#ld-label")).toHaveText("Click Share");
  await page.locator("#ld-next").click();
  await expect(count).toHaveText(`Step 3 of ${accepted}`);
  await page.locator("#ld-back").click();
  await expect(count).toHaveText(`Step 2 of ${accepted}`);
  await page.keyboard.press("End");
  await expect(page.getByTestId("cta")).toBeVisible();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(count).toHaveText(`Step 1 of ${accepted}`);
  // deep link
  await page.goto("file://" + path.join(demoDir, "index.html") + "#step-4");
  await expect(count).toHaveText(`Step 4 of ${accepted}`);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  await ctx.close();
});

test("editor Export dialog: live demo preview, hotspot editor, tooltip, guide", async ({ page }) => {
  await openEditor(page, `/?dir=${encodeURIComponent(SESSION)}`);
  await page.getByTestId("export-dialog-open").click();
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  await page.getByTestId("export-tab-demo").click();
  await expect(page.getByTestId("export-step")).toHaveCount(accepted);
  await page.getByTestId("export-build-demo").click();
  const frame = page.frameLocator('[data-testid="export-demo-frame"]');
  await expect(frame.locator("#ld-count")).toHaveText(`Step 1 of ${accepted}`, { timeout: 60_000 });
  await expect(page.getByTestId("hotspot-editor")).toBeVisible();
  // select step 3: the preview follows
  await page.getByTestId("export-step").nth(2).click();
  await expect(frame.locator("#ld-count")).toHaveText(`Step 3 of ${accepted}`);
  const before = await frame.locator("#ld-hot").boundingBox();
  // drag the hotspot 60 px right in the editor
  const h = await page.getByTestId("hotspot-handle").boundingBox();
  await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
  await page.mouse.down();
  await page.mouse.move(h!.x + h!.width / 2 + 30, h!.y + h!.height / 2, { steps: 4 });
  await page.mouse.move(h!.x + h!.width / 2 + 60, h!.y + h!.height / 2, { steps: 4 });
  await page.mouse.up();
  let st = await state(page);
  const hs = st.project.demo.hotspots as Array<{ stepId: string; x: number; y: number }>;
  expect(hs.length).toBe(1);
  expect(hs[0]!.stepId).toBe("st3");
  expect(hs[0]!.x).toBeGreaterThan(640 + 20);
  expect(Math.abs(hs[0]!.y - 420)).toBeLessThan(6);
  await expect.poll(async () => (await frame.locator("#ld-hot").boundingBox())!.x - before!.x).toBeGreaterThan(10);
  // tooltip text, live in the preview
  await page.getByTestId("hotspot-tooltip").fill("Create the report");
  await page.getByTestId("hotspot-tooltip").press("Enter");
  await expect(frame.locator("#ld-label")).toHaveText("Create the report");
  st = await state(page);
  expect((st.project.demo.hotspots as Array<{ tooltip?: string }>)[0]!.tooltip).toBe("Create the report");
  expect(st.project.stepLabels.drafts.find((d: { id: string }) => d.id === "st3").label).toBe("Click New report");
  await shot(page, "steps-export-dialog");
  // undo twice: tooltip, then hotspot
  await page.evaluate(() => (window as any).__lens.store.undo());
  await page.evaluate(() => (window as any).__lens.store.undo());
  st = await state(page);
  expect(st.project.demo.hotspots).toEqual([]);
  await expect(frame.locator("#ld-label")).toHaveText("Click New report");
  // the guide tab
  await page.getByTestId("export-tab-guide").click();
  await page.getByTestId("export-build-guide").click();
  await expect(page.getByTestId("guide-pdf")).toBeVisible({ timeout: 60_000 });
  const pdf = await page.request.get(await page.getByTestId("guide-pdf").getAttribute("href") as string);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await expect(page.frameLocator('[data-testid="guide-frame"]').locator(".lg-step")).toHaveCount(accepted);
});
