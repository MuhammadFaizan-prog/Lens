/**
 * Second batch of caption styles at parity (Windows v0.1.3 "add more styles"): every new preset on the
 * sample project (transcript captions with word highlight), drawn by the browser renderer and by the
 * reference compositor (compositor/render.py), compared on the caption band (bottom 30 %).
 *
 * Bounds, set before the first run: per frame, caption band mean |RGB diff| <= 12 (the request's
 * "frame diff mean <= 12") and caption band luma SSIM >= 0.85 (glow, shadow and the frosted backdrop
 * are Gaussian blurs computed by two different blur implementations); whole frame SSIM >= 0.95.
 * Each frame's preview PNG is kept in test-results/parity-caption2-<id>/ (contact sheet input).
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCaptionPreset, CAPTION_PRESETS, defaultProject } from "../../../packages/engine/src/index";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.resolve(HERE, "..");
// inside spoken words (0.4-3.3 s, 5.2-7.55 s at 30 fps): mid-word frames show pop / bounce / underline in motion
const FRAMES = [20, 48, 170];
const NEW = CAPTION_PRESETS.slice(6);
const ONLY = process.env.LENS_CAPTION_STYLES?.split(",");

for (const pr of NEW.filter((p) => !ONLY || ONLY.includes(p.id))) {
  test(`caption style ${pr.id}: browser preview matches compositor/render.py`, async ({ page }) => {
    test.setTimeout(300_000);
    const src = path.join(EDITOR, "sample");
    await page.request.get(`/api/bundle?dir=${encodeURIComponent(src)}`); // generates the sample if missing
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lens-capstyle2-${pr.id}-`));
    for (const f of fs.readdirSync(src)) if (fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    const style = applyCaptionPreset({ ...defaultProject().captions.style, ...(pj.captions?.style ?? {}) }, pr.id);
    pj.captions = { ...pj.captions, enabled: true, wordHighlight: true, style };
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(pj, null, 1));

    const OUT = path.join(EDITOR, "test-results", `parity-caption2-${pr.id}`);
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    await page.goto(`/parity.html?dir=${encodeURIComponent(dir)}`);
    await page.evaluate(() => window.lensParity.ready);
    const plan = await page.evaluate(() => window.lensParity.plan());
    expect(plan.style.captions.font).toBe(pr.style.font);
    expect(plan.fonts?.map((f) => f.family)).toContain(pr.style.font);
    expect(plan.fontFallbacks ?? []).toEqual([]);
    const frames = FRAMES.filter((i) => plan.frames[i]?.caption);
    expect(frames.length).toBe(FRAMES.length);
    fs.writeFileSync(path.join(OUT, "plan.json"), JSON.stringify(plan));
    for (const i of frames) {
      const url = await page.evaluate((n) => window.lensParity.render(n), i);
      fs.writeFileSync(path.join(OUT, `frame-${i}.png`), Buffer.from(url.split(",")[1]!, "base64"));
    }
    const args = [path.join(EDITOR, "scripts", "parity_ssim.py"), "--plan", path.join(OUT, "plan.json"), "--screen", path.join(dir, "screen.mp4"),
      "--pngs", OUT, "--frames", frames.join(","), "--out", path.join(OUT, "ssim.json"), "--diff-dir", path.join(OUT, "diff"), "--assets", dir, "--caption-band", "0.3"];
    if (plan.frames.some((f) => f.layout.camera) && fs.existsSync(path.join(dir, "cam.mp4"))) args.push("--camera", path.join(dir, "cam.mp4"));
    execFileSync("python3", args, { stdio: "inherit", timeout: 240_000 });
    const res = JSON.parse(fs.readFileSync(path.join(OUT, "ssim.json"), "utf8")) as { frames: Array<{ frame: number; ssim: number; captionSsim?: number; captionMeanAbsDiff?: number }>; mean: number };
    console.log(`style ${pr.id}: band mean |diff| ${res.frames.map((r) => r.captionMeanAbsDiff).join(", ")} (bound 12); band SSIM ${res.frames.map((r) => r.captionSsim).join(", ")} (bound 0.85); frame SSIM ${res.frames.map((r) => r.ssim).join(", ")}`);
    for (const r of res.frames) {
      expect(r.captionMeanAbsDiff!, `frame ${r.frame} band mean |diff|`).toBeLessThanOrEqual(12);
      expect(r.captionSsim!, `frame ${r.frame} band SSIM`).toBeGreaterThanOrEqual(0.85);
      expect(r.ssim, `frame ${r.frame} SSIM`).toBeGreaterThanOrEqual(0.95);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
