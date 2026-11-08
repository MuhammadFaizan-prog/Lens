/**
 * Parity harness page (e2e/parity.spec.ts): builds the plan for the bundle in the browser with the
 * same engine and draws chosen frames with the live renderer, so the test can compare them with
 * compositor/render.py output for the very same plan.
 */
import type { RenderPlan } from "@lens/engine";
import { FrameStore } from "./media/frames";
import { PlanRenderer } from "./render/renderer";
import { buildPlan, fetchBundle, loadCaptionFont } from "./state/bundle";

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
  const b = await fetchBundle(new URLSearchParams(location.search).get("dir") ?? undefined);
  await loadCaptionFont();
  plan = buildPlan(b, b.project);
  screen = new FrameStore("screen", b.screen.frames, b.screen.fps);
  cam = b.camera && b.project.camera.enabled ? new FrameStore("cam", b.camera.frames, b.camera.fps) : null;
  canvas.width = plan.output.width;
  canvas.height = plan.output.height;
})();

window.lensParity = {
  ready,
  plan: () => plan,
  async render(i: number) {
    await ready;
    const f = plan.frames[i]!;
    const [s, c] = await Promise.all([screen.load(screen.indexAt(f.src)), cam ? cam.load(cam.indexAt(f.src)) : Promise.resolve(null)]);
    const g = canvas.getContext("2d")!;
    renderer.draw(g, plan, i, { screen: s, cam: c });
    return canvas.toDataURL("image/png");
  },
};
