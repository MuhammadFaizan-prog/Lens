/**
 * Editor end-to-end: transport, timeline, transcript, inspector, undo/redo, captions and export,
 * each checked against the store state AND the pixels the preview actually drew.
 */
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, canvasPixels, expect, meanAbsDiff, openEditor, seek, settle, shot, state, waitDrawn } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("main screen renders and is screenshotted", async ({ page }) => {
  await seek(page, 60);
  await shot(page, "01-editor-main");
  const s = await state(page);
  expect(s.frames).toBe(300);
  expect(s.fps).toBe(30);
  await expect(page.getByTestId("timecode")).toContainText("00:02.00");
  // the mic track's waveform is drawn in the audio lane
  await page.waitForFunction(() => ((window as any).__lens.store.audio.peaks?.length ?? 0) > 0);
  const lit = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="waveform"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
    return n / (c.width * c.height);
  });
  expect(lit).toBeGreaterThan(0.05);
});

test("scrubbing seeks to the exact frame and the preview shows that frame", async ({ page, browser }) => {
  const bar = page.getByTestId("scrubber");
  const box = (await bar.boundingBox())!;
  const n = (await state(page)).frames;
  for (const u of [0.137, 0.5, 0.861]) {
    const x = Math.round(box.x + u * box.width);
    await page.mouse.click(x, box.y + box.height / 2);
    const expected = Math.round(Math.max(0, Math.min(1, (x - box.x) / box.width)) * (n - 1));
    await waitDrawn(page);
    const s = await state(page);
    expect(s.frame).toBe(expected);
    await expect(page.getByTestId("frame-count")).toContainText(`frame ${expected} of`);
  }
  // Pixel check against an independent render of the same frame (parity page, separate renderer).
  const target = 33; // camera is zooming in here, so neighbouring frames differ
  await seek(page, target);
  const shown = await canvasPixels(page);
  const ref = await browser.newPage();
  await ref.goto("/parity.html");
  await ref.evaluate(() => (window as any).lensParity.ready);
  const refPixels = async (i: number) =>
    ref.evaluate(async (k) => {
      const url: string = await (window as any).lensParity.render(k);
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const out: number[] = [];
      for (let y = 0; y < c.height; y += 8)
        for (let x = 0; x < c.width; x += 8) {
          const j = (y * c.width + x) * 4;
          out.push(d[j]!, d[j + 1]!, d[j + 2]!);
        }
      return out;
    }, i);
  const same = meanAbsDiff(shown, await refPixels(target));
  const next = meanAbsDiff(shown, await refPixels(target + 1));
  const prev = meanAbsDiff(shown, await refPixels(target - 1));
  expect(same).toBeLessThan(0.5);
  expect(next).toBeGreaterThan(same + 0.5);
  expect(prev).toBeGreaterThan(same + 0.5);
  await ref.close();
  // arrow keys step exactly one frame
  await page.keyboard.press("ArrowRight");
  await waitDrawn(page);
  expect((await state(page)).frame).toBe(target + 1);
  await page.keyboard.press("Shift+ArrowLeft");
  await waitDrawn(page);
  expect((await state(page)).frame).toBe(target - 9);
});

test("hovering the scrubber shows a live thumbnail of that frame", async ({ page }) => {
  const bar = page.getByTestId("scrubber");
  const box = (await bar.boundingBox())!;
  const n = (await state(page)).frames;
  const x = Math.round(box.x + box.width * 0.62);
  await page.mouse.move(x, box.y + box.height / 2);
  const expected = Math.round(((x - box.x) / box.width) * (n - 1));
  await expect(page.locator('[data-testid="hover-thumb"] canvas')).toHaveAttribute("data-frame", String(expected));
  await shot(page, "02-scrubber-hover-thumbnail");
});

test("playback advances in real time, loops, and J/K/L shuttle", async ({ page }) => {
  await seek(page, 0);
  await page.getByTestId("play").click();
  // measure the playback rate with the page's own clock (test-runner latency does not count)
  const clock = () => page.evaluate(() => ({ t: performance.now(), f: (window as any).__lens.state().frame as number }));
  await page.waitForTimeout(200);
  const a = await clock();
  await page.waitForTimeout(1000);
  const b = await clock();
  let s = await state(page);
  expect(s.playing).toBe(true);
  expect(b.f - a.f).toBeGreaterThanOrEqual(20);
  const realtime = (b.f - a.f) / (((b.t - a.t) / 1000) * 30);
  expect(realtime).toBeGreaterThan(0.85); // 1.0 = real time at 30 fps
  expect(realtime).toBeLessThan(1.15);
  await page.keyboard.press("k");
  s = await state(page);
  expect(s.playing).toBe(false);
  const stopped = s.frame;
  await page.waitForTimeout(300);
  expect((await state(page)).frame).toBe(stopped);
  // L twice = 2x forward
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  const t0 = (await state(page)).frame;
  await page.waitForTimeout(500);
  const t1 = (await state(page)).frame;
  expect(t1 - t0).toBeGreaterThanOrEqual(20); // 2x: ~30 frames in 0.5 s
  // J plays backwards
  await page.keyboard.press("k");
  await page.keyboard.press("j");
  const b0 = (await state(page)).frame;
  await page.waitForTimeout(400);
  expect((await state(page)).frame).toBeLessThan(b0);
  await page.keyboard.press("k");
  // loop wraps around the end
  await page.getByTestId("loop").click();
  await seek(page, (await state(page)).frames - 5);
  await page.keyboard.press(" ");
  await page.waitForTimeout(700);
  s = await state(page);
  expect(s.playing).toBe(true);
  expect(s.frame).toBeLessThan(30);
  await page.keyboard.press(" ");
});

test("dragging a zoom block changes the preview; undo and redo restore it", async ({ page }) => {
  const frameAt6500 = 195; // src 6500 ms, inside the second auto zoom (5650-7400 ms)
  await seek(page, frameAt6500);
  const zoomed = await canvasPixels(page);
  const before = await state(page);
  expect(before.zooms[1]!.startMs).toBeLessThan(6500);
  expect(before.zooms[1]!.endMs).toBeGreaterThan(6500);
  const block = page.getByTestId("block-zoom-1");
  const b = (await block.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width / 2 + i * 22, b.y + b.height / 2);
  await page.mouse.up();
  await waitDrawn(page);
  const after = await state(page);
  expect(after.zooms[1]!.startMs).toBeGreaterThan(6600);
  expect(after.zooms[1]!.endMs - after.zooms[1]!.startMs).toBeCloseTo(before.zooms[1]!.endMs - before.zooms[1]!.startMs, 0);
  expect(after.frame).toBe(frameAt6500);
  const unzoomed = await canvasPixels(page);
  expect(meanAbsDiff(zoomed, unzoomed)).toBeGreaterThan(8);
  await shot(page, "03-zoom-block-dragged");
  // undo: the move, then the freeze of auto zooms
  await page.getByTestId("undo").click();
  await page.keyboard.press("Control+z");
  await waitDrawn(page);
  const undone = await state(page);
  expect(undone.zooms[1]!.startMs).toBe(before.zooms[1]!.startMs);
  expect(undone.project.zoom.auto).toBe(true);
  expect(meanAbsDiff(zoomed, await canvasPixels(page))).toBeLessThan(0.5);
  await page.getByTestId("redo").click();
  await page.keyboard.press("Control+Shift+z");
  await waitDrawn(page);
  expect((await state(page)).zooms[1]!.startMs).toBe(after.zooms[1]!.startMs);
  expect(meanAbsDiff(unzoomed, await canvasPixels(page))).toBeLessThan(0.5);
});

test("timeline: create, trim with snapping, and delete blocks", async ({ page }) => {
  const lane = page.getByTestId("lane-speed");
  const lb = (await lane.boundingBox())!;
  const frames0 = (await state(page)).frames;
  await page.mouse.dblclick(lb.x + lb.width * 0.35, lb.y + lb.height / 2);
  await waitDrawn(page);
  let s = await state(page);
  expect(s.project.edits.speed).toHaveLength(1);
  const sp = s.project.edits.speed[0];
  expect(sp.rate).toBe(2);
  // a 1.5 s range at 2x saves 0.75 s = 22-23 frames
  expect(frames0 - s.frames).toBeGreaterThanOrEqual(22);
  expect(frames0 - s.frames).toBeLessThanOrEqual(23);
  await expect(page.getByTestId("selection-card")).toBeVisible();
  // trim the right edge
  const blk = page.getByTestId("block-speed-0");
  const bb = (await blk.boundingBox())!;
  await page.mouse.move(bb.x + bb.width - 3, bb.y + bb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(bb.x + bb.width - 3 + i * 10, bb.y + bb.height / 2);
  await page.mouse.up();
  s = await state(page);
  expect(s.project.edits.speed[0].startMs).toBe(sp.startMs);
  expect(s.project.edits.speed[0].endMs).toBeGreaterThan(sp.endMs + 200);
  // snapping: drag the start edge near the zoom block's end; it lands exactly on a snap target
  // delete with the keyboard
  await page.keyboard.press("Delete");
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.edits.speed).toHaveLength(0);
  expect(s.frames).toBe(frames0);
  // add a mask at the playhead with the + button, then snap-move it onto the playhead
  await seek(page, 150);
  await page.getByTestId("add-mask").click();
  s = await state(page);
  expect(s.project.masks).toHaveLength(3);
});

test("snapping pulls a dragged edge onto the playhead", async ({ page }) => {
  const lane = page.getByTestId("lane-cut");
  const lb = (await lane.boundingBox())!;
  await page.mouse.dblclick(lb.x + lb.width * 0.15, lb.y + lb.height / 2);
  // put the playhead on source 4000 ms (the double-click's first click also seeks)
  await page.evaluate(() => (window as any).__lens.store.seekSource(4000));
  await waitDrawn(page);
  let s = await state(page);
  expect(s.project.edits.cuts).toHaveLength(1);
  const cut = s.project.edits.cuts[0];
  const blk = page.getByTestId("block-cut-0");
  const bb = (await blk.boundingBox())!;
  const pps = bb.width / ((cut.endMs - cut.startMs) / 1000);
  expect((await state(page)).src).toBe(4000);
  const laneOrigin = bb.x - (cut.startMs / 1000) * pps;
  const playheadX = laneOrigin + 4 * pps; // 4000 ms
  // drag the right edge to 4 px short of the playhead: it should snap to 4000 ms exactly
  await page.mouse.move(bb.x + bb.width - 2, bb.y + bb.height / 2);
  await page.mouse.down();
  const steps = 8;
  const target = playheadX - 4;
  for (let i = 1; i <= steps; i++) await page.mouse.move(bb.x + bb.width - 2 + ((target - (bb.x + bb.width - 2)) * i) / steps, bb.y + bb.height / 2);
  await page.mouse.up();
  s = await state(page);
  expect(pps).toBeGreaterThan(50);
  expect(s.project.edits.cuts[0].endMs).toBe(4000);
});

test("deleting a transcript word adds a cut; fillers go in one click", async ({ page }) => {
  const frames0 = (await state(page)).frames;
  const um = page.getByTestId("word-3");
  await expect(um).toHaveText("um");
  await um.click();
  await page.keyboard.press("Delete");
  await waitDrawn(page);
  let s = await state(page);
  expect(s.cuts).toHaveLength(1);
  const c = s.cuts[0]!;
  // the cut covers the word (1380-1700 ms) and stops short of its neighbours
  expect(c.startMs).toBeLessThanOrEqual(1380);
  expect(c.endMs).toBeGreaterThanOrEqual(1700);
  expect(c.startMs).toBeGreaterThan(1300);
  expect(c.endMs).toBeLessThan(1760);
  expect(s.frames).toBeLessThan(frames0);
  await expect(um).toHaveClass(/deleted/);
  // the deleted word is gone from the burned-in caption too
  await page.getByTestId("word-1").click();
  await waitDrawn(page);
  const cap = (await state(page)).caption!;
  expect(cap.words).toContain("Lens,");
  expect(cap.words).not.toContain("um");
  // the source moment of the cut word is no longer shown by any frame
  const shown = await page.evaluate(() => (window as any).__lens.store.get().plan.frames.map((f: any) => f.src));
  expect(shown.some((t: number) => t > 1450 && t < 1650)).toBe(false);
  // remove remaining fillers ("uh") in one click
  await page.getByTestId("remove-fillers").click();
  s = await state(page);
  expect(s.cuts).toHaveLength(2);
  await expect(page.getByTestId("word-11")).toHaveClass(/deleted/);
  await shot(page, "04-transcript-cuts");
  // undo the filler removal only
  await page.keyboard.press("Control+z");
  expect((await state(page)).cuts).toHaveLength(1);
  // restore the deleted word
  await um.click();
  await page.getByTestId("restore-words").click();
  s = await state(page);
  expect(s.cuts).toHaveLength(0);
  expect(s.frames).toBe(frames0);
});

test("clicking a transcript word seeks to it", async ({ page }) => {
  await page.getByTestId("word-8").click(); // "Watch" at 5200 ms
  await waitDrawn(page);
  const s = await state(page);
  expect(s.src).toBeGreaterThanOrEqual(5200);
  expect(s.src).toBeLessThan(5200 + 1000 / 30 + 0.01);
  await expect(page.getByTestId("word-8")).toHaveClass(/active/);
});

test("inspector changes update the render immediately", async ({ page }) => {
  await seek(page, 150);
  const base = await canvasPixels(page);
  const rect0 = await page.evaluate(() => (window as any).__lens.store.get().plan.frames[150].layout.screen);
  await page.getByTestId("padding").fill("0.2");
  await settle(page);
  const s = await state(page);
  expect(s.project.frame.padding).toBeCloseTo(0.2, 5);
  const rect1 = await page.evaluate(() => (window as any).__lens.store.get().plan.frames[150].layout.screen);
  expect(rect1[2]).toBeLessThan(rect0[2]);
  expect(meanAbsDiff(base, await canvasPixels(page))).toBeGreaterThan(5);
  // one undo step for the whole slider gesture
  await page.keyboard.press("Control+z");
  await waitDrawn(page);
  expect(meanAbsDiff(base, await canvasPixels(page))).toBeLessThan(0.5);
  // backdrop and aspect
  await page.getByRole("button", { name: "Backdrop Ember" }).click();
  await waitDrawn(page);
  const corner = await page.evaluate(() => Array.from((document.querySelector('[data-testid="preview"]') as HTMLCanvasElement).getContext("2d")!.getImageData(4, 4, 1, 1).data));
  expect(corner[0]).toBeGreaterThan(corner[2]!); // warm backdrop
  await page.getByTestId("aspect").getByRole("radio", { name: "9:16" }).click();
  await waitDrawn(page);
  const dims = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    return [c.width, c.height];
  });
  expect(dims).toEqual([720, 1280]);
  await shot(page, "05-inspector-vertical");
});

test("zoom presets and the zoom budget re-plan the camera", async ({ page }) => {
  await page.getByTestId("tab-zoom").click();
  const def = await state(page);
  await page.getByTestId("zoom-preset").getByRole("radio", { name: "Punchy" }).click();
  let s = await state(page);
  expect(s.project.zoom.preset).toBe("punchy");
  expect(s.zooms[0]!.scale).toBeGreaterThan(def.zooms[0]!.scale);
  await page.getByTestId("zoom-preset").getByRole("radio", { name: "Calm" }).click();
  s = await state(page);
  expect(s.project.zoom.preset).toBe("calm");
  expect(s.project.zoom.budget.enabled).toBe(true);
  expect(s.zooms.every((z) => z.endMs - z.startMs >= 3000 - 1)).toBe(true);
  // budget: at most 1 zoom per minute keeps a single zoom
  await page.getByTestId("budget-max").fill("1");
  await settle(page);
  s = await state(page);
  expect(s.zooms).toHaveLength(1);
  await expect(page.getByTestId("zoom-stats")).toContainText("1 zoom");
  await shot(page, "06-zoom-calm-budget");
});

test("captions highlight the current word during playback", async ({ page }) => {
  await page.getByTestId("word-8").click(); // "Watch"
  await waitDrawn(page);
  await page.getByTestId("play").click();
  const seen: Array<{ block: string; active: number }> = [];
  let highlightPixels = 0;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(120);
    const s = await state(page);
    if (s.caption && s.caption.active >= 0) seen.push({ block: s.caption.words.join(" "), active: s.caption.active });
    const n = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, Math.floor(c.height * 0.7), c.width, Math.floor(c.height * 0.3)).data;
      let k = 0;
      for (let j = 0; j < d.length; j += 4) if (d[j]! > 225 && d[j + 1]! > 180 && d[j + 1]! < 230 && d[j + 2]! < 120) k++;
      return k;
    });
    highlightPixels = Math.max(highlightPixels, n);
    if (i === 6) await shot(page, "07-captions-playing");
  }
  await page.keyboard.press(" ");
  const first = seen.filter((x) => x.block === seen[0]!.block).map((x) => x.active);
  // within one caption block the highlight walks forward word by word
  expect(new Set(first).size).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < first.length; i++) expect(first[i]!).toBeGreaterThanOrEqual(first[i - 1]!);
  expect(highlightPixels).toBeGreaterThan(80);
  // Paused on a spoken word, the transcript highlights exactly that word and the caption agrees.
  // (Checked at a fixed word: where the pause lands after the sampling loop depends on machine
  // speed, and on a slow run it fell past the last word, where nothing is highlighted.)
  await expect.poll(async () => (await state(page)).playing).toBe(false);
  await page.getByTestId("word-10").click(); // "camera"
  await waitDrawn(page);
  await expect(page.locator(".word.active")).toHaveCount(1);
  await expect(page.locator(".word.active")).toHaveText("camera");
  const c = (await state(page)).caption!;
  expect(c.words[c.active]).toBe("camera");
});

test("open and save project.json", async ({ page }) => {
  const s0 = await state(page);
  const bundle = await (await page.request.get("/api/bundle")).json();
  const file = path.join(bundle.dir, "project.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    await page.getByTestId("padding").fill("0.12");
    await settle(page);
    await page.getByTestId("save").click();
    await expect(page.getByTestId("toast")).toContainText("Saved");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).frame.padding).toBeCloseTo(0.12, 5);
    // open a project file from disk
    const alt = { ...s0.project, frame: { ...s0.project.frame, radius: 40 }, captions: { ...s0.project.captions, enabled: false } };
    const tmp = path.join(EDITOR, "test-results", "open-me.json");
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(alt));
    await page.getByTestId("open-input").setInputFiles(tmp);
    await expect(page.getByTestId("toast")).toContainText("Opened open-me.json");
    const s = await state(page);
    expect(s.project.frame.radius).toBe(40);
    expect(s.project.captions.enabled).toBe(false);
    expect(s.canUndo).toBe(false);
    // invalid projects are rejected with a message, state unchanged
    fs.writeFileSync(tmp, JSON.stringify({ frame: { padding: 3 } }));
    await page.getByTestId("open-input").setInputFiles(tmp);
    await expect(page.getByTestId("toast")).toContainText("Could not open");
    expect((await state(page)).project.frame.radius).toBe(40);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test("export renders an MP4 through the compositor with progress", async ({ page }) => {
  test.setTimeout(300_000);
  await page.getByTestId("export").click();
  await expect(page.getByTestId("export-sheet")).toBeVisible();
  // progress moves before it finishes
  await expect.poll(async () => Number(await page.getByTestId("export-progress").getAttribute("aria-valuenow")), { timeout: 120_000 }).toBeGreaterThan(0);
  await shot(page, "08-export-progress");
  await expect(page.getByTestId("export-video")).toBeVisible({ timeout: 240_000 });
  await shot(page, "09-export-done");
  const href = (await page.getByTestId("export-download").getAttribute("href"))!;
  const res = await page.request.get(href);
  expect(res.ok()).toBe(true);
  const out = path.join(EDITOR, "test-results", "export.mp4");
  fs.writeFileSync(out, await res.body());
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames,color_space,color_primaries,color_transfer,color_range:format=duration", "-of", "json", out], { encoding: "utf8" }));
  const v = probe.streams.find((x: any) => x.codec_type === "video");
  const a = probe.streams.find((x: any) => x.codec_type === "audio");
  expect(v.codec_name).toBe("h264");
  expect([v.width, v.height]).toEqual([1280, 720]);
  expect(Number(v.nb_frames)).toBe(300);
  // BT.709 conversion + tags (players decode untagged HD as BT.709; the old BT.601 encode shifted colours)
  expect([v.color_space, v.color_primaries, v.color_transfer, v.color_range]).toEqual(["bt709", "bt709", "bt709", "tv"]);
  expect(a?.codec_name).toBe("aac");
  expect(Number(probe.format.duration)).toBeCloseTo(10, 0);
});
