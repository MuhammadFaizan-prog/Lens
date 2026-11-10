/**
 * Timeline multi-select end to end, on the sample bundle: blocks on two lanes (Cuts, Speed);
 * Ctrl+click two (badge "2 selected"), Delete removes both and one Ctrl+Z restores both; a marquee
 * from an empty spot on the Cuts lane down to the Speed lane selects all three; dragging one block of
 * the group moves every block by the same delta; Shift+click selects the run between two blocks;
 * Esc clears; right-click Duplicate copies a block; the lane menu's "Delete all" asks first (> 3
 * blocks) and removes the whole lane as one undo step.
 */
import { test, type Page } from "@playwright/test";
import { expect, openEditor, shot } from "./helpers";

type Ref = { track: string; index: number };
type Range = { startMs: number; endMs: number };

const proj = (page: Page) => page.evaluate(() => (window as any).__lens.store.get().project);
const speeds = async (page: Page): Promise<Range[]> => (await proj(page)).edits.speed.map((s: Range) => ({ startMs: s.startMs, endMs: s.endMs }));
const cuts = async (page: Page): Promise<Range[]> => (await proj(page)).edits.cuts.map((s: Range) => ({ startMs: s.startMs, endMs: s.endMs }));
const keys = (page: Page) => page.evaluate(() => ((window as any).__lens.store.get().multi as Ref[]).map((x) => `${x.track}:${x.index}`).sort());
const center = async (page: Page, testId: string) => {
  const b = (await page.getByTestId(testId).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

async function dragMouse(page: Page, a: { x: number; y: number }, b: { x: number; y: number }, steps = 10): Promise<void> {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("timeline multi-select: ctrl/shift click, marquee, group drag, bulk delete, duplicate, lane menu", async ({ page }) => {
  await page.getByTestId("lane-speed").scrollIntoViewIfNeeded();
  const cutLane = (await page.getByTestId("lane-cut").boundingBox())!;
  const speedLane = (await page.getByTestId("lane-speed").boundingBox())!;

  // ---- three blocks on two lanes (double-click a lane adds one)
  await page.mouse.dblclick(speedLane.x + speedLane.width * 0.15, speedLane.y + speedLane.height / 2);
  await page.mouse.dblclick(speedLane.x + speedLane.width * 0.6, speedLane.y + speedLane.height / 2);
  await page.mouse.dblclick(cutLane.x + cutLane.width * 0.38, cutLane.y + cutLane.height / 2);
  const s0 = await speeds(page);
  const c0 = await cuts(page);
  expect(s0).toHaveLength(2);
  expect(c0).toHaveLength(1);
  console.log(`blocks: speed ${JSON.stringify(s0)} cut ${JSON.stringify(c0)}`);

  // ---- Ctrl+click two -> badge "2 selected"; Delete removes both; one Ctrl+Z restores both
  await page.keyboard.press("Escape");
  expect(await keys(page)).toEqual([]);
  await page.getByTestId("block-speed-0").click({ modifiers: ["Control"] });
  await page.getByTestId("block-cut-0").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("selection-count")).toHaveText("2 selected");
  expect(await keys(page)).toEqual(["cut:0", "speed:0"]);
  await expect(page.getByTestId("multi-selection-count")).toHaveText("2 items selected");
  await page.keyboard.press("Delete");
  expect(await speeds(page)).toEqual([s0[1]]);
  expect(await cuts(page)).toEqual([]);
  await expect(page.getByTestId("selection-count")).toBeHidden();
  await page.keyboard.press("Control+z");
  expect(await speeds(page)).toEqual(s0);
  expect(await cuts(page)).toEqual(c0);

  // ---- marquee from an empty spot on the Cuts lane down to the Speed lane selects all three
  await page.keyboard.press("Escape");
  await dragMouse(page, { x: cutLane.x + cutLane.width * 0.03, y: cutLane.y + cutLane.height / 2 }, { x: speedLane.x + speedLane.width * 0.95, y: speedLane.y + speedLane.height / 2 });
  expect(await keys(page)).toEqual(["cut:0", "speed:0", "speed:1"]);
  await expect(page.getByTestId("selection-count")).toHaveText("3 selected");
  await expect(page.getByTestId("timeline-marquee")).toBeHidden();
  await shot(page, "timeline-multiselect-marquee");

  // ---- dragging one grouped block moves all three by the same delta (one undo step)
  const a = await center(page, "block-speed-0");
  await dragMouse(page, a, { x: a.x + 60, y: a.y });
  const s1 = await speeds(page);
  const c1 = await cuts(page);
  const d = s1[0]!.startMs - s0[0]!.startMs;
  console.log(`group drag delta ${d} ms`);
  expect(Math.abs(d)).toBeGreaterThan(100);
  for (const [x, y] of [[s1[0]!, s0[0]!], [s1[1]!, s0[1]!], [c1[0]!, c0[0]!]] as const) {
    expect(x.startMs - y.startMs).toBe(d);
    expect(x.endMs - y.endMs).toBe(d);
  }
  expect(await keys(page)).toEqual(["cut:0", "speed:0", "speed:1"]);
  await page.keyboard.press("Control+z");
  expect(await speeds(page)).toEqual(s0);
  expect(await cuts(page)).toEqual(c0);
  await page.keyboard.press("Control+Shift+z");
  expect(await speeds(page)).toEqual(s1);

  // ---- Shift+click selects the run between the primary and the clicked block (a third speed block between)
  const e0 = await center(page, "block-speed-0");
  const e1 = await center(page, "block-speed-1");
  const b0 = (await page.getByTestId("block-speed-0").boundingBox())!;
  const b1 = (await page.getByTestId("block-speed-1").boundingBox())!;
  await page.mouse.dblclick((b0.x + b0.width + b1.x) / 2, e0.y);
  const s2 = await speeds(page);
  expect(s2).toHaveLength(3);
  expect(s2[0]!.startMs).toBeLessThan(s2[1]!.startMs);
  expect(s2[1]!.startMs).toBeLessThan(s2[2]!.startMs);
  await page.mouse.click(e0.x, e0.y); // plain click: the only selection (and the primary)
  expect(await keys(page)).toEqual(["speed:0"]);
  await page.getByTestId("block-speed-2").click({ modifiers: ["Shift"] });
  expect(await keys(page)).toEqual(["speed:0", "speed:1", "speed:2"]);
  await expect(page.getByTestId("selection-count")).toHaveText("3 selected");
  expect(e1.x).toBeGreaterThan(e0.x);

  // ---- Esc clears the selection
  await page.keyboard.press("Escape");
  expect(await keys(page)).toEqual([]);
  await expect(page.getByTestId("selection-count")).toBeHidden();
  await expect(page.getByTestId("multi-selection-card")).toBeHidden();

  // ---- right-click Duplicate: the copy lands right after the block and becomes the selection
  await page.getByTestId("block-speed-2").click({ button: "right" });
  await expect(page.getByTestId("block-menu")).toBeVisible();
  await page.getByTestId("block-menu-duplicate").click();
  const s3 = await speeds(page);
  expect(s3).toHaveLength(4);
  const len = s2[2]!.endMs - s2[2]!.startMs;
  expect(s3[3]).toEqual({ startMs: s2[2]!.startMs + len, endMs: s2[2]!.endMs + len });
  expect(await keys(page)).toEqual(["speed:3"]);

  // ---- lane menu "Delete all": more than 3 blocks asks first, then the lane empties as one undo step
  await page.getByTestId("lane-menu-speed").click();
  await expect(page.getByTestId("lane-menu")).toBeVisible();
  let asked = "";
  page.once("dialog", (dlg) => {
    asked = dlg.message();
    void dlg.accept();
  });
  await page.getByTestId("lane-menu-delete-all").click();
  await expect.poll(async () => (await speeds(page)).length).toBe(0);
  expect(asked).toContain("Delete all 4 blocks");
  expect(await cuts(page)).toHaveLength(1); // the other lane is untouched
  await page.keyboard.press("Control+z");
  expect(await speeds(page)).toEqual(s3);
  await shot(page, "timeline-multiselect-done");
});
