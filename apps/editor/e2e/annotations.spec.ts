/**
 * Annotations in the editor (demand #4), on the annotations sample (apps/editor/sample-annotations: a
 * short click-through of a fake app with every annotation kind and a text slide).
 *
 * 1. Draw an arrow by click-drag on the preview (lands where the pointer went, in source px), edit text
 *    inline (create + double-click), scrub through the arrow's draw-on with the scrubber and watch the
 *    drawn arrow grow frame by frame, then undo everything back to the original pixels.
 * 2. Generate step labels (real on-device OCR through the dev server), edit one, accept all: badges
 *    numbered 1..n in click order in the plan and on the preview; undo / redo.
 */
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, canvasPixels, expect, meanAbsDiff, openEditor, seek, shot, state, waitDrawn } from "./helpers";

const DIR = path.join(EDITOR, "sample-annotations");
const URL = `/?dir=${encodeURIComponent(DIR)}`;

/** Canvas px of an output-px point (the preview canvas is CSS-scaled). */
async function screenPt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId("ann-overlay").boundingBox())!;
  const s = await state(page);
  const W = s.project.output.resolution === 720 ? 1280 : 1920;
  const H = W === 1280 ? 720 : 1080;
  return { x: box.x + (x / W) * box.width, y: box.y + (y / H) * box.height };
}

/** Output px of a source point through the current frame's camera. */
async function srcToOut(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([px, py]: number[]) => {
    const st = (window as any).__lens.store.get();
    const f = st.plan.frames[st.frame];
    const [cropX, cropY, srcW, srcH] = st.plan.source.crop;
    const [cx, cy, s] = f.cam;
    const [sx, sy, sw, sh] = f.layout.screen;
    const vw = srcW / s, vh = srcH / s;
    return { x: sx + (px! - cropX - (cx - vw / 2)) * (sw / vw), y: sy + (py! - cropY - (cy - vh / 2)) * (sh / vh) };
  }, [x, y]);
}

/** Pixels of the default annotation colour (#ff5a36) in the preview, inside an output-px rect. */
async function orangePixels(page: Page, r: { x: number; y: number; w: number; h: number }): Promise<number> {
  return page.evaluate((q) => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(Math.floor(q.x), Math.floor(q.y), Math.ceil(q.w), Math.ceil(q.h)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! > 60 && d[i + 1]! < 130 && d[i + 2]! < 100) n++;
    return n;
  }, r);
}

async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
  await page.mouse.up();
}

test("draw an arrow, edit text inline, scrub the draw-on, undo", async ({ page }) => {
  test.setTimeout(240_000);
  await openEditor(page, URL);
  let s = await state(page);
  const n0 = s.project.annotations.length;
  const last = s.frames - 12; // after every sample annotation has ended
  await seek(page, last);
  s = await state(page);
  expect(s.project.annotations.filter((a: any) => s.src >= a.startMs && s.src < a.endMs)).toHaveLength(0);
  const before = await canvasPixels(page);

  // ---- draw an arrow (on screen: stored in source px)
  await page.getByTestId("tool-arrow").click();
  const A = { x: 400, y: 420 };
  const B = { x: 760, y: 260 };
  await drag(page, await screenPt(page, A.x, A.y), await screenPt(page, B.x, B.y));
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.annotations).toHaveLength(n0 + 1);
  const arrow = s.project.annotations[n0];
  expect(arrow.kind).toBe("arrow");
  expect(arrow.anchor).toBe("screen");
  const fo = await srcToOut(page, arrow.from.x, arrow.from.y);
  const to = await srcToOut(page, arrow.to.x, arrow.to.y);
  expect(Math.hypot(fo.x - A.x, fo.y - A.y)).toBeLessThan(4);
  expect(Math.hypot(to.x - B.x, to.y - B.y)).toBeLessThan(4);
  expect(s.project.annotations.length).toBe(n0 + 1);
  // it is fully drawn at the playhead (it starts its draw-on before it) and in the plan frame
  const pf = await page.evaluate(() => { const st = (window as any).__lens.store.get(); return st.plan.frames[st.frame].annotations; });
  expect(pf.find((a: any) => a.id === arrow.id).anim.draw).toBe(1);
  const box = { x: Math.min(A.x, B.x) - 20, y: Math.min(A.y, B.y) - 20, w: Math.abs(B.x - A.x) + 40, h: Math.abs(B.y - A.y) + 40 };
  const full = await orangePixels(page, box);
  expect(full).toBeGreaterThan(400);
  expect((await store(page)).undoLabel).toBe("Draw arrow");
  await expect(page.getByTestId("ann-card")).toBeVisible();
  await expect(page.getByTestId("ann-card-kind")).toHaveText("Arrow");
  await expect(page.getByTestId(`block-annotation-${arrow.id}`)).toBeVisible();

  // ---- scrub through the draw-on with the scrubber: the arrow grows frame by frame
  const f0 = await page.evaluate((t) => { const f = (window as any).__lens.store.get().plan.frames; let i = 0; while (f[i].src < t) i++; return i; }, arrow.startMs);
  const inFrames = Math.round((arrow.in.ms / 1000) * s.fps);
  const bar = (await page.getByTestId("scrubber").boundingBox())!;
  const xOf = (fr: number) => bar.x + (fr / (s.frames - 1)) * bar.width;
  await page.mouse.move(xOf(f0 - 2), bar.y + bar.height / 2);
  await page.mouse.down();
  const draws: number[] = [];
  const counts: number[] = [];
  for (let fr = f0; fr <= f0 + inFrames + 1; fr += 3) {
    await page.mouse.move(xOf(fr), bar.y + bar.height / 2);
    await page.waitForFunction((want) => Math.abs((window as any).__lens.store.get().frame - want) <= 1, fr);
    await waitDrawn(page);
    const st = await page.evaluate((id) => { const g = (window as any).__lens.store.get(); const a = g.plan.frames[g.frame].annotations.find((x: any) => x.id === id); return a ? a.anim.draw : 0; }, arrow.id);
    draws.push(st);
    counts.push(await orangePixels(page, box));
  }
  await page.mouse.up();
  for (let i = 1; i < draws.length; i++) {
    expect(draws[i]!).toBeGreaterThanOrEqual(draws[i - 1]!);
    expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]! - 30); // anti-aliasing noise only
  }
  expect(draws[0]!).toBeLessThan(0.2);
  expect(draws[draws.length - 1]!).toBe(1);
  expect(counts[0]!).toBeLessThan(full * 0.35);
  expect(counts[counts.length - 1]!).toBeGreaterThan(full * 0.85);
  console.log(`draw-on scrub: draw ${draws.map((d) => d.toFixed(2)).join(" ")} | pixels ${counts.join(" ")}`);

  // ---- text: create with the text tool, type inline
  await seek(page, last);
  await page.getByTestId("tool-text").click();
  const T = await screenPt(page, 300, 560);
  await page.mouse.click(T.x, T.y);
  const ed = page.getByTestId("ann-inline");
  await expect(ed).toBeVisible();
  await ed.fill("Hello Lens");
  await ed.press("Enter");
  await expect(ed).toBeHidden();
  await waitDrawn(page);
  s = await state(page);
  const text = s.project.annotations[n0 + 1];
  expect(text.kind).toBe("text");
  expect(text.text).toBe("Hello Lens");

  // ---- double-click the drawn text to edit it inline
  const tb = (await page.getByTestId(`ann-box-${text.id}`).boundingBox())!;
  await page.getByTestId("tool-select").click();
  await page.mouse.dblclick(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await expect(ed).toBeVisible();
  await expect(ed).toHaveValue("Hello Lens");
  await ed.fill("Edited inline");
  await ed.press("Enter");
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.annotations.find((a: any) => a.id === text.id).text).toBe("Edited inline");
  expect((await store(page)).undoLabel).toBe("Edit text");
  await shot(page, "annotations-drawn");

  // ---- undo everything: text edit, text, arrow; pixels back to the start
  await page.keyboard.press("Control+z");
  s = await state(page);
  expect(s.project.annotations.find((a: any) => a.id === text.id).text).toBe("Hello Lens");
  await page.keyboard.press("Control+z"); // the inline edit that set "Hello Lens"
  await page.keyboard.press("Control+z"); // the text item
  s = await state(page);
  expect(s.project.annotations.find((a: any) => a.id === text.id)).toBeUndefined();
  await page.keyboard.press("Control+z"); // the arrow
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.annotations).toHaveLength(n0);
  await seek(page, last);
  expect(meanAbsDiff(before, await canvasPixels(page))).toBeLessThan(0.5);
  // redo brings the arrow back
  await page.keyboard.press("Control+Shift+z");
  s = await state(page);
  expect(s.project.annotations[n0].id).toBe(arrow.id);
});

async function store(page: Page): Promise<{ undoLabel: string | null }> {
  return page.evaluate(() => ({ undoLabel: (window as any).__lens.store.get().undoLabel }));
}

test("generate step labels, edit one, accept all: numbered badges in click order; undo / redo", async ({ page }) => {
  test.setTimeout(240_000);
  fs.rmSync(path.join(DIR, ".lens-cache", "steps"), { recursive: true, force: true });
  await openEditor(page, URL);
  await page.getByTestId("left-tab-steps").click();
  await expect(page.getByTestId("st-count")).toHaveText(/not generated/);
  await page.getByTestId("st-generate").click();
  await page.waitForFunction(() => (window as any).__lens.store.get().project.stepLabels.drafts.length > 0, null, { timeout: 120_000 });
  let s = await state(page);
  const drafts = s.project.stepLabels.drafts as Array<{ id: string; clickMs: number; label: string; state: string; x: number; y: number }>;
  // the sample's six clicks, read by OCR on this machine
  expect(drafts.map((d) => d.label)).toEqual(["Open Projects", "Click Create", "Click Export CSV", "Open Settings", "Click Reset password", "Click Save changes"]);
  expect(drafts.every((d) => d.state === "pending")).toBe(true);
  await expect(page.getByTestId("st-pending-badge")).toHaveText("6");

  // edit one label in the review list
  const lbl = page.getByTestId(`st-label-${drafts[1]!.id}`);
  await lbl.fill("Create a project");
  await lbl.press("Enter");
  s = await state(page);
  expect(s.project.stepLabels.drafts[1].label).toBe("Create a project");

  // accept all: one badge per click, numbered 1..6 in click order
  const n0 = s.project.annotations.length;
  await page.getByTestId("st-accept-all").click();
  s = await state(page);
  const badges = s.project.annotations.filter((a: any) => a.stepId);
  expect(badges).toHaveLength(6);
  expect(badges.find((b: any) => b.stepId === drafts[1]!.id).text).toBe("Create a project");
  const shown = await page.evaluate(() => {
    const st = (window as any).__lens.store.get();
    const out: Record<string, number> = {};
    for (const f of st.plan.frames) for (const a of f.annotations) if (a.kind === "badge") {
      const t = a.ops.find((o: any) => o.op === "text" && /^\d+$/.test(o.text));
      out[a.id] ??= Number(t.text);
    }
    return out;
  });
  const order = [...drafts].sort((a, b) => a.clickMs - b.clickMs);
  // every auto badge (the six steps and the sample's own badge, which sits between steps 2 and 3)
  // is numbered 1..7 by start time: step numbers rise with click time, and nothing is skipped
  const nums = order.map((d) => shown[`step-${d.id}`]!);
  for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThan(nums[i - 1]!);
  expect(Object.values(shown).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const starts = s.project.annotations.filter((a: any) => a.kind === "badge").sort((a: any, b: any) => a.startMs - b.startMs).map((a: any) => shown[a.id]);
  expect(starts).toEqual([1, 2, 3, 4, 5, 6, 7]);
  await expect(page.getByTestId(`st-item-${drafts[0]!.id}`)).toHaveAttribute("data-state", "accepted");
  // the review list shows the number the badge draws
  for (const d of drafts) await expect(page.getByTestId(`st-show-${d.id}`)).toHaveText(String(shown[`step-${d.id}`]));

  // the badge is on the preview at its click, next to the clicked control
  const third = order[3]!;
  await page.evaluate((t) => (window as any).__lens.store.seekSource(t), third.clickMs);
  await waitDrawn(page);
  const bb = (await page.getByTestId(`ann-box-step-${third.id}`).boundingBox())!;
  const at = await srcToOut(page, third.x, third.y);
  const ov = (await page.getByTestId("ann-overlay").boundingBox())!;
  const clickCss = { x: ov.x + (at.x / 1280) * ov.width, y: ov.y + (at.y / 720) * ov.height };
  expect(Math.abs(bb.x - clickCss.x)).toBeLessThan(80);
  expect(Math.abs(bb.y + bb.height / 2 - clickCss.y)).toBeLessThan(60);
  await shot(page, "annotations-steps");

  // undo / redo the accept
  await page.keyboard.press("Control+z");
  s = await state(page);
  expect(s.project.annotations).toHaveLength(n0);
  expect(s.project.stepLabels.drafts.every((d: any) => d.state === "pending")).toBe(true);
  await page.keyboard.press("Control+Shift+z");
  s = await state(page);
  expect(s.project.annotations.filter((a: any) => a.stepId)).toHaveLength(6);
});
