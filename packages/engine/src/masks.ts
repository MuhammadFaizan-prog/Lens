import type { MaskKey, MaskKind, MaskRegion, Rect } from "./types.js";

export const DEFAULT_MASK_STRENGTH: Record<MaskKind, number> = { spotlight: 0.6, blur: 12, pixelate: 16 };

/** One mask as drawn on one frame. rect is in (cropped) source px; the compositor maps it through the camera. */
export interface MaskFrame {
  kind: MaskKind;
  rect: [number, number, number, number];
  feather: number;
  strength: number;
  /** 0..1 fade in/out. */
  opacity: number;
}

function smooth(u: number): number {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
}

/**
 * The rect of a tracked mask at source time t: the key at t (within 0.5 ms), else the union of the
 * two keys around t, else the nearest end key.
 */
export function keyedRect(keys: MaskKey[], tMs: number): Rect {
  let lo = 0;
  let hi = keys.length - 1;
  if (tMs <= keys[0]!.tMs + 0.5) return keys[0]!.rect;
  if (tMs >= keys[hi]!.tMs - 0.5) return keys[hi]!.rect;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.tMs <= tMs) lo = mid;
    else hi = mid;
  }
  const a = keys[lo]!;
  const b = keys[hi]!;
  if (Math.abs(a.tMs - tMs) < 0.5) return a.rect;
  if (Math.abs(b.tMs - tMs) < 0.5) return b.rect;
  const x0 = Math.min(a.rect.x, b.rect.x);
  const y0 = Math.min(a.rect.y, b.rect.y);
  const x1 = Math.max(a.rect.x + a.rect.w, b.rect.x + b.rect.w);
  const y1 = Math.max(a.rect.y + a.rect.h, b.rect.y + b.rect.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Masks active at source time t with their fade (TXT-04/05). Rects must already be in cropped space. */
export function masksAt(masks: MaskRegion[], tMs: number): MaskFrame[] {
  const out: MaskFrame[] = [];
  for (const m of masks) {
    if (tMs < m.startMs || tMs >= m.endMs) continue;
    const fade = Math.max(0, Math.min(m.fadeMs, (m.endMs - m.startMs) / 2));
    const opacity = fade > 0 ? Math.min(smooth((tMs - m.startMs) / fade), smooth((m.endMs - tMs) / fade)) : 1;
    if (opacity <= 0.001) continue;
    const r: Rect = m.keys && m.keys.length ? keyedRect(m.keys, tMs) : m.rect;
    out.push({
      kind: m.kind,
      rect: [r.x, r.y, r.w, r.h],
      feather: Math.max(0, m.feather),
      strength: m.strength ?? DEFAULT_MASK_STRENGTH[m.kind],
      opacity: Math.round(opacity * 10000) / 10000,
    });
  }
  return out;
}
