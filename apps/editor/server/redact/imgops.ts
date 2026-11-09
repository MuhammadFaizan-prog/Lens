/**
 * The image operations the privacy scan and step labels need, in plain TypeScript (no OpenCV, no
 * Python): grey conversion, area resize, absdiff, bilinear translate (replicate border), phase
 * correlation (FFT), normalised cross-correlation template matching (TM_CCOEFF_NORMED), Canny,
 * erode / dilate / close, connected components, median blur. Semantics follow OpenCV's where the
 * redact pipeline depends on them; tests compare against cv2 (test/redactImgops.test.ts).
 */

export interface Gray {
  w: number;
  h: number;
  d: Uint8Array;
}
export interface FGray {
  w: number;
  h: number;
  d: Float32Array;
}

export function gray(w: number, h: number): Gray {
  return { w, h, d: new Uint8Array(w * h) };
}

/** RGB24 -> grey with OpenCV's BT.601 weights (fixed point, rounded). */
export function rgbToGray(rgb: Uint8Array, w: number, h: number): Gray {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 3) out[i] = (rgb[j]! * 4899 + rgb[j + 1]! * 9617 + rgb[j + 2]! * 1868 + 8192) >> 14;
  return { w, h, d: out };
}

/** INTER_AREA downscale by an integer factor k (box average, rounded). */
export function areaDownInt(src: Gray, k: number): Gray {
  const w = Math.floor(src.w / k);
  const h = Math.floor(src.h / k);
  const out = new Uint8Array(w * h);
  const n = k * k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < k; yy++) {
        const row = (y * k + yy) * src.w + x * k;
        for (let xx = 0; xx < k; xx++) s += src.d[row + xx]!;
      }
      out[y * w + x] = Math.round(s / n);
    }
  }
  return { w, h, d: out };
}

/** INTER_AREA resize of a float image to (w, h) with fractional pixel coverage (downscale). */
export function areaResizeF(src: FGray, w: number, h: number): FGray {
  const out = new Float32Array(w * h);
  const sx = src.w / w;
  const sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let acc = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          acc += src.d[yy * src.w + xx]! * wx * wy;
        }
      }
      out[y * w + x] = acc / (sx * sy);
    }
  }
  return { w, h, d: out };
}

/** Area resize of a grey image by a real factor (used for thumbnails / OCR scale); rounded. */
export function resizeArea(src: Gray, w: number, h: number): Gray {
  const f = areaResizeF({ w: src.w, h: src.h, d: Float32Array.from(src.d) }, w, h);
  return { w, h, d: Uint8Array.from(f.d, (v) => Math.round(v)) };
}

/** Bicubic-ish upscale for OCR (bilinear: tesseract is insensitive to the kernel at 2x). */
export function resizeLinear(src: Gray, w: number, h: number): Gray {
  const out = new Uint8Array(w * h);
  const sx = src.w / w;
  const sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(src.h - 1, Math.floor(fy));
    const y1 = Math.min(src.h - 1, y0 + 1);
    const ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(src.w - 1, Math.floor(fx));
      const x1 = Math.min(src.w - 1, x0 + 1);
      const ax = fx - x0;
      const a = src.d[y0 * src.w + x0]! * (1 - ax) + src.d[y0 * src.w + x1]! * ax;
      const b = src.d[y1 * src.w + x0]! * (1 - ax) + src.d[y1 * src.w + x1]! * ax;
      out[y * w + x] = Math.round(a * (1 - ay) + b * ay);
    }
  }
  return { w, h, d: out };
}

export function crop(src: Gray, x: number, y: number, w: number, h: number): Gray {
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) out.set(src.d.subarray((y + r) * src.w + x, (y + r) * src.w + x + w), r * w);
  return { w, h, d: out };
}

/** warpAffine translate by (dx, dy), bilinear, BORDER_REPLICATE: dst(x, y) = src(x - dx, y - dy). Returns floats. */
export function translate(src: Gray | FGray, dx: number, dy: number): Float32Array {
  const { w, h, d } = src;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let fy = y - dy;
    fy = Math.max(0, Math.min(h - 1, fy));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ay = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = x - dx;
      fx = Math.max(0, Math.min(w - 1, fx));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const ax = fx - x0;
      const a = d[y0 * w + x0]! * (1 - ax) + d[y0 * w + x1]! * ax;
      const b = d[y1 * w + x0]! * (1 - ax) + d[y1 * w + x1]! * ax;
      out[y * w + x] = a * (1 - ay) + b * ay;
    }
  }
  return out;
}

/** cv2.warpAffine of a uint8 image (rounded back to uint8). */
export function translateU8(src: Gray, dx: number, dy: number): Gray {
  const f = translate(src, dx, dy);
  return { w: src.w, h: src.h, d: Uint8Array.from(f, (v) => Math.round(v)) };
}

// ---------------------------------------------------------------- FFT / phase correlation

function fft1(re: Float64Array, im: Float64Array, inv: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, W: number, H: number, inv: boolean): void {
  const rr = new Float64Array(W);
  const ri = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    rr.set(re.subarray(y * W, y * W + W));
    ri.set(im.subarray(y * W, y * W + W));
    fft1(rr, ri, inv);
    re.set(rr, y * W);
    im.set(ri, y * W);
  }
  const cr = new Float64Array(H);
  const ci = new Float64Array(H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      cr[y] = re[y * W + x]!;
      ci[y] = im[y * W + x]!;
    }
    fft1(cr, ci, inv);
    for (let y = 0; y < H; y++) {
      re[y * W + x] = cr[y]!;
      im[y * W + x] = ci[y]!;
    }
  }
}

const pow2 = (n: number) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

export class PhaseCorrelator {
  private win: Float64Array;
  private W: number;
  private H: number;
  constructor(readonly w: number, readonly h: number) {
    this.W = pow2(w);
    this.H = pow2(h);
    // cv2.createHanningWindow
    this.win = new Float64Array(w * h);
    const wc = new Float64Array(w).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (w - 1)));
    const wr = new Float64Array(h).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (h - 1)));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.win[y * w + x] = Math.sqrt(wr[y]! * wc[x]!);
  }

  /** Windowed, zero-padded spectrum of an image (reusable for consecutive frames). */
  spectrum(img: Gray): { re: Float64Array; im: Float64Array } {
    const { W, H, w, h } = this;
    const re = new Float64Array(W * H);
    const im = new Float64Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) re[y * W + x] = img.d[y * w + x]! * this.win[y * w + x]!;
    fft2(re, im, W, H, false);
    return { re, im };
  }

  /**
   * Translation of b relative to a (content moved by (dx, dy) from a to b, the convention of
   * cv2.phaseCorrelate(a, b)) and the peak response (sum of the normalised correlation in a 5x5
   * window around the peak).
   */
  correlate(A: { re: Float64Array; im: Float64Array }, B: { re: Float64Array; im: Float64Array }): { dx: number; dy: number; resp: number } {
    const { W, H } = this;
    const n = W * H;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // conj(A) * B, normalised
      const r = A.re[i]! * B.re[i]! + A.im[i]! * B.im[i]!;
      const m = A.re[i]! * B.im[i]! - A.im[i]! * B.re[i]!;
      const mag = Math.hypot(r, m) + 1e-12;
      re[i] = r / mag;
      im[i] = m / mag;
    }
    fft2(re, im, W, H, true);
    let best = -Infinity;
    let bx = 0;
    let by = 0;
    for (let i = 0; i < n; i++) {
      if (re[i]! > best) {
        best = re[i]!;
        bx = i % W;
        by = Math.floor(i / W);
      }
    }
    // weighted centroid over 5x5 (wrapping)
    let sx = 0;
    let sy = 0;
    let s = 0;
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const v = re[((by + oy + H) % H) * W + ((bx + ox + W) % W)]! / n;
        sx += v * ox;
        sy += v * oy;
        s += v;
      }
    }
    let dx = bx + (s !== 0 ? sx / s : 0);
    let dy = by + (s !== 0 ? sy / s : 0);
    if (dx > W / 2) dx -= W;
    if (dy > H / 2) dy -= H;
    return { dx, dy, resp: s };
  }
}

// ---------------------------------------------------------------- template matching

/** Integral images of a region (sum and sum of squares), (w+1) x (h+1). */
function integrals(img: Gray, x0: number, y0: number, w: number, h: number): { s: Float64Array; q: Float64Array } {
  const s = new Float64Array((w + 1) * (h + 1));
  const q = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    const row = (y0 + y) * img.w + x0;
    for (let x = 0; x < w; x++) {
      const v = img.d[row + x]!;
      rs += v;
      rq += v * v;
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1]! + rs;
      q[(y + 1) * (w + 1) + x + 1] = q[y * (w + 1) + x + 1]! + rq;
    }
  }
  return { s, q };
}

/**
 * Best TM_CCOEFF_NORMED match of tpl inside img's region [x0, x1) x [y0, y1) (the template's
 * top-left ranges over the region minus the template size). Returns [score, x, y].
 */
export function matchTemplateBest(img: Gray, tpl: Gray, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const rw = x1 - x0;
  const rh = y1 - y0;
  const tw = tpl.w;
  const th = tpl.h;
  if (rw < tw || rh < th) return [-1, x0, y0];
  const tn = tw * th;
  let tmean = 0;
  for (let i = 0; i < tn; i++) tmean += tpl.d[i]!;
  tmean /= tn;
  const t = new Float32Array(tn);
  let tss = 0;
  for (let i = 0; i < tn; i++) {
    t[i] = tpl.d[i]! - tmean;
    tss += t[i]! * t[i]!;
  }
  const { s, q } = integrals(img, x0, y0, rw, rh);
  const W1 = rw + 1;
  let best = -2;
  let bx = x0;
  let by = y0;
  for (let y = 0; y + th <= rh; y++) {
    for (let x = 0; x + tw <= rw; x++) {
      const sum = s[(y + th) * W1 + x + tw]! - s[y * W1 + x + tw]! - s[(y + th) * W1 + x]! + s[y * W1 + x]!;
      const sq = q[(y + th) * W1 + x + tw]! - q[y * W1 + x + tw]! - q[(y + th) * W1 + x]! + q[y * W1 + x]!;
      const iv = sq - (sum * sum) / tn;
      let cross = 0;
      for (let ty = 0; ty < th; ty++) {
        const row = (y0 + y + ty) * img.w + x0 + x;
        const trow = ty * tw;
        for (let tx = 0; tx < tw; tx++) cross += t[trow + tx]! * img.d[row + tx]!;
      }
      const den = Math.sqrt(Math.max(0, iv) * tss);
      // OpenCV: a flat window against a flat template counts as a perfect match, flat vs textured as 0
      const r = den > 1e-6 ? cross / den : tss < 1e-6 && iv < 1e-6 ? 1 : 0;
      if (r > best) {
        best = r;
        bx = x0 + x;
        by = y0 + y;
      }
    }
  }
  return [Math.max(-1, Math.min(1, best)), bx, by];
}

export function stdDev(img: Gray): number {
  const n = img.d.length;
  if (!n) return 0;
  let s = 0;
  let q = 0;
  for (const v of img.d) {
    s += v;
    q += v * v;
  }
  return Math.sqrt(Math.max(0, q / n - (s / n) ** 2));
}

// ---------------------------------------------------------------- morphology / edges / labelling

/** Erode (min) or dilate (max) a 0/1 mask with a kw x kh rectangle, anchor at (kw/2, kh/2) (OpenCV default). */
export function morph(m: Uint8Array, w: number, h: number, kw: number, kh: number, op: "erode" | "dilate"): Uint8Array {
  const ax = Math.floor(kw / 2);
  const ay = Math.floor(kh / 2);
  const isErode = op === "erode";
  const tmp = new Uint8Array(w * h);
  // horizontal pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = isErode ? 1 : 0;
      for (let k = 0; k < kw; k++) {
        const xx = x + k - ax;
        if (xx < 0 || xx >= w) continue; // border: neutral (OpenCV's morphologyDefaultBorderValue)
        const p = m[y * w + xx]!;
        if (isErode ? !p : p) {
          v = isErode ? 0 : 1;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = isErode ? 1 : 0;
      for (let k = 0; k < kh; k++) {
        const yy = y + k - ay;
        if (yy < 0 || yy >= h) continue;
        const p = tmp[yy * w + x]!;
        if (isErode ? !p : p) {
          v = isErode ? 0 : 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export function close(m: Uint8Array, w: number, h: number, k: number): Uint8Array {
  return morph(morph(m, w, h, k, k, "dilate"), w, h, k, k, "erode");
}

/** Canny (3x3 Sobel, L1 gradient, hysteresis lo / hi) -> 0/1 edge mask. */
export function canny(img: Gray, lo: number, hi: number): Uint8Array {
  const { w, h, d } = img;
  const gx = new Int32Array(w * h);
  const gy = new Int32Array(w * h);
  const mag = new Int32Array(w * h);
  const at = (x: number, y: number) => d[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))]!; // replicate (OpenCV reflect101 is close enough at 1 px)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const e = at(x - 1, y + 1), f = at(x, y + 1), g = at(x + 1, y + 1);
      const sx = c + 2 * r + g - a - 2 * l - e;
      const sy = e + 2 * f + g - a - 2 * b - c;
      gx[y * w + x] = sx;
      gy[y * w + x] = sy;
      mag[y * w + x] = Math.abs(sx) + Math.abs(sy);
    }
  }
  // non-maximum suppression; 2 = strong, 1 = weak
  const st = new Uint8Array(w * h);
  const T = Math.tan(Math.PI / 8);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i]!;
      if (m <= lo) continue;
      const ax = Math.abs(gx[i]!);
      const ay = Math.abs(gy[i]!);
      let n1: number, n2: number;
      if (ay <= ax * T) {
        n1 = mag[i - 1]!;
        n2 = mag[i + 1]!;
      } else if (ay >= ax / T) {
        n1 = mag[i - w]!;
        n2 = mag[i + w]!;
      } else {
        const s = (gx[i]! ^ gy[i]!) < 0 ? -1 : 1;
        n1 = mag[i - w - s]!;
        n2 = mag[i + w + s]!;
      }
      if (m > n1 && m >= n2) st[i] = m > hi ? 2 : 1;
    }
  }
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (st[i] === 2 && !out[i]) {
      out[i] = 1;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % w;
        const py = (p - px) / w;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const qx = px + ox;
            const qy = py + oy;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
            const q = qy * w + qx;
            if (st[q] && !out[q]) {
              out[q] = 1;
              stack.push(q);
            }
          }
        }
      }
    }
  }
  return out;
}

export interface Component {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

/** 8-connected components of a 0/1 mask (background excluded). */
export function components(m: Uint8Array, w: number, h: number): Component[] {
  const lab = new Int32Array(w * h);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || lab[i]) continue;
    const id = out.length + 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    lab[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      area++;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const qx = px + ox;
          const qy = py + oy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (m[q] && !lab[q]) {
            lab[q] = id;
            stack.push(q);
          }
        }
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

/** cv2.medianBlur(ksize) for uint8 (histogram per row, reflect-101 border). */
export function medianBlur(img: Gray, k: number): Gray {
  const { w, h, d } = img;
  const r = k >> 1;
  const out = new Uint8Array(w * h);
  const refl = (v: number, n: number) => (v < 0 ? -v : v >= n ? 2 * n - 2 - v : v);
  const half = (k * k) >> 1;
  for (let y = 0; y < h; y++) {
    const hist = new Int32Array(256);
    for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) hist[d[refl(y + yy, h) * w + refl(xx, w)]!]!++;
    for (let x = 0; x < w; x++) {
      let c = 0;
      let v = 0;
      for (; v < 256; v++) {
        c += hist[v]!;
        if (c > half) break;
      }
      out[y * w + x] = v;
      if (x + 1 < w) {
        const xo = refl(x - r, w);
        const xi = refl(x + r + 1, w);
        for (let yy = -r; yy <= r; yy++) {
          const row = refl(y + yy, h) * w;
          hist[d[row + xo]!]!--;
          hist[d[row + xi]!]!++;
        }
      }
    }
  }
  return { w, h, d: out };
}

/** PGM (P5) bytes of a grey image: tesseract (leptonica) reads it directly. */
export function toPgm(img: Gray): Buffer {
  const head = Buffer.from(`P5\n${img.w} ${img.h}\n255\n`, "ascii");
  return Buffer.concat([head, Buffer.from(img.d.buffer, img.d.byteOffset, img.d.byteLength)]);
}
