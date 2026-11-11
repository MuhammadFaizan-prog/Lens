import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RenderPlan } from "@lens/engine";
import { PlanRenderer } from "../render/renderer";
import { store, useEditor } from "../state/store";
import { AnnotationOverlay } from "./AnnotationOverlay";
import { CanvasOverlay, framingEditing, zoomEditFrame, zoomEditing } from "./CanvasOverlay";
import { editViewRect, framingEditPlan } from "../state/framingEdit";
import { normalizeCrop } from "@lens/engine";
import { useUi } from "../state/uiLayout";

/** Draw frame i of plan into g with the right source images (awaits decoding when needed). */
/** The plan with frame i unzoomed (and no motion blur into it): the preview while a zoom block is aimed. */
function withZoomEdit(plan: RenderPlan, i: number): RenderPlan {
  const frames = plan.frames.slice();
  frames[i] = zoomEditFrame(plan, frames[i]!);
  if (i > 0) frames[i - 1] = frames[i]!;
  return { ...plan, frames };
}

/** The custom framing edit view of frame i (fix/aspect-framing-014): the whole recording, the window drawn by the overlay. */
function withFramingEdit(plan: RenderPlan, i: number): RenderPlan {
  const s = store.get();
  const meta = s.bundle?.meta;
  if (!meta) return plan;
  const out = { width: plan.output.width, height: plan.output.height };
  return framingEditPlan(plan, i, normalizeCrop(s.project.crop, meta), editViewRect(s.project, meta, out));
}

export async function drawPlanFrame(renderer: PlanRenderer, g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, plan: RenderPlan, i: number, editPlan = false, framingPlan = false): Promise<boolean> {
  const f = plan.frames[i];
  if (!f || !store.screen) return false;
  const si = store.screen.indexAt(f.src);
  const wantCam = !!(store.cam && f.layout.camera && f.layout.cameraOpacity > 0);
  const ci = wantCam ? store.cam!.indexAt(f.src) : -1;
  let scr = store.screen.peek(si);
  let cam = wantCam ? store.cam!.peek(ci) : null;
  if (!scr || (wantCam && !cam)) {
    [scr, cam] = await Promise.all([scr ?? store.screen.load(si), wantCam ? cam ?? store.cam!.load(ci) : Promise.resolve(null)]);
  }
  // a cut transition (demand #14) also needs the images of the other side of the join
  const of = f.tr ? plan.frames[f.tr.other] : undefined;
  let other: { screen: CanvasImageSource | null; cam: CanvasImageSource | null } | null = null;
  if (of) {
    const osi = store.screen.indexAt(of.src);
    const oWantCam = !!(store.cam && of.layout.camera && of.layout.cameraOpacity > 0);
    const oci = oWantCam ? store.cam!.indexAt(of.src) : -1;
    let os = store.screen.peek(osi);
    let oc = oWantCam ? store.cam!.peek(oci) : null;
    if (!os || (oWantCam && !oc)) [os, oc] = await Promise.all([os ?? store.screen.load(osi), oWantCam ? oc ?? store.cam!.load(oci) : Promise.resolve(null)]);
    other = { screen: os ?? null, cam: oc ?? null };
  }
  renderer.draw(g, framingPlan ? withFramingEdit(plan, i) : editPlan ? withZoomEdit(plan, i) : plan, i, { screen: scr ?? null, cam: cam ?? null }, other);
  // time from page start to the first real source frame on screen (window.__lens.state().firstPaintMs)
  if (scr && store.firstPaintMs == null) store.firstPaintMs = Math.round(performance.now());
  return true;
}

export function Preview() {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const plan = useEditor((s) => s.plan);
  const w = plan?.output.width ?? 1280;
  const h = plan?.output.height ?? 720;
  const [area, setArea] = useState({ w: 0, h: 0 });

  // Fit the canvas into the free area by hand (CSS aspect tricks overflow for portrait outputs).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const zoom = useUi((s) => s.previewZoom);
  const fs = useUi((s) => s.fullscreen);
  // fit: largest size that fits the stage (keeps aspect); 100 %: one output px per device px
  const k = zoom === "100" ? 1 / (window.devicePixelRatio || 1) : area.w && area.h ? Math.min(area.w / w, area.h / h) : 0;
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setArea({ w: el.clientWidth, h: el.clientHeight });
  }, [fs, zoom]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = new PlanRenderer();
    let drawnKey = "";
    let lastError = "";
    let busy = false;
    let again = false;
    const draw = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const s = store.get();
          if (!s.plan) break;
          const ze = zoomEditing();
          const fe = framingEditing();
          const key = `${s.revision}:${s.frame}:${ze ? "z" : ""}${fe ? "f" : ""}`;
          if (key === drawnKey) break;
          // Size is owned here, never by React: assigning width clears the canvas.
          if (canvas.width !== s.plan.output.width || canvas.height !== s.plan.output.height) {
            canvas.width = s.plan.output.width;
            canvas.height = s.plan.output.height;
          }
          const g = canvas.getContext("2d")!;
          let ok = false;
          try {
            ok = await drawPlanFrame(renderer, g, s.plan, s.frame, ze, fe);
          } catch (e) {
            // e.g. 3D motion without WebGL2: say so instead of freezing on a stale frame
            const msg = e instanceof Error ? e.message : String(e);
            if (msg !== lastError) store.notify(msg);
            lastError = msg;
            canvas.dataset.error = msg;
            ok = true;
          }
          if (ok) {
            drawnKey = key;
            canvas.dataset.frame = String(s.frame);
            canvas.dataset.revision = String(s.revision);
            canvas.dataset.framingEdit = fe ? "1" : "0";
          }
          const now = store.get();
          if (`${now.revision}:${now.frame}:${zoomEditing() ? "z" : ""}${framingEditing() ? "f" : ""}` !== drawnKey) again = true;
        } while (again);
      } finally {
        busy = false;
      }
    };
    void draw();
    return store.subscribe(() => void draw());
  }, []);

  return (
    <div className={`preview ${zoom === "100" ? "zoom-100" : ""}`} ref={box} data-testid="preview-area">
      <div className="preview-stage" style={{ width: Math.floor(w * k), height: Math.floor(h * k) }}>
        <canvas ref={ref} className="preview-canvas" data-testid="preview" style={{ width: Math.floor(w * k), height: Math.floor(h * k) }} />
        {k > 0 && <AnnotationOverlay cssW={Math.floor(w * k)} cssH={Math.floor(h * k)} />}
        {k > 0 && <CanvasOverlay cssW={Math.floor(w * k)} cssH={Math.floor(h * k)} />}
      </div>
    </div>
  );
}
