/**
 * Parity harness page (e2e/parity.spec.ts): builds the plan for the bundle in the browser with the
 * same engine and draws chosen frames with the live renderer, so the test can compare them with
 * compositor/render.py output for the very same plan.
 */
import { videoTime, type RenderPlan } from "@lens/engine";
import { FrameStore } from "./media/frames";
import { PlanRenderer } from "./render/renderer";
import { buildPlan, fetchBundle, fetchSilences, loadCaptionFont } from "./state/bundle";
import { ensurePlanAssets, setAssetBundle } from "./render/assets";

declare global {
  interface Window {
    lensParity: { ready: Promise<void>; plan(): RenderPlan; render(i: number): Promise<string> };
  }
}

let plan: RenderPlan;
let screen: FrameStore;
let cam: FrameStore | null = null;
const renderer = new PlanRenderer();
const canvas = document.getElementById("c") as HTMLCanvasElement;

const ready = (async () => {
  const dir = new URLSearchParams(location.search).get("dir");
  const b = await fetchBundle(dir ?? undefined);
  if (b.silencesPending) b.silences = await fetchSilences(dir ?? undefined);
  await loadCaptionFont();
  plan = buildPlan(b, b.project);
  // frames from the bundle opened with ?dir= (the annotations parity run), not the default sample
  const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  setAssetBundle(q);
  await ensurePlanAssets(plan);
  screen = new FrameStore("screen", b.screen.frames, b.screen.fps, q, 24, true);
  cam = b.camera && b.project.camera.enabled ? new FrameStore("cam", b.camera.frames, b.camera.fps, q, 24, true) : null;
  canvas.width = plan.output.width;
  canvas.height = plan.output.height;
})();

window.lensParity = {
  ready,
  plan: () => plan,
  async render(i: number) {
    await ready;
    const f = plan.frames[i]!;
    const [s, c] = await Promise.all([screen.load(screen.indexAt(videoTime(f))), cam ? cam.load(cam.indexAt(f.src)) : Promise.resolve(null)]);
    const g = canvas.getContext("2d")!;
    renderer.draw(g, plan, i, { screen: s, cam: c });
    return canvas.toDataURL("image/png");
  },
};
