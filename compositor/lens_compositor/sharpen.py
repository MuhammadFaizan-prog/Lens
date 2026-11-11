"""Sharper text in zooms (demand #22), the Python reference of apps/editor/src/render/sharpen.ts.

Above 1.5x the screen is resampled from the source frame with a Lanczos-3 filter instead of the
bicubic warp, then unsharp-masked. Both steps are edge-aware so they cannot ring:
  - the Lanczos result is clamped to the range of the 2 x 2 source pixels around each sample;
  - the unsharp result (3 x 3 binomial blur) is clamped to the 3 x 3 neighbourhood range.
The amount ramps in with the zoom (smoothstep, 0 at 1.5x, full at 1.75x). Only used when the plan
carries style.zoomSharpen, so plans without it render exactly as before.
"""
from __future__ import annotations

import cv2
import numpy as np

SHARPEN_MIN_SCALE = 1.5
SHARPEN_FULL_SCALE = 1.75


def sharpen_amount_at(amount: float, scale: float) -> float:
    u = min(1.0, max(0.0, (scale - SHARPEN_MIN_SCALE) / (SHARPEN_FULL_SCALE - SHARPEN_MIN_SCALE)))
    return amount * u * u * (3 - 2 * u)


def lanczos3(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, np.float64)
    a = np.abs(x)
    px = np.pi * x
    with np.errstate(divide="ignore", invalid="ignore"):
        v = 3 * np.sin(px) * np.sin(px / 3) / (px * px)
    v = np.where(a < 1e-5, 1.0, v)
    return np.where(a >= 3, 0.0, v)


def _taps(n_out: int, origin: float, k: float, n_src: int):
    """Source indices (n_out x 6), normalised weights, and the 2-pixel clamp pair for one axis.
    Output pixel j samples source pixel-centre coordinate origin + j / k (cv2.warpAffine's convention)."""
    s = origin + np.arange(n_out, dtype=np.float64) / k
    f = np.floor(s)
    t = s - f
    offs = np.arange(-2, 4)
    w = lanczos3(t[:, None] - offs[None, :])
    w /= w.sum(axis=1, keepdims=True)
    idx = np.clip(f[:, None].astype(np.int64) + offs[None, :], 0, n_src - 1)
    return idx, w.astype(np.float32), idx[:, 2], idx[:, 3]


def lanczos_view(frame: np.ndarray, cam: list[float], rect_w: int, rect_h: int, src_w: int, src_h: int) -> np.ndarray:
    """The camera view (same geometry as render._viewport_warp) resampled with clamped Lanczos-3.
    frame: H x W x 3 (uint8 or float); returns rect_h x rect_w x 3 float32 in the frame's value range."""
    cx, cy, s = cam
    vw, vh = src_w / s, src_h / s
    x0, y0 = cx - vw / 2, cy - vh / 2
    kx, ky = rect_w / vw, rect_h / vh
    H, W = frame.shape[:2]
    src = frame.astype(np.float32)
    xi, xw, xa, xb = _taps(rect_w, x0, kx, W)
    yi, yw, ya, yb = _taps(rect_h, y0, ky, H)
    # horizontal pass over only the rows we need, then vertical
    rows = np.unique(yi)
    rmap = np.zeros(H, np.int64)
    rmap[rows] = np.arange(len(rows))
    sub = src[rows]                                           # R x W x 3
    hpass = np.einsum("rjkc,jk->rjc", sub[:, xi], xw)          # R x rect_w x 3
    out = np.einsum("ikjc,ik->ijc", hpass[rmap[yi]], yw)       # rect_h x rect_w x 3
    # anti-ringing clamp to the 2 x 2 source pixels around each sample
    q = [src[ya][:, xa], src[ya][:, xb], src[yb][:, xa], src[yb][:, xb]]
    lo = np.minimum(np.minimum(q[0], q[1]), np.minimum(q[2], q[3]))
    hi = np.maximum(np.maximum(q[0], q[1]), np.maximum(q[2], q[3]))
    return np.clip(out, lo, hi).astype(np.float32)


_K3 = np.ones((3, 3), np.uint8)


def unsharp(img: np.ndarray, amount: float) -> np.ndarray:
    """c + amount * (c - binomial3x3(c)), clamped to the 3 x 3 range (no halos). float32 in/out."""
    img = img.astype(np.float32)
    blur = cv2.sepFilter2D(img, -1, np.float32([0.25, 0.5, 0.25]), np.float32([0.25, 0.5, 0.25]), borderType=cv2.BORDER_REPLICATE)
    lo = cv2.erode(img, _K3, borderType=cv2.BORDER_REPLICATE)
    hi = cv2.dilate(img, _K3, borderType=cv2.BORDER_REPLICATE)
    return np.clip(img + amount * (img - blur), lo, hi)


def sharpened_view(frame: np.ndarray, cam: list[float], rect_w: int, rect_h: int, src_w: int, src_h: int, amount: float) -> np.ndarray:
    return unsharp(lanczos_view(frame, cam, rect_w, rect_h, src_w, src_h), amount)


__all__ = ["SHARPEN_MIN_SCALE", "SHARPEN_FULL_SCALE", "sharpen_amount_at", "lanczos3", "lanczos_view", "unsharp", "sharpened_view"]
