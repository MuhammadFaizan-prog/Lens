import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RenderPlan } from "@lens/engine";
import { PlanRenderer } from "../render/renderer";
import { store, useEditor } from "../state/store";
import { AnnotationOverlay } from "./AnnotationOverlay";

/** Draw frame i of plan into g with the right source images (awaits decoding when needed). */
export async function drawPlanFrame(renderer: PlanRenderer, g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, plan: RenderPlan, i: number): Promise<boolean> {
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
  renderer.draw(g, plan, i, { screen: scr ?? null, cam: cam ?? null });
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
  const k = area.w && area.h ? Math.min(area.w / w, area.h / h) : 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = new PlanRenderer();
    let drawnKey = "";
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
          const key = `${s.revision}:${s.frame}`;
          if (key === drawnKey) break;
          // Size is owned here, never by React: assigning width clears the canvas.
          if (canvas.width !== s.plan.output.width || canvas.height !== s.plan.output.height) {
            canvas.width = s.plan.output.width;
            canvas.height = s.plan.output.height;
          }
          const g = canvas.getContext("2d")!;
          const ok = await drawPlanFrame(renderer, g, s.plan, s.frame);
          if (ok) {
            drawnKey = key;
            canvas.dataset.frame = String(s.frame);
            canvas.dataset.revision = String(s.revision);
          }
          const now = store.get();
          if (`${now.revision}:${now.frame}` !== drawnKey) again = true;
        } while (again);
      } finally {
        busy = false;
      }
    };
    void draw();
    return store.subscribe(() => void draw());
  }, []);

  return (
    <div className="preview" ref={box}>
      <div className="preview-stage" style={{ width: Math.floor(w * k), height: Math.floor(h * k) }}>
        <canvas ref={ref} className="preview-canvas" data-testid="preview" style={{ width: Math.floor(w * k), height: Math.floor(h * k) }} />
        {k > 0 && <AnnotationOverlay cssW={Math.floor(w * k)} cssH={Math.floor(h * k)} />}
      </div>
    </div>
  );
}
