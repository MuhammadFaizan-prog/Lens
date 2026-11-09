/**
 * Annotations lane (demand #9 UI fix): overlapping annotations stack into sub-rows; blocks never
 * overlap and labels stay readable; the lane collapses to one summary row and expands again.
 *
 * Bounds (written before the first run): with 7 sample items + 12 added items that all overlap in
 * time, at fit zoom and at 400% zoom: no two block rectangles (including an outside label's box)
 * intersect; every expanded block is >= 18 px tall; every label that is shown has >= 28 px of
 * visible width or the full text fits; collapsed, the lane is <= 32 px tall and every block is
 * still in it (clickable, selects the item); expanding restores the rows.
 */
import { test } from "@playwright/test";
import path from "node:path";
import { EDITOR, expect, openEditor, shot, state } from "./helpers";

const URL = `/?dir=${encodeURIComponent(path.join(EDITOR, "sample-annotations"))}`;

interface Box { id: string; x0: number; y0: number; x1: number; y1: number; lw: number; full: boolean }

async function boxes(page: import("@playwright/test").Page): Promise<Box[]> {
  return page.evaluate(() => {
    const out: Box[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="lane-annotation"] .block')) {
      const r = el.getBoundingClientRect();
      const lab = el.querySelector<HTMLElement>(".block-label")!;
      const lr = lab.getBoundingClientRect();
      const shown = getComputedStyle(lab).display !== "none";
      // the item's footprint: the block plus a label drawn outside it
      const x1 = shown ? Math.max(r.right, lr.right) : r.right;
      out.push({ id: el.dataset.testid!, x0: r.left, y0: r.top, x1, y1: r.bottom, lw: shown ? lr.width : 0, full: shown && lab.scrollWidth <= lab.clientWidth + 1 });
    }
    return out;
  }) as Promise<Box[]>;
}

function overlapping(bs: Box[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i]!, b = bs[j]!;
      if (a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5) bad.push(`${a.id} x ${b.id}`);
    }
  return bad;
}

test("annotations lane: stacked sub-rows never overlap, labels stay readable, collapse / expand", async ({ page }) => {
  test.setTimeout(120_000);
  await openEditor(page, URL);
  // 12 more items, all overlapping 2.0-6.0 s, short and long, with long labels
  await page.evaluate(() => {
    const st = (window as any).__lens.store;
    st.edit("Add many", (p: any) => ({
      ...p,
      annotations: [
        ...p.annotations,
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `extra${i}`, kind: i % 2 ? "rect" : "text", anchor: "screen", startMs: 2000 + i * 150, endMs: 2000 + i * 150 + (i % 3 === 0 ? 120 : 1800 + i * 100),
          rect: { x: 100 + i * 10, y: 100, w: i % 2 ? 80 : 0, h: i % 2 ? 40 : 0 }, text: i % 2 ? undefined : `Label number ${i} with words`,
          in: { kind: "fade", ms: 100 }, out: { kind: "fade", ms: 100 },
          style: { color: "@primary", fill: null, fillOpacity: 0.1, strokeWidth: 4, fontSize: 20, bold: true, textColor: "#ffffff", radius: 6, shadow: { enabled: false, opacity: 0, blur: 0, offsetY: 0 }, opacity: 1 },
        })),
      ],
    }));
  });
  expect((await state(page)).project.annotations.length).toBe(19);
  const lane = page.getByTestId("lane-annotation");
  await expect(lane).toHaveClass(/expanded/);
  for (const zoom of [null, 400]) {
    if (zoom) await page.getByTestId("timeline-zoom").fill(String(zoom));
    await page.waitForTimeout(200);
    const bs = await boxes(page);
    expect(bs.length).toBe(19);
    const rows = Number(await lane.getAttribute("data-rows"));
    console.log(`zoom ${zoom ?? "fit"}: ${rows} rows, lane ${(await lane.boundingBox())!.height} px, narrowest label ${Math.min(...bs.filter((b) => !b.full).map((b) => b.lw), Infinity).toFixed(0)} px`);
    expect(overlapping(bs)).toEqual([]);
    for (const b of bs) {
      expect(b.y1 - b.y0, b.id).toBeGreaterThanOrEqual(18);
      expect(b.full || b.lw >= 28, `${b.id} label ${b.lw}px`).toBe(true);
    }
    if (!zoom) await shot(page, "annotations-lane-expanded");
  }
  // collapse: one short summary row, every block still there and selectable
  await page.getByTestId("ann-lane-toggle").click();
  await expect(lane).toHaveClass(/collapsed/);
  const h = (await lane.boundingBox())!.height;
  expect(h).toBeLessThanOrEqual(32);
  const bs = await boxes(page);
  expect(bs.length).toBe(19);
  for (const b of bs) expect(b.y0 >= (await lane.boundingBox())!.y - 0.5 && b.y1 <= (await lane.boundingBox())!.y + h + 0.5, b.id).toBe(true);
  await page.getByTestId("block-annotation-extra5").click({ force: true });
  expect((await state(page)).project.annotations.findIndex((a: any) => a.id === "extra5")).toBeGreaterThan(0);
  await page.getByTestId("ann-lane-toggle").click();
  await expect(lane).toHaveClass(/expanded/);
  expect(overlapping(await boxes(page))).toEqual([]);
});
