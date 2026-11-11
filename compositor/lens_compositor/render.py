"""Reference compositor: draws a Lens render plan onto a cursorless screen recording.

This is the CPU reference implementation of the render graph described in Techspec.md. The
production compositor (wgpu, Rust) must produce the same pixels for the same plan; golden tests
compare the two. Order of passes per frame:

  background -> shadow -> screen (source crop, camera transform, motion blur)
  -> masks (spotlight / blur / pixelate) -> click effects -> screen-anchored annotations
  -> cursor (with motion blur) -> rounded mask -> webcam (crop, mirror) -> frame-anchored annotations
  -> shortcut pill -> caption (styled, word highlight) -> brand watermark -> text slide

A frame near a cut join (plan frame `tr`, demand #14) is drawn twice, itself and the other side of the
join held still (from a second decoder), and the two are composited (crossfade / push / zoom / blur dip).

Then audio (see audio.py) is muxed as AAC, or the video is converted to a palette GIF.

All motion decisions come from the plan. This file only draws.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, Iterator, Optional

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from PIL import features as _pil_features

from . import annotations as ann
from .annotations import draw_items, image_premul, resolve_asset, set_fonts, shaped_font, text_font
from .audio import build_audio, export_gif, mux_audio
from .backdrop_art import draw_backdrop_art

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/SFNS.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
]


@lru_cache(maxsize=16)
def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def hex_to_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (b, g, r)


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    b, g, r = hex_to_bgr(h)
    return (r, g, b)


# ---------------------------------------------------------------- background

def gradient_stops(colors: list, stops) -> list:
    """[(position, colour)] sorted by position: background.stops when it gives one in 0..1 per colour
    (stops placed freely, Windows bug #20), else evenly spaced. Same rule as the editor's gradientStops()."""
    n = len(colors)
    ok = isinstance(stops, list) and len(stops) == n and all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in stops)
    pos = [float(v) for v in stops] if ok else [i / (n - 1) if n > 1 else 0.0 for i in range(n)]
    return sorted(zip(pos, colors), key=lambda pc: pc[0])


def make_background(style: dict, w: int, h: int) -> np.ndarray:
    bg = style["background"]
    kind = bg.get("kind", "solid")
    colors = [np.array(hex_to_bgr(c), dtype=np.float32) for c in bg.get("colors", ["#202020"])] or [np.array(hex_to_bgr("#202020"), np.float32)]
    blur = float(bg.get("blur", 0) or 0)
    art = style.get("backdropArt")
    if kind == "hidden":
        # no backdrop (Windows bug #20): black behind a recording that fills the frame (as the editor)
        return np.zeros((h, w, 3), np.float32)
    if kind == "image" and art:
        # Lens's own procedural art, drawn larger when blurred so the edges stay solid (as the editor)
        m = math.ceil(blur * 3)
        out = draw_backdrop_art(art, w + 2 * m, h + 2 * m)
        if blur > 0:
            out = cv2.GaussianBlur(out, (0, 0), blur)
        out = out[m:m + h, m:m + w]
        blur = 0
    elif kind == "image" and bg.get("imagePath") and Path(bg["imagePath"]).exists():
        img = cv2.imread(bg["imagePath"])
        ih, iw = img.shape[:2]
        contain = bg.get("fit") == "contain"
        s = min(w / iw, h / ih) if contain else max(w / iw, h / ih)
        img = cv2.resize(img, (max(1, round(iw * s)), max(1, round(ih * s))), interpolation=cv2.INTER_AREA).astype(np.float32)
        if contain:
            # the image inside the frame, colors[0] around it
            out = np.broadcast_to(colors[0], (h, w, 3)).copy()
            y0 = (h - img.shape[0]) // 2
            x0 = (w - img.shape[1]) // 2
            out[y0:y0 + img.shape[0], x0:x0 + img.shape[1]] = img[:h, :w]
        else:
            y0 = (img.shape[0] - h) // 2
            x0 = (img.shape[1] - w) // 2
            out = img[y0:y0 + h, x0:x0 + w]
    elif kind == "gradient" and len(colors) >= 2:
        ang = math.radians(bg.get("angle", 135))
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        dx, dy = math.sin(ang), -math.cos(ang)
        proj = (xx - w / 2) * dx + (yy - h / 2) * dy
        span = abs(w / 2 * dx) + abs(h / 2 * dy)
        u = np.clip((proj / span + 1) / 2, 0, 1)
        st = gradient_stops([c for c in colors], bg.get("stops"))
        pos = np.array([p for p, _ in st], np.float32)
        out = np.empty((h, w, 3), np.float32)
        for ch in range(3):
            out[..., ch] = np.interp(u, pos, np.array([c[ch] for _, c in st], np.float32))
    else:
        out = np.broadcast_to(colors[0], (h, w, 3)).copy()
    if blur > 0:
        out = cv2.GaussianBlur(out, (0, 0), blur)
    # Subtle dither so gradients do not band after 8-bit encode (Screen Studio calls this debanding).
    rng = np.random.default_rng(1)
    out = out + rng.uniform(-0.5, 0.5, out.shape).astype(np.float32)
    return np.clip(out, 0, 255).astype(np.float32)


# ---------------------------------------------------------------- masks

@lru_cache(maxsize=64)
def rounded_mask(w: int, h: int, radius: float) -> np.ndarray:
    """Anti-aliased rounded-rect alpha mask (float32 0..1), drawn at 4x and downsampled."""
    ss = 4
    m = np.zeros((h * ss, w * ss), np.uint8)
    r = int(max(0, min(radius, min(w, h) / 2)) * ss)
    W, H = w * ss, h * ss
    if r == 0:
        m[:] = 255
    else:
        cv2.rectangle(m, (r, 0), (W - r - 1, H - 1), 255, -1)
        cv2.rectangle(m, (0, r), (W - 1, H - r - 1), 255, -1)
        for cx, cy in ((r, r), (W - r - 1, r), (r, H - r - 1), (W - r - 1, H - r - 1)):
            cv2.circle(m, (cx, cy), r, 255, -1, lineType=cv2.LINE_AA)
    return cv2.resize(m, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0


@lru_cache(maxsize=32)
def shadow_layer(out_w: int, out_h: int, rect: tuple[int, int, int, int], radius: float, blur: float, offset_y: float, angle: float, opacity: float) -> np.ndarray:
    """Alpha of the drop shadow over the whole output (float32 0..1)."""
    x, y, w, h = rect
    a = np.zeros((out_h, out_w), np.float32)
    ox = offset_y * math.cos(math.radians(angle))
    oy = offset_y * math.sin(math.radians(angle))
    m = rounded_mask(w, h, radius)
    x0, y0 = int(round(x + ox)), int(round(y + oy))
    xs0, ys0 = max(0, x0), max(0, y0)
    xs1, ys1 = min(out_w, x0 + w), min(out_h, y0 + h)
    if xs1 > xs0 and ys1 > ys0:
        a[ys0:ys1, xs0:xs1] = m[ys0 - y0:ys1 - y0, xs0 - x0:xs1 - x0]
    if blur > 0:
        a = cv2.GaussianBlur(a, (0, 0), blur / 2)
    return a * opacity


# ---------------------------------------------------------------- cursor art (original Lens design)

@lru_cache(maxsize=8)
def cursor_sprite(shape: str, px: int = 256) -> tuple[np.ndarray, tuple[float, float]]:
    """RGBA cursor sprite and its hotspot (fraction of sprite size). Original vector art."""
    ss = 4
    S = px * ss
    img = np.zeros((S, S, 4), np.uint8)
    if shape in ("text",):
        w = int(S * 0.06)
        cx = S // 2
        cv2.rectangle(img, (cx - w, int(S * 0.1)), (cx + w, int(S * 0.9)), (255, 255, 255, 255), -1)
        cv2.rectangle(img, (cx - w // 2, int(S * 0.12)), (cx + w // 2, int(S * 0.88)), (20, 20, 20, 255), -1)
        hot = (0.5, 0.5)
    elif shape in ("pointer",):
        # Rounded hand-like pointer: a tilted capsule with a dot, distinct from OS art.
        pts = np.array([[0.40, 0.08], [0.52, 0.08], [0.52, 0.45], [0.78, 0.50], [0.80, 0.80], [0.60, 0.95], [0.40, 0.95], [0.25, 0.70], [0.30, 0.55], [0.40, 0.58]]) * S
        cv2.fillPoly(img, [pts.astype(np.int32)], (255, 255, 255, 255), lineType=cv2.LINE_AA)
        inner = (pts - pts.mean(0)) * 0.82 + pts.mean(0)
        cv2.fillPoly(img, [inner.astype(np.int32)], (24, 24, 24, 255), lineType=cv2.LINE_AA)
        hot = (0.46, 0.08)
    else:
        # Arrow: white outline, near-black fill, slightly softened tail.
        pts = np.array([[0.12, 0.06], [0.12, 0.80], [0.30, 0.64], [0.42, 0.92], [0.54, 0.87], [0.42, 0.60], [0.66, 0.60]]) * S
        cv2.fillPoly(img, [pts.astype(np.int32)], (255, 255, 255, 255), lineType=cv2.LINE_AA)
        c = pts.mean(0)
        inner = (pts - c) * 0.80 + c + np.array([-0.012, 0.0]) * S
        cv2.fillPoly(img, [inner.astype(np.int32)], (18, 18, 18, 255), lineType=cv2.LINE_AA)
        hot = (0.12, 0.06)
    img = cv2.resize(img, (px, px), interpolation=cv2.INTER_AREA)
    # Soft drop shadow under the cursor.
    alpha = img[..., 3].astype(np.float32) / 255
    sh = cv2.GaussianBlur(alpha, (0, 0), px * 0.03)
    sh = np.roll(np.roll(sh, int(px * 0.02), 0), int(px * 0.01), 1) * 0.45
    out = np.zeros((px, px, 4), np.float32)
    a = alpha + sh * (1 - alpha)
    rgb = img[..., :3].astype(np.float32) * alpha[..., None]
    out[..., :3] = np.where(a[..., None] > 0, rgb / np.maximum(a[..., None], 1e-6), 0)
    out[..., 3] = a
    return out, hot


def blend_rgba(dst: np.ndarray, sprite: np.ndarray, x: float, y: float, opacity: float = 1.0) -> None:
    """Alpha-blend an RGBA float sprite onto dst (float32 BGR) with top-left at (x, y)."""
    h, w = sprite.shape[:2]
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    # Sub-pixel placement keeps slow cursor motion smooth.
    fx, fy = x - x0, y - y0
    if fx or fy:
        M = np.float32([[1, 0, fx], [0, 1, fy]])
        sprite = cv2.warpAffine(sprite, M, (w + 1, h + 1), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        h, w = sprite.shape[:2]
    H, W = dst.shape[:2]
    xs0, ys0 = max(0, x0), max(0, y0)
    xs1, ys1 = min(W, x0 + w), min(H, y0 + h)
    if xs1 <= xs0 or ys1 <= ys0:
        return
    s = sprite[ys0 - y0:ys1 - y0, xs0 - x0:xs1 - x0]
    a = s[..., 3:4] * opacity
    dst[ys0:ys1, xs0:xs1] = dst[ys0:ys1, xs0:xs1] * (1 - a) + s[..., :3] * a


# ---------------------------------------------------------------- video io

def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames", "-of", "json", path],
        check=True, capture_output=True, text=True,
    ).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": float(num) / float(den)}


def read_frames(path: str, w: int, h: int) -> Iterator[np.ndarray]:
    # YUV -> RGB with the same accurate rounding as the export encode (matrix and range from the
    # stream's tags; untagged input keeps ffmpeg's default)
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale=flags={SWS_FLAGS}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         stdout=subprocess.PIPE)
    assert p.stdout
    size = w * h * 3
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.wait()


class FrameSource:
    """Sequential access to a video by timestamp (source time only moves forward in a plan)."""

    def __init__(self, path: str):
        info = probe(path)
        self.w, self.h, self.fps = info["width"], info["height"], info["fps"]
        self._it = read_frames(path, self.w, self.h)
        self._idx = -1
        self._frame: Optional[np.ndarray] = None

    def at(self, t_ms: float) -> np.ndarray:
        want = max(0, int(round(t_ms * self.fps / 1000)))
        while self._idx < want:
            try:
                self._frame = next(self._it)
                self._idx += 1
            except StopIteration:
                break
        assert self._frame is not None, "empty video"
        return self._frame


# BT.709 limited range, converted and tagged explicitly. ffmpeg's default RGB->YUV conversion uses the
# BT.601 matrix and writes no colour tags; players (Chrome, QuickTime, VLC) decode untagged HD video as
# BT.709, which shifted saturated colours by up to ~23 levels. accurate_rnd + full_chroma_int keep the
# conversion itself within ~1-2 levels on flat colours.
SWS_FLAGS = "accurate_rnd+full_chroma_int"
COLOR_TAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]


def encoder_args(preset: str, crf: int, bitrate: Optional[float] = None, maxrate: Optional[float] = None) -> list[str]:
    """ffmpeg output args for the x264 export: explicit bt709 conversion plus matching stream tags.
    A platform export preset (demand #24) sets an average bitrate (Mbps) and its peak instead of crf."""
    rate = ["-crf", str(crf)]
    if bitrate:
        peak = maxrate if maxrate and maxrate >= bitrate else bitrate * 1.5
        rate = ["-b:v", f"{bitrate:g}M", "-maxrate", f"{peak:g}M", "-bufsize", f"{bitrate * 2:g}M"]
    return [
        "-vf", f"scale=out_color_matrix=bt709:out_range=tv:flags={SWS_FLAGS},"
        "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
        "-c:v", "libx264", "-preset", preset, *rate, "-pix_fmt", "yuv420p",
        *COLOR_TAGS,
    ]


# ---------------------------------------------------------------- render

@dataclass
class RenderOptions:
    crf: int = 18
    preset: str = "medium"
    #: platform export preset (demand #24): average video bitrate and peak in Mbps (None = crf)
    bitrate: Optional[float] = None
    maxrate: Optional[float] = None
    max_frames: Optional[int] = None
    #: mux the plan's audio block (tracks, cleanup, click sounds) when present
    audio: bool = True
    #: called as progress(frames_done, frames_total) after each encoded frame (editor export bar)
    progress: Optional[Callable[[int, int], None]] = None
    #: when set, each finished frame (uint8 BGR, H x W x 3) goes here and nothing is encoded or
    #: written (golden / parity tests compare pixels before the lossy YUV encode)
    frame_sink: Optional[Callable[[int, np.ndarray], None]] = None
    #: folder that relative logo / font paths in the plan resolve against (default: the plan's folder)
    asset_dir: Optional[str] = None


def draw_watermark(out: np.ndarray, wm: dict, asset_dir) -> None:
    """Brand logo watermark (demand #9): premultiplied, area-resampled to its whole-pixel rect, at its opacity."""
    path = resolve_asset(wm["path"], asset_dir)
    if not path.exists():
        return
    x, y, w, h = int(wm["x"]), int(wm["y"]), int(wm["w"]), int(wm["h"])
    pre = image_premul(str(path), w, h) * float(wm.get("opacity", 1))
    H, W = out.shape[:2]
    xa, ya, xb, yb = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if xb <= xa or yb <= ya:
        return
    src = pre[ya - y:yb - y, xa - x:xb - x]
    a = src[..., 3:4] / 255.0
    out[ya:yb, xa:xb] = out[ya:yb, xa:xb] * (1 - a) + src[..., 2::-1]


# ---------------------------------------------------------------- masks (TXT-04/05)

def _soft_rect_alpha(h: int, w: int, x0: float, y0: float, x1: float, y1: float, feather: float) -> np.ndarray:
    """Alpha (float32 0..1) of a rect with linear feathered edges centred on the rect border.
    feather <= 1 px gives a 1 px anti-aliased edge."""
    f = max(1.0, feather)
    xx = np.arange(w, dtype=np.float32) + 0.5
    yy = np.arange(h, dtype=np.float32) + 0.5
    ax = np.clip((xx - x0) / f + 0.5, 0, 1) * np.clip((x1 - xx) / f + 0.5, 0, 1)
    ay = np.clip((yy - y0) / f + 0.5, 0, 1) * np.clip((y1 - yy) / f + 0.5, 0, 1)
    return ay[:, None] * ax[None, :]


def apply_masks(view: np.ndarray, masks: list[dict], to_rect, kx: float, ky: float) -> np.ndarray:
    """Draw the frame's masks into the camera view. Mask rects are in (cropped) source px, mapped
    through the same camera transform as the screen, so they stay glued to content while zooming."""
    if not masks:
        return view
    vh, vw = view.shape[:2]
    spot = np.zeros((vh, vw), np.float32)
    spot_dim = 0.0
    for m in masks:
        x, y, w, h = m["rect"]
        rx0, ry0 = to_rect(x, y)
        rx1, ry1 = to_rect(x + w, y + h)
        fe = m["feather"] * kx
        op = float(m["opacity"])
        if m["kind"] == "spotlight":
            a = _soft_rect_alpha(vh, vw, rx0, ry0, rx1, ry1, fe)
            spot = np.maximum(spot, a * op)
            spot_dim = max(spot_dim, float(m["strength"]) * op)
            continue
        pad = int(math.ceil(fe + 2))
        bx0, by0 = max(0, int(math.floor(rx0)) - pad), max(0, int(math.floor(ry0)) - pad)
        bx1, by1 = min(vw, int(math.ceil(rx1)) + pad), min(vh, int(math.ceil(ry1)) + pad)
        if bx1 - bx0 < 2 or by1 - by0 < 2:
            continue
        a = _soft_rect_alpha(by1 - by0, bx1 - bx0, rx0 - bx0, ry0 - by0, rx1 - bx0, ry1 - by0, fe)[..., None] * op
        region = view[by0:by1, bx0:bx1]
        if m["kind"] == "blur":
            sigma = max(0.5, float(m["strength"]) * kx)
            # blur a margin around the region too so the edge samples real neighbours, not padding
            mg = int(math.ceil(sigma * 3))
            ex0, ey0, ex1, ey1 = max(0, bx0 - mg), max(0, by0 - mg), min(vw, bx1 + mg), min(vh, by1 + mg)
            big = cv2.GaussianBlur(view[ey0:ey1, ex0:ex1], (0, 0), sigma)
            eff = big[by0 - ey0:by1 - ey0, bx0 - ex0:bx1 - ex0]
        else:  # pixelate: blocks anchored to the mask's own origin, so they move with the content
            bi = max(2, int(round(float(m["strength"]) * kx)))
            ox, oy = int(math.floor(rx0)), int(math.floor(ry0))
            gx0 = max(0, ox - int(math.ceil((ox - bx0) / bi)) * bi)
            gy0 = max(0, oy - int(math.ceil((oy - by0) / bi)) * bi)
            gx1 = min(vw, gx0 + int(math.ceil((bx1 - gx0) / bi)) * bi)
            gy1 = min(vh, gy0 + int(math.ceil((by1 - gy0) / bi)) * bi)
            sub = view[gy0:gy1, gx0:gx1]
            nh, nw = max(1, int(math.ceil(sub.shape[0] / bi))), max(1, int(math.ceil(sub.shape[1] / bi)))
            small = cv2.resize(sub, (nw, nh), interpolation=cv2.INTER_AREA)
            px = np.repeat(np.repeat(small, bi, 0), bi, 1)[: sub.shape[0], : sub.shape[1]]
            eff = px[by0 - gy0:, bx0 - gx0:][: by1 - by0, : bx1 - bx0]
        view[by0:by1, bx0:bx1] = region * (1 - a) + eff * a
    if spot_dim > 0:
        view = view * (1 - spot_dim * (1 - spot))[..., None]
    return view


# ---------------------------------------------------------------- captions (AI-03)

_ARABIC_RANGES = ((0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF))


def has_arabic_script(s: str) -> bool:
    """Arabic-script text (Arabic, Urdu, Persian); mirrors translation.ts hasArabicScript."""
    return any(a <= ord(c) <= b for c in s for a, b in _ARABIC_RANGES)


_FINE = 64


@lru_cache(maxsize=64)
def _fine_variant(font, size: int):
    """The same font file at 64 x size: its advances are (nearly) unhinted, the fractional widths
    Chrome measures, where FreeType at the real size rounds each glyph's advance to whole pixels."""
    return font.font_variant(size=size * _FINE)


def fine_textlength(d: ImageDraw.ImageDraw, text: str, font, size: int) -> float:
    """Width of ``text`` as the preview's measureText gives it (within ~0.02 px): measured from the
    same font at 64 x size, divided by 64 (Rules.md section 4, caption text metrics)."""
    if isinstance(font, ImageFont.FreeTypeFont):
        try:
            return d.textlength(text, font=_fine_variant(font, size)) / _FINE
        except (OSError, ValueError):
            pass
    return d.textlength(text, font=font)


@lru_cache(maxsize=64)
def _shaped_variant(path: str, size: int):
    return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.RAQM)


def caption_face(font):
    """(font, text kwargs) the caption words are measured and drawn with: the same file through RAQM
    (HarfBuzz) with kerning off, as the preview draws them (fontKerning = none, default ligatures,
    fractional advances). BASIC layout draws each glyph at its hinted whole-pixel advance, which
    drifts along a word (Caveat 40 px "Lens" 65 px drawn vs 62.77 measured) and ignores ligatures
    (Lobster). Falls back to the font as given when Pillow has no libraqm."""
    if isinstance(font, ImageFont.FreeTypeFont) and getattr(font, "path", None) and _pil_features.check("raqm"):
        try:
            return _shaped_variant(str(font.path), int(font.size)), {"features": ["-kern"]}
        except OSError:
            pass
    return font, {}


def draw_caption(d: ImageDraw.ImageDraw, cap, cs: dict, W: int, H: int, base: Optional[Image.Image] = None) -> None:
    """Styled caption: wrapped lines, optional pill background, per-word highlight.

    Translated captions (demand #8): Arabic-script words use the plan's script font with RAQM
    shaping (HarfBuzz joining, right-to-left glyph order, no kerning, as the preview draws them);
    a right-to-left caption carries each line's left-to-right word order in cap["visual"]
    (word-level bidi from the engine). All words of a line share one baseline.

    Second batch of styles (Windows v0.1.3 "add more styles"), each field optional (captionStyles.ts
    captionEffects / captionMotion, mirrored here): background per line / word, square corners or a
    full-width bar with an accent stripe, a frosted backdrop (``base`` is the frame under the caption
    layer), glow and drop shadow (the words' silhouette blurred), gradient fill, second-line colour,
    reveal (cap["shown"]) and the pill / underline / karaoke / pop / bounce highlights (cap["progress"])."""
    if isinstance(cap, str):  # plans from before caption styling
        cap = {"text": cap, "words": cap.split(), "lines": [len(cap.split())], "active": -1}
    # caption styling (Windows request "diff diff fonts"): absent fields = the original look
    bold = cs.get("weight", "bold") != "regular"
    upper = cs.get("uppercase") is True
    words = [w.upper() for w in cap["words"]] if upper else cap["words"]
    if not words:
        return
    layer = d._image
    size = max(10, int(round(cs.get("fontSize", H * 0.04))))
    # theme / brand font (demand #9): same BASIC-layout file the preview loads; default unchanged
    font = text_font(size, bold, cs["font"]) if cs.get("font") else (_font(size) if bold else text_font(size, False, None))
    sfont = shaped_font(size, bold, cs["scriptFont"]) if cs.get("scriptFont") else None
    script = [bool(sfont) and has_arabic_script(w) for w in words]
    # a right-to-left line is one Arabic-script run: its spaces come from the script font, shaped, as
    # a full-line shaper (HarfBuzz itemising by script) would take them; left-to-right lines unchanged
    rtl_line = bool(cap.get("visual")) and any(script)
    tfont, tkw = caption_face(font)
    space = d.textlength(" ", font=sfont, direction="rtl", features=["-kern"]) if rtl_line else (d.textlength(" ", font=tfont, **tkw) if tkw else fine_textlength(d, " ", font, size))

    def wlen(j: int) -> float:
        if script[j]:
            return d.textlength(words[j], font=sfont, direction="rtl", features=["-kern"])
        return d.textlength(words[j], font=tfont, **tkw) if tkw else fine_textlength(d, words[j], font, size)

    lines, i = [], 0
    for n in cap["lines"]:
        lines.append(list(range(i, i + n)))
        i += n
    widths = [[wlen(j) for j in ln] for ln in lines]
    line_w = [sum(ws) + space * (len(ws) - 1) for ws in widths]
    asc, desc = font.getmetrics() if hasattr(font, "getmetrics") else (size, size // 4)
    main_asc = asc
    s_asc = asc
    if any(script):
        s_asc, s_desc = sfont.getmetrics()
        asc, desc = max(asc, s_asc), max(desc, s_desc)
    lh = int((asc + desc) * 1.12)
    block_h = lh * len(lines)
    pos = cs.get("position", "bottom")
    if pos == "top":
        top = int(H * 0.07)
    elif pos == "custom":
        top = int(cs.get("y", 0.88) * H - block_h / 2)
    else:
        top = int(H * 0.93) - block_h
    padx, pady = size * 0.55, size * 0.28
    fx = caption_effects(cs)
    hs = cs.get("highlightStyle") if cs.get("highlightStyle") in HIGHLIGHT_STYLES else "color"
    active = cap.get("active", -1) if cs.get("wordHighlight", True) else -1
    shown = cap.get("shown")

    def visible(j: int) -> bool:
        return shown is None or j < shown

    scale, lift, sweep = caption_motion(hs, cap.get("progress"))
    visual = cap.get("visual")
    placed = []
    for li, ln in enumerate(lines):
        x = (W - line_w[li]) / 2
        y = top + li * lh
        order = visual[li] if visual else ln
        for j in order:
            wj = widths[li][ln.index(j)]
            placed.append((j, li, x, y, wj))
            x += wj + space
    big = max(1, _js_round(size * scale))
    big_font = text_font(big, bold, cs.get("font")) if cs.get("font") else (_font(big) if bold else text_font(big, False, None))
    big_tfont, big_kw = caption_face(big_font)

    def word_pos(j: int, x: float, y: float, wj: float):
        """(font, x, baseline offset dy, scaled) for word j: the spoken word under pop / bounce moves."""
        if j != active or hs not in ("pop", "bounce"):
            return x, 0, False
        dy = -_js_round(size * lift)
        if hs == "bounce" or scale == 1:
            return x, dy, False
        bw = d.textlength(words[j], font=big_tfont, **big_kw) if big_kw else fine_textlength(d, words[j], big_font, big)
        return x + (wj - bw) / 2, dy, True

    def draw_word(dr: ImageDraw.ImageDraw, j: int, x: float, y: float, dy: int, scaled: bool, fill, sk: dict) -> None:
        if script[j]:
            # each word from its own ascender, so every word sits on the line's baseline (y + asc)
            dr.text((x, y + asc - s_asc + dy), words[j], font=sfont, fill=fill, direction="rtl", features=["-kern"], **sk)
        elif scaled:
            b_asc = big_font.getmetrics()[0]
            dr.text((x, y + asc - b_asc + dy), words[j], font=big_tfont, fill=fill, **big_kw, **sk)
        else:
            dr.text((x, y + asc - main_asc + dy), words[j], font=tfont, fill=fill, **tkw, **sk)

    st = cs.get("stroke") or {}
    stroke_px = max(1, int(_js_round(size * float(st.get("width", 0.08))))) if st.get("enabled") else 0
    stroke_rgb = (*hex_to_rgb(st.get("color", "#000000")), 255)

    # 1. background(s)
    bg = cs.get("background", {})
    if bg.get("enabled", True):
        r, g, b = hex_to_rgb(bg.get("color", "#000000"))
        rects = _caption_rects(fx, [p for p in placed if visible(p[0])], len(lines), line_w, W, top, block_h, asc, size, padx, pady)
        if fx["backdropBlur"] > 0 and base is not None and rects:
            _blur_under(base, rects, size * fx["backdropBlur"], W, H)
        for (qx, qy, qw, qh, qr) in rects:
            d.rounded_rectangle((qx, qy, qx + qw, qy + qh), radius=qr, fill=(r, g, b, int(255 * float(bg.get("opacity", 0.66)))))
        if fx["accent"] and rects:
            qx, qy, qw, qh, _ = rects[0]
            ax = round_half_up((W - max(line_w)) / 2 - padx) if fx["boxShape"] == "bar" else round_half_up(qx)
            aw = max(2, _js_round(size * 0.12))
            d.rectangle((ax, round_half_up(qy), ax + aw - 1, round_half_up(qy) + round_half_up(qh)), fill=(*hex_to_rgb(fx["accent"]), 255))

    # 2. glow, then drop shadow: the words' silhouette (with outline), blurred, under everything else
    def ghost(color: str, opacity: float, dx: int, dy_: int, sigma: float) -> None:
        m = int(math.ceil(sigma * 3)) + 2 + max(abs(dx), abs(dy_))
        x0 = max(0, int(math.floor(min(p[2] for p in placed))) - m - size)
        x1 = min(W, int(math.ceil(max(p[2] + p[4] for p in placed))) + m + size)
        y0 = max(0, int(top) - m - size)
        y1 = min(H, int(top + block_h) + m + size)
        if x1 <= x0 or y1 <= y0:
            return
        mask = Image.new("L", (x1 - x0, y1 - y0), 0)
        md = ImageDraw.Draw(mask)
        sk = {"stroke_width": stroke_px, "stroke_fill": 255} if stroke_px else {}
        for j, li, x, y, wj in placed:
            if not visible(j):
                continue
            wx, wdy, sc = word_pos(j, x, y, wj)
            draw_word(md, j, wx - x0 + dx, y - y0 + dy_, wdy, sc, 255, sk)
        if sigma > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(sigma))
        if opacity < 1:
            mask = mask.point(lambda v: int(v * opacity + 0.5))
        col = Image.new("RGBA", mask.size, (*hex_to_rgb(color), 255))
        col.putalpha(mask)
        layer.alpha_composite(col, (x0, y0))

    if fx["glow"]:
        ghost(fx["glow"]["color"], 1.0, 0, 0, size * fx["glow"]["radius"])
    if fx["shadow"]:
        sh = fx["shadow"]
        ghost(sh["color"], float(sh["opacity"]), _js_round(size * sh["dx"]), _js_round(size * sh["dy"]), size * sh["blur"])

    # 3. highlight decorations under the text
    hi_hex = cs.get("highlightColor", "#ffd23f")
    hi_rgb = hex_to_rgb(hi_hex)
    box_hi = hs in ("box", "pill") and active >= 0
    ap = next((p for p in placed if p[0] == active and visible(p[0])), None) if active >= 0 else None
    if box_hi and ap is not None:
        j, li, x, y, wj = ap
        if hs == "pill":
            pad = _js_round(size * 0.28)
            bh_ = _js_round(size * 1.14)
            bx, by, bw_, rad = _js_round(x) - pad, y + asc - _js_round(size * 0.88), _js_round(wj) + 2 * pad, int(bh_ / 2)
        else:
            pad = int(_js_round(size * 0.16))
            bx, by = int(_js_round(x)) - pad, y + asc - int(_js_round(size * 0.9))
            bw_, bh_, rad = int(_js_round(wj)) + 2 * pad, int(_js_round(size * 1.16)), int(size * 0.22)
        d.rounded_rectangle((bx, by, bx + bw_, by + bh_), radius=rad, fill=(*hi_rgb, 255))
    if hs == "underline" and ap is not None:
        j, li, x, y, wj = ap
        uw = _js_round(wj * sweep)
        if uw > 0:
            ux, uy, uh = _js_round(x), y + asc + _js_round(size * 0.12), max(2, _js_round(size * 0.08))
            d.rectangle((ux, uy, ux + uw - 1, uy + uh - 1), fill=(*hi_rgb, 255))

    # 4. words: outline, then fill (highlight colour, gradient, second-line colour or the text colour)
    text_rgb = hex_to_rgb(cs.get("textColor", "#ffffff"))
    line2 = hex_to_rgb(fx["line2Color"]) if fx["line2Color"] else None
    box_text = (17, 19, 24) if _luminance(hi_rgb) > 0.45 else (255, 255, 255)
    grad = fx["gradient"]
    grad_words: dict[int, list] = {}
    for j, li, x, y, wj in placed:
        if not visible(j):
            continue
        wx, wdy, sc = word_pos(j, x, y, wj)
        on_box = box_hi and j == active
        lit = active >= 0 and ((j <= active) if hs == "karaoke" else (j == active and hs in ("color", "pop", "bounce")))
        base_rgb = line2 if (li >= 1 and line2) else text_rgb
        sk = {"stroke_width": stroke_px, "stroke_fill": stroke_rgb} if stroke_px and not on_box else {}
        if on_box or lit or not grad:
            fill = (*(box_text if on_box else hi_rgb if lit else base_rgb), 255)
            draw_word(d, j, wx, y, wdy, sc, fill, sk)
            continue
        # gradient: the outline now, the glyphs below (one vertical gradient per line, y .. y + lh)
        if sk:
            draw_word(d, j, wx, y, wdy, sc, stroke_rgb, sk)
        grad_words.setdefault(li, []).append((j, wx, y, wdy, sc))
    for li, ws in grad_words.items():
        y = ws[0][2]
        ry0, ry1 = max(0, y - size), min(H, y + lh + size)
        if ry1 <= ry0:
            continue
        mask = Image.new("L", (W, ry1 - ry0), 0)
        md = ImageDraw.Draw(mask)
        for j, wx, wy, wdy, sc in ws:
            draw_word(md, j, wx, wy - ry0, wdy, sc, 255, {})
        bbox = mask.getbbox()
        if not bbox:
            continue
        c0, c1 = np.array(hex_to_rgb(grad["from"]), np.float64), np.array(hex_to_rgb(grad["to"]), np.float64)
        t = np.clip((np.arange(ry0 + bbox[1], ry0 + bbox[3]) + 0.5 - y) / max(1e-6, lh), 0, 1)[:, None]
        cols = np.clip(np.round(c0 * (1 - t) + c1 * t), 0, 255).astype(np.uint8)
        gimg = np.empty((bbox[3] - bbox[1], bbox[2] - bbox[0], 4), np.uint8)
        gimg[..., :3] = cols[:, None, :]
        gimg[..., 3] = 255
        layer.paste(Image.fromarray(gimg, "RGBA"), (bbox[0], ry0 + bbox[1]), mask.crop(bbox))


HIGHLIGHT_STYLES = ("color", "box", "pill", "underline", "karaoke", "pop", "bounce")


def round_half_up(v: float) -> int:
    return int(math.floor(v + 0.5))


def caption_effects(cs: dict) -> dict:
    """captionStyles.ts captionEffects: absent / disabled fields filled in."""
    g, gl, sh = cs.get("gradient") or {}, cs.get("glow") or {}, cs.get("shadow") or {}
    return {
        "boxMode": cs.get("boxMode") if cs.get("boxMode") in ("line", "word") else "block",
        "boxShape": cs.get("boxShape") if cs.get("boxShape") in ("square", "bar") else "rounded",
        "accent": cs.get("accent"),
        "gradient": {"from": g["from"], "to": g["to"]} if g.get("enabled") else None,
        "glow": {"color": gl["color"], "radius": float(gl["radius"])} if gl.get("enabled") and float(gl.get("radius", 0)) > 0 else None,
        "shadow": dict(sh) if sh.get("enabled") and float(sh.get("opacity", 0)) > 0 else None,
        "backdropBlur": float(cs.get("backdropBlur") or 0),
        "line2Color": cs.get("line2Color"),
    }


def caption_motion(style: str, progress) -> tuple[float, float, float]:
    """captionStyles.ts captionMotion: (scale, lift as a fraction of the size, underline sweep)."""
    p = min(1.0, max(0.0, 1.0 if progress is None else float(progress)))
    if style == "pop":
        return 1.1 + 0.15 * (1 - min(1.0, p / 0.35)), 0.0, 1.0
    if style == "bounce":
        return 1.0, 0.18 * math.sin(math.pi * min(1.0, p / 0.45)), 1.0
    if style == "underline":
        q = min(1.0, p / 0.6)
        return 1.0, 0.0, 1 - (1 - q) * (1 - q)
    return 1.0, 0.0, 1.0


def _caption_rects(fx: dict, placed, n_lines: int, line_w, W: int, top: int, block_h: int, asc: int, size: int, padx: float, pady: float):
    """renderer.ts captionBackgroundRects: (x, y, w, h, radius) per background rect."""
    square = fx["boxShape"] != "rounded"
    if fx["boxShape"] == "bar":
        return [(0, top - pady, W, block_h + 2 * pady, 0)]
    if fx["boxMode"] == "block":
        bw = max(line_w)
        return [((W - bw) / 2 - padx, top - pady, bw + 2 * padx, block_h + 2 * pady, 0 if square else int(size * 0.45))]
    bh = _js_round(size * 1.25)
    rad = 0 if square else int(size * 0.3)
    out = []
    if fx["boxMode"] == "line":
        px = _js_round(size * 0.3)
        for li in range(n_lines):
            ws = [p for p in placed if p[1] == li]
            if not ws:
                continue
            lx = min(p[2] for p in ws)
            rx = max(p[2] + p[4] for p in ws)
            out.append((_js_round(lx) - px, ws[0][3] + asc - _js_round(size * 0.95), _js_round(rx - lx) + 2 * px, bh, rad))
        return out
    px = _js_round(size * 0.16)
    return [(_js_round(p[2]) - px, p[3] + asc - _js_round(size * 0.95), _js_round(p[4]) + 2 * px, bh, rad) for p in placed]


def _blur_under(base: Image.Image, rects, sigma: float, W: int, H: int) -> None:
    """Frosted background: the frame under the rects, Gaussian-blurred (sigma px), pasted back inside them."""
    m = int(math.ceil(sigma * 3))
    x0 = max(0, int(math.floor(min(q[0] for q in rects))) - m)
    y0 = max(0, int(math.floor(min(q[1] for q in rects))) - m)
    x1 = min(W, int(math.ceil(max(q[0] + q[2] + 1 for q in rects))) + m)
    y1 = min(H, int(math.ceil(max(q[1] + q[3] + 1 for q in rects))) + m)
    if x1 <= x0 or y1 <= y0:
        return
    region = base.crop((x0, y0, x1, y1)).filter(ImageFilter.GaussianBlur(sigma))
    mask = Image.new("L", (x1 - x0, y1 - y0), 0)
    md = ImageDraw.Draw(mask)
    for (qx, qy, qw, qh, qr) in rects:
        md.rounded_rectangle((qx - x0, qy - y0, qx - x0 + qw, qy - y0 + qh), radius=qr, fill=255)
    base.paste(region, (x0, y0), mask)


def _js_round(v: float) -> int:
    """JavaScript Math.round (half up), as the preview rounds outline width and highlight box."""
    return int(math.floor(v + 0.5))


def _luminance(rgb: tuple[int, int, int]) -> float:
    """Relative luminance (palette.ts luminance)."""
    def lin(c: int) -> float:
        v = c / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])


def _viewport_warp(frame: np.ndarray, cam: list[float], rect_w: int, rect_h: int, src_w: int, src_h: int, loupe: bool = False) -> np.ndarray:
    cx, cy, s = cam
    vw, vh = src_w / s, src_h / s
    x0, y0 = cx - vw / 2, cy - vh / 2
    kx, ky = rect_w / vw, rect_h / vh
    M = np.float32([[kx, 0, -x0 * kx], [0, ky, -y0 * ky]])
    interp = cv2.INTER_AREA if kx < 1 else cv2.INTER_CUBIC
    return cv2.warpAffine(frame, M, (rect_w, rect_h), flags=interp, borderMode=cv2.BORDER_REPLICATE)


class HeldFrames:
    """Second sequential decoder for the frames held still across cut joins (demand #14). Each wanted
    source frame is kept from the moment the decoder passes it until its last use, so a request that
    goes back in source time (the incoming side asks for the last outgoing frame) needs no re-decode."""

    def __init__(self, path: str, wanted_src: list[float]):
        info = probe(path)
        self.fps = info["fps"]
        self._w, self._h = info["width"], info["height"]
        self.path = path
        idx = [max(0, int(round(t * self.fps / 1000))) for t in wanted_src]
        self.uses: dict[int, int] = {}
        for i in idx:
            self.uses[i] = self.uses.get(i, 0) + 1
        self.cache: dict[int, np.ndarray] = {}
        self._restart()

    def _restart(self) -> None:
        self._it = read_frames(self.path, self._w, self._h)
        self._idx = -1
        self._last: Optional[np.ndarray] = None

    def at(self, t_ms: float) -> np.ndarray:
        want = max(0, int(round(t_ms * self.fps / 1000)))
        if want not in self.cache:
            if want <= self._idx:
                self._restart()
            while self._idx < want:
                try:
                    self._last = next(self._it)
                except StopIteration:
                    break
                self._idx += 1
                if self._idx in self.uses:
                    self.cache[self._idx] = self._last
            if want not in self.cache:
                assert self._last is not None, "empty video"
                return self._last
        fr = self.cache[want]
        self.uses[want] = self.uses.get(want, 1) - 1
        if self.uses[want] <= 0:
            self.cache.pop(want, None)
        return fr


def _ease_clamp(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def transition_layers(kind: str, u: float) -> tuple[dict, dict]:
    """Outgoing (a) and incoming (b) layer of a cut transition at eased progress u: alpha, scale about
    the centre, x offset as a fraction of the width, blur sigma as a fraction of the short side.
    Mirrors transitionLayers in packages/engine/src/transitions.ts."""
    v = _ease_clamp(u)
    L = lambda alpha=1.0, scale=1.0, dx=0.0, blur=0.0: {"alpha": alpha, "scale": scale, "dx": dx, "blur": blur}  # noqa: E731
    if kind == "push":
        return L(dx=-v), L(dx=1 - v)
    if kind == "zoom":
        return L(scale=1 + 0.35 * v), L(alpha=v, scale=1 + 0.15 * (1 - v))
    if kind == "blur":
        s = 0.025 * math.sin(math.pi * v)
        w = _ease_clamp((v - 0.3) / 0.4)
        return L(blur=s), L(alpha=w * w * (3 - 2 * w), blur=s)
    return L(), L(alpha=v)


def _blur_premul(img: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    """Gaussian blur of an opaque image with transparent surroundings (canvas filter: blur()):
    premultiplied colour and coverage."""
    H, W = img.shape[:2]
    col = cv2.GaussianBlur(img, (0, 0), sigma, borderType=cv2.BORDER_CONSTANT)
    cov = cv2.GaussianBlur(np.ones((H, W), np.float32), (0, 0), sigma, borderType=cv2.BORDER_CONSTANT)
    return col, cov


def _place(dst: np.ndarray, col: np.ndarray, cov: np.ndarray, alpha: float, scale: float, dx_px: float, dy_px: float) -> None:
    """dst = dst over (premultiplied col / coverage cov), scaled about the frame centre and offset, times alpha."""
    H, W = dst.shape[:2]
    if scale != 1 or dx_px or dy_px:
        M = np.float32([[scale, 0, (1 - scale) * W / 2 + dx_px], [0, scale, (1 - scale) * H / 2 + dy_px]])
        col = cv2.warpAffine(col, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        cov = cv2.warpAffine(cov, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    a = (cov * alpha)[..., None]
    dst *= 1 - a
    dst += col * alpha


def composite_transition(a_img: np.ndarray, b_img: np.ndarray, kind: str, u: float) -> np.ndarray:
    """Outgoing frame a and incoming frame b of a cut join composited at progress u on black, b over a
    (same steps as the editor renderer's PlanRenderer.draw)."""
    H, W = a_img.shape[:2]
    short = min(W, H)
    la, lb = transition_layers(kind, u)
    out = np.zeros((H, W, 3), np.float32)
    for img, l in ((a_img, la), (b_img, lb)):
        if l["alpha"] <= 0:
            continue
        col = img.astype(np.float32)
        cov = np.ones((H, W), np.float32)
        sigma = l["blur"] * short
        if sigma > 0.05:
            # blurred copy over the sharp one: the blur fades the edges, the sharp layer fills them
            bc, bv = _blur_premul(col, sigma)
            col = col * (1 - bv[..., None]) + bc
        _place(out, col, cov, min(1.0, l["alpha"]), l["scale"], l["dx"] * W, 0.0)
    return out


def draw_slide_fx(out: np.ndarray, items: list[dict], fx: list[float], bg: np.ndarray) -> None:
    """A text slide with its enter / exit transform (plan slide.fx = [dx, dy, scale, blur], demand #14):
    the slide is drawn alone (premultiplied, from a black and a white pass), offset, scaled about the
    frame centre and blurred, then laid over out."""
    H, W = out.shape[:2]
    dark = np.zeros_like(out)
    light = np.full_like(out, 255.0)
    ident = lambda px, py: (px, py)  # noqa: E731
    draw_items(dark, items, ident, 1.0, background=bg)
    draw_items(light, items, ident, 1.0, background=bg)
    cov = np.clip(1 - (light - dark).mean(axis=2) / 255.0, 0, 1).astype(np.float32)
    col = dark.astype(np.float32)
    dx, dy, scale, blur = (float(v) for v in fx[:4])
    if blur > 0.05:
        col = cv2.GaussianBlur(col, (0, 0), blur, borderType=cv2.BORDER_CONSTANT)
        cov = cv2.GaussianBlur(cov, (0, 0), blur, borderType=cv2.BORDER_CONSTANT)
    _place(out, col, cov, 1.0, scale, dx, dy)


def render(plan_path: str, screen_path: str, out_path: str, camera_path: Optional[str] = None, opts: RenderOptions = RenderOptions()) -> dict:
    plan = json.loads(Path(plan_path).read_text())
    W, H, fps = plan["output"]["width"], plan["output"]["height"], plan["output"]["fps"]
    style = plan["style"]
    full_w, full_h = plan["source"]["width"], plan["source"]["height"]
    screen = FrameSource(screen_path)
    if (screen.w, screen.h) != (full_w, full_h):
        raise ValueError(f"screen video is {screen.w}x{screen.h} but plan expects {full_w}x{full_h}")
    # Source crop (LOOK-14): plan positions are already in cropped space.
    crop_x, crop_y, src_w, src_h = (int(v) for v in plan["source"].get("crop", [0, 0, full_w, full_h]))
    cropped = (crop_x, crop_y, src_w, src_h) != (0, 0, full_w, full_h)
    cam_crop = style.get("cameraCrop")
    cam_mirror = bool(style.get("cameraMirror"))
    cap_style = style.get("captions", {"fontSize": H * 0.04})
    cam_src = FrameSource(camera_path) if camera_path else None
    bg = make_background(style, W, H)
    asset_dir = opts.asset_dir or str(Path(plan_path).resolve().parent)
    ann.ASSET_DIR[0] = Path(asset_dir)
    set_fonts(plan.get("fonts"), asset_dir)
    # a chosen caption font must be there: never draw the fallback face in its place
    cap_font = cap_style.get("font") if isinstance(cap_style, dict) else None
    if cap_font:
        fam = next((f for f in plan.get("fonts") or [] if f.get("family") == cap_font), None)
        files = [resolve_asset(fam[k], asset_dir) for k in ("regular", "bold")] if fam else []
        if not files or not all(Path(p).exists() for p in files):
            raise FileNotFoundError(f"caption font not available for the export: {cap_font}")
    watermark = plan.get("watermark")
    mb = style["motionBlur"]
    frame_ms = 1000 / fps
    font_pill = _font(max(14, int(H * 0.032)))

    out_path = str(out_path)
    is_gif = out_path.lower().endswith(".gif")
    want_audio = opts.audio and not is_gif and bool(plan.get("audio"))
    tmpdir = tempfile.mkdtemp(prefix="lens-render-") if (is_gif or want_audio) else None
    video_path = os.path.join(tmpdir, "video.mp4") if tmpdir else out_path
    crf = min(opts.crf, 12) if is_gif else opts.crf

    sink = opts.frame_sink
    enc = None if sink else subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
         *encoder_args(opts.preset, crf, None if is_gif else opts.bitrate, opts.maxrate), "-movflags", "+faststart", video_path],
        stdin=subprocess.PIPE,
    )
    assert sink or (enc and enc.stdin)
    frames = plan["frames"][: opts.max_frames] if opts.max_frames else plan["frames"]
    def frame_geom(f: dict):
        """Screen rect (output px), output px per source px and the source -> screen-rect mapping of a frame."""
        sx, sy, sw, sh = (int(round(v)) for v in f["layout"]["screen"])
        sw, sh = max(2, sw), max(2, sh)
        cam = f["cam"]
        k = sw / (src_w / cam[2])
        vw, vh = src_w / cam[2], src_h / cam[2]
        x0, y0 = cam[0] - vw / 2, cam[1] - vh / 2
        return (sx, sy, sw, sh), k, (lambda px, py: ((px - x0) * k, (py - y0) * (sh / vh)))

    def cursor_pos(f: Optional[dict]):
        """Where a frame's cursor sits in its screen rect (the previous frame's, for cursor motion blur)."""
        if f is None or f["cur"] is None:
            return None
        return frame_geom(f)[2](f["cur"][0], f["cur"][1])

    def draw_frame(f: dict, src_frame: np.ndarray, cam_at: Callable[[], np.ndarray], prev_f: Optional[dict]) -> np.ndarray:
        """Draw one plan frame (float32 BGR, H x W x 3). prev_f is the plan frame before it (cursor motion blur)."""
        if cropped:
            src_frame = np.ascontiguousarray(src_frame[crop_y:crop_y + src_h, crop_x:crop_x + src_w])
        sx, sy, sw, sh = (int(round(v)) for v in f["layout"]["screen"])
        sw, sh = max(2, sw), max(2, sh)
        out = bg.copy()

        # Shadow (cached per rect).
        shadow = style["shadow"]
        if f["layout"]["screenOpacity"] > 0 and shadow["opacity"] > 0:
            a = shadow_layer(W, H, (sx, sy, sw, sh), style["radius"], shadow["blur"], shadow["offsetY"], shadow["angle"], shadow["opacity"] * f["layout"]["screenOpacity"])
            out *= (1 - a[..., None])

        # Screen through the virtual camera, with optional motion blur along camera velocity.
        cam = f["cam"]
        vx, vy, vs = f["camVel"]
        k = sw / (src_w / cam[2])  # output px per source px
        speed_out = math.hypot(vx, vy) * k / fps + abs(vs) * sw / fps
        if mb["enabled"] and speed_out > 1.5:
            n = max(2, int(mb["samples"]))
            acc = np.zeros((sh, sw, 3), np.float32)
            shutter = mb["strength"] * frame_ms / 1000
            for j in range(n):
                dt = (j / (n - 1) - 0.5) * shutter
                c2 = [cam[0] + vx * dt, cam[1] + vy * dt, max(1.0, cam[2] + vs * dt)]
                acc += _viewport_warp(src_frame, c2, sw, sh, src_w, src_h).astype(np.float32)
            view = acc / n
        else:
            view = _viewport_warp(src_frame, cam, sw, sh, src_w, src_h).astype(np.float32)

        cx, cy, s = cam
        vw, vh = src_w / s, src_h / s
        x0, y0 = cx - vw / 2, cy - vh / 2

        def to_rect(px: float, py: float) -> tuple[float, float]:
            return (px - x0) * k, (py - y0) * (sh / vh)

        # Spotlight / privacy masks, glued to content through the camera transform.
        if f.get("masks"):
            view = apply_masks(view, f["masks"], to_rect, k, sh / vh)

        # Click effects (drawn inside the screen so they get the rounded mask).
        if style["clickEffect"] != "none":
            for (px, py, p) in f["clicks"]:
                rx, ry = to_rect(px, py)
                ease = 1 - (1 - p) ** 3
                radius = (8 + 34 * ease) * k * 0.75
                alpha = 0.55 * (1 - p)
                overlay = view.copy()
                if style["clickEffect"] in ("ripple", "circle"):
                    thickness = -1 if style["clickEffect"] == "circle" else max(2, int(3 * k))
                    cv2.circle(overlay, (int(rx), int(ry)), int(radius), (255, 255, 255), thickness, lineType=cv2.LINE_AA)
                else:
                    cv2.circle(overlay, (int(rx), int(ry)), int(radius * 1.2), (60, 220, 255), -1, lineType=cv2.LINE_AA)
                view = view * (1 - alpha) + overlay * alpha

        # Screen-anchored annotations (demand #4): through the camera, under the cursor.
        scr_ann = [a for a in f.get("annotations", []) if a["space"] == "screen"]
        if scr_ann:
            draw_items(view, scr_ann, to_rect, k)

        # Cursor (re-rendered from the log, A13/C02).
        if f["cur"] is not None:
            px, py, op, sc, shape = f["cur"]
            shape_name = shape if style["cursorShape"] == "system" else style["cursorShape"]
            base = 26 * style["cursorSize"] * plan["source"].get("pixelRatio", 1)
            size = max(6, int(round(base * k * sc)))
            sprite, (hx, hy) = cursor_sprite(shape_name)
            spr = cv2.resize(sprite, (size, size), interpolation=cv2.INTER_AREA if size < 256 else cv2.INTER_CUBIC)
            rx, ry = to_rect(px, py)
            prev_cur = cursor_pos(prev_f)
            if mb["enabled"] and prev_cur is not None:
                pdx, pdy = rx - prev_cur[0], ry - prev_cur[1]
                dist = math.hypot(pdx, pdy)
                if dist > 3:
                    n = min(int(mb["samples"]), max(2, int(dist / 3)))
                    for j in range(n):
                        u = (j + 1) / n
                        tx = prev_cur[0] + pdx * (1 - mb["strength"]) + pdx * mb["strength"] * u
                        ty = prev_cur[1] + pdy * (1 - mb["strength"]) + pdy * mb["strength"] * u
                        blend_rgba(view, spr, tx - hx * size, ty - hy * size, op / n * 1.0)
                else:
                    blend_rgba(view, spr, rx - hx * size, ry - hy * size, op)
            else:
                blend_rgba(view, spr, rx - hx * size, ry - hy * size, op)

        # Composite the screen with rounded corners.
        m = rounded_mask(sw, sh, style["radius"])[..., None] * f["layout"]["screenOpacity"]
        xs0, ys0, xs1, ys1 = max(0, sx), max(0, sy), min(W, sx + sw), min(H, sy + sh)
        if xs1 > xs0 and ys1 > ys0:
            region = out[ys0:ys1, xs0:xs1]
            vv = view[ys0 - sy:ys1 - sy, xs0 - sx:xs1 - sx]
            mm = m[ys0 - sy:ys1 - sy, xs0 - sx:xs1 - sx]
            out[ys0:ys1, xs0:xs1] = region * (1 - mm) + vv * mm

        # Webcam.
        if cam_src is not None and f["layout"]["camera"] is not None and f["layout"]["cameraOpacity"] > 0:
            cxr, cyr, cwr, chr_ = (int(round(v)) for v in f["layout"]["camera"])
            if cwr > 2 and chr_ > 2:
                cframe = cam_at()
                if cam_crop:
                    qx, qy, qw, qh = (int(round(v)) for v in cam_crop)
                    fh_, fw_ = cframe.shape[:2]
                    qx, qy = max(0, min(fw_ - 2, qx)), max(0, min(fh_ - 2, qy))
                    cframe = cframe[qy:min(fh_, qy + qh), qx:min(fw_, qx + qw)]
                if cam_mirror:
                    cframe = cv2.flip(cframe, 1)
                ch0, cw0 = cframe.shape[:2]
                sc_ = max(cwr / cw0, chr_ / ch0)
                rs = cv2.resize(cframe, (math.ceil(cw0 * sc_), math.ceil(ch0 * sc_)), interpolation=cv2.INTER_AREA)
                oy, ox = (rs.shape[0] - chr_) // 2, (rs.shape[1] - cwr) // 2
                crop = rs[oy:oy + chr_, ox:ox + cwr].astype(np.float32)
                shape = style["cameraShape"]
                rad = min(cwr, chr_) / 2 if shape == "circle" else (0 if shape == "square" else min(cwr, chr_) * 0.12)
                cm = rounded_mask(cwr, chr_, rad)[..., None] * f["layout"]["cameraOpacity"]
                xa, ya, xb, yb = max(0, cxr), max(0, cyr), min(W, cxr + cwr), min(H, cyr + chr_)
                if xb > xa and yb > ya:
                    out[ya:yb, xa:xb] = out[ya:yb, xa:xb] * (1 - cm[ya - cyr:yb - cyr, xa - cxr:xb - cxr]) + crop[ya - cyr:yb - cyr, xa - cxr:xb - cxr] * cm[ya - cyr:yb - cyr, xa - cxr:xb - cxr]

        # Frame-anchored annotations: fixed overlay above the webcam.
        frm_ann = [a for a in f.get("annotations", []) if a["space"] == "frame"]
        if frm_ann:
            draw_items(out, frm_ann, lambda px, py: (px, py), 1.0)

        # Text overlays drawn with PIL for full Unicode (⌘ ⇧ ⌥).
        if f["shortcut"] or f["caption"]:
            pil = Image.fromarray(cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_BGR2RGB)).convert("RGBA")
            layer = Image.new("RGBA", pil.size, (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            if f["shortcut"]:
                tb = d.textbbox((0, 0), f["shortcut"], font=font_pill)
                tw, th = tb[2] - tb[0], tb[3] - tb[1]
                padx, pady = int(th * 0.9), int(th * 0.6)
                bx = (W - tw) // 2 - padx
                by = int(H * 0.86) - th - pady
                d.rounded_rectangle((bx, by, bx + tw + 2 * padx, by + th + 2 * pady), radius=int(th * 0.7), fill=(15, 15, 18, 215))
                d.text((bx + padx - tb[0], by + pady - tb[1]), f["shortcut"], font=font_pill, fill=(255, 255, 255, 255))
            if f["caption"]:
                draw_caption(d, f["caption"], cap_style, W, H, base=pil)
            pil = Image.alpha_composite(pil, layer).convert("RGB")
            out = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR).astype(np.float32)

        # Brand watermark above the caption (slides cover it).
        if watermark:
            draw_watermark(out, watermark, asset_dir)

        # Text slide: full frame, over everything, cross-faded by its opacity.
        if f.get("slide"):
            sl = f["slide"]
            items = [{"ops": sl["ops"], "opacity": sl["opacity"], "shadow": None}]
            fx = sl.get("fx")
            if fx:
                draw_slide_fx(out, items, fx, bg)
            else:
                draw_items(out, items, lambda px, py: (px, py), 1.0, background=bg)
        return out

    all_frames = plan["frames"]
    # Cut transitions (demand #14): a frame near a cut join is composited with the other side of the
    # join (frame tr.other, held still). Those source frames come from a second decoder.
    held_idx = sorted({f["tr"]["other"] for f in frames if f.get("tr") and 0 <= f["tr"]["other"] < len(all_frames)})
    # the screen picture of a frame is at "vid" (a freeze frame, demand #20, holds it), the camera at "src"
    held_vid = [all_frames[i].get("vid", all_frames[i]["src"]) for i in held_idx]
    held_src = [all_frames[i]["src"] for i in held_idx]
    held = HeldFrames(screen_path, held_vid) if held_idx else None
    held_cam = HeldFrames(camera_path, held_src) if held_idx and camera_path else None
    for fi, f in enumerate(frames):
        src_frame = screen.at(f.get("vid", f["src"]))  # a freeze frame (demand #20) holds the screen picture
        prev_f = all_frames[fi - 1] if fi > 0 else None
        out = draw_frame(f, src_frame, lambda: cam_src.at(f["src"]), prev_f)
        tr = f.get("tr")
        if tr and 0 <= tr["other"] < len(all_frames):
            oi = tr["other"]
            of = all_frames[oi]
            other = draw_frame(of, held.at(of.get("vid", of["src"])), lambda: held_cam.at(of["src"]), all_frames[oi - 1] if oi > 0 else None)
            a_img, b_img = (other, out) if tr["incoming"] else (out, other)
            out = composite_transition(a_img, b_img, tr["kind"], tr["u"])
        final = np.clip(out, 0, 255).astype(np.uint8)
        if sink:
            sink(fi, final)
        else:
            enc.stdin.write(final.tobytes())
        if opts.progress:
            opts.progress(fi + 1, len(frames))

    info = {"frames": len(frames), "width": W, "height": H, "fps": fps, "out": out_path, "audio": False}
    if sink:
        if tmpdir:
            os.rmdir(tmpdir)
        return info
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError("ffmpeg encode failed")
    try:
        if is_gif:
            g = plan.get("export", {}).get("gif", {"fps": 15, "width": 640, "loop": True})
            export_gif(video_path, out_path, g["fps"], g["width"], g["loop"])
            info["gif"] = g
        elif want_audio:
            sr = int(plan["audio"]["sampleRate"])
            n_out = int(round(len(frames) / fps * sr))
            pcm = build_audio(plan, Path(plan_path).resolve().parent, n_out)
            if pcm is not None:
                mux_audio(video_path, pcm, sr, out_path)
                info["audio"] = True
            else:
                os.replace(video_path, out_path)
    finally:
        if tmpdir:
            for fn in os.listdir(tmpdir):
                os.remove(os.path.join(tmpdir, fn))
            os.rmdir(tmpdir)
    return info
