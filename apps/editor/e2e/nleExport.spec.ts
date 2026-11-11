/**
 * NLE hand-off export (demand #11, feat/nle-export-015): Export dialog "Editor hand-off" tab -> transparent
 * overlay (cursor, click effects) as ProRes 4444 .mov and VP9-alpha .webm, plus cuts.fcpxml and cuts.edl.
 * The overlay is drawn by the editor's renderer and encoded by ffmpeg only (the desktop app's path, no Python).
 *
 * Synthetic bundle: 640x360 @30, 6 s, flat grey screen; the cursor glides left to right along y = 120 and
 * clicks at 2.2 s and 4.4 s; manual cuts [1000, 1500] and [3000, 3500]; a manual 2x zoom at source
 * 1800..2800 focused on (320, 180); output 360p30, 150 frames.
 *
 * Bounds, set before the first run:
 *  - overlay.mov: codec prores, profile 4444, pix_fmt yuva*, 150 frames, 640x360;
 *  - overlay.webm: codec vp9, ALPHA_MODE tag 1, 150 frames;
 *  - alpha, at output frames 10 / 40 / 50 / 100 / 140 (cursor visible, no click effect running; first run had 60, which a click effect covers, fixture fix): the max alpha
 *    in a 16 x 22 px box below-right of the plan cursor position (the arrow) >= 128 in the .mov and the .webm;
 *    every pixel farther than 80 px from it: alpha <= 2 in the .mov, <= 8 in the .webm (lossy);
 *  - cuts.fcpxml is well-formed XML (python3 xml.etree), has 3 screen clips whose offset / start / duration
 *    match the plan's kept ranges (0-1000, 1500-3000, 3500-6000 source; 0-1000, 1000-2500, 2500-5000 output)
 *    within 1 frame, and a "Zoom 2.00x" marker;
 *  - cuts.edl: 3 events, source in / out and record in / out within 1 frame of the same ranges, one zoom LOC.
 */
import { test } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect } from "./helpers";
import { closeAll, openLens } from "./lensApp";

test.afterAll(() => closeAll());
test.use({ actionTimeout: 20_000, navigationTimeout: 60_000 });

const W = 640, H = 360, FPS = 30, SECS = 6;
const KEPT = [[0, 1000, 0], [1500, 3000, 1000], [3500, 6000, 2500]] as const; // srcStart, srcEnd, outStart
const FMS = 1000 / FPS;

function makeBundle(): string {
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `nle-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x606060:s=${W}x${H}:r=${FPS}:d=${SECS}`, "-c:v", "libx264", "-preset", "veryfast",
    "-crf", "10", "-pix_fmt", "yuv420p", path.join(dir, "screen.mp4")]);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: W, height: H, fps: FPS, durationMs: SECS * 1000, pixelRatio: 1 }));
  const ev = ['# lens-events v1 {"capture":{"width":640,"height":360},"source":"screen","platform":"linux"}'];
  for (let t = 0; t <= SECS * 1000; t += 50) ev.push(JSON.stringify({ t, type: "move", x: Math.round(60 + (t / (SECS * 1000)) * 520), y: 120 }));
  for (const t of [2200, 4400]) {
    const x = Math.round(60 + (t / (SECS * 1000)) * 520);
    ev.push(JSON.stringify({ t, type: "down", x, y: 120, button: "left" }), JSON.stringify({ t: t + 90, type: "up", x, y: 120, button: "left" }));
  }
  ev.sort((a, b) => (a.startsWith("#") ? -1 : b.startsWith("#") ? 1 : JSON.parse(a).t - JSON.parse(b).t));
  fs.writeFileSync(path.join(dir, "events.jsonl"), ev.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({
    version: 1, output: { aspect: "16:9", resolution: 360, fps: FPS },
    zoom: { auto: false, segments: [{ id: "z1", startMs: 1800, endMs: 2800, scale: 2, focus: { x: 320, y: 180 }, style: "classic", auto: false }] },
    cursor: { visible: true, clickEffect: "ripple" }, motionBlur: { enabled: false }, shortcuts: { enabled: false },
    background: { kind: "hidden", colors: ["#000000"], inherit: false }, audio: { tracks: [] },
    edits: { cuts: [{ startMs: 1000, endMs: 1500 }, { startMs: 3000, endMs: 3500 }] },
  }, null, 1));
  return dir;
}

function probe(file: string, extra: string[] = []): any {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", ...extra, "-select_streams", "v:0", "-count_frames", "-show_entries",
    "stream=codec_name,profile,pix_fmt,width,height,nb_read_frames:stream_tags", "-of", "json", file], { encoding: "utf8" })).streams[0];
}

/** Alpha plane of output frame n (decoder forced to libvpx-vp9 for WebM so the alpha is decoded). */
function alphaOf(file: string, n: number): Buffer {
  const dec = file.endsWith(".webm") ? ["-c:v", "libvpx-vp9"] : [];
  const r = spawnSync("ffmpeg", ["-v", "error", ...dec, "-i", file, "-vf", `select=eq(n\\,${n})`, "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.stdout.length < W * H * 4) throw new Error(`decode ${file} frame ${n}: ${r.stderr}`);
  const a = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) a[i] = r.stdout[i * 4 + 3]!;
  return a;
}

function alphaStats(a: Buffer, cx: number, cy: number): { near: number; far: number } {
  let near = 0, far = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = a[y * W + x]!;
    if (x >= cx - 2 && x <= cx + 14 && y >= cy - 2 && y <= cy + 20) near = Math.max(near, v);
    if (Math.hypot(x - cx, y - cy) > 80) far = Math.max(far, v);
  }
  return { near, far };
}

/** "N/Ds" or "0s" -> frames at FPS. */
const tf = (s: string) => (s === "0s" ? 0 : (() => { const [n, d] = s.replace(/s$/, "").split("/").map(Number); return (n! / (d ?? 1)) * FPS; })());
const tcf = (tc: string) => { const [h, m, s, f] = tc.split(":").map(Number); return ((h! * 60 + m!) * 60 + s!) * FPS + f!; };

test("NLE hand-off: overlay ProRes 4444 + VP9 alpha, FCPXML + EDL cut times", async () => {
  test.setTimeout(600_000);
  const dir = makeBundle();
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  const results: Record<string, unknown> = {};

  const plan = await page.evaluate(() => (window as any).__lens.store.get().plan);
  expect(plan.frames.length).toBe(150);

  await page.getByTestId("export-dialog-open").click();
  await page.getByTestId("export-tab-nle").click();
  await expect(page.getByTestId("export-nle")).toBeVisible();
  await page.getByTestId("export-nle-go").click();
  await expect(page.getByTestId("export-nle-files")).toBeVisible({ timeout: 300_000 });
  const ex = await page.evaluate(() => (window as any).__lens.store.get().nleExport);
  expect(ex.state).toBe("done");
  const out = path.join(dir, ".lens-export", ex.id);
  const mov = path.join(out, "overlay.mov"), webm = path.join(out, "overlay.webm");

  // codecs and alpha formats
  const pm = probe(mov);
  results.mov = pm;
  expect(pm.codec_name).toBe("prores");
  expect(String(pm.profile)).toMatch(/4444/);
  expect(pm.pix_fmt).toMatch(/^yuva/);
  expect([pm.width, pm.height, Number(pm.nb_read_frames)]).toEqual([W, H, 150]);
  const pw = probe(webm);
  results.webm = pw;
  expect(pw.codec_name).toBe("vp9");
  expect(String(pw.tags?.ALPHA_MODE ?? pw.tags?.alpha_mode)).toBe("1");
  expect(Number(pw.nb_read_frames)).toBe(150);

  // alpha around the plan's cursor position vs far from it
  const pt = (f: any): [number, number] => {
    const [cx, cy, s] = f.cam;
    const [, , sw0, sh0] = plan.source.crop;
    const [sx, sy, sw, sh] = f.layout.screen;
    const vw = sw0 / s, vh = sh0 / s;
    return [sx + (f.cur[0] - (cx - vw / 2)) * (sw / vw), sy + (f.cur[1] - (cy - vh / 2)) * (sh / vh)];
  };
  for (const n of [10, 40, 50, 100, 140]) {
    const f = plan.frames[n];
    expect(f.cur, `cursor on frame ${n}`).toBeTruthy();
    expect(f.clicks.length, `no click effect on frame ${n}`).toBe(0);
    const [cx, cy] = pt(f).map(Math.round) as [number, number];
    const a = alphaStats(alphaOf(mov, n), cx, cy);
    const b = alphaStats(alphaOf(webm, n), cx, cy);
    results[`alpha.${n}`] = { cursor: [cx, cy], mov: a, webm: b };
    expect(a.near).toBeGreaterThanOrEqual(128);
    expect(a.far).toBeLessThanOrEqual(2);
    expect(b.near).toBeGreaterThanOrEqual(128);
    expect(b.far).toBeLessThanOrEqual(8);
  }

  // FCPXML: well-formed, clip times = the kept ranges within a frame, zoom marker
  const xml = fs.readFileSync(path.join(out, "cuts.fcpxml"), "utf8");
  const wf = spawnSync("python3", ["-c", "import sys, xml.etree.ElementTree as E; E.parse(sys.argv[1]); print('ok')", path.join(out, "cuts.fcpxml")], { encoding: "utf8" });
  expect(wf.stdout.trim(), wf.stderr).toBe("ok");
  const clips = [...xml.matchAll(/<asset-clip name="screen \d+" ref="r3" offset="([^"]+)" start="([^"]+)" duration="([^"]+)"/g)].map((m) => [tf(m[1]!), tf(m[2]!), tf(m[3]!)]);
  results.fcpxmlClips = clips;
  expect(clips).toHaveLength(3);
  const errs: number[] = [];
  clips.forEach(([off, start, dur], i) => {
    const [s0, s1, o0] = KEPT[i]!;
    errs.push(Math.abs(off! * FMS - o0), Math.abs(start! * FMS - s0), Math.abs((off! + dur!) * FMS - (o0 + s1 - s0)));
  });
  expect(xml).toMatch(/<marker [^>]*value="Zoom 2\.00x at 320,180"/);
  expect(xml).toMatch(/lane="1"/);

  // EDL: 3 events, source / record in and out within a frame
  const edl = fs.readFileSync(path.join(out, "cuts.edl"), "utf8");
  const evs = edl.split("\n").filter((l) => /^\d{3}\s/.test(l)).map((l) => l.trim().split(/\s+/).slice(-4).map(tcf));
  results.edlEvents = evs;
  expect(evs).toHaveLength(3);
  evs.forEach(([si, so, ri, ro], i) => {
    const [s0, s1, o0] = KEPT[i]!;
    errs.push(Math.abs(si! * FMS - s0), Math.abs(so! * FMS - s1), Math.abs(ri! * FMS - o0), Math.abs(ro! * FMS - (o0 + s1 - s0)));
  });
  expect((edl.match(/^\* LOC: /gm) ?? []).length).toBe(1);
  results.maxCutErrorMs = Math.max(...errs);
  console.log("RESULTS", JSON.stringify(results, null, 1));
  for (const e of errs) expect(e).toBeLessThanOrEqual(FMS + 1e-6);
});
