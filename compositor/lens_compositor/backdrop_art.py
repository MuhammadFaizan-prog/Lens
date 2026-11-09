"""Lens's own procedural backdrop art (Windows bug #20), the Python twin of the editor's
apps/editor/src/render/backdrops.ts drawBackdrop().

The plan carries the chosen art as style.backdropArt ({id, colors, style, seed}); this draws the same
picture from the same seeded random sequence (mulberry32), so the reference compositor matches the
editor's preview and in-app export. Original designs, no third-party wallpapers or assets.
Output is BGR float32, like make_background().
"""
from __future__ import annotations

import math

import cv2
import numpy as np

M32 = 0xFFFFFFFF


def mulberry32(seed: int):
    """Same sequence as backdrops.ts rng(): uint32 arithmetic, float in [0, 1)."""
    a = seed & M32

    def r() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & M32
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & M32)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return r


def _bgr(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)], np.float32)


def _over(img: np.ndarray, col: np.ndarray, alpha: np.ndarray) -> None:
    """Source-over a flat colour with per-pixel alpha (H x W) onto img in place."""
    a = alpha[..., None]
    img *= 1 - a
    img += col * a


def _poly(img: np.ndarray, pts: list[tuple[float, float]], col: np.ndarray, alpha: float) -> None:
    h, w = img.shape[:2]
    m = np.zeros((h, w), np.uint8)
    p = np.array([[round(x * 4), round(y * 4)] for x, y in pts], np.int32)
    cv2.fillPoly(m, [p], 255, lineType=cv2.LINE_AA, shift=2)
    _over(img, col, m.astype(np.float32) / 255 * alpha)


def draw_backdrop_art(art: dict, W: int, H: int) -> np.ndarray:
    r = mulberry32(int(art["seed"]))
    c = [_bgr(x) for x in art["colors"]]
    style = art["style"]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    xx += 0.5
    yy += 0.5
    # base: linear gradient (0,0) -> (W,H), colours 0 -> 1
    u = np.clip((xx * W + yy * H) / float(W * W + H * H), 0, 1)[..., None]
    img = c[0] * (1 - u) + c[1] * u
    S = max(W, H)
    if style in ("blobs", "grain"):
        for i in range(7):
            x = r() * W
            y = r() * H
            rad = S * (0.25 + r() * 0.45)
            d = np.sqrt((xx - x) ** 2 + (yy - y) ** 2) / rad
            _over(img, c[2 + (i % 2)], 0.55 * np.clip(1 - d, 0, 1))
    if style == "waves":
        for i in range(6):
            amp = H * (0.05 + r() * 0.1)
            y0 = H * (0.25 + i * 0.12)
            ph = r() * math.pi * 2
            k = (math.pi * 2 * (0.6 + r())) / W
            step = max(4, W / 160)
            pts = [(0.0, float(H))]
            x = 0.0
            while x <= W:
                pts.append((x, y0 + math.sin(x * k + ph) * amp))
                x += step
            pts.append((float(W), float(H)))
            _poly(img, pts, c[2 + (i % 2)], 0.16)
    if style == "rays":
        cx = W * (0.2 + r() * 0.6)
        cy = -H * 0.2
        for i in range(9):
            a0 = math.pi * (0.15 + (i / 9) * 0.7) + (r() - 0.5) * 0.05
            a1 = a0 + 0.035 + r() * 0.05
            pts = [(cx, cy), (cx + math.cos(a0) * S * 2, cy + math.sin(a0) * S * 2), (cx + math.cos(a1) * S * 2, cy + math.sin(a1) * S * 2)]
            _poly(img, pts, c[2 + (i % 2)], 0.18)
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (S * 1.1)
        _over(img, c[3], 0.35 * np.clip(1 - d, 0, 1))
    if style == "grain":
        n = round((W * H) / 900)
        for _ in range(n):
            a = 0.15 + r() * 0.5
            s = max(1.0, (S / 1080) * (1 if r() < 0.95 else 2.4))
            x = r() * W
            y = r() * H
            x0, y0 = int(x), int(y)
            x1, y1 = min(W, int(math.ceil(x + s))), min(H, int(math.ceil(y + s)))
            if x1 > x0 and y1 > y0:
                img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - a) + c[3] * a
    return img.astype(np.float32)
