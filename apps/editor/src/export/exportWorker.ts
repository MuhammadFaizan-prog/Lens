/**
 * Export renderer off the UI thread (Windows bug #11): draws every plan frame with the preview's
 * renderer into an OffscreenCanvas, encodes JPEG and streams it to the server's ffmpeg, reporting
 * progress; a "cancel" message stops it between frames. Same renderer and plan as the preview, so
 * preview == export still holds.
 */
import { videoTime, withFontFallback, type RenderPlan } from "@lens/engine";
import { CAPTION_FONT, PlanRenderer } from "../render/renderer";
import { ensurePlanAssets, fontSet, missingPlanFonts, setAssetBundle } from "../render/assets";
import { FrameStore } from "../media/frames";

export interface StartMsg {
  type: "start";
  id: string;
  plan: RenderPlan;
  query: string;
  screen: { count: number; fps: number };
  cam: { count: number; fps: number } | null;
  /** NLE hand-off (demand #11): draw only the overlay layer on transparent and post PNGs (no source frames needed). */
  overlay?: boolean;
}
export type FromWorker =
  | { type: "progress"; done: number; total: number }
  | { type: "rendered"; total: number }
  | { type: "error"; error: string; done: number }
  | { type: "cancelled"; done: number };

let cancelled = false;
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

async function loadCaptionFonts(): Promise<void> {
  try {
    const b = new FontFace(CAPTION_FONT, "url(/api/font/caption.ttf)", { weight: "bold" });
    const r = new FontFace(CAPTION_FONT, "url(/api/font/caption-regular.ttf)", { weight: "normal" });
    const [bb, rr] = await Promise.all([b.load(), r.load()]);
    fontSet().add(bb);
    fontSet().add(rr);
  } catch {
    // the system fallback stack draws instead (same as the preview without the font)
  }
}

async function run(m: StartMsg): Promise<void> {
  const { plan: plan0, id, query } = m;
  const total = plan0.frames.length;
  let i = 0;
  try {
    setAssetBundle(query);
    await loadCaptionFonts();
    await ensurePlanAssets(plan0);
    // a caption / theme font that did not load is drawn in the default font, as the preview draws it
    // (Windows v0.1.3: missing fonts fall back with a warning instead of stopping the export)
    const plan = withFontFallback(plan0, await missingPlanFonts(plan0));
    const renderer = new PlanRenderer();
    const canvas = new OffscreenCanvas(plan.output.width, plan.output.height);
    const g = canvas.getContext("2d")!;
    const sep = query ? "&" : "?";
    const scr = new FrameStore("screen", m.screen.count, m.screen.fps, query, 6, true);
    const cam = m.cam ? new FrameStore("cam", m.cam.count, m.cam.fps, query, 6, true) : null;
    for (i = 0; i < total; i++) {
      if (cancelled) return post({ type: "cancelled", done: i });
      const f = plan.frames[i]!;
      if (m.overlay) {
        renderer.draw(g, plan, i, { screen: null, cam: null }, null, { overlay: true });
      } else {
        const si = scr.indexAt(videoTime(f));
        const ci = cam ? cam.indexAt(f.src) : 0;
        // the next frames' bytes download while this one draws
        scr.prefetch([si + 1, si + 2, si + 3], 1);
        const [s, c] = await Promise.all([scr.load(si), cam ? cam.load(ci) : Promise.resolve(null)]);
        // cut transition (demand #14): the other side of the join, held still, composited with this frame
        const of = f.tr ? plan.frames[f.tr.other] : undefined;
        let other: { screen: CanvasImageSource | null; cam: CanvasImageSource | null } | null = null;
        let low = si;
        let lowCam = ci;
        if (of) {
          const osi = scr.indexAt(videoTime(of));
          const oci = cam ? cam.indexAt(of.src) : 0;
          const [os, oc] = await Promise.all([scr.load(osi), cam ? cam.load(oci) : Promise.resolve(null)]);
          other = { screen: os, cam: oc };
          low = Math.min(si, osi);
          lowCam = Math.min(ci, oci);
        }
        renderer.draw(g, plan, i, { screen: s, cam: c }, other);
        scr.releaseBelow(low);
        cam?.releaseBelow(lowCam);
      }
      const blob = m.overlay ? await canvas.convertToBlob({ type: "image/png" }) : await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
      if (cancelled) return post({ type: "cancelled", done: i });
      const r = await fetch(`/api/export-browser/${id}/frame${query}${sep}i=${i}`, { method: "POST", body: blob });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return post({ type: "error", error: (j as { error?: string }).error ?? `frame ${i} failed`, done: i });
      }
      if (i % 3 === 0 || i === total - 1) post({ type: "progress", done: i + 1, total });
    }
    await fetch(`/api/export-browser/${id}/finish${query}`, { method: "POST" });
    post({ type: "rendered", total });
  } catch (e) {
    post({ type: "error", error: e instanceof Error ? e.message : String(e), done: i });
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as StartMsg | { type: "cancel" };
  if (m.type === "cancel") cancelled = true;
  else if (m.type === "start") void run(m);
};
