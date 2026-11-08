/**
 * Lens cursor art (original vector design, same polygons as render.py cursor_sprite) drawn at 256 px
 * with its soft drop shadow, cached per shape. Hotspot is a fraction of the sprite size.
 */
import { makeCanvas, type AnyCanvas } from "./canvas";
export interface Sprite {
  canvas: AnyCanvas;
  hot: [number, number];
}

const PX = 256;
const cache = new Map<string, Sprite>();

const ARROW: Array<[number, number]> = [[0.12, 0.06], [0.12, 0.8], [0.3, 0.64], [0.42, 0.92], [0.54, 0.87], [0.42, 0.6], [0.66, 0.6]];
const POINTER: Array<[number, number]> = [[0.4, 0.08], [0.52, 0.08], [0.52, 0.45], [0.78, 0.5], [0.8, 0.8], [0.6, 0.95], [0.4, 0.95], [0.25, 0.7], [0.3, 0.55], [0.4, 0.58]];

function poly(g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, pts: Array<[number, number]>, color: string): void {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x * PX, y * PX) : g.moveTo(x * PX, y * PX)));
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

function shrink(pts: Array<[number, number]>, k: number, shift: [number, number] = [0, 0]): Array<[number, number]> {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [(x - cx) * k + cx + shift[0], (y - cy) * k + cy + shift[1]]);
}

export function cursorSprite(shape: string): Sprite {
  const key = shape === "text" || shape === "pointer" ? shape : "arrow";
  const hit = cache.get(key);
  if (hit) return hit;
  const art = makeCanvas(PX, PX);
  const g = art.getContext("2d") as OffscreenCanvasRenderingContext2D;
  let hot: [number, number];
  if (key === "text") {
    // render.py draws at 4x (S = 1024): bar half-width int(S*0.06) = 61, inclusive pixel rects
    const S = PX * 4;
    const w = Math.trunc(S * 0.06);
    const cx = S / 2;
    g.fillStyle = "#ffffff";
    g.fillRect((cx - w) / 4, Math.trunc(S * 0.1) / 4, (2 * w + 1) / 4, (Math.trunc(S * 0.9) - Math.trunc(S * 0.1) + 1) / 4);
    const w2 = Math.trunc(w / 2);
    g.fillStyle = "rgb(20,20,20)";
    g.fillRect((cx - w2) / 4, Math.trunc(S * 0.12) / 4, (2 * w2 + 1) / 4, (Math.trunc(S * 0.88) - Math.trunc(S * 0.12) + 1) / 4);
    hot = [0.5, 0.5];
  } else if (key === "pointer") {
    poly(g, POINTER, "#ffffff");
    poly(g, shrink(POINTER, 0.82), "rgb(24,24,24)");
    hot = [0.46, 0.08];
  } else {
    poly(g, ARROW, "#ffffff");
    poly(g, shrink(ARROW, 0.8, [-0.012, 0]), "rgb(18,18,18)");
    hot = [0.12, 0.06];
  }
  // soft shadow: Gaussian sigma = 3% of the sprite, offset (1%, 2%), 45% black, under the art
  const out = makeCanvas(PX, PX);
  const og = out.getContext("2d") as OffscreenCanvasRenderingContext2D;
  og.shadowColor = "rgba(0,0,0,0.45)";
  og.shadowBlur = PX * 0.03 * 2;
  og.shadowOffsetX = Math.trunc(PX * 0.01);
  og.shadowOffsetY = Math.trunc(PX * 0.02);
  og.drawImage(art as CanvasImageSource, 0, 0);
  const sprite = { canvas: out, hot };
  cache.set(key, sprite);
  return sprite;
}
