"""Find the rendered cursor in exported frames and convert it to source coordinates.

The cursor is whatever differs from the reference screen near where the input log says the mouse
is. For each tracked frame we warp the reference into export space with that frame's similarity
transform, diff, and pick the strongest compact blob within a search radius of the logged
position. UI changes (typed text, button flashes) are rejected by size and by distance.

Click ripples are white overlays, so they only ever brighten the frame, while the cursor's dark fill
darkens it. The blob search therefore runs first on the darkening-only diff (ripple-free); only if
no cursor blob is found there (e.g. over a dark sidebar) does it fall back to the absolute diff.
"""
from __future__ import annotations

import math
from typing import Optional

import cv2
import numpy as np

from .track import frames


def raw_position(events: list[dict], t_ms: float) -> Optional[tuple[float, float]]:
    pos = [e for e in events if "x" in e and "y" in e]
    if not pos:
        return None
    if t_ms <= pos[0]["t"]:
        return pos[0]["x"], pos[0]["y"]
    for a, b in zip(pos, pos[1:]):
        if b["t"] >= t_ms:
            span = b["t"] - a["t"]
            u = 1.0 if span <= 0 else (t_ms - a["t"]) / span
            return a["x"] + (b["x"] - a["x"]) * u, a["y"] + (b["y"] - a["y"]) * u
    return pos[-1]["x"], pos[-1]["y"]


def track_cursor(video: str, reference_path: str, track: dict, events: list[dict], sync_offset_ms: float = 0.0, search_px: float = 140) -> list[dict]:
    ref = cv2.imread(reference_path)
    by_index = {f["index"]: f for f in track["frames"] if f["ok"]}
    rect = track["contentRect"]
    out = []
    for i, fr in frames(video):
        f = by_index.get(i)
        if f is None:
            continue
        H, W = fr.shape[:2]
        M = np.float32([[f["a"], 0, f["tx"]], [0, f["a"], f["ty"]]])
        warped = cv2.warpAffine(ref, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
        x0, y0 = int(rect["x"]), int(rect["y"])
        x1, y1 = int(rect["x"] + rect["w"]), int(rect["y"] + rect["h"])
        mask = np.zeros(fr.shape[:2], np.uint8)
        mask[y0:y1, x0:x1] = 1
        diff_abs = (cv2.absdiff(fr, warped).max(axis=2) * mask).astype(np.uint8)
        diff_dark = (cv2.subtract(warped, fr).max(axis=2) * mask).astype(np.uint8)
        t_src = f["t"] - sync_offset_ms
        rp = raw_position(events, t_src)
        if rp is None:
            continue
        ex, ey = rp[0] * f["a"] + f["tx"], rp[1] * f["a"] + f["ty"]
        r = search_px * max(1.0, f["scale"])
        sx0, sy0 = int(max(0, ex - r)), int(max(0, ey - r))
        sx1, sy1 = int(min(W, ex + r)), int(min(H, ey + r))
        if sx1 <= sx0 or sy1 <= sy0:
            out.append({"t": t_src, "x": math.nan, "y": math.nan, "found": False})
            continue
        cursor_area = (26 * f["a"] * f["scale"] / max(f["scale"], 1)) ** 2
        best = None
        for diff in (diff_dark, diff_abs):
            best = _best_blob(diff[sy0:sy1, sx0:sx1], sx0, sy0, ex, ey, cursor_area)
            if best is not None:
                break
        if best is None:
            out.append({"t": t_src, "x": math.nan, "y": math.nan, "found": False})
        else:
            _, hx, hy = best
            out.append({"t": t_src, "x": (hx - f["tx"]) / f["a"], "y": (hy - f["ty"]) / f["a"], "found": True})
    return out


def _best_blob(win: np.ndarray, sx0: int, sy0: int, ex: float, ey: float, cursor_area: float):
    """Strongest compact blob near the expected position; returns (score, hx, hy) or None."""
    _, th = cv2.threshold(win, 60, 255, cv2.THRESH_BINARY)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(th)
    best = None
    for k in range(1, n):
        area = stats[k, cv2.CC_STAT_AREA]
        if area < 6 or area > cursor_area * 6:
            continue
        # Hotspot ~ top-left of the arrow blob.
        hx = sx0 + stats[k, cv2.CC_STAT_LEFT]
        hy = sy0 + stats[k, cv2.CC_STAT_TOP]
        d = math.hypot(hx - ex, hy - ey)
        score = d - 0.02 * area
        if best is None or score < best[0]:
            best = (score, hx, hy)
    return best
