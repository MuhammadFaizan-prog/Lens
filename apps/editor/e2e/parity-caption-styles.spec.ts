/**
 * Caption styles at parity (Windows request "diff diff fonts for the captions"): the sample project
 * (transcript captions with word highlight) with two caption looks, rendered by the browser renderer
 * and by the reference compositor (compositor/render.py), compared frame by frame.
 *
 *  A: Poppins, regular weight, capitals, black outline (10 % of the size), spoken word on a box.
 *  B: Caveat, bold, as typed, no outline, recoloured spoken word, light pill.
 *
 * Bounds, set before the first run: the parity suite's luma SSIM >= 0.95 per frame / >= 0.97 mean on the
 * whole frame, and on the caption band alone (bottom 30 %) >= 0.90 per frame / >= 0.93 mean (glyph
 * edges dominate the band, and canvas strokeText vs FreeType's stroker differ by sub-pixel coverage).
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.resolve(HERE, "..");
const FRAMES = [24, 48, 75, 110, 150, 190, 230, 262];

const LOOKS: Record<string, Record<string, unknown>> = {
  A: { font: "Poppins", weight: "regular", uppercase: true, stroke: { enabled: true, color: "#000000", width: 0.1 }, highlightStyle: "box", background: { enabled: false, color: "#000000", opacity: 0.66 } },
  B: { font: "Caveat", weight: "bold", uppercase: false, highlightStyle: "color", background: { enabled: true, color: "#f4f1ea", opacity: 0.9 }, textColor: "#1d2027", highlightColor: "#d9480f" },
};

for (const [name, look] of Object.entries(LOOKS)) {
  test(`caption look ${name}: browser preview matches compositor/render.py`, async ({ page }) => {
    test.setTimeout(400_000);
    // a copy of the sample with this caption look
    const src = path.join(EDITOR, "sample");
    await page.request.get(`/api/bundle?dir=${encodeURIComponent(src)}`); // generates the sample if missing
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lens-capstyle-${name}-`));
    for (const f of fs.readdirSync(src)) if (fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    pj.captions = { ...pj.captions, enabled: true, style: { ...(pj.captions?.style ?? {}), ...look } };
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(pj, null, 1));

    const OUT = path.join(EDITOR, "test-results", `parity-caption-${name}`);
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const q = `?dir=${encodeURIComponent(dir)}`;
    await page.goto(`/parity.html${q}`);
    await page.evaluate(() => window.lensParity.ready);
    const plan = await page.evaluate(() => window.lensParity.plan());
    expect(plan.style.captions.font).toBe(look.font);
    expect(plan.fonts?.map((f) => f.family)).toContain(look.font);
    const frames = FRAMES.filter((i) => plan.frames[i]?.caption);
    expect(frames.length).toBeGreaterThanOrEqual(6);
    if (name === "A") expect(frames.some((i) => plan.frames[i]!.caption!.active >= 0)).toBe(true);
    fs.writeFileSync(path.join(OUT, "plan.json"), JSON.stringify(plan));
    for (const i of frames) {
      const url = await page.evaluate((n) => window.lensParity.render(n), i);
      fs.writeFileSync(path.join(OUT, `frame-${i}.png`), Buffer.from(url.split(",")[1]!, "base64"));
    }
    const args = [path.join(EDITOR, "scripts", "parity_ssim.py"), "--plan", path.join(OUT, "plan.json"), "--screen", path.join(dir, "screen.mp4"),
      "--pngs", OUT, "--frames", frames.join(","), "--out", path.join(OUT, "ssim.json"), "--diff-dir", path.join(OUT, "diff"), "--assets", dir, "--caption-band", "0.3"];
    if (plan.frames.some((f) => f.layout.camera) && fs.existsSync(path.join(dir, "cam.mp4"))) args.push("--camera", path.join(dir, "cam.mp4"));
    execFileSync("python3", args, { stdio: "inherit", timeout: 300_000 });
    const res = JSON.parse(fs.readFileSync(path.join(OUT, "ssim.json"), "utf8")) as { frames: Array<{ frame: number; ssim: number; captionSsim?: number; captionMeanAbsDiff?: number }>; mean: number; min: number; caption?: { frames: number; mean: number; min: number } };
    console.log(`caption look ${name} parity: whole frame mean ${res.mean} min ${res.min}; caption band mean ${res.caption?.mean} min ${res.caption?.min} over ${res.caption?.frames} frames; band mean |diff| ${res.frames.map((r) => r.captionMeanAbsDiff).join(", ")}`);
    for (const r of res.frames) expect(r.ssim, `frame ${r.frame}`).toBeGreaterThanOrEqual(0.95);
    expect(res.mean).toBeGreaterThanOrEqual(0.97);
    expect(res.caption?.frames).toBe(frames.length);
    for (const r of res.frames) expect(r.captionSsim!, `caption band frame ${r.frame}`).toBeGreaterThanOrEqual(0.9);
    expect(res.caption!.mean).toBeGreaterThanOrEqual(0.93);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
