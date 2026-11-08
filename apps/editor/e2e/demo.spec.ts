/**
 * A short screen recording of the editor in use (Playwright video), for people to watch:
 * scrub with hover thumbnails, play with captions, drag a zoom block, cut a word from the
 * transcript, switch to the Calm zoom preset and change the backdrop. Written to
 * test-results/lens-editor-demo.webm and converted to .mp4 when ffmpeg is present.
 */
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, openEditor, state, waitDrawn } from "./helpers";

test.use({ video: { mode: "on", size: { width: 1600, height: 1000 } }, viewport: { width: 1600, height: 1000 } });

async function glide(page: import("@playwright/test").Page, x0: number, y0: number, x1: number, y1: number, steps = 25) {
  for (let i = 0; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
}

test("record a tour of the editor", async ({ page }) => {
  test.setTimeout(180_000);
  await openEditor(page);
  await page.waitForTimeout(600);
  // hover-scrub across the seeker
  const bar = (await page.getByTestId("scrubber").boundingBox())!;
  const y = bar.y + bar.height / 2;
  await glide(page, bar.x + 20, y, bar.x + bar.width * 0.7, y, 40);
  await page.mouse.click(bar.x + bar.width * 0.5, y);
  await page.waitForTimeout(400);
  // jump to "Watch" and play with captions
  await page.getByTestId("word-8").click();
  await page.keyboard.press(" ");
  await page.waitForTimeout(2600);
  await page.keyboard.press(" ");
  // drag the second zoom block later
  const blk = (await page.getByTestId("block-zoom-1").boundingBox())!;
  await page.mouse.move(blk.x + blk.width / 2, blk.y + blk.height / 2);
  await page.mouse.down();
  await glide(page, blk.x + blk.width / 2, blk.y + blk.height / 2, blk.x + blk.width / 2 + 160, blk.y + blk.height / 2, 30);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  // cut a filler from the transcript, then all fillers
  await page.getByTestId("word-3").click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(500);
  await page.getByTestId("remove-fillers").click();
  await page.waitForTimeout(600);
  // calm camera
  await page.getByTestId("tab-zoom").click();
  await page.waitForTimeout(300);
  await page.getByTestId("zoom-preset").getByRole("radio", { name: "Calm" }).click();
  await page.waitForTimeout(600);
  // look: backdrop + padding
  await page.getByTestId("tab-look").click();
  await page.getByRole("button", { name: "Backdrop Orchid" }).click();
  await page.waitForTimeout(400);
  const pad = (await page.getByTestId("padding").boundingBox())!;
  await page.mouse.move(pad.x + pad.width * 0.32, pad.y + pad.height / 2);
  await page.mouse.down();
  await glide(page, pad.x + pad.width * 0.32, pad.y + pad.height / 2, pad.x + pad.width * 0.6, pad.y + pad.height / 2, 20);
  await page.mouse.up();
  await page.waitForTimeout(300);
  // play the edited cut from the top
  await page.keyboard.press("Home");
  await page.keyboard.press(" ");
  await page.waitForTimeout(3500);
  await page.keyboard.press(" ");
  await waitDrawn(page);
  expect((await state(page)).cuts.length).toBe(2);
  const video = page.video()!;
  await page.close();
  const webm = path.join(EDITOR, "test-results", "lens-editor-demo.webm");
  await video.saveAs(webm);
  const mp4 = webm.replace(/\.webm$/, ".mp4");
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", mp4]);
  } catch {
    /* webm stays */
  }
  expect(fs.existsSync(webm)).toBe(true);
});
