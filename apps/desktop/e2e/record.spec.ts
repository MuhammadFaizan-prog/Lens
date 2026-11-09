/**
 * Desktop recorder end to end on Linux: Xvfb + a synthetic scene (moving bar, magenta flash under
 * each mouse press) driven by xdotool, the real Electron app recording it.
 *
 * Bounds (set before the first measurement, docs/Desktop.md):
 *  - the recorded file plays (every frame decodes) and its duration is within 0.5 s of the wall time
 *    between "recording" being visible to the driver and the stop hotkey;
 *  - logged clicks match the injected clicks: count exact, positions within 2 px, and each click's
 *    time within 50 ms of the video time of the first frame showing its flash;
 *  - the zoom plan built from the recording targets each click: an auto zoom segment covers the click,
 *    at the click's frame the camera has scale >= 1.2 with the click inside the viewport, and 500 ms
 *    later the click sits within the central 60% of the viewport;
 *  - the live preview zoomed in (scale > 1.2) within 800 ms of a click;
 *  - the project opens in the editor (status ready, frame count = duration x fps +- 1, 6 clicks);
 *  - (export.spec.ts) export from the desktop app writes an MP4 with exactly the plan's frame count.
 * LENS_E2E_SCALE=2 runs the same scene with Electron at device scale factor 2 (DIP != capture px).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { DESKTOP, RUNS, decodeFrames, epoch, ffprobeJson, flashCrop, glide, isFlash, sleep, startScene, startXvfb, xdo } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 97);
const W = 1280;
const H = 720;
const SCALE = Number(process.env.LENS_E2E_SCALE ?? 1);
const CLICKS = [
  { x: 220, y: 160 },
  { x: 1010, y: 210 },
  { x: 640, y: 380 },
  { x: 300, y: 560 },
  { x: 1100, y: 600 },
  { x: 760, y: 120 },
];
const B = { durationS: 0.5, posPx: 2, timeMs: 50, zoomScaleAtClick: 1.2, centralFrac: 0.6, liveScale: 1.2, liveWithinMs: 800 };

let xvfb: ChildProcess | null = null;
let scene: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  scene?.kill();
  xvfb?.kill();
});

async function recorderPage(a: ElectronApplication): Promise<Page> {
  const p = await a.firstWindow();
  await p.waitForFunction(() => (window as any).lensRecorder?.state().sources.some((s: any) => s.kind === "screen"), null, { timeout: 30_000 });
  return p;
}

test("record a synthetic scene: file, clicks, zoom plan, editor, export", async () => {
  test.setTimeout(600_000);
  const run = path.join(RUNS, `e2e-${SCALE}x-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  const report: Record<string, unknown> = { scale: SCALE, bounds: B };
  const save = () => fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));

  xvfb = await startXvfb(DISPLAY, W, H);
  app = await electron.launch({
    args: [DESKTOP, "--no-sandbox", ...(SCALE !== 1 ? [`--force-device-scale-factor=${SCALE}`] : [])],
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: path.join(run, "rec"), LENS_USER_DATA: path.join(run, "userdata"), LENS_NO_UPDATE: "1" },
    timeout: 60_000,
  });
  const pages: Page[] = [];
  app.on("window", (p) => pages.push(p));
  const crashes: string[] = [];
  app.on("window", (p) => p.on("crash", () => crashes.push(p.url())));
  const rec = await recorderPage(app);
  const sceneLog = path.join(run, "scene.jsonl");
  scene = startScene(DISPLAY, W, H, sceneLog);
  await sleep(2000);
  xdo(DISPLAY, "mousemove", "640", "360");
  await sleep(300);

  // Start with the global hotkey
  xdo(DISPLAY, "key", "ctrl+shift+r");
  await rec.waitForFunction(() => (window as any).lensRecorder.state().state === "recording", null, { timeout: 30_000, polling: 20 });
  const wallStart = epoch();
  await sleep(800);

  const injected: Array<{ x: number; y: number; t: number }> = [];
  const live: Array<{ scale: number; segs: number; atMs: number }> = [];
  let at = { x: 640, y: 360 };
  for (const c of CLICKS) {
    await glide(DISPLAY, at, c, 450);
    at = c;
    await sleep(120);
    const t = epoch();
    xdo(DISPLAY, "click", "1");
    injected.push({ ...c, t });
    // live preview zoom, sampled until it zooms or the bound passes
    let best = { scale: 1, segs: 0, atMs: -1 };
    while (epoch() - t < B.liveWithinMs) {
      const s = await rec.evaluate(() => (window as any).lensRecorder.state());
      if (s.camera && s.camera.scale > best.scale) best = { scale: s.camera.scale, segs: s.zooms.length, atMs: Math.round(epoch() - t) };
      await sleep(100);
    }
    live.push(best);
    await sleep(Math.max(0, 1300 - (epoch() - t)));
  }
  await sleep(500);
  const wallStop = epoch();
  xdo(DISPLAY, "key", "ctrl+shift+r");
  // the recorder window is replaced after each recording (main.ts recycleRecorder), so the result is read from main
  let result: any = null;
  for (let i = 0; i < 900 && !result; i++) {
    result = await app.evaluate(() => (globalThis as any).lensLastResult ?? null);
    if (!result) await sleep(200);
  }
  expect(result, "recording saved").toBeTruthy();
  const bundle: string = result.dir;
  report.bundle = bundle;
  report.result = result;
  report.live = live;
  save();

  // ---- recorded file
  const wallS = (wallStop - wallStart) / 1000;
  const webmFrames = await decodeFrames(path.join(bundle, "recording.webm"), 16, 9);
  const lastPts = webmFrames[webmFrames.length - 1]!.pts;
  const mp4 = ffprobeJson(["-show_entries", "format=duration:stream=nb_frames,r_frame_rate", "-count_frames", "-select_streams", "v:0", path.join(bundle, "screen.mp4")]);
  const mp4Dur = Number(mp4.format.duration);
  const recInfo = JSON.parse(fs.readFileSync(path.join(bundle, "recording.json"), "utf8"));
  report.file = { wallS, webmFrames: webmFrames.length, webmFirstPts: webmFrames[0]!.pts, webmLastPts: lastPts, mp4DurationS: mp4Dur, mp4Frames: Number(mp4.streams[0].nb_frames), recorderWallS: recInfo.wallMs / 1000, capture: recInfo.capture };
  save();
  expect(webmFrames.every((f) => Number.isFinite(f.pts))).toBe(true);
  expect(Math.abs(mp4Dur - wallS), `duration ${mp4Dur} vs wall ${wallS}`).toBeLessThanOrEqual(B.durationS);

  // ---- clicks
  const events = fs.readFileSync(path.join(bundle, "events.jsonl"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => JSON.parse(l));
  const downs = events.filter((e) => e.type === "down");
  const webm = path.join(bundle, "recording.webm");
  const t0pts = webmFrames[0]!.pts;
  const clickRows = [];
  for (const [i, c] of injected.entries()) {
    const d = downs[i];
    const crop = await flashCrop(webm, c.x, c.y);
    const fi = crop.findIndex(isFlash);
    const flashMs = fi >= 0 ? (crop[fi]!.pts - t0pts) * 1000 : NaN;
    const prevMs = fi > 0 ? (crop[fi - 1]!.pts - t0pts) * 1000 : NaN;
    clickRows.push({ injected: c, logged: d ?? null, dx: d ? d.x - c.x : NaN, dy: d ? d.y - c.y : NaN, flashFrame: fi, flashMs, prevFrameMs: prevMs, dtMs: d ? d.t - flashMs : NaN });
  }
  // capture rate, and the video clock origin bracketed independently: the scene stamps each press
  // (epoch ms) and draws its flash, which must land after the last frame without it and by the first
  // frame with it, so epoch(video t=0) lies in [press - flashMs, press - prevFrameMs] for every click
  const gaps = webmFrames.slice(1).map((f, i) => (f.pts - webmFrames[i]!.pts) * 1000).sort((a, b) => a - b);
  const presses = fs.existsSync(sceneLog) ? fs.readFileSync(sceneLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  let lo = -Infinity;
  let hi = Infinity;
  clickRows.forEach((r, i) => {
    const p = presses[i];
    if (!p || !Number.isFinite(r.flashMs)) return;
    lo = Math.max(lo, p.t - r.flashMs);
    if (Number.isFinite(r.prevFrameMs)) hi = Math.min(hi, p.t - r.prevFrameMs);
  });
  const v0 = (lo + hi) / 2;
  const bracket = { lo, hi, widthMs: hi - lo, consistent: lo <= hi };
  const vsScene = clickRows.map((r, i) => (presses[i] && r.logged ? Math.round((r.logged.t - (presses[i].t - v0)) * 10) / 10 : null));
  report.clicks = { count: downs.length, rows: clickRows, clickSources: recInfo.clickSources, frameGapMs: { median: gaps[gaps.length >> 1], p90: gaps[Math.floor(gaps.length * 0.9)], max: gaps[gaps.length - 1] }, v0Bracket: bracket, loggedMinusScenePressMs: vsScene, appVideoStartMinusV0Ms: recInfo.videoStartEpoch ? Math.round((recInfo.videoStartEpoch - v0) * 10) / 10 : null, clockCandidatesMinusV0Ms: Object.fromEntries(Object.entries(recInfo.clock ?? {}).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, Math.round(((v as number) - v0) * 10) / 10])), clockChosen: recInfo.clock?.chosen };
  save();
  expect(downs.length).toBe(CLICKS.length);
  for (const r of clickRows) {
    expect(Math.abs(r.dx), `x error ${JSON.stringify(r)}`).toBeLessThanOrEqual(B.posPx);
    expect(Math.abs(r.dy), `y error ${JSON.stringify(r)}`).toBeLessThanOrEqual(B.posPx);
    expect(r.flashFrame, "flash found in the video").toBeGreaterThanOrEqual(0);
    // (a) the click is logged between the last frame without its flash and the first frame with it (+-50 ms)
    expect(r.logged!.t, `logged before its flash frame ${JSON.stringify(r)}`).toBeLessThanOrEqual(r.flashMs + B.timeMs);
    if (Number.isFinite(r.prevFrameMs)) expect(r.logged!.t, `logged after the frame before ${JSON.stringify(r)}`).toBeGreaterThan(r.prevFrameMs - B.timeMs);
  }
  // (b) against the scene's own press time on the video clock bracketed from the flash frames
  expect(bracket.consistent, "flash frames give a consistent video clock origin").toBe(true);
  expect(bracket.widthMs, "video clock origin bracketed to within 50 ms").toBeLessThanOrEqual(B.timeMs);
  for (const d of vsScene) expect(Math.abs(d ?? Infinity), `logged vs scene press ${JSON.stringify(vsScene)}`).toBeLessThanOrEqual(B.timeMs);

  // ---- editor opened on the new project
  const findEd = () => [...pages, ...app!.windows()].find((p) => !p.isClosed() && p.url().includes("dir="));
  for (let i = 0; i < 120 && !findEd(); i++) await sleep(500);
  const ed = findEd();
  report.windows = { urls: app.windows().map((p) => p.url()), crashes };
  save();
  expect(ed, "editor window").toBeTruthy();
  if (!ed) return;
  await ed.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
  const es = await ed.evaluate(() => {
    const s = (window as any).__lens.state();
    const st = (window as any).__lens.store.get();
    const plan = st.plan;
    const clicks = st.bundle.events.filter((e: any) => e.type === "down");
    return { frames: s.frames, fps: s.fps, zooms: s.zooms, clicks, meta: st.bundle.meta, planFrames: plan.frames.map((f: any) => ({ t: f.t, src: f.src, cam: f.cam })) };
  });
  const expectFrames = Math.round((es.meta.durationMs * es.fps) / 1000);
  report.editor = { frames: es.frames, expectFrames, zooms: es.zooms, clicks: es.clicks.length, meta: es.meta };
  save();
  expect(Math.abs(es.frames - expectFrames)).toBeLessThanOrEqual(1);
  expect(es.clicks.length).toBe(CLICKS.length);

  // ---- zoom plan targets each click (plan frames are in source px; no crop in a new project)
  const frameAt = (t: number) => es.planFrames.reduce((a: any, b: any) => (Math.abs(b.src - t) < Math.abs(a.src - t) ? b : a));
  const zoomRows = es.clicks.map((c: any) => {
    const seg = es.zooms.find((z: any) => z.auto && z.startMs <= c.t && c.t < z.endMs) ?? null;
    const f0 = frameAt(c.t);
    const f1 = frameAt(c.t + 500);
    // "central" is only a bound 500 ms after the click: at the click frame the camera spring is still
    // panning toward it by design, so only "inside" is checked there (the report used to carry a
    // central flag for the click frame too, which read as a failure; Tracker).
    const view = (f: any, withCentral: boolean) => {
      const [cx, cy, s] = f.cam;
      const w = es.meta.width / s;
      const h = es.meta.height / s;
      const inside = Math.abs(c.x - cx) <= w / 2 && Math.abs(c.y - cy) <= h / 2;
      const central = Math.abs(c.x - cx) <= (w / 2) * B.centralFrac && Math.abs(c.y - cy) <= (h / 2) * B.centralFrac;
      return withCentral ? { cx, cy, s, w, h, inside, central } : { cx, cy, s, w, h, inside };
    };
    return { t: c.t, x: c.x, y: c.y, seg, atClick: view(f0, false), after500: view(f1, true) as { central: boolean } & Record<string, number | boolean> };
  });
  report.zoom = zoomRows;
  save();
  for (const z of zoomRows) {
    expect(z.seg, `zoom segment covers click at ${z.t}`).not.toBeNull();
    expect(z.atClick.s, `scale at click ${z.t}`).toBeGreaterThanOrEqual(B.zoomScaleAtClick);
    expect(z.atClick.inside, `click ${z.t} in view`).toBe(true);
    expect(z.after500.central, `click ${z.t} central after 500 ms`).toBe(true);
  }
  for (const l of live) expect(l.scale, `live preview zoom ${JSON.stringify(l)}`).toBeGreaterThan(B.liveScale);

  // export from the desktop app runs in its own invocation (export.spec.ts) on this bundle: Electron,
  // the editor and x264 next to the recorder and the scene got OOM-killed on this box (runs 11-13)
  fs.writeFileSync(path.join(RUNS, "last-bundle.txt"), bundle);
});
