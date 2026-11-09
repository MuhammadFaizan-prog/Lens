"""Annotations and text slides (demand #4): draws the plan's annotation ops.

The engine (packages/engine/src/annotations.ts) decides everything: which items are on a frame,
their animation state and their geometry, tessellated into ops:

  fill    closed polygon, colour, alpha
  stroke  polyline (open or closed), width, round caps and joins, colour, alpha
  text    a text box: wrapped lines (no kerning, DejaVu Sans / Bold), alignment, optional rounded
          backing, and a visible-character count for the typewriter animation

This module maps the points (screen anchor: through the camera; frame anchor: as is), rasterises
each item into its own layer (vector ops 4x supersampled, then area-averaged), adds the item's drop
shadow (Gaussian, sigma = blur / 2, like the frame shadow) and composites it with the item's
opacity. The editor's Canvas2D renderer (apps/editor/src/render/annotations.ts) does the same.
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SS = 4  # supersampling for vector ops

FONT_FILES = {
    True: ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/DejaVuSans-Bold.ttf"],
    False: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/Library/Fonts/DejaVuSans.ttf"],
}


@lru_cache(maxsize=64)
def text_font(size: int, bold: bool):
    for p in FONT_FILES[bold]:
        if Path(p).exists():
            # BASIC layout: no kerning, the same advances the browser uses with fontKerning = none
            return ImageFont.truetype(p, size, layout_engine=ImageFont.Layout.BASIC)
    return ImageFont.load_default()


def py_round(v: float) -> int:
    return int(round(v))


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


# ---------------------------------------------------------------- text layout (mirrored in the editor)

def layout_text(op: dict, scale: float) -> dict:
    """Lines, widths and metrics of a text op at output scale `scale` (font px = round(size * scale))."""
    size = max(6, py_round(op["size"] * scale))
    font = text_font(size, bool(op.get("bold", True)))
    wbox = op["w"] * scale
    lines: list[str] = []
    for para in str(op["text"]).split("\n"):
        words = para.split(" ")
        cur = words[0]
        for w in words[1:]:
            cand = cur + " " + w
            if wbox > 0 and font.getlength(cand) > wbox and cur:
                lines.append(cur)
                cur = w
            else:
                cur = cand
        lines.append(cur)
    widths = [font.getlength(s) for s in lines]
    asc, desc = font.getmetrics()
    lh = int((asc + desc) * 1.15)
    return {"font": font, "size": size, "lines": lines, "widths": widths, "asc": asc, "desc": desc, "lh": lh}


def text_geometry(op: dict, x: float, y: float, scale: float) -> dict:
    """Where each line goes (top-left of its ascent box) and the backing rect, in output px."""
    L = layout_text(op, scale)
    wbox = op["w"] * scale
    hbox = op["h"] * scale
    block_h = L["lh"] * len(L["lines"])
    if op.get("valign") == "middle":
        top = y + (hbox - block_h) / 2 if hbox > 0 else y - block_h / 2
    else:
        top = y
    align = op.get("align", "left")
    xs = []
    for lw in L["widths"]:
        if wbox > 0:
            lx = x if align == "left" else (x + wbox / 2 - lw / 2 if align == "center" else x + wbox - lw)
        else:
            lx = x if align == "left" else (x - lw / 2 if align == "center" else x - lw)
        xs.append(lx)
    maxw = max(L["widths"]) if L["widths"] else 0
    bx0 = min(xs) if xs else x
    L.update(top=top, xs=xs, block_h=block_h, box=(bx0, top, maxw, block_h))
    return L


# ---------------------------------------------------------------- rasterising

def _coverage(polys: list[np.ndarray], closed: bool, width: float, fill: bool, w: int, h: int) -> np.ndarray:
    """Coverage (float32 0..1, h x w) of filled polygons or round-capped strokes, 4x supersampled.
    Points are in layer px (pixel edges at integers, like canvas)."""
    m = np.zeros((h * SS, w * SS), np.uint8)
    SHIFT = 4
    for p in polys:
        # canvas: x is a pixel edge; OpenCV: pixel centres -> shift by half a supersample pixel
        q = np.round((p * SS - 0.5) * (1 << SHIFT)).astype(np.int32).reshape(-1, 1, 2)
        if fill:
            cv2.fillPoly(m, [q], 255, lineType=cv2.LINE_AA, shift=SHIFT)
        else:
            t = max(1, int(round(width * SS)))
            if len(p) == 1:
                c = q[0, 0]
                cv2.circle(m, (int(c[0]), int(c[1])), max(1, int(round(width * SS / 2 * (1 << SHIFT)))), 255, -1, lineType=cv2.LINE_AA, shift=SHIFT)
            else:
                cv2.polylines(m, [q], closed, 255, thickness=t, lineType=cv2.LINE_AA, shift=SHIFT)
    return cv2.resize(m, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0


def _over(layer: np.ndarray, cov: np.ndarray, rgb: tuple[int, int, int], alpha: float, x0: int, y0: int) -> None:
    """Premultiplied source-over of a solid colour with coverage onto the layer (RGBA float, premult)."""
    a = (cov * alpha)[..., None]
    h, w = cov.shape
    reg = layer[y0:y0 + h, x0:x0 + w]
    col = np.array([*rgb, 255.0], np.float32)
    reg[:] = reg * (1 - a) + col * a


def _rounded_rect_pts(x: float, y: float, w: float, h: float, r: float) -> np.ndarray:
    rr = max(0.0, min(r, w / 2, h / 2))
    pts = []
    seg = 8 if rr > 0 else 1
    for cx, cy, a0 in ((x + w - rr, y + rr, -math.pi / 2), (x + w - rr, y + h - rr, 0.0), (x + rr, y + h - rr, math.pi / 2), (x + rr, y + rr, math.pi)):
        for i in range(seg + 1):
            a = a0 + i / seg * (math.pi / 2)
            pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return np.array(pts, np.float64)


def draw_items(dst: np.ndarray, items: list[dict], to_px: Callable[[float, float], tuple[float, float]], k: float, opacity_mul: float = 1.0) -> None:
    """Draw annotation frames (or a slide) onto dst (float32 BGR, H x W x 3) in place.
    to_px maps an item's coordinates to dst px; k scales its widths and sizes."""
    H, W = dst.shape[:2]
    for it in items:
        ops = it["ops"]
        if not ops:
            continue
        # 1. map geometry, lay out text, find the item's bounds
        mapped = []
        x0, y0, x1, y1 = math.inf, math.inf, -math.inf, -math.inf
        for o in ops:
            if o["op"] in ("fill", "stroke"):
                p = np.array(o["pts"], np.float64).reshape(-1, 2)
                p = np.array([to_px(a, b) for a, b in p], np.float64)
                pad = o.get("width", 0) * k / 2 + 2
                mapped.append(("v", o, p))
                x0, y0 = min(x0, p[:, 0].min() - pad), min(y0, p[:, 1].min() - pad)
                x1, y1 = max(x1, p[:, 0].max() + pad), max(y1, p[:, 1].max() + pad)
            else:
                tx, ty = to_px(o["x"], o["y"])
                g = text_geometry(o, tx, ty, k)
                bg = o.get("bg")
                bx, by, bw, bh = g["box"]
                px_, py_ = (bg["padX"] * k, bg["padY"] * k) if bg else (0, 0)
                mapped.append(("t", o, g))
                x0, y0 = min(x0, bx - px_ - 2), min(y0, by - py_ - 2)
                x1, y1 = max(x1, bx + bw + px_ + 2), max(y1, by + bh + py_ + 2)
        sh = it.get("shadow")
        spad = 0
        if sh:
            spad = int(math.ceil(sh[1] * k * 1.6 + abs(sh[3]) * k)) + 2
        lx0, ly0 = max(0, int(math.floor(x0)) - spad), max(0, int(math.floor(y0)) - spad)
        lx1, ly1 = min(W, int(math.ceil(x1)) + spad), min(H, int(math.ceil(y1)) + spad)
        if lx1 - lx0 < 1 or ly1 - ly0 < 1:
            continue
        lw, lh = lx1 - lx0, ly1 - ly0
        layer = np.zeros((lh, lw, 4), np.float32)  # premultiplied RGBA 0..255
        # 2. ops in order
        for kind, o, g in mapped:
            if kind == "v":
                p = g - np.array([lx0, ly0])
                if o["op"] == "fill":
                    cov = _coverage([p], True, 0, True, lw, lh)
                else:
                    cov = _coverage([p], bool(o["closed"]), o["width"] * k, False, lw, lh)
                _over(layer, cov, hex_rgb(o["color"]), float(o["alpha"]), 0, 0)
            else:
                bg = o.get("bg")
                if bg:
                    bx, by, bw, bh = g["box"]
                    pts = _rounded_rect_pts(bx - bg["padX"] * k - lx0, by - bg["padY"] * k - ly0, bw + 2 * bg["padX"] * k, bh + 2 * bg["padY"] * k, bg["radius"] * k)
                    _over(layer, _coverage([pts], True, 0, True, lw, lh), hex_rgb(bg["color"]), float(bg["alpha"]), 0, 0)
                n = int(o.get("chars", -1))
                pil = Image.new("RGBA", (lw, lh), (0, 0, 0, 0))
                d = ImageDraw.Draw(pil)
                rgb = hex_rgb(o["color"])
                left = n
                for li, line in enumerate(g["lines"]):
                    if n >= 0:
                        if left <= 0:
                            break
                        s = line[:left]
                        left -= len(line) + 1  # the space or newline the wrap consumed
                    else:
                        s = line
                    if s:
                        d.text((g["xs"][li] - lx0, g["top"] + li * g["lh"] - ly0), s, font=g["font"], fill=(*rgb, 255))
                arr = np.asarray(pil, np.float32)
                ta = arr[..., 3:4] / 255.0
                layer[:] = layer * (1 - ta) + np.concatenate([arr[..., :3] * ta, arr[..., 3:4]], axis=2)
        # 3. shadow, then the layer, both with the item's opacity
        op = float(it.get("opacity", 1)) * opacity_mul
        reg = dst[ly0:ly1, lx0:lx1]
        if sh:
            a = layer[..., 3] / 255.0
            blur = sh[1] * k
            if blur > 0:
                a = cv2.GaussianBlur(a, (0, 0), blur / 2)
            dx, dy = int(round(sh[2] * k)), int(round(sh[3] * k))
            a = np.roll(np.roll(a, dy, 0), dx, 1)
            reg *= (1 - a * sh[0] * op)[..., None]
        la = layer[..., 3:4] / 255.0 * op
        bgr = layer[..., 2::-1] * op
        reg[:] = reg * (1 - la) + bgr
