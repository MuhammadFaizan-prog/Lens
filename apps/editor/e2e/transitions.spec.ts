/**
 * Cut transitions (demand #14, feat/transitions-015): set through the UI (Look tab default + the
 * transition chip on a cut block + the cut's selection card), measured in the preview and in the
 * browser export (LENS_EXPORT=browser: the shipped desktop path, no Python).
 *
 * Synthetic screen: 640x360 @30, the whole picture dark (luma 32) on even seconds and light (luma 224) on
 * odd seconds; output 360p30 with the backdrop hidden, so a frame's luma is the screen's. Kept source
 * [0,900] dark, [1100,1900] light, [2100,2900] dark, [3100,3900] light, [4100,4900] dark: four cut
 * joins, each dark <-> light, at output 900 / 1700 / 2500 / 3300 ms = frames 27 / 51 / 75 / 99, plus a
 * trailing cut [4900, 8000) with no join after it. Output 4.1 s = 123 frames.
 *
 * Bounds, set before the first run:
 *  - no transitions yet: no plan frame carries `tr`;
 *  - UI: Look tab style Crossfade, length typed 0.4 s; cut 2 -> Push and cut 3 -> Zoom through from the
 *    chip menu on their blocks; cut 4 -> Blur dip from the selection card select. The plan then has
 *    12 `tr` frames per join (400 ms at 30 fps), 48 in all, kinds crossfade / push / zoom / blur by join,
 *    none on the trailing cut;
 *  - crossfade midpoint (frame 27, raw progress 0.5, ease-in-out): mean luma within 10% of the average of
 *    the two sides (|mid - avg| <= 0.10 * avg), sides measured on frames 10 (dark) and 40 (light), in the
 *    preview and in the export;
 *  - preview vs export at each join's midpoint frame (27 / 51 / 75 / 99): mean |RGB| per pixel <= 12
 *    (the bound the caption / 3D parity specs use for JPEG q0.95 + H.264);
 *  - each kind really composites in the export: push frame 51 left half minus right half >= 0.6 x (light -
 *    dark) (outgoing light moving out left, incoming dark from the right); zoom (75) and blur dip (99)
 *    mean luma at least 0.2 x (light - dark) away from both sides;
 *  - no-transition plan identical: setting the style back to None and every cut to the project default
 *    through the UI gives a plan byte-identical (JSON) to the plan before any transition was set.
 *
 * Added after the first run, bounds set before its own first run: a red text slide (no title) at source
 * 4500 ms, 1000 ms long (output 3700..4700 ms, frames 111..140; output 153 frames), its Enter set in the
 * slide card to Slide up, 0.4 s, Linear. Frame 117 (halfway through the enter): the plan's slide fx dy is
 * 180 px (+-1); in the export the top quarter is the video (luma within 25 of the dark side) and the band
 * at 52..60% height, left 10% is the slide (R - G >= 100); preview vs export mean |RGB| <= 12. Enter back
 * to Default is part of the final no-transition comparison.
 * (Its first run failed on the fixture, not the code: a 600 ms slide clamps a 400 ms enter to half the
 * slide, 300 ms, so frame 117 was 2/3 through; the slide is now 1000 ms. Bounds unchanged.)
 */
import { test, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, seek, settle } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { EXPORT_PATH, exportMp4 } from "./uxHelpers";

test.afterAll(() => closeAll());
test.use({ actionTimeout: 20_000, navigationTimeout: 60_000 });

const W = 640, H = 360, FPS = 30, SECS = 8;
const DARK = 32, LIGHT = 224;
const JOIN_FRAMES = [27, 51, 75, 99];
const KINDS = ["crossfade", "push", "zoom", "blur"];

function makeBundle(): string {
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `transitions-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=${SECS}`,
    "-vf", `format=yuv420p,geq=lum='if(mod(floor(T),2),${LIGHT},${DARK})':cb=128:cr=128`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p",
    path.join(dir, "screen.mp4")]);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: W, height: H, fps: FPS, durationMs: SECS * 1000, pixelRatio: 1 }));
  const ev = ['# lens-events v1 {"capture":{"width":640,"height":360},"source":"screen","platform":"linux"}'];
  for (let i = 0; i < SECS * 10; i++) ev.push(JSON.stringify({ t: i * 100, type: "move", x: 100 + i * 5, y: 100 }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), ev.join("\n") + "\n");
  const cuts = [[900, 1100], [1900, 2100], [2900, 3100], [3900, 4100], [4900, 8000]].map(([a, b]) => ({ startMs: a, endMs: b }));
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({
    version: 1, output: { aspect: "16:9", resolution: 360, fps: FPS }, zoom: { auto: false }, cursor: { visible: false, clickEffect: "none" },
    motionBlur: { enabled: false }, shortcuts: { enabled: false }, background: { kind: "hidden", colors: ["#000000"], inherit: false }, audio: { tracks: [] }, edits: { cuts },
    slides: [{ id: "s1", atMs: 4500, durationMs: 1000, title: "", subtitle: "", background: "#d02020", textColor: "#ffffff", accent: null, fadeMs: 250, titleSize: 84, subtitleSize: 40 }],
  }, null, 1));
  return dir;
}

type Rgb = { w: number; h: number; rgb: Buffer };

function frameIdx(file: string, n: number): Rgb {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.stdout.length < W * H * 3) throw new Error(`could not decode frame ${n} of ${file}: ${r.stderr}`);
  return { w: W, h: H, rgb: r.stdout.subarray(0, W * H * 3) };
}

async function previewRgb(page: Page): Promise<Rgb> {
  const r = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb = new Uint8Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]!; rgb[j + 1] = d[i + 1]!; rgb[j + 2] = d[i + 2]!; }
    let s = "";
    for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode(...rgb.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height, b64: btoa(s) };
  });
  return { w: r.w, h: r.h, rgb: Buffer.from(r.b64, "base64") };
}

function luma(f: Rgb, x0 = 0, x1 = f.w): number {
  let s = 0, n = 0;
  for (let y = 0; y < f.h; y++) for (let x = x0; x < x1; x++) {
    const i = (y * f.w + x) * 3;
    s += 0.299 * f.rgb[i]! + 0.587 * f.rgb[i + 1]! + 0.114 * f.rgb[i + 2]!;
    n++;
  }
  return s / n;
}

function meanRgbDiff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

function dump(name: string, f: Rgb): void {
  const out = path.join(EDITOR, "test-results", "screens", `${name}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${f.w}x${f.h}`, "-i", "pipe:0", "-frames:v", "1", out], { input: f.rgb });
}

test("cut transitions: UI picker, plan, crossfade midpoint, preview == browser export per kind, no-transition plan unchanged", async () => {
  test.setTimeout(900_000);
  expect(EXPORT_PATH, "run with LENS_EXPORT=browser (the desktop export path)").toBe("browser");
  const dir = makeBundle();
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const step = (s: string) => console.log(`[step] ${new Date().toISOString().slice(11, 19)} ${s}`);
  const plan = () => page.evaluate(() => (window as any).__lens.store.get().plan);

  step("baseline plan");
  const p0 = await plan();
  expect(p0.frames.length).toBe(153);
  expect(p0.frames.filter((f: any) => f.tr).length).toBe(0);
  const json0: string = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));

  step("project default: Crossfade 0.4 s (Look tab)");
  await page.getByTestId("tab-look").click();
  await page.getByTestId("tr-kind").selectOption("crossfade");
  const len = page.getByTestId("tr-duration-value");
  await len.click();
  await len.fill("0.4");
  await len.press("Enter");
  await settle(page);
  expect((await page.evaluate(() => (window as any).__lens.store.get().project.transitions))).toMatchObject({ kind: "crossfade", durationMs: 400 });

  step("cut 2 -> Push, cut 3 -> Zoom through (chip menu on the block)");
  for (const [i, k] of [[1, "push"], [2, "zoom"]] as const) {
    await page.getByTestId(`cut-tr-${i}`).click();
    await expect(page.getByTestId(`cut-tr-opt-${k}`)).toBeVisible();
    await page.getByTestId(`cut-tr-opt-${k}`).click();
    await expect(page.getByTestId(`cut-tr-${i}`)).toHaveAttribute("data-kind", k);
  }
  step("cut 4 -> Blur dip (selection card)");
  // the chip selects its cut: the selection card's select is right there (pressing it closes the chip menu)
  await page.getByTestId("cut-tr-3").click();
  await expect(page.getByTestId("sel-cut-transition")).toBeVisible();
  await page.getByTestId("sel-cut-transition").selectOption("blur");
  await settle(page);
  await expect(page.getByTestId("cut-tr-3")).toHaveAttribute("data-kind", "blur");

  step("slide enter: Slide up 0.4 s Linear (slide card)");
  await page.evaluate(() => (window as any).__lens.store.select({ track: "slide", index: 0 }));
  await expect(page.getByTestId("slide-card")).toBeVisible();
  await page.getByTestId("slide-enter-kind").selectOption("slide-up");
  const sms = page.getByTestId("slide-enter-ms-value");
  await sms.click();
  await sms.fill("0.4");
  await sms.press("Enter");
  await page.getByTestId("slide-enter-easing").selectOption("linear");
  await settle(page);
  expect((await page.evaluate(() => (window as any).__lens.store.get().project.slides[0].enter))).toEqual({ kind: "slide-up", ms: 400, easing: "linear" });

  const p1 = await plan();
  console.log("slide fx 117", JSON.stringify(p1.frames[117].slide?.fx));
  expect(p1.frames[117].slide.fx[1]).toBeGreaterThanOrEqual(179);
  expect(p1.frames[117].slide.fx[1]).toBeLessThanOrEqual(181);
  const tr = p1.frames.map((f: any, i: number) => ({ f, i })).filter(({ f }: any) => f.tr);
  console.log("tr frames", tr.length, JSON.stringify(JOIN_FRAMES.map((n) => p1.frames[n].tr)));
  expect(tr.length).toBe(48);
  JOIN_FRAMES.forEach((n, j) => {
    const near = tr.filter(({ i }: any) => Math.abs(i - n) <= 7);
    expect(near.length, `join ${j}`).toBe(12);
    expect(near.every(({ f }: any) => f.tr.kind === KINDS[j]), `join ${j} kind`).toBe(true);
    expect(p1.frames[n].tr.u).toBeCloseTo(0.5, 3);
  });
  expect(p1.frames.slice(110).some((f: any) => f.tr)).toBe(false);

  step("preview frames");
  const prev: Record<number, Rgb> = {};
  for (const n of [10, 40, ...JOIN_FRAMES, 117]) {
    await seek(page, n);
    prev[n] = await previewRgb(page);
    dump(`tr-preview-${n}`, prev[n]!);
  }

  step("browser export");
  const mp4 = await exportMp4(page, dir, 600_000);
  await page.evaluate(() => { const st = (window as any).__lens.store; st.closeExport(); st.closeExportDialog(); });
  const ex: Record<number, Rgb> = {};
  for (const n of [10, 40, ...JOIN_FRAMES, 117]) {
    ex[n] = frameIdx(mp4, n);
    dump(`tr-export-${n}`, ex[n]!);
  }

  const res: Record<string, number> = {};
  for (const [name, src] of [["preview", prev], ["export", ex]] as const) {
    const d = luma(src[10]!), l = luma(src[40]!);
    const avg = (d + l) / 2;
    const mid = luma(src[27]!);
    res[`${name}.dark`] = d;
    res[`${name}.light`] = l;
    res[`${name}.crossfadeMid`] = mid;
    res[`${name}.crossfadeErrPct`] = (Math.abs(mid - avg) / avg) * 100;
  }
  JOIN_FRAMES.forEach((n, j) => (res[`parity.${KINDS[j]}`] = meanRgbDiff(prev[n]!.rgb, ex[n]!.rgb)));
  const d = res["export.dark"]!, l = res["export.light"]!, span = l - d;
  res["export.pushLeftMinusRight"] = luma(ex[51]!, 0, W / 2) - luma(ex[51]!, W / 2, W);
  res["export.zoomMid"] = luma(ex[75]!);
  res["export.blurMid"] = luma(ex[99]!);
  {
    const f = ex[117]!;
    let top = 0, n1 = 0, rg = 0, n2 = 0;
    for (let y = 0; y < H / 4; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; top += 0.299 * f.rgb[i]! + 0.587 * f.rgb[i + 1]! + 0.114 * f.rgb[i + 2]!; n1++; }
    for (let y = Math.round(H * 0.52); y < Math.round(H * 0.6); y++) for (let x = 0; x < W * 0.1; x++) { const i = (y * W + x) * 3; rg += f.rgb[i]! - f.rgb[i + 1]!; n2++; }
    res["export.slideTopLuma"] = top / n1;
    res["export.slideBandRminusG"] = rg / n2;
    res["parity.slideEnter"] = meanRgbDiff(prev[117]!.rgb, ex[117]!.rgb);
  }
  console.log("RESULTS", JSON.stringify(res, null, 1));
  expect(Math.abs(res["export.slideTopLuma"]! - d)).toBeLessThanOrEqual(25);
  expect(res["export.slideBandRminusG"]).toBeGreaterThanOrEqual(100);
  expect(res["parity.slideEnter"]).toBeLessThanOrEqual(12);

  for (const name of ["preview", "export"]) expect(res[`${name}.crossfadeErrPct`], `${name} crossfade midpoint`).toBeLessThanOrEqual(10);
  for (const k of KINDS) expect(res[`parity.${k}`], `preview vs export ${k}`).toBeLessThanOrEqual(12);
  expect(res["export.pushLeftMinusRight"]).toBeGreaterThanOrEqual(0.6 * span);
  for (const k of ["zoomMid", "blurMid"]) {
    const v = res[`export.${k}`]!;
    expect(Math.min(Math.abs(v - d), Math.abs(v - l)), k).toBeGreaterThanOrEqual(0.2 * span);
  }

  step("back to hard cuts through the UI: plan identical to the baseline");
  await page.getByTestId("tab-look").click();
  await page.getByTestId("tr-kind").selectOption("none");
  for (const i of [1, 2, 3]) {
    await page.getByTestId(`cut-tr-${i}`).click();
    await page.getByTestId("cut-tr-opt-default").click();
  }
  await page.evaluate(() => (window as any).__lens.store.select({ track: "slide", index: 0 }));
  await page.getByTestId("slide-enter-kind").selectOption("default");
  await settle(page);
  const json1: string = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));
  expect(json1 === json0, "plan with transitions off == plan before any transition").toBe(true);
  await lens.close();
});
