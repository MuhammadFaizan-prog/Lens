/**
 * Plan assets for the preview (demand #9): theme / brand fonts and logo images.
 *
 * Fonts: every family in plan.fonts is registered as a FontFace named "Lens <family>" from the
 * same TTF the reference compositor opens (dev server /api/font/file), so text metrics match.
 * Images: loaded once per path; drawn through `imageAt(path, w, h)`, which area-averages the
 * premultiplied image to exactly w x h like the compositor's cv2.INTER_AREA (no browser resampler
 * in between), so watermark and card logos are at pixel parity.
 */
import type { FontFiles, RenderPlan } from "@lens/engine";
import { makeCanvas, type AnyCanvas } from "./canvas";

export const DEFAULT_FONT_FAMILY = "DejaVu Sans";

/** CSS family name the preview registers a plan font under. */
export function fontCss(family: string | undefined, fallback: string): string {
  return family && family !== DEFAULT_FONT_FAMILY ? `"Lens ${family}", ${fallback}` : fallback;
}

let dirQuery = "";
/** The bundle (?dir=) relative asset paths resolve against. */
export function setAssetBundle(q: string): void {
  dirQuery = q;
}

export function assetUrl(path: string): string {
  const sep = dirQuery ? "&" : "?";
  return `/api/asset${dirQuery}${sep}path=${encodeURIComponent(path)}`;
}

export function fontUrl(ref: string): string {
  const sep = dirQuery ? "&" : "?";
  return `/api/font/file${dirQuery}${sep}ref=${encodeURIComponent(ref)}`;
}

/** The page's FontFaceSet, or the worker's (exports render in a worker, Windows bug #11). */
export function fontSet(): FontFaceSet {
  return ((globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? document.fonts) as FontFaceSet;
}

const fonts = new Map<string, Promise<boolean>>();

/** Register a font family as "Lens <family>" (both weights); resolves false when a file did not load. */
export function loadFont(f: FontFiles): Promise<boolean> {
  const key = `${f.family}|${f.regular}|${f.bold}`;
  let p = fonts.get(key);
  if (!p) {
    p = (async () => {
      try {
        const name = `Lens ${f.family}`;
        const [r, b] = await Promise.all([new FontFace(name, `url(${fontUrl(f.regular)})`, { weight: "normal" }).load(), new FontFace(name, `url(${fontUrl(f.bold)})`, { weight: "bold" }).load()]);
        fontSet().add(r);
        fontSet().add(b);
        return true;
      } catch {
        return false;
      }
    })();
    fonts.set(key, p);
  }
  return p;
}

/**
 * Families of `plan` that are not usable: listed in plan.fonts but a file failed to load, or named by
 * the caption style without any files (an unknown family). The export refuses to start on any of
 * these instead of silently drawing the fallback font (the preview shows them as a warning).
 */
export async function missingPlanFonts(plan: RenderPlan): Promise<string[]> {
  const fs = (plan.fonts ?? []).filter((f) => f.family !== DEFAULT_FONT_FAMILY);
  const ok = await Promise.all(fs.map(loadFont));
  const bad = fs.filter((_, i) => !ok[i]).map((f) => f.family);
  const cap = (plan.style.captions as { font?: string }).font;
  if (cap && cap !== DEFAULT_FONT_FAMILY && !fs.some((f) => f.family === cap)) bad.push(cap);
  return [...new Set(bad)];
}

const images = new Map<string, Promise<ImageBitmap | null>>();
const ready = new Map<string, ImageBitmap>();

function loadImage(path: string): Promise<ImageBitmap | null> {
  const key = `${dirQuery}|${path}`;
  let p = images.get(key);
  if (!p) {
    p = fetch(assetUrl(path))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => createImageBitmap(b, { premultiplyAlpha: "none", colorSpaceConversion: "none" }))
      .then((bm) => {
        ready.set(key, bm);
        return bm;
      })
      .catch(() => null);
    images.set(key, p);
  }
  return p;
}

/** Image paths a plan draws (watermark, card logos). */
export function planImages(plan: RenderPlan): string[] {
  const out = new Set<string>();
  if (plan.watermark) out.add(plan.watermark.path);
  const bg = plan.style.background;
  if (bg.kind === "image" && bg.imagePath && !bg.imagePath.startsWith("builtin:")) out.add(bg.imagePath);
  for (const f of plan.frames) if (f.slide) for (const o of f.slide.ops) if (o.op === "image") out.add(o.path);
  return [...out];
}

/** Load every font and image `plan` uses; resolves true when something new became available. */
export async function ensurePlanAssets(plan: RenderPlan): Promise<boolean> {
  const fs = (plan.fonts ?? []).filter((f) => f.family !== DEFAULT_FONT_FAMILY);
  const before = fs.filter((f) => fonts.has(`${f.family}|${f.regular}|${f.bold}`)).length + planImages(plan).filter((p) => ready.has(`${dirQuery}|${p}`)).length;
  await Promise.all([...fs.map(loadFont), ...planImages(plan).map(loadImage)]);
  const after = fs.length + planImages(plan).filter((p) => ready.has(`${dirQuery}|${p}`)).length;
  return after > before;
}

const scaled = new Map<string, AnyCanvas>();

/**
 * The image at `path` resampled to w x h (canvas), or null while it loads. Shrinking area-averages
 * premultiplied pixels (cv2.INTER_AREA); enlarging falls back to the browser's smoothing.
 */
export function imageAt(path: string, w: number, h: number): AnyCanvas | null {
  const bm = ready.get(`${dirQuery}|${path}`);
  if (!bm) {
    void loadImage(path);
    return null;
  }
  const key = `${dirQuery}|${path}|${w}x${h}`;
  const hit = scaled.get(key);
  if (hit) return hit;
  const out = makeCanvas(w, h);
  const og = out.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  const iw = bm.width;
  const ih = bm.height;
  if (w > iw || h > ih) {
    og.imageSmoothingEnabled = true;
    og.imageSmoothingQuality = "high";
    og.drawImage(bm, 0, 0, w, h);
  } else {
    const src = makeCanvas(iw, ih);
    const sg = src.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    sg.drawImage(bm, 0, 0);
    const d = sg.getImageData(0, 0, iw, ih).data;
    // premultiplied float RGBA
    const pre = new Float32Array(iw * ih * 4);
    for (let i = 0; i < iw * ih; i++) {
      const a = d[i * 4 + 3]! / 255;
      pre[i * 4] = d[i * 4]! * a;
      pre[i * 4 + 1] = d[i * 4 + 1]! * a;
      pre[i * 4 + 2] = d[i * 4 + 2]! * a;
      pre[i * 4 + 3] = d[i * 4 + 3]!;
    }
    const weights = (n: number, m: number) => {
      // for each output index: list of [source index, weight] covering [o * s, (o + 1) * s)
      const s = n / m;
      const out: Array<Array<[number, number]>> = [];
      for (let o = 0; o < m; o++) {
        const a = o * s;
        const b = (o + 1) * s;
        const ws: Array<[number, number]> = [];
        for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i++) {
          const cov = Math.min(b, i + 1) - Math.max(a, i);
          if (cov > 1e-9) ws.push([i, cov / s]);
        }
        out.push(ws);
      }
      return out;
    };
    const wx = weights(iw, w);
    const wy = weights(ih, h);
    const tmp = new Float32Array(w * ih * 4);
    for (let y = 0; y < ih; y++)
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const [i, k] of wx[x]!) {
          const o = (y * iw + i) * 4;
          r += pre[o]! * k;
          g += pre[o + 1]! * k;
          b += pre[o + 2]! * k;
          a += pre[o + 3]! * k;
        }
        const o = (y * w + x) * 4;
        tmp[o] = r;
        tmp[o + 1] = g;
        tmp[o + 2] = b;
        tmp[o + 3] = a;
      }
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const [j, k] of wy[y]!) {
          const o = (j * w + x) * 4;
          r += tmp[o]! * k;
          g += tmp[o + 1]! * k;
          b += tmp[o + 2]! * k;
          a += tmp[o + 3]! * k;
        }
        const o = (y * w + x) * 4;
        const al = a / 255;
        img.data[o] = al > 0 ? Math.round(r / al) : 0;
        img.data[o + 1] = al > 0 ? Math.round(g / al) : 0;
        img.data[o + 2] = al > 0 ? Math.round(b / al) : 0;
        img.data[o + 3] = Math.round(a);
      }
    og.putImageData(img, 0, 0);
  }
  scaled.set(key, out);
  return out;
}

/** Width / height of a loaded image, or null while it loads (starts loading it). */
export function imageAspect(path: string): number | null {
  const bm = ready.get(`${dirQuery}|${path}`);
  if (!bm) {
    void loadImage(path);
    return null;
  }
  return bm.width / Math.max(1, bm.height);
}
