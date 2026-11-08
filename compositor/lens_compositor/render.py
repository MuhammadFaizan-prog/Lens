"""Reference compositor: draws a Lens render plan onto a cursorless screen recording.

This is the CPU reference implementation of the render graph described in Techspec.md. The
production compositor (wgpu, Rust) must produce the same pixels for the same plan; golden tests
compare the two. Order of passes per frame:

  background -> shadow -> screen (camera transform, motion blur, rounded mask)
  -> click effects -> cursor (with motion blur) -> webcam -> shortcut pill -> caption

All motion decisions come from the plan. This file only draws.
"""
from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterator, Optional

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/SFNS.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
]


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def hex_to_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (b, g, r)


# ---------------------------------------------------------------- background

def make_background(style: dict, w: int, h: int) -> np.ndarray:
    bg = style["background"]
    kind = bg.get("kind", "solid")
    colors = [np.array(hex_to_bgr(c), dtype=np.float32) for c in bg.get("colors", ["#202020"])]
    if kind == "image" and bg.get("imagePath") and Path(bg["imagePath"]).exists():
        img = cv2.imread(bg["imagePath"])
        ih, iw = img.shape[:2]
        s = max(w / iw, h / ih)
        img = cv2.resize(img, (math.ceil(iw * s), math.ceil(ih * s)), interpolation=cv2.INTER_AREA)
        y0 = (img.shape[0] - h) // 2
        x0 = (img.shape[1] - w) // 2
        out = img[y0:y0 + h, x0:x0 + w].astype(np.float32)
    elif kind == "gradient" and len(colors) >= 2:
        ang = math.radians(bg.get("angle", 135))
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        dx, dy = math.sin(ang), -math.cos(ang)
        proj = (xx - w / 2) * dx + (yy - h / 2) * dy
        span = abs(w / 2 * dx) + abs(h / 2 * dy)
        u = np.clip((proj / span + 1) / 2, 0, 1)
        n = len(colors) - 1
        idx = np.minimum((u * n).astype(int), n - 1)
        frac = (u * n - idx)[..., None]
        c = np.stack(colors)
        out = c[idx] * (1 - frac) + c[idx + 1] * frac
    else:
        out = np.broadcast_to(colors[0], (h, w, 3)).copy()
    if bg.get("blur", 0) > 0:
        out = cv2.GaussianBlur(out, (0, 0), bg["blur"])
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
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
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


# ---------------------------------------------------------------- render

@dataclass
class RenderOptions:
    crf: int = 18
    preset: str = "medium"
    max_frames: Optional[int] = None


def _viewport_warp(frame: np.ndarray, cam: list[float], rect_w: int, rect_h: int, src_w: int, src_h: int, loupe: bool = False) -> np.ndarray:
    cx, cy, s = cam
    vw, vh = src_w / s, src_h / s
    x0, y0 = cx - vw / 2, cy - vh / 2
    kx, ky = rect_w / vw, rect_h / vh
    M = np.float32([[kx, 0, -x0 * kx], [0, ky, -y0 * ky]])
    interp = cv2.INTER_AREA if kx < 1 else cv2.INTER_CUBIC
    return cv2.warpAffine(frame, M, (rect_w, rect_h), flags=interp, borderMode=cv2.BORDER_REPLICATE)


def render(plan_path: str, screen_path: str, out_path: str, camera_path: Optional[str] = None, opts: RenderOptions = RenderOptions()) -> dict:
    plan = json.loads(Path(plan_path).read_text())
    W, H, fps = plan["output"]["width"], plan["output"]["height"], plan["output"]["fps"]
    style = plan["style"]
    src_w, src_h = plan["source"]["width"], plan["source"]["height"]
    screen = FrameSource(screen_path)
    if (screen.w, screen.h) != (src_w, src_h):
        raise ValueError(f"screen video is {screen.w}x{screen.h} but plan expects {src_w}x{src_h}")
    cam_src = FrameSource(camera_path) if camera_path else None
    bg = make_background(style, W, H)
    mb = style["motionBlur"]
    frame_ms = 1000 / fps
    font_pill = _font(max(14, int(H * 0.032)))
    font_cap = _font(max(14, int(H * 0.04)))

    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
         "-c:v", "libx264", "-preset", opts.preset, "-crf", str(opts.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path],
        stdin=subprocess.PIPE,
    )
    assert enc.stdin
    frames = plan["frames"][: opts.max_frames] if opts.max_frames else plan["frames"]
    prev_cur = None
    for f in frames:
        src_frame = screen.at(f["src"])
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

        # Cursor (re-rendered from the log, A13/C02).
        if f["cur"] is not None:
            px, py, op, sc, shape = f["cur"]
            shape_name = shape if style["cursorShape"] == "system" else style["cursorShape"]
            base = 26 * style["cursorSize"] * plan["source"].get("pixelRatio", 1)
            size = max(6, int(round(base * k * sc)))
            sprite, (hx, hy) = cursor_sprite(shape_name)
            spr = cv2.resize(sprite, (size, size), interpolation=cv2.INTER_AREA if size < 256 else cv2.INTER_CUBIC)
            rx, ry = to_rect(px, py)
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
            prev_cur = (rx, ry)
        else:
            prev_cur = None

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
                cframe = cam_src.at(f["src"])
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
                tb = d.textbbox((0, 0), f["caption"], font=font_cap)
                tw, th = tb[2] - tb[0], tb[3] - tb[1]
                x = (W - tw) // 2
                y = int(H * 0.93) - th
                d.rounded_rectangle((x - th * 0.6, y - th * 0.4, x + tw + th * 0.6, y + th * 1.4), radius=int(th * 0.4), fill=(0, 0, 0, 170))
                d.text((x - tb[0], y - tb[1]), f["caption"], font=font_cap, fill=(255, 255, 255, 255))
            pil = Image.alpha_composite(pil, layer).convert("RGB")
            out = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR).astype(np.float32)

        enc.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())

    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError("ffmpeg encode failed")
    return {"frames": len(frames), "width": W, "height": H, "fps": fps, "out": out_path}
