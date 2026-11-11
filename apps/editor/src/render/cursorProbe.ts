/**
 * Test hook (demand #12 e2e): the cursor art of one type, drawn alone over a flat colour exactly where
 * the renderer puts the cursor's hotspot on output frame n, in a box of 2 x the cursor size centred on
 * the hotspot (the same box for every type, so the export's crop can be matched against each).
 */
import type { RenderPlan } from "@lens/engine";
import { makeCanvas } from "./canvas";
import { cursorSprite } from "./cursorSprite";
import { cardRect, pyRound, viewMapOf } from "./renderer";

export function cursorTemplate(plan: RenderPlan, n: number, shape: string, bg: [number, number, number]): { x0: number; y0: number; w: number; h: number; size: number; rgb: Uint8Array } | null {
  const f = plan.frames[n];
  if (!f || !f.cur) return null;
  const map = viewMapOf(plan, f);
  const [sx, sy] = cardRect(f);
  const size = Math.max(6, pyRound(26 * plan.style.cursorSize * (plan.source.pixelRatio || 1) * map.k * f.cur[3]));
  const hx = sx + (f.cur[0] - map.x0) * map.k;
  const hy = sy + (f.cur[1] - map.y0) * map.ky;
  const x0 = Math.floor(hx - size);
  const y0 = Math.floor(hy - size);
  const w = 2 * size;
  const h = 2 * size;
  const c = makeCanvas(w, h);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  const spr = cursorSprite(shape, plan.style.cursorTheme === "light" ? "light" : "classic");
  g.drawImage(spr.canvas as CanvasImageSource, hx - spr.hot[0] * size - x0, hy - spr.hot[1] * size - y0, size, size);
  const d = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    rgb[j] = d[i]!;
    rgb[j + 1] = d[i + 1]!;
    rgb[j + 2] = d[i + 2]!;
  }
  return { x0, y0, w, h, size, rgb };
}
