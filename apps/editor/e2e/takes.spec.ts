/**
 * Multi-take in the editor (demand #1), on the multi-take sample (apps/editor/sample-takes: the
 * default sample's media with a fumbled first take of "Watch the camera ..."). The swap button must
 * change the kept take in the plan AND in what the preview draws; A/B preview plays a take without
 * an undo step; undo restores the original take, plan and pixels.
 */
import { test } from "@playwright/test";
import path from "node:path";
import { EDITOR, canvasPixels, expect, meanAbsDiff, openEditor, seek, shot, state, waitDrawn } from "./helpers";

const TAKES_URL = `/?dir=${encodeURIComponent(path.join(EDITOR, "sample-takes"))}`;
const words = (s: { caption: { words: string[] } | null }) => (s.caption?.words ?? []).join(" ");

test("swap take changes the kept take and the preview; A/B preview; undo restores it", async ({ page }) => {
  await openEditor(page, TAKES_URL);
  let s = await state(page);
  expect(s.takes).toHaveLength(1);
  const g0 = s.takes[0]!;
  expect(g0.takes).toHaveLength(2);
  expect(g0.kept).toBe(1); // strategy "last"
  const [alt, last] = g0.takes;

  // timeline lane: the first take is ghosted, the second kept
  await expect(page.getByTestId("take-0-0")).toHaveClass(/rejected/);
  await expect(page.getByTestId("take-0-1")).toHaveClass(/kept/);
  // transcript: the fumbled take's words are struck through, the kept take's are not
  for (let i = alt!.firstWord; i <= alt!.lastWord; i++) await expect(page.getByTestId(`word-${i}`)).toHaveClass(/alt-take/);
  for (let i = last!.firstWord; i <= last!.lastWord; i++) await expect(page.getByTestId(`word-${i}`)).not.toHaveClass(/alt-take/);

  // The output frame where "Watch the camera" begins, with the last take kept.
  const frameOf = (src: number) => page.evaluate((t) => {
    const st = (window as any).__lens.store.get();
    const f = st.plan.frames as Array<{ src: number }>;
    let i = 0;
    while (i < f.length - 1 && f[i]!.src < t) i++;
    return i;
  }, src);
  const fB = await frameOf(last!.startMs + 120);
  await seek(page, fB);
  s = await state(page);
  expect(s.src).toBeGreaterThanOrEqual(last!.startMs);
  expect(words(s)).toContain("Watch");
  const beforePx = await canvasPixels(page);
  const beforeFrames = s.frames;
  const beforeSrc = s.src;
  await shot(page, "takes-01-last-kept");

  // A/B preview the rejected take: plays it with a trial plan, no undo step
  const undoBefore = s.canUndo;
  await page.getByTestId("take-ab-0-0").click();
  await page.waitForFunction(() => (window as any).__lens.state().audition !== null);
  s = await state(page);
  expect(s.audition!.take).toBe(0);
  expect(s.takes[0]!.kept).toBe(0); // the trial plan keeps the previewed take
  expect(s.canUndo).toBe(undoBefore);
  expect(s.project.edits.takes.choices).toHaveLength(0);
  await expect(page.getByTestId("audition-bar")).toBeVisible();
  await shot(page, "takes-02-ab-preview");
  // it ends on its own after the take and restores the project's plan
  await page.waitForFunction(() => (window as any).__lens.state().audition === null, null, { timeout: 30_000 });
  s = await state(page);
  expect(s.takes[0]!.kept).toBe(1);
  expect(s.playing).toBe(false);

  // Swap: click the ghosted take in the Alt Takes lane
  await page.getByTestId("take-0-0").click({ position: { x: 4, y: 12 } });
  await page.waitForFunction(() => (window as any).__lens.state().takes[0]?.kept === 0);
  s = await state(page);
  expect(s.canUndo).toBe(true);
  expect(s.project.edits.takes.choices).toEqual([{ atMs: expect.any(Number), keep: 0 }]);
  await expect(page.getByTestId("take-0-0")).toHaveClass(/kept/);
  await expect(page.getByTestId("take-0-1")).toHaveClass(/rejected/);
  for (let i = alt!.firstWord; i <= alt!.lastWord; i++) await expect(page.getByTestId(`word-${i}`)).not.toHaveClass(/alt-take/);
  for (let i = last!.firstWord; i <= last!.lastWord; i++) await expect(page.getByTestId(`word-${i}`)).toHaveClass(/alt-take/);
  // the preview now shows the first take where the sentence begins
  const fA = await frameOf(alt!.startMs + 120);
  await seek(page, fA);
  s = await state(page);
  expect(s.src).toBeGreaterThanOrEqual(alt!.startMs);
  expect(s.src).toBeLessThan(alt!.endMs);
  expect(words(s)).toContain("Watch");
  // same output position as before the swap now draws a different source moment
  await seek(page, fB);
  s = await state(page);
  expect(Math.abs(s.src - beforeSrc)).toBeGreaterThan(200);
  const swappedPx = await canvasPixels(page);
  expect(meanAbsDiff(beforePx, swappedPx)).toBeGreaterThan(0.5);
  await shot(page, "takes-03-first-kept");

  // Undo restores the kept take, the plan and the pixels
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => (window as any).__lens.state().takes[0]?.kept === 1);
  s = await state(page);
  expect(s.project.edits.takes.choices).toHaveLength(0);
  expect(s.frames).toBe(beforeFrames);
  await seek(page, fB);
  s = await state(page);
  expect(s.src).toBeCloseTo(beforeSrc, 1);
  await waitDrawn(page);
  expect(meanAbsDiff(beforePx, await canvasPixels(page))).toBeLessThan(0.5);
  await expect(page.getByTestId("take-0-0")).toHaveClass(/rejected/);
});

test("mark retake and takes toggle are undoable edits", async ({ page }) => {
  await openEditor(page, TAKES_URL);
  // turning takes off brings the fumbled take back
  const n0 = (await state(page)).frames;
  await page.getByTestId("takes-enabled").uncheck();
  await page.waitForFunction(() => (window as any).__lens.state().takes.length === 0);
  expect((await state(page)).frames).toBeGreaterThan(n0);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => (window as any).__lens.state().takes.length === 1);
  expect((await state(page)).frames).toBe(n0);
  // mark "Private bits" as a retake by hand: words 18..19 become a rejected take
  await page.getByTestId("word-18").click();
  await page.getByTestId("word-19").click({ modifiers: ["Shift"] });
  await page.getByTestId("mark-retake").click();
  await page.waitForFunction(() => (window as any).__lens.state().takes.length === 2);
  const s = await state(page);
  expect(s.takes[1]!.manual).toBe(true);
  await expect(page.getByTestId("word-18")).toHaveClass(/alt-take/);
  await expect(page.getByTestId("word-19")).toHaveClass(/alt-take/);
  expect(s.frames).toBeLessThan(n0);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => (window as any).__lens.state().takes.length === 1);
  await expect(page.getByTestId("word-18")).not.toHaveClass(/alt-take/);
});
