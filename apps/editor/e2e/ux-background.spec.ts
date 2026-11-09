/**
 * Backdrop picker (Windows bug #20): Image / Hidden / Gradient / Color tabs change the exported frame's
 * backdrop; a picked backdrop is saved with the project and in a saved style preset; the upload works
 * offline (the image goes into the bundle).
 * Bounds (set before the first run), on the exported frame's corner pixels (the backdrop; the
 * recording sits inside the padding):
 *  - Color: a swatch makes the corner that colour within 6 levels per channel; hex input likewise;
 *  - Gradient: a preset makes the top-left and bottom-right corners differ by >= 40 and each lie
 *    within 40 of the gradient's end colours; stops are placed freely: with the default (even) stops the
 *    top-edge midpoint (u ~ 0.32 along the gradient) is >= 40 from the end colour, and after typing 20 %
 *    for the end stop it is within 12 of it; dragging stop 1's handle to the bar's middle stores
 *    0.5 +- 0.03; adding a stop gives 3 colours;
 *  - Image (built-in art): the corner differs from the previous solid colour by >= 30 and matches the
 *    preview canvas's corner within 12 (preview == export), and the Python compositor's backdrop
 *    (make_background on the same plan style) matches the export within 16 at the four corners and the
 *    top / left edge midpoints; Upload your own (a generated magenta PNG,
 *    no network): corner within 12 of magenta for Cover; Contain leaves the image's sides filled;
 *  - Hidden: the recording fills the frame: the corner shows checkerboard (black or white), not the backdrop;
 *  - the project file and a style preset saved from it keep the image backdrop.
 */
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { exportMp4, frameAt, hexRgb, proj, px, rgbDist, seekSrc, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

test("each backdrop tab changes the exported backdrop", async () => {
  const dir = uxBundle("background");
  const lens = await openLens(dir, { w: 1366, h: 768 });
  const page = lens.page;
  await smallExport(page, 400);
  await seekSrc(page, 100);
  await page.getByTestId("tab-look").click();
  const corner = async () => {
    const f = frameAt(await exportMp4(page, dir), 0.1);
    await page.evaluate(() => (window as any).__lens.store.closeExport());
    return { tl: px(f, 3, 3), br: px(f, f.w - 4, f.h - 4), f };
  };
  const previewCorner = () => page.evaluate(() => { const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement; return Array.from(c.getContext("2d")!.getImageData(3, 3, 1, 1).data.slice(0, 3)); });

  // Color
  await page.getByTestId("bg-tab-color").click();
  const sw = await page.locator('[data-testid^="bg-color-"]').nth(7).getAttribute("data-testid");
  const hex = `#${sw!.slice("bg-color-".length)}`;
  await page.getByTestId(sw!).click();
  expect((await proj(page)).background).toMatchObject({ kind: "solid", colors: [hex], inherit: false });
  let c = await corner();
  console.log("color", hex, c.tl);
  expect(rgbDist(c.tl, hexRgb(hex))).toBeLessThanOrEqual(6);
  await page.getByTestId("bg-hex").fill("#12a4d9");
  c = await corner();
  console.log("hex #12a4d9", c.tl);
  expect(rgbDist(c.tl, hexRgb("#12a4d9"))).toBeLessThanOrEqual(6);
  const solid = c.tl;

  // Gradient
  await page.getByTestId("bg-tab-gradient").click();
  await page.getByTestId("bg-gradient-lagoon").click();
  c = await corner();
  console.log("gradient lagoon", c.tl, c.br);
  expect(rgbDist(c.tl, c.br)).toBeGreaterThanOrEqual(40);
  expect(rgbDist(c.tl, hexRgb("#00c6ff"))).toBeLessThanOrEqual(40);
  expect(rgbDist(c.br, hexRgb("#0072ff"))).toBeLessThanOrEqual(40);
  const topMid = (f: { w: number; rgb: Buffer }) => px(f, f.w / 2, 3);
  console.log("gradient lagoon even stops: top-mid", topMid(c.f));
  expect(rgbDist(topMid(c.f), hexRgb("#0072ff"))).toBeGreaterThanOrEqual(40);
  await page.getByTestId("bg-stop-pos-1").fill("20");
  expect((await proj(page)).background.stops).toEqual([0, 0.2]);
  c = await corner();
  console.log("gradient lagoon end stop at 20 %: top-mid", topMid(c.f));
  expect(rgbDist(topMid(c.f), hexRgb("#0072ff"))).toBeLessThanOrEqual(12);
  const bar = (await page.getByTestId("bg-stop-bar").boundingBox())!;
  const h1 = (await page.getByTestId("bg-stop-handle-1").boundingBox())!;
  await page.mouse.move(h1.x + h1.width / 2, h1.y + h1.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.3, bar.y + bar.height / 2, { steps: 4 });
  await page.mouse.move(bar.x + bar.width * 0.5, bar.y + bar.height / 2, { steps: 4 });
  await page.mouse.up();
  const dragged = (await proj(page)).background.stops;
  console.log("stop 1 dragged to the bar middle", dragged);
  expect(Math.abs(dragged[1] - 0.5)).toBeLessThanOrEqual(0.03);
  await page.getByTestId("bg-stop-add").click();
  expect((await proj(page)).background.colors).toHaveLength(3);

  // Image: built-in art
  await page.getByTestId("bg-tab-image").click();
  await page.getByTestId("bg-image-ember").click();
  expect((await proj(page)).background).toMatchObject({ kind: "image", imagePath: "builtin:ember" });
  await page.waitForTimeout(400);
  const pv = await previewCorner();
  c = await corner();
  console.log("image ember export", c.tl, "preview", pv, "previous solid", solid);
  expect(rgbDist(c.tl, solid)).toBeGreaterThanOrEqual(30);
  expect(rgbDist(c.tl, pv)).toBeLessThanOrEqual(12);
  // the Python compositor draws the same built-in art from the plan (style.backdropArt)
  const style = await page.evaluate(() => (window as any).__lens.store.get().plan.style);
  expect(style.backdropArt?.id).toBe("ember");
  const pts: Array<[number, number]> = [[3, 3], [c.f.w - 4, 3], [3, c.f.h - 4], [c.f.w - 4, c.f.h - 4], [c.f.w / 2, 3], [3, c.f.h / 2]];
  const py = JSON.parse(execFileSync("python3", ["-c", [
    "import json,sys; sys.path.insert(0, sys.argv[1]); from lens_compositor.render import make_background",
    "a=json.loads(sys.argv[2]); bg=make_background(a['style'], a['w'], a['h'])",
    "print(json.dumps([[float(v) for v in bg[int(round(y)), int(round(x))][::-1]] for x, y in a['pts']]))",
  ].join("\n"), path.resolve(process.cwd(), "..", "..", "compositor"), JSON.stringify({ style, w: c.f.w, h: c.f.h, pts })], { encoding: "utf8" }));
  const ex = pts.map(([x, y]) => px(c.f, x, y));
  const dists = pts.map((_, i) => rgbDist(ex[i]!, py[i]));
  console.log("ember python vs export", JSON.stringify(py.map((v: number[]) => v.map(Math.round))), JSON.stringify(ex), "dist", dists);
  for (const d of dists) expect(d).toBeLessThanOrEqual(16);
  await shot(page, `bg-image${PACKAGED ? "-app" : ""}`);

  // Upload your own (offline: a PNG made here, uploaded into the bundle)
  const png = path.join(os.tmpdir(), `lens-bg-${Date.now()}.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xff00ff:s=400x400", "-frames:v", "1", png]);
  await page.getByTestId("bg-upload-input").setInputFiles(png);
  await page.waitForFunction(() => { const b = (window as any).__lens.store.get().project.background; return b.kind === "image" && !b.imagePath.startsWith("builtin:"); }, null, { timeout: 30_000 });
  const up = (await proj(page)).background;
  expect(fs.existsSync(path.isAbsolute(up.imagePath) ? up.imagePath : path.join(dir, up.imagePath))).toBe(true);
  c = await corner();
  console.log("upload cover", up.imagePath, c.tl);
  expect(rgbDist(c.tl, [255, 0, 255])).toBeLessThanOrEqual(12);
  await page.getByTestId("bg-fit").getByText("Contain").click();
  expect((await proj(page)).background.fit).toBe("contain");
  c = await corner();
  console.log("upload contain (square image in a 16:9 frame: sides show the fill)", c.tl);
  expect(rgbDist(c.tl, [255, 0, 255])).toBeGreaterThan(40);

  // saved with the project and in a style preset
  await page.getByTestId("bg-image-aurora").click();
  await page.evaluate(() => (window as any).__lens.store.save());
  await page.waitForTimeout(500);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  expect(saved.background).toMatchObject({ kind: "image", imagePath: "builtin:aurora" });
  const pr = await page.evaluate(() => { const s = (window as any).__lens.store; const p = s.saveCurrentAsPreset("UX backdrop"); return p.sections.look.backdrop; });
  expect(pr).toMatchObject({ kind: "image", imagePath: "builtin:aurora" });

  // Hidden: the recording fills the frame
  await page.getByTestId("bg-tab-hidden").click();
  expect((await proj(page)).background.kind).toBe("hidden");
  c = await corner();
  const lum = (p: number[]) => 0.299 * p[0]! + 0.587 * p[1]! + 0.114 * p[2]!;
  const ls = [px(c.f, 2, 2), px(c.f, c.f.w - 3, 2), px(c.f, 2, c.f.h - 3)].map(lum);
  console.log("hidden corner luma", ls);
  for (const l of ls) expect(l < 60 || l > 195).toBe(true);
  await shot(page, `bg-hidden${PACKAGED ? "-app" : ""}`);
  await lens.close();
});
