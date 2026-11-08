import type { MaskKind, MaskRegion, Rect } from "./types.js";

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

/** Masks active at source time t with their fade (TXT-04/05). Rects must already be in cropped space. */
export function masksAt(masks: MaskRegion[], tMs: number): MaskFrame[] {
  const out: MaskFrame[] = [];
  for (const m of masks) {
    if (tMs < m.startMs || tMs >= m.endMs) continue;
    const fade = Math.max(0, Math.min(m.fadeMs, (m.endMs - m.startMs) / 2));
    const opacity = fade > 0 ? Math.min(smooth((tMs - m.startMs) / fade), smooth((m.endMs - tMs) / fade)) : 1;
    if (opacity <= 0.001) continue;
    const r: Rect = m.rect;
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
