/**
 * Automatic privacy redaction in the editor (demand #3), on the privacy sample
 * (apps/editor/sample-privacy: 15 s fake console with planted fake secrets that scroll and move).
 * Scan runs the real on-device scanner through the dev server. Accepting one item must add a tracked
 * mask to the Masks lane and blur that text in the drawn preview; undo must remove both again.
 * Export asks first while items are pending.
 */
import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, openEditor, shot, state, waitDrawn } from "./helpers";

const URL = `/?dir=${encodeURIComponent(path.join(EDITOR, "sample-privacy"))}`;

/** Sum of absolute horizontal neighbour differences in a canvas rect (text detail), per pixel. */
async function detail(page: import("@playwright/test").Page, r: { x: number; y: number; w: number; h: number }): Promise<number> {
  return page.evaluate((q) => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const x = Math.max(0, Math.floor(q.x)), y = Math.max(0, Math.floor(q.y));
    const w = Math.min(c.width - x, Math.ceil(q.w)), h = Math.min(c.height - y, Math.ceil(q.h));
    const d = c.getContext("2d")!.getImageData(x, y, w, h).data;
    let s = 0;
    for (let j = 0; j < h; j++)
      for (let i = 1; i < w; i++) {
        const a = (j * w + i) * 4, b = a - 4;
        s += Math.abs(d[a]! - d[b]!) + Math.abs(d[a + 1]! - d[b + 1]!) + Math.abs(d[a + 2]! - d[b + 2]!);
      }
    return s / (w * h);
  }, r);
}

/** A source-px rect mapped to canvas px through the current plan frame's camera and layout. */
async function toCanvas(page: import("@playwright/test").Page, r: { x: number; y: number; w: number; h: number }) {
  return page.evaluate((q) => {
    const st = (window as any).__lens.store.get();
    const f = st.plan.frames[st.frame];
    const [cx, cy, s] = f.cam;
    const [, , srcW, srcH] = st.plan.source.crop;
    const [sx, sy, sw, sh] = f.layout.screen;
    const vw = srcW / s, vh = srcH / s;
    const X = (x: number) => sx + (x - (cx - vw / 2)) * (sw / vw);
    const Y = (y: number) => sy + (y - (cy - vh / 2)) * (sh / vh);
    return { x: X(q.x), y: Y(q.y), w: X(q.x + q.w) - X(q.x), h: Y(q.y + q.h) - Y(q.y) };
  }, r);
}

test("scan, review, hide one item in the preview, undo removes it; export asks while items are pending", async ({ page }) => {
  test.setTimeout(240_000);
  // a real scan every run: drop the cached one
  fs.rmSync(path.join(EDITOR, "sample-privacy", ".lens-cache", "privacy"), { recursive: true, force: true });
  await openEditor(page, URL);
  await page.getByTestId("left-tab-privacy").click();
  await expect(page.getByTestId("privacy-panel")).toBeVisible();
  await expect(page.getByTestId("pv-count")).toHaveText(/not scanned/);

  // Scan (real OCR on this machine)
  await page.getByTestId("pv-scan").click();
  await page.waitForFunction(() => (window as any).__lens.store.get().project.privacy.detections.length > 0, null, { timeout: 200_000 });
  let s = await state(page);
  const dets = s.project.privacy.detections as Array<{ id: string; type: string; preview: string; state: string; thumb: string | null; tracks: Array<{ startMs: number; endMs: number; keys: Array<{ tMs: number; rect: { x: number; y: number; w: number; h: number } }> }> }>;
  expect(dets.every((d) => d.state === "pending")).toBe(true);
  const kinds = new Set(dets.map((d) => d.type));
  for (const k of ["email", "card", "phone", "api_key"]) expect(kinds.has(k)).toBe(true);
  await expect(page.getByTestId("pv-group-email")).toBeVisible();
  await expect(page.getByTestId("pv-count")).toHaveText(new RegExp(`${dets.length} found · ${dets.length} to review`));
  await expect(page.getByTestId("pv-pending-badge")).toHaveText(String(dets.length));
  // thumbnails load
  const withThumb = dets.find((d) => d.thumb)!;
  await expect.poll(() => page.locator(`[data-testid="pv-item-${withThumb.id}"] img`).evaluate((im: HTMLImageElement) => im.complete && im.naturalWidth > 0)).toBe(true);
  // the scan is one undo step; nothing is masked yet
  expect(s.project.masks.filter((m: { privacyId?: string }) => m.privacyId)).toHaveLength(0);

  // Export while items are pending: the sheet asks first; Review goes to the panel
  await page.getByTestId("export").click();
  await expect(page.getByTestId("export-warning")).toBeVisible();
  await expect(page.getByTestId("export-warning")).toContainText(`${dets.length} items`);
  await page.getByTestId("export-warning-review").click();
  await expect(page.getByTestId("export-warning")).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).__lens.store.get().exporting))).toBeNull();

  // Show the email in the preview
  const email = dets.find((d) => d.type === "email")!;
  await page.getByTestId(`pv-show-${email.id}`).click();
  await waitDrawn(page);
  s = await state(page);
  const key = email.tracks[0]!.keys.reduce((best, k) => (Math.abs(k.tMs - s.src) < Math.abs(best.tMs - s.src) ? k : best));
  const region = await toCanvas(page, key.rect);
  const masksBefore = (await page.evaluate(() => { const st = (window as any).__lens.store.get(); return st.plan.frames[st.frame].masks.length; })) as number;
  const before = await detail(page, region);
  expect(before).toBeGreaterThan(4); // there is text there
  await shot(page, "privacy-01-found");

  // Accept just that one
  await page.getByTestId(`pv-accept-${email.id}`).click();
  await waitDrawn(page);
  s = await state(page);
  const pm = s.project.masks.filter((m: { privacyId?: string }) => m.privacyId === email.id);
  expect(pm.length).toBe(email.tracks.length);
  await expect(page.getByTestId(`pv-item-${email.id}`)).toHaveAttribute("data-state", "accepted");
  await expect(page.locator(".block-mask.privacy")).toHaveCount(pm.length);
  const masksAfter = (await page.evaluate(() => { const st = (window as any).__lens.store.get(); return st.plan.frames[st.frame].masks.length; })) as number;
  expect(masksAfter).toBe(masksBefore + 1);
  const after = await detail(page, region);
  expect(after).toBeLessThan(0.4 * before); // blurred in the drawn preview
  await expect(page.getByTestId("pv-pending-badge")).toHaveText(String(dets.length - 1));
  await shot(page, "privacy-02-hidden");

  // Undo: the mask leaves the lane, the plan and the pixels
  await page.getByTestId("undo").click();
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.masks.filter((m: { privacyId?: string }) => m.privacyId)).toHaveLength(0);
  await expect(page.locator(".block-mask.privacy")).toHaveCount(0);
  await expect(page.getByTestId(`pv-item-${email.id}`)).toHaveAttribute("data-state", "pending");
  const undone = await detail(page, region);
  expect(Math.abs(undone - before)).toBeLessThan(0.05 * before);
  // Redo brings it back
  await page.getByTestId("redo").click();
  await waitDrawn(page);
  expect(await detail(page, region)).toBeLessThan(0.4 * before);

  // Dismiss one, hide the rest at once; nothing pending -> export no longer asks
  const other = dets.find((d) => d.id !== email.id)!;
  await page.getByTestId(`pv-dismiss-${other.id}`).click();
  await expect(page.getByTestId(`pv-item-${other.id}`)).toHaveAttribute("data-state", "dismissed");
  await page.getByTestId("pv-accept-all").click();
  s = await state(page);
  const states = (s.project.privacy.detections as Array<{ state: string }>).map((d) => d.state);
  expect(states.filter((x) => x === "pending")).toHaveLength(0);
  expect(states.filter((x) => x === "dismissed")).toHaveLength(1);
  await expect(page.getByTestId("pv-pending-badge")).toHaveCount(0);
  // pixelate instead of blur rebuilds the accepted masks as one step
  await page.getByTestId("pv-kind-pixelate").click();
  s = await state(page);
  expect(s.project.masks.filter((m: { privacyId?: string; kind: string }) => m.privacyId).every((m: { kind: string }) => m.kind === "pixelate")).toBe(true);
  await page.getByTestId(`pv-show-${email.id}`).click();
  await waitDrawn(page);
  await shot(page, "privacy-03-all-hidden");
});
