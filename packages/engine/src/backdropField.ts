/**
 * Lens's procedural backdrop "fields" (v0.1.4): the newer built-in backdrops are pure per-pixel
 * functions of (x, y), a seed and a palette, evaluated at the output size. So they ship as code (no
 * image files), are deterministic, render crisply at any size up to 4K (nothing is upscaled), and the
 * preview, the in-app export and the picker thumbnails all come from this one function. The Python
 * compositor has a line-by-line twin (compositor/lens_compositor/backdrop_field.py) with the same
 * integer hash, value noise and seeded random sequence, so the reference render matches too.
 * Original designs; no third-party wallpapers or assets.
 *
 * Coordinates: X = (x + 0.5) / S, Y = (y + 0.5) / S with S = max(W, H), so X in [0, A], Y in [0, B].
 * Shapes and noise are sized in those units (resolution independent); line widths are at least one
 * output pixel and anti-aliased against the pixel size.
 */
import type { Backdrop } from "./backdropArt.js";

export const FIELD_STYLES = ["mesh", "aurora", "blur", "bokeh", "lowpoly", "grid", "iso", "grain2", "topo", "silk", "burst", "spot", "synth", "dunes", "mountains", "sky"] as const;
export type FieldStyle = (typeof FIELD_STYLES)[number];

export function isFieldStyle(style: string): style is FieldStyle {
  return (FIELD_STYLES as readonly string[]).includes(style);
}

/** mulberry32: same sequence as the editor's backdrops.ts rng() and backdrop_art.py mulberry32(). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash to [0, 1) (uint32 arithmetic, identical in numpy). */
export function hash3(ix: number, iy: number, s: number): number {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Smooth value noise in [0, 1). */
export function vnoise(x: number, y: number, s: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash3(ix, iy, s);
  const b = hash3(ix + 1, iy, s);
  const c = hash3(ix, iy + 1, s);
  const d = hash3(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export function fbm(x: number, y: number, s: number, oct: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x, y, s + i * 101);
    norm += amp;
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 9.2;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Ridged noise (sharp crests) in [0, 1]. */
function ridged(x: number, y: number, s: number, oct: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(2 * vnoise(x, y, s + i * 101) - 1);
    sum += amp * n * n;
    norm += amp;
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 9.2;
    amp *= 0.5;
  }
  return sum / norm;
}

type RGB = [number, number, number];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v: number) => v - Math.floor(v);
const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
function ramp(t: number, cs: RGB[], o: Float64Array): void {
  if (cs.length === 1) {
    o[0] = cs[0]![0];
    o[1] = cs[0]![1];
    o[2] = cs[0]![2];
    return;
  }
  t = clamp01(t);
  const f = t * (cs.length - 1);
  const i = Math.min(Math.floor(f), cs.length - 2);
  const k = f - i;
  const a = cs[i]!;
  const b = cs[i + 1]!;
  o[0] = a[0] + (b[0] - a[0]) * k;
  o[1] = a[1] + (b[1] - a[1]) * k;
  o[2] = a[2] + (b[2] - a[2]) * k;
}
function lerpTo(o: Float64Array, a: RGB, b: RGB, t: number): void {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
}
function mix(o: Float64Array, c: RGB | Float64Array, a: number): void {
  o[0] = o[0]! + (c[0]! - o[0]!) * a;
  o[1] = o[1]! + (c[1]! - o[1]!) * a;
  o[2] = o[2]! + (c[2]! - o[2]!) * a;
}

/** A style's per-pixel shader: X, Y in S units, x, y integer pixel, o = output rgb (0..255). */
type Shader = (X: number, Y: number, x: number, y: number, o: Float64Array) => void;
interface Field {
  shade: Shader;
  /** dither / grain amplitude in 8-bit levels */
  dither: number;
  /** grain cell size in pixels (1 = per pixel dither) */
  cell?: number;
}

const TAU = Math.PI * 2;

function build(b: Backdrop, W: number, H: number): Field {
  const S = Math.max(W, H);
  const A = W / S;
  const B = H / S;
  const r = mulberry32(b.seed);
  const sd = b.seed;
  const C = b.colors.map(rgb);
  const n = C.length;
  const v = b.variant ?? 0;
  const px = 1 / S;
  const lineW = Math.max(1, S / 1080);
  const tmp = new Float64Array(3);
  switch (b.style as FieldStyle) {
    case "mesh": {
      const pts: Array<[number, number]> = [];
      for (let k = 0; k < n; k++) pts.push([r() * A, r() * B]);
      return {
        dither: 1.5,
        shade: (X, Y, _x, _y, o) => {
          const wx = X + 0.18 * (fbm(X * 2.2, Y * 2.2, sd, 3) - 0.5);
          const wy = Y + 0.18 * (fbm(X * 2.2 + 17.3, Y * 2.2 + 5.1, sd + 500, 3) - 0.5);
          let sw = 0;
          let r0 = 0;
          let g0 = 0;
          let b0 = 0;
          for (let k = 0; k < n; k++) {
            const dx = wx - pts[k]![0];
            const dy = wy - pts[k]![1];
            const w = Math.exp(-(dx * dx + dy * dy) / 0.045) + 1e-9;
            sw += w;
            r0 += w * C[k]![0];
            g0 += w * C[k]![1];
            b0 += w * C[k]![2];
          }
          o[0] = r0 / sw;
          o[1] = g0 / sw;
          o[2] = b0 / sw;
        },
      };
    }
    case "aurora": {
      const cur: Array<{ y0: number; amp: number; fr: number; ph: number; col: RGB }> = [];
      for (let k = 0; k < 3; k++) {
        const y0 = B * (0.28 + 0.14 * k + (r() - 0.5) * 0.08);
        const amp = 0.05 + r() * 0.07;
        const fr = (0.6 + r() * 0.8) * TAU;
        const ph = r() * TAU;
        cur.push({ y0, amp, fr, ph, col: C[2 + (k % (n - 2))]! });
      }
      const sr = Math.max(0.0008, 0.6 * px);
      // the curtains' line, rays and brightness depend on X only: one evaluation per column
      const yc = new Float64Array(W * 3);
      const sh = new Float64Array(W * 3);
      for (let x = 0; x < W; x++) {
        const X = (x + 0.5) / S;
        for (let k = 0; k < 3; k++) {
          const c = cur[k]!;
          yc[x * 3 + k] = c.y0 + c.amp * Math.sin(X * c.fr + c.ph) + 0.18 * (fbm(X * 1.6, k * 7.7, sd + k * 31, 3) - 0.5);
          const s = 0.45 + 0.55 * fbm(X * 24 + k * 5.3, k * 1.9, sd + k * 31 + 7, 2);
          const h = 0.55 + 0.45 * fbm(X * 2.4, k * 3.7 + 1, sd + k * 31 + 13, 2);
          sh[x * 3 + k] = s * h * 0.85;
        }
      }
      return {
        dither: 1.5,
        shade: (X, Y, x, _y, o) => {
          lerpTo(o, C[0]!, C[1]!, clamp01(Y / B));
          // stars: one per lit cell of a fixed lattice, a small soft dot
          const cx = Math.floor(X / 0.004);
          const cy = Math.floor(Y / 0.004);
          if (hash3(cx, cy, sd + 99) > 0.994) {
            const sx = (cx + 0.2 + 0.6 * hash3(cx, cy, sd + 98)) * 0.004;
            const sy = (cy + 0.2 + 0.6 * hash3(cx, cy, sd + 97)) * 0.004;
            const d2 = (X - sx) * (X - sx) + (Y - sy) * (Y - sy);
            mix(o, [255, 255, 255], 0.8 * Math.exp(-d2 / (sr * sr)) * clamp01(1 - Y / B));
          }
          for (let k = 0; k < 3; k++) {
            const dy = Y - yc[x * 3 + k]!;
            const I = dy > 0 ? Math.exp(-(dy * dy) / 0.0009) : Math.exp(dy / 0.16);
            mix(o, cur[k]!.col, clamp01(I * sh[x * 3 + k]!));
          }
        },
      };
    }
    case "blur": {
      const blobs: Array<[number, number, number, RGB]> = [];
      for (let i = 0; i < 6; i++) {
        const x = r() * A;
        const y = r() * B;
        const rad = 0.16 + r() * 0.26;
        blobs.push([x, y, rad, C[2 + (i % (n - 2))]!]);
      }
      return {
        dither: 4,
        shade: (X, Y, _x, _y, o) => {
          lerpTo(o, C[0]!, C[1]!, clamp01((X / A + Y / B) / 2));
          for (const [bx, by, rad, col] of blobs) {
            const d2 = (X - bx) * (X - bx) + (Y - by) * (Y - by);
            mix(o, col, 0.9 * Math.exp(-d2 / (rad * rad)));
          }
        },
      };
    }
    case "bokeh": {
      const gx = r() * A;
      const gy = r() * B;
      const circ: Array<[number, number, number, RGB, number]> = [];
      for (let i = 0; i < 28; i++) {
        const x = r() * A;
        const y = r() * B;
        const rad = 0.015 + r() * r() * 0.08;
        const al = 0.18 + r() * 0.4;
        circ.push([x, y, rad, C[2 + (i % (n - 2))]!, al]);
      }
      return {
        dither: 1.5,
        shade: (X, Y, _x, _y, o) => {
          lerpTo(o, C[0]!, C[1]!, clamp01((X / A) * 0.3 + (Y / B) * 0.7));
          const g2 = (X - gx) * (X - gx) + (Y - gy) * (Y - gy);
          mix(o, C[2]!, 0.5 * Math.exp(-g2 / 0.25));
          for (const [cx, cy, rad, col, al] of circ) {
            const d = Math.sqrt((X - cx) * (X - cx) + (Y - cy) * (Y - cy));
            const edge = Math.max(0.08 * rad, px);
            const cov = clamp01((rad - d) / edge + 0.5);
            if (cov <= 0) continue;
            const rf = clamp01(d / rad);
            mix(o, col, al * cov * (0.75 + 0.25 * rf * rf));
          }
        },
      };
    }
    case "lowpoly": {
      const cell = 0.11 * (0.8 + r() * 0.4);
      const vy = (i: number, j: number) => j * cell + (hash3(i, j, sd) - 0.5) * 0.6 * cell;
      return {
        dither: 0,
        shade: (X, Y, _x, _y, o) => {
          const i = Math.floor(X / cell);
          const fx = X / cell - i;
          const line = (j: number) => vy(i, j) + (vy(i + 1, j) - vy(i, j)) * fx;
          let j = Math.floor(Y / cell);
          if (Y < line(j)) j -= 1;
          else if (Y >= line(j + 1)) j += 1;
          const ax = i * cell;
          const ay = vy(i, j);
          const bx = (i + 1) * cell;
          const by = vy(i + 1, j);
          const cx = bx;
          const cy = vy(i + 1, j + 1);
          const dx = ax;
          const dy = vy(i, j + 1);
          let tri: number;
          let gx: number;
          let gy: number;
          if (hash3(i, j, sd + 1) < 0.5) {
            // diagonal a-c: triangles abc / acd
            const side = (cx - ax) * (Y - ay) - (cy - ay) * (X - ax);
            if (side < 0) {
              tri = 0;
              gx = (ax + bx + cx) / 3;
              gy = (ay + by + cy) / 3;
            } else {
              tri = 1;
              gx = (ax + cx + dx) / 3;
              gy = (ay + cy + dy) / 3;
            }
          } else {
            // diagonal b-d: triangles abd / bcd
            const side = (dx - bx) * (Y - by) - (dy - by) * (X - bx);
            if (side > 0) {
              tri = 0;
              gx = (ax + bx + dx) / 3;
              gy = (ay + by + dy) / 3;
            } else {
              tri = 1;
              gx = (bx + cx + dx) / 3;
              gy = (by + cy + dy) / 3;
            }
          }
          ramp(0.55 * (gx / A) + 0.45 * (gy / B) + (hash3(i * 2 + tri, j, sd + 2) - 0.5) * 0.12, C, o);
          const sh = 0.9 + 0.2 * hash3(i * 2 + tri, j, sd + 3);
          o[0] = o[0]! * sh;
          o[1] = o[1]! * sh;
          o[2] = o[2]! * sh;
        },
      };
    }
    case "grid": {
      const gx = r() * A;
      const gy = r() * B;
      const g = 0.032;
      const M = Math.max(A, B);
      return {
        dither: 1,
        shade: (X, Y, _x, _y, o) => {
          const dc = Math.sqrt((X - A / 2) * (X - A / 2) + (Y - B / 2) * (Y - B / 2));
          lerpTo(o, C[1]!, C[0]!, clamp01(dc / (0.75 * M)));
          const g2 = (X - gx) * (X - gx) + (Y - gy) * (Y - gy);
          mix(o, C[3 % n]!, 0.55 * Math.exp(-g2 / 0.12));
          const fx = Math.abs(fract(X / g + 0.5) - 0.5) * g;
          const fy = Math.abs(fract(Y / g + 0.5) - 0.5) * g;
          const fade = 1 - 0.6 * clamp01(dc / (0.8 * M));
          let cov: number;
          let d: number;
          if (v === 0) {
            d = Math.sqrt(fx * fx + fy * fy);
            const rad = 0.0021;
            const re = Math.max(rad, 0.75 * px);
            cov = clamp01((re - d) / px + 0.5) * (rad / re) * (rad / re);
          } else {
            d = Math.min(fx, fy);
            const w = 0.0011;
            const we = Math.max(w, px);
            cov = clamp01((we / 2 - d) / px + 0.5) * (w / we);
          }
          if (v === 2) mix(o, C[2]!, 0.25 * Math.exp(-(d / 0.004) * (d / 0.004)) * fade);
          mix(o, C[2]!, cov * fade * (v === 2 ? 0.9 : 0.45));
        },
      };
    }
    case "iso": {
      const R = 0.06 * (v === 1 ? 1.5 : 1);
      const s3 = Math.sqrt(3);
      const faces = C.slice(1);
      return {
        dither: 0,
        shade: (X, Y, _x, _y, o) => {
          const q = ((s3 / 3) * X - Y / 3) / R;
          const rr = ((2 / 3) * Y) / R;
          const cy0 = -q - rr;
          let rx = Math.floor(q + 0.5);
          let ry = Math.floor(cy0 + 0.5);
          let rz = Math.floor(rr + 0.5);
          const ex = Math.abs(rx - q);
          const ey = Math.abs(ry - cy0);
          const ez = Math.abs(rz - rr);
          if (ex > ey && ex > ez) rx = -ry - rz;
          else if (ey > ez) ry = -rx - rz;
          else rz = -rx - ry;
          const hx = R * s3 * (rx + rz / 2);
          const hy = R * 1.5 * rz;
          const th = Math.atan2(Y - hy, X - hx);
          const sh = th > (-5 * Math.PI) / 6 && th < -Math.PI / 6 ? 1.12 : th >= -Math.PI / 6 && th < Math.PI / 2 ? 0.6 : 0.82;
          ramp(hash3(rx, rz, sd), faces, o);
          const lit = sh * (0.85 + 0.3 * (1 - Y / B));
          o[0] = o[0]! * lit;
          o[1] = o[1]! * lit;
          o[2] = o[2]! * lit;
        },
      };
    }
    case "grain2": {
      const ang = r() * TAU;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const span = Math.abs((A / 2) * dx) + Math.abs((B / 2) * dy);
      return {
        dither: 18,
        cell: Math.max(1, Math.floor(S / 1600 + 0.5)),
        shade: (X, Y, _x, _y, o) => {
          const proj = (X - A / 2) * dx + (Y - B / 2) * dy;
          ramp((proj / span + 1) / 2 + 0.18 * (fbm(X * 1.8, Y * 1.8, sd, 3) - 0.5), C, o);
        },
      };
    }
    case "topo": {
      const N = 12;
      // the field at every pixel centre, one extra row and column for the forward differences
      const W1 = W + 1;
      const F = new Float64Array(W1 * (H + 1));
      for (let y = 0; y <= H; y++) {
        const Y = (y + 0.5) / S;
        for (let x = 0; x <= W; x++) F[y * W1 + x] = fbm(((x + 0.5) / S) * 2, Y * 2, sd, 4) + 0.25 * (Y / B);
      }
      return {
        dither: 1,
        shade: (_X, _Y, x, y, o) => {
          const f0 = F[y * W1 + x]!;
          const v0 = f0 * N;
          const gx = F[y * W1 + x + 1]! * N - v0;
          const gy = F[(y + 1) * W1 + x]! * N - v0;
          const g = Math.max(Math.sqrt(gx * gx + gy * gy), 1e-4);
          const lvl = Math.floor(v0 + 0.5);
          const dpx = Math.abs(v0 - lvl) / g;
          const major = ((lvl % 5) + 5) % 5 === 0;
          const lw = lineW * (major ? 1.8 : 1.1);
          const cov = clamp01(lw / 2 - dpx + 0.5);
          lerpTo(o, C[0]!, C[1]!, clamp01(f0 * 1.4 - 0.2));
          mix(o, major ? C[3 % n]! : C[2]!, cov * (major ? 0.7 : 0.55));
        },
      };
    }
    case "silk": {
      const K = 30;
      const f1 = TAU * (0.5 + r() * 0.6);
      const ph1 = r() * TAU;
      const f2 = TAU * (0.3 + r() * 0.5);
      const ph2 = r() * TAU;
      const tilt = (r() - 0.5) * 0.3;
      const mid = B * (0.45 + (r() - 0.5) * 0.1);
      const yk = (X: number, k: number) => mid + tilt * (X - A / 2) + (k / (K - 1) - 0.5) * B * (0.55 + 0.35 * Math.sin(X * f1 + ph1)) + B * 0.12 * Math.sin(X * f2 + ph2 + k * 0.06);
      // per column: each line's height and the cosine of its slope (lines depend on X only)
      const ys = new Float64Array(W * K);
      const cs = new Float64Array(W * K);
      const e = 1e-4;
      for (let x = 0; x < W; x++) {
        const X = (x + 0.5) / S;
        for (let k = 0; k < K; k++) {
          ys[x * K + k] = yk(X, k);
          const sl = (yk(X + e, k) - yk(X - e, k)) / (2 * e);
          cs[x * K + k] = 1 / Math.sqrt(1 + sl * sl);
        }
      }
      const cols: RGB[] = [];
      const lc = C.slice(2);
      for (let k = 0; k < K; k++) {
        ramp(k / (K - 1), lc, tmp);
        cols.push([tmp[0]!, tmp[1]!, tmp[2]!]);
      }
      const lw = lineW * 1.1;
      const gw = lineW * 10;
      return {
        dither: 1,
        shade: (X, Y, x, _y, o) => {
          lerpTo(o, C[0]!, C[1]!, clamp01(Y / B));
          for (let k = 0; k < K; k++) {
            const d = Math.abs(Y - ys[x * K + k]!) * cs[x * K + k]! * S;
            if (v === 1 && d < 4 * gw) mix(o, cols[k]!, 0.18 * Math.exp(-(d / gw) * (d / gw)));
            const cov = clamp01(lw / 2 - d + 0.5);
            if (cov > 0) mix(o, cols[k]!, cov * 0.8);
          }
        },
      };
    }
    case "burst": {
      const cx = A * (0.2 + 0.6 * r());
      const u = r();
      const cy = v === 0 ? B * (u * 0.5 - 0.15) : B * (0.3 + 0.4 * u);
      const N = 14 + 2 * Math.floor(r() * 6);
      const ph = r() * TAU;
      const M = Math.max(A, B);
      const loop = [...C, C[0]!];
      const avg: RGB = [0, 1, 2].map((i) => C.reduce((s, c) => s + c[i]!, 0) / n) as RGB;
      return {
        dither: 1.5,
        shade: (X, Y, _x, _y, o) => {
          const dx = X - cx;
          const dy = Y - cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const th = Math.atan2(dy, dx);
          if (v === 0) {
            const s = Math.sin(th * N + 0.5 * Math.sin(th * 3 + ph));
            const cov = clamp01(0.5 + (s * d * S) / (N * 1.2));
            lerpTo(o, C[0]!, C[1]!, clamp01(d / (1.2 * M)));
            mix(o, C[2]!, cov * 0.35);
            mix(o, C[3 % n]!, 0.85 * Math.exp(-(d * d) / 0.06));
          } else {
            ramp(fract(th / TAU + 0.5 + d * 0.6 + 0.08 * (fbm(X * 2, Y * 2, sd, 3) - 0.5)), loop, o);
            mix(o, avg, Math.exp(-(d * d) / 0.002));
            const vg = 1 - 0.3 * clamp01(d / M) * clamp01(d / M);
            o[0] = o[0]! * vg;
            o[1] = o[1]! * vg;
            o[2] = o[2]! * vg;
          }
        },
      };
    }
    case "spot": {
      const u1 = r();
      const u2 = r();
      const M = Math.max(A, B);
      const sx = A * (0.3 + 0.4 * u1);
      const sy = B * (0.2 + 0.3 * u2);
      const y0 = B * (0.55 + 0.15 * u2);
      const ang = Math.PI / 4 + (u1 - 0.5) * 0.4;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      return {
        dither: 2,
        shade: (X, Y, _x, _y, o) => {
          if (v === 0) {
            o[0] = C[0]![0];
            o[1] = C[0]![1];
            o[2] = C[0]![2];
            mix(o, C[1]!, 0.9 * Math.exp(-((X - sx) * (X - sx) + (Y - sy) * (Y - sy) * 1.6) / 0.12));
            const ex = A - sx * 0.6;
            const ey = B * 0.9;
            mix(o, C[2 % n]!, 0.35 * Math.exp(-((X - ex) * (X - ex) + (Y - ey) * (Y - ey)) / 0.05));
          } else if (v === 1) {
            lerpTo(o, C[0]!, C[1]!, clamp01(Y / B));
            const t1 = (Y - y0) / 0.0025;
            const t2 = (Y - y0) / 0.05;
            const hx = (X - A / 2) / (0.45 * A);
            mix(o, C[2 % n]!, clamp01((Math.exp(-t1 * t1) + 0.35 * Math.exp(-t2 * t2)) * Math.exp(-hx * hx)));
          } else {
            lerpTo(o, C[0]!, C[1]!, 0.15);
            const along = ca * X + sa * Y;
            const perp = Math.abs(-sa * X + ca * Y);
            const w = 0.08 + 0.25 * along;
            mix(o, C[2 % n]!, clamp01(Math.exp(-(perp / w) * (perp / w)) * Math.exp(-along / 1.1) * 0.7));
          }
          const dc = clamp01(Math.sqrt((X - A / 2) * (X - A / 2) + (Y - B / 2) * (Y - B / 2)) / (0.8 * M));
          const vg = 1 - 0.35 * dc * dc;
          o[0] = o[0]! * vg;
          o[1] = o[1]! * vg;
          o[2] = o[2]! * vg;
        },
      };
    }
    case "synth": {
      const h = B * 0.62;
      const scx = A / 2 + (r() - 0.5) * 0.3 * A;
      const R = 0.3 * B;
      const sy = h - R * 0.55;
      const per = 0.14 * R;
      const floorC: RGB = [C[0]![0] * 0.55, C[0]![1] * 0.55, C[0]![2] * 0.55];
      const lw = lineW * 1.5;
      return {
        dither: 1,
        shade: (X, Y, _x, _y, o) => {
          if (Y < h) {
            const t = clamp01(Y / h);
            lerpTo(o, C[0]!, C[1]!, Math.pow(t, 1.5));
            const d = Math.sqrt((X - scx) * (X - scx) + (Y - sy) * (Y - sy));
            mix(o, C[2]!, v === 0 ? 0.35 * Math.exp(-Math.max(0, d - R) / 0.08) : 0.3 * Math.exp(-(d * d) / 0.05));
            if (v === 0) {
              const cov = clamp01((R - d) * S + 0.5);
              if (cov > 0) {
                let gap = 0;
                if (Y > sy) {
                  const uu = (Y - sy) / R;
                  const gpos = fract((Y - sy) / per);
                  const gw = uu * 0.55;
                  if (gpos < gw) gap = clamp01(Math.min(gpos, gw - gpos) * per * S + 0.5);
                }
                lerpTo(tmp, C[3 % n]!, C[2]!, clamp01((Y - (sy - R)) / (2 * R)));
                mix(o, tmp, cov * (1 - gap));
              }
            }
          } else {
            const dz = Y - h;
            o[0] = floorC[0];
            o[1] = floorC[1];
            o[2] = floorC[2];
            const depth = 0.6 / Math.max(dz, 1e-6);
            const dvpx = 0.6 / (dz * dz) / S;
            const dl = Math.abs(fract(depth + 0.5) - 0.5);
            const ch = clamp01(lw / 2 - dl / dvpx + 0.5) * clamp01(1 / (dvpx * 10));
            const xw = ((X - A / 2) / dz) * 1.2;
            const dxpx = 1.2 / dz / S;
            const dl2 = Math.abs(fract(xw + 0.5) - 0.5);
            const cv = clamp01(lw / 2 - dl2 / dxpx + 0.5) * clamp01(1 / (dxpx * 10));
            const hf = clamp01(dz / 0.08);
            mix(o, C[2]!, Math.max(ch, cv) * 0.9 * hf * hf);
          }
          const hg = (Y - h) / 0.01;
          mix(o, C[2]!, 0.6 * Math.exp(-hg * hg));
        },
      };
    }
    case "dunes":
    case "mountains": {
      const L = 5;
      const mtn = b.style === "mountains";
      const lp: Array<{ ph: number; f: number; off: number }> = [];
      for (let l = 0; l < L; l++) {
        const ph = r() * TAU;
        const f = TAU * (0.4 + r() * 0.5);
        const off = r() * 100;
        lp.push({ ph, f, off });
      }
      const sunx = A * (0.2 + 0.6 * r());
      const suny = B * (0.15 + 0.2 * r());
      const ridge = (X: number, l: number) => {
        const p = lp[l]!;
        if (!mtn) return B * (0.42 + 0.11 * l) + 0.045 * Math.sin(X * p.f + p.ph) + 0.05 * (fbm(X * 1.3 + p.off, l * 3.3, sd + l * 17, 3) - 0.5);
        return B * (0.36 + 0.13 * l) - B * (0.3 - 0.04 * l) * ridged(X * (1.4 + 0.6 * l) + p.off, l * 5.1, sd + l * 17, 4);
      };
      const rs = new Float64Array(W * L);
      const sl = new Float64Array(W * L);
      const e = 1e-4;
      for (let x = 0; x < W; x++) {
        const X = (x + 0.5) / S;
        for (let l = 0; l < L; l++) {
          rs[x * L + l] = ridge(X, l);
          sl[x * L + l] = (ridge(X + e, l) - ridge(X - e, l)) / (2 * e);
        }
      }
      const lc: RGB[] = [];
      const layerCs = C.slice(1);
      for (let l = 0; l < L; l++) {
        ramp((l + 1) / L, layerCs, tmp);
        lc.push([tmp[0]!, tmp[1]!, tmp[2]!]);
      }
      return {
        dither: 1.5,
        shade: (X, Y, x, _y, o) => {
          lerpTo(o, C[0]!, C[1]!, clamp01(Y / (B * 0.6)));
          const d2 = (X - sunx) * (X - sunx) + (Y - suny) * (Y - suny);
          mix(o, [255, 245, 230], 0.35 * Math.exp(-d2 / 0.02));
          for (let l = 0; l < L; l++) {
            const ry = rs[x * L + l]!;
            const cov = clamp01((Y - ry) * S + 0.5);
            if (cov <= 0) continue;
            let sh: number;
            if (mtn) sh = 1 - 0.15 * clamp01((Y - ry) / 0.2);
            else sh = (1 - 0.22 * clamp01((Y - ry) / 0.12)) * (1 + 0.12 * Math.tanh(-sl[x * L + l]! * 4));
            const c = lc[l]!;
            tmp[0] = c[0] * sh;
            tmp[1] = c[1] * sh;
            tmp[2] = c[2] * sh;
            mix(o, tmp, cov);
          }
        },
      };
    }
    case "sky": {
      const sx = A * (0.2 + 0.6 * r());
      const sy = B * (0.25 + 0.3 * r());
      const wind = r() * 10;
      return {
        dither: 1.5,
        shade: (X, Y, _x, _y, o) => {
          lerpTo(o, C[0]!, C[1]!, Math.pow(clamp01(Y / B), 0.8));
          const d2 = (X - sx) * (X - sx) + (Y - sy) * (Y - sy);
          mix(o, C[2]!, clamp01(0.85 * Math.exp(-d2 / 0.004) + 0.4 * Math.exp(-d2 / 0.06)));
          const nz = fbm(X * 2.4 + wind, Y * 5.5, sd, 5);
          const bt = (Y / B - 0.55) / 0.35;
          const band = Math.exp(-bt * bt);
          const t = clamp01((nz - 0.48) / 0.24);
          const c = t * t * (3 - 2 * t) * band;
          if (c > 0) {
            const n2 = fbm(X * 2.4 + wind, (Y + 0.012) * 5.5, sd, 5);
            const lit = clamp01(0.75 + (nz - n2) * 4);
            const cc = C[3 % n]!;
            tmp[0] = cc[0] * lit;
            tmp[1] = cc[1] * lit;
            tmp[2] = cc[2] * lit;
            mix(o, tmp, c * 0.9);
          }
        },
      };
    }
  }
  throw new Error(`not a field backdrop style: ${b.style}`);
}

/**
 * Render a field backdrop at W x H into RGBA bytes (alpha 255). Deterministic: the same backdrop and
 * size always give the same bytes. Rows [y0, y1) only when given (for chunked work).
 */
export function renderBackdropField(b: Backdrop, W: number, H: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  const buf = out ?? new Uint8ClampedArray(W * H * 4);
  const f = build(b, W, H);
  const S = Math.max(W, H);
  const o = new Float64Array(3);
  const cell = f.cell ?? 1;
  const D = f.dither;
  for (let y = 0; y < H; y++) {
    const Y = (y + 0.5) / S;
    for (let x = 0; x < W; x++) {
      const X = (x + 0.5) / S;
      f.shade(X, Y, x, y, o);
      const nz = D > 0 ? (hash3(Math.floor(x / cell), Math.floor(y / cell), b.seed + 7919) - 0.5) * D : 0;
      const i = (y * W + x) * 4;
      buf[i] = Math.floor(o[0]! + nz + 0.5);
      buf[i + 1] = Math.floor(o[1]! + nz + 0.5);
      buf[i + 2] = Math.floor(o[2]! + nz + 0.5);
      buf[i + 3] = 255;
    }
  }
  return buf;
}
