/**
 * Lens cursor art (original vector design, same geometry as render.py cursor_sprite) drawn at 256 px
 * with its soft drop shadow, cached per shape and theme. Hotspot is a fraction of the sprite size.
 *
 * Arrow, hand and I-beam are the original sprites (byte-identical for the classic theme). Demand #12
 * added the other UI cursor types (grab / grabbing, crosshair, resize in four directions, move, busy,
 * not allowed) as outline + fill primitives, and a "light" theme that swaps outline and fill colours.
 */
import { makeCanvas, type AnyCanvas } from "./canvas";
export interface Sprite {
  canvas: AnyCanvas;
  hot: [number, number];
}

const PX = 256;
const cache = new Map<string, Sprite>();

type Pt = [number, number];
const ARROW: Pt[] = [[0.12, 0.06], [0.12, 0.8], [0.3, 0.64], [0.42, 0.92], [0.54, 0.87], [0.42, 0.6], [0.66, 0.6]];
const POINTER: Pt[] = [[0.4, 0.08], [0.52, 0.08], [0.52, 0.45], [0.78, 0.5], [0.8, 0.8], [0.6, 0.95], [0.4, 0.95], [0.25, 0.7], [0.3, 0.55], [0.4, 0.58]];

/** Outline + fill primitives of the demand #12 shapes (unit square). Kept in step with render.py SHAPE_PRIMS. */
export type Prim = { poly: Pt[] } | { ring: [number, number, number, number] } | { capsule: [number, number, number, number, number] };

/** Outline width each side (unit). */
export const OUTLINE = 0.045;

const DOUBLE_ARROW: Pt[] = [[0.1, 0.5], [0.3, 0.32], [0.3, 0.44], [0.7, 0.44], [0.7, 0.32], [0.9, 0.5], [0.7, 0.68], [0.7, 0.56], [0.3, 0.56], [0.3, 0.68]];
const rot = (pts: Pt[], deg: number): Pt[] => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return pts.map(([x, y]) => [0.5 + (x - 0.5) * c - (y - 0.5) * s, 0.5 + (x - 0.5) * s + (y - 0.5) * c]);
};
const scaleAbout = (pts: Pt[], k: number): Pt[] => pts.map(([x, y]) => [0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k]);
const PALM: Pt[] = [[0.27, 0.48], [0.73, 0.48], [0.75, 0.72], [0.63, 0.9], [0.37, 0.9], [0.25, 0.72]];
const FINGER_X = [0.33, 0.45, 0.57, 0.68];

export const SHAPE_PRIMS: Record<string, { prims: Prim[]; hot: Pt }> = {
  "resize-ew": { prims: [{ poly: DOUBLE_ARROW }], hot: [0.5, 0.5] },
  "resize-ns": { prims: [{ poly: rot(DOUBLE_ARROW, 90) }], hot: [0.5, 0.5] },
  "resize-nwse": { prims: [{ poly: rot(DOUBLE_ARROW, 45) }], hot: [0.5, 0.5] },
  "resize-nesw": { prims: [{ poly: rot(DOUBLE_ARROW, -45) }], hot: [0.5, 0.5] },
  move: { prims: [{ poly: scaleAbout(DOUBLE_ARROW, 0.95) }, { poly: rot(scaleAbout(DOUBLE_ARROW, 0.95), 90) }, { poly: [[0.37, 0.37], [0.63, 0.37], [0.63, 0.63], [0.37, 0.63]] }], hot: [0.5, 0.5] },
  crosshair: {
    prims: [{ capsule: [0.5, 0.1, 0.5, 0.38, 0.07] }, { capsule: [0.5, 0.62, 0.5, 0.9, 0.07] }, { capsule: [0.1, 0.5, 0.38, 0.5, 0.07] }, { capsule: [0.62, 0.5, 0.9, 0.5, 0.07] }],
    hot: [0.5, 0.5],
  },
  wait: { prims: [{ poly: [[0.28, 0.1], [0.72, 0.1], [0.72, 0.2], [0.55, 0.5], [0.72, 0.8], [0.72, 0.9], [0.28, 0.9], [0.28, 0.8], [0.45, 0.5], [0.28, 0.2]] }], hot: [0.5, 0.5] },
  "not-allowed": { prims: [{ ring: [0.5, 0.5, 0.3, 0.09] }, { capsule: [0.29, 0.71, 0.71, 0.29, 0.09] }], hot: [0.5, 0.5] },
  grab: {
    prims: [{ poly: PALM }, ...FINGER_X.map((x, i): Prim => ({ capsule: [x, 0.52, x, [0.24, 0.16, 0.18, 0.28][i]!, 0.1] })), { capsule: [0.28, 0.66, 0.15, 0.48, 0.1] }],
    hot: [0.5, 0.45],
  },
  grabbing: {
    prims: [{ poly: PALM }, ...FINGER_X.map((x, i): Prim => ({ capsule: [x, 0.52, x, [0.42, 0.39, 0.4, 0.44][i]!, 0.1] })), { capsule: [0.28, 0.66, 0.22, 0.54, 0.1] }],
    hot: [0.5, 0.5],
  },
};

type G = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function poly(g: G, pts: Pt[], color: string): void {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x * PX, y * PX) : g.moveTo(x * PX, y * PX)));
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

function shrink(pts: Pt[], k: number, shift: Pt = [0, 0]): Pt[] {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [(x - cx) * k + cx + shift[0], (y - cy) * k + cy + shift[1]]);
}

/** One pass of primitives: grow = extra half-width (outline pass) or 0 (fill pass). */
function prims(g: G, list: Prim[], color: string, grow: number): void {
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineJoin = "round";
  g.lineCap = "round";
  for (const p of list) {
    g.beginPath();
    if ("poly" in p) {
      p.poly.forEach(([x, y], i) => (i ? g.lineTo(x * PX, y * PX) : g.moveTo(x * PX, y * PX)));
      g.closePath();
      g.fill();
      if (grow > 0) {
        g.lineWidth = 2 * grow * PX;
        g.stroke();
      }
    } else if ("ring" in p) {
      const [cx, cy, r, w] = p.ring;
      g.arc(cx * PX, cy * PX, r * PX, 0, Math.PI * 2);
      g.lineWidth = (w + 2 * grow) * PX;
      g.stroke();
    } else {
      const [x1, y1, x2, y2, w] = p.capsule;
      g.moveTo(x1 * PX, y1 * PX);
      g.lineTo(x2 * PX, y2 * PX);
      g.lineWidth = (w + 2 * grow) * PX;
      g.stroke();
    }
  }
}

export type CursorTheme = "classic" | "light";

/** Every shape Lens has art for (others fall back to the arrow). */
export const SPRITE_SHAPES = ["arrow", "pointer", "text", ...Object.keys(SHAPE_PRIMS)];

export function cursorSprite(shape: string, theme: CursorTheme = "classic"): Sprite {
  const key = shape === "text" || shape === "pointer" || shape in SHAPE_PRIMS ? shape : "arrow";
  const ck = theme === "light" ? `${key}:light` : key;
  const hit = cache.get(ck);
  if (hit) return hit;
  const light = theme === "light";
  const art = makeCanvas(PX, PX);
  const g = art.getContext("2d") as OffscreenCanvasRenderingContext2D;
  let hot: [number, number];
  if (key === "text") {
    // render.py draws at 4x (S = 1024): bar half-width int(S*0.06) = 61, inclusive pixel rects
    const S = PX * 4;
    const w = Math.trunc(S * 0.06);
    const cx = S / 2;
    g.fillStyle = light ? "rgb(20,20,20)" : "#ffffff";
    g.fillRect((cx - w) / 4, Math.trunc(S * 0.1) / 4, (2 * w + 1) / 4, (Math.trunc(S * 0.9) - Math.trunc(S * 0.1) + 1) / 4);
    const w2 = Math.trunc(w / 2);
    g.fillStyle = light ? "#ffffff" : "rgb(20,20,20)";
    g.fillRect((cx - w2) / 4, Math.trunc(S * 0.12) / 4, (2 * w2 + 1) / 4, (Math.trunc(S * 0.88) - Math.trunc(S * 0.12) + 1) / 4);
    hot = [0.5, 0.5];
  } else if (key === "pointer") {
    poly(g, POINTER, light ? "rgb(24,24,24)" : "#ffffff");
    poly(g, shrink(POINTER, 0.82), light ? "#ffffff" : "rgb(24,24,24)");
    hot = [0.46, 0.08];
  } else if (key === "arrow") {
    poly(g, ARROW, light ? "rgb(18,18,18)" : "#ffffff");
    poly(g, shrink(ARROW, 0.8, [-0.012, 0]), light ? "#ffffff" : "rgb(18,18,18)");
    hot = [0.12, 0.06];
  } else {
    const def = SHAPE_PRIMS[key]!;
    prims(g, def.prims, light ? "rgb(18,18,18)" : "#ffffff", OUTLINE);
    prims(g, def.prims, light ? "#ffffff" : "rgb(18,18,18)", 0);
    hot = [def.hot[0], def.hot[1]];
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
  cache.set(ck, sprite);
  return sprite;
}
