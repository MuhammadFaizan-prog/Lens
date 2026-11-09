"""Scan a screen recording for sensitive text and turn it into tracked, timed mask regions.

Two passes over the video, all on-device:

1. Analysis. Every frame is reduced to a 1/4-size grey image. Frame-to-frame global motion (the
   scroll) comes from phase correlation; the motion-compensated residual (each pixel matched either
   unshifted or shifted, whichever is closer, so static chrome and scrolled content both match)
   flags scene changes. Sample frames for OCR are chosen at a fixed interval (skipped while nothing
   changed), right after each scene change, and whenever the content has scrolled a third of the
   screen since the last sample. Notification banners are found here: a corner region that differs
   from the frame before the change and then stays still.
2. OCR (Tesseract, batched, two workers) on the samples, classified by `classify.py`.
3. Tracking. A second decode at full resolution follows each hit frame by frame with normalised
   cross-correlation template matching around a prediction (own velocity or the global shift),
   widening the search when that fails and falling back to matching parts of the box when it is
   partly covered or partly off-screen. New hits are tracked backwards through a frame buffer to the
   moment they appeared, so frames before the first OCR sample are covered too. Hits at a sample are
   linked to live tracks by IoU.
4. Tracks become detections: tracks with the same type and (fuzzy) same text are one review item;
   each track becomes one mask with a key rect per frame where it moved.
"""
from __future__ import annotations

import json
import math
import subprocess
import tempfile
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Optional

import cv2
import numpy as np

from .classify import mask_preview
from .frame import FrameHit, hits_from_words
from .ocr import _run_batch

VERSION = 1


@dataclass
class ScanSettings:
    interval_ms: float = 1000.0
    scene_threshold: float = 4.0       # mean motion-compensated residual (grey levels, 1/4 size)
    tile_threshold: float = 12.0       # ... or its mean in any one of 8 x 6 tiles (a banner, a dialog)
    scroll_fraction: float = 0.33      # resample after this much scroll (fraction of the height)
    settle_frames: int = 3             # sample this many frames after a scene change
    min_gap_ms: float = 200.0
    notifications: bool = True
    pad_px: int = 6                    # mask padding around the text box
    match_threshold: float = 0.72      # NCC to keep following a box
    workers: int = 2
    buffer_frames: int = 72            # backward tracking reach (frames kept at full resolution)
    types: tuple[str, ...] = ("email", "phone", "card", "api_key", "token", "jwt", "ip", "notification")


def probe(path: str) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                          "stream=width,height,r_frame_rate,nb_read_packets", "-of", "json", path], check=True, capture_output=True, text=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": float(num) / float(den), "frames": int(s.get("nb_read_packets", 0))}


def decode(path: str, w: int, h: int, fmt: str = "gray") -> Iterator[np.ndarray]:
    ch = 1 if fmt == "gray" else 3
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", fmt, "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=w * h * ch * 2)
    assert p.stdout
    n = w * h * ch
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            a = np.frombuffer(buf, np.uint8)
            yield a.reshape(h, w) if ch == 1 else a.reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.kill()
        p.wait()


# ------------------------------------------------------------------ pass 1: analysis


def _shift(a: np.ndarray, b: np.ndarray) -> tuple[float, float, float]:
    """Global translation from a to b (small grey frames) and the phase-correlation response."""
    win = getattr(_shift, "_win", None)
    if win is None or win.shape != a.shape:
        win = cv2.createHanningWindow((a.shape[1], a.shape[0]), cv2.CV_32F)
        _shift._win = win  # type: ignore[attr-defined]
    (dx, dy), resp = cv2.phaseCorrelate(a.astype(np.float32), b.astype(np.float32), win)
    return dx, dy, resp


def _translate(img: np.ndarray, dx: float, dy: float) -> np.ndarray:
    m = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(img, m, (img.shape[1], img.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


@dataclass
class Analysis:
    fps: float
    width: int
    height: int
    n: int
    shift: list[tuple[float, float]]          # per frame, full-res px, from the previous frame
    residual: list[float]
    samples: list[int]
    sample_reason: dict[int, str]
    notifications: list[tuple[int, tuple[int, int, int, int]]]  # (frame, box) confirmed banners


def analyse(video: str, s: ScanSettings, scroll_frames: Optional[set[int]] = None, sample_dir: Optional[Path] = None,
            progress: Optional[Callable[[str, int, int], None]] = None) -> Analysis:
    info = probe(video)
    W, H, fps = info["width"], info["height"], info["fps"]
    q = 4
    sw, sh = W // q, H // q
    interval = max(1, int(round(s.interval_ms * fps / 1000)))
    min_gap = max(1, int(round(s.min_gap_ms * fps / 1000)))
    small_hist: deque[tuple[int, np.ndarray]] = deque(maxlen=64)
    shifts: list[tuple[float, float]] = []
    resid: list[float] = []
    samples: list[int] = []
    reason: dict[int, str] = {}
    pending_scene: list[int] = []
    pending_notif: list[int] = []
    notifs: list[tuple[int, tuple[int, int, int, int]]] = []
    last_sample = -10**9
    cum_since = [0.0, 0.0]
    changed_since = False
    prev = None
    i = -1

    def take(i: int, frame: np.ndarray, why: str) -> None:
        nonlocal last_sample, cum_since, changed_since
        samples.append(i)
        reason[i] = why
        last_sample = i
        cum_since = [0.0, 0.0]
        changed_since = False
        if sample_dir is not None:
            cv2.imwrite(str(sample_dir / f"{i:06d}.png"), cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), [cv2.IMWRITE_PNG_COMPRESSION, 1])
            cv2.imwrite(str(sample_dir / f"{i:06d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

    total = info["frames"] or 1
    for i, frame in enumerate(decode(video, W, H, "bgr24")):
        half = cv2.cvtColor(cv2.resize(frame, (W // 2, H // 2), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        g = cv2.resize(half, (sw, sh), interpolation=cv2.INTER_AREA)
        if prev is None:
            shifts.append((0.0, 0.0))
            resid.append(0.0)
        else:
            dx, dy, resp = _shift(prev, g)
            if resp < 0.05 or abs(dx) > sw / 3 or abs(dy) > sh / 3:
                dx = dy = 0.0
            plain = cv2.absdiff(prev, g)
            moved = cv2.absdiff(_translate(prev, dx, dy), g) if (abs(dx) > 0.25 or abs(dy) > 0.25) else plain
            mres = np.minimum(plain, moved)
            r = float(mres.mean())
            tile = float(cv2.resize(mres.astype(np.float32), (8, 6), interpolation=cv2.INTER_AREA).max())
            # sub-pixel "global motion" is noise from local motion (a card moving over a still page)
            dxq, dyq = dx * q, dy * q
            dxq = 0.0 if abs(dxq) < 1.0 else dxq
            dyq = 0.0 if abs(dyq) < 1.0 else dyq
            shifts.append((dxq, dyq))
            resid.append(r)
            cum_since[0] += dxq
            cum_since[1] += dyq
            if r > 0.6 or abs(dx) > 0.25 or abs(dy) > 0.25:
                changed_since = True
            if r > s.scene_threshold or tile > s.tile_threshold:
                pending_scene.append(i + s.settle_frames)
                if s.notifications:
                    pending_notif.append(i)
        small_hist.append((i, half))
        why = None
        if i == 0:
            why = "first"
        elif pending_scene and i >= pending_scene[0]:
            while pending_scene and pending_scene[0] <= i:
                pending_scene.pop(0)
            if i - last_sample >= min_gap:
                why = "scene"
        elif abs(cum_since[1]) > s.scroll_fraction * H or abs(cum_since[0]) > s.scroll_fraction * W:
            why = "scroll"
        elif i - last_sample >= interval and changed_since:
            why = "interval"
        if scroll_frames and why is None and i in scroll_frames and i - last_sample >= interval // 2 and changed_since:
            why = "scroll-event"
        if why:
            take(i, frame, why)
        # notification confirmation: needs the frames 15 and 27 after the change
        while pending_notif and i >= pending_notif[0] + 27:
            c = pending_notif.pop(0)
            box = _confirm_notification(small_hist, c, W // 2, H // 2, 2, shifts)
            if box and not any(abs(c - f) < fps * 1.0 and _iou(box, b) > 0.3 for f, b in notifs):
                notifs.append((c + 15, box))
        prev = g
        if progress and i % 30 == 0:
            progress("analyse", i, total)
    n = i + 1
    return Analysis(fps, W, H, n, shifts, resid, samples, reason, notifs)


def _iou(a, b) -> float:
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = ix * iy
    u = aw * ah + bw * bh - inter
    return inter / u if u > 0 else 0.0


def _confirm_notification(hist, c: int, hw: int, hh: int, q: int, shifts: list[tuple[float, float]]) -> Optional[tuple[int, int, int, int]]:
    """A banner: in a screen corner, a block of edges (outline + text) that is new relative to the
    frame before the change (c-1) and not explained by the scroll since then, present 15 frames
    later, and still 12 frames after that while the content around it may scroll on.
    hist holds half-resolution grey frames; q is the factor back to source px; shifts are the
    per-frame global motions in source px."""
    d = {i: g for i, g in hist}
    if (c - 1) not in d or (c + 15) not in d or (c + 27) not in d:
        return None
    k3 = np.ones((3, 3), np.uint8)

    def cum(a: int, b: int) -> tuple[float, float]:
        return (sum(shifts[k][0] for k in range(a + 1, b + 1)) / q, sum(shifts[k][1] for k in range(a + 1, b + 1)) / q)

    before = d[c - 1].astype(np.int16)
    now = d[c + 15].astype(np.int16)
    later = d[c + 27].astype(np.int16)
    s1 = cum(c - 1, c + 15)
    s2 = cum(c + 15, c + 27)
    # new: differs from the frame before the change, also once that frame is moved by the scroll
    new = (np.abs(now - before) > 24) & (np.abs(now - _translate(d[c - 1], *s1).astype(np.int16)) > 24)
    # still: unchanged 12 frames later; when the content scrolled meanwhile, not explained by it
    still = np.abs(later - now) < 10
    if abs(s2[0]) + abs(s2[1]) >= 2:
        still &= np.abs(later - _translate(d[c + 15], *s2).astype(np.int16)) > 24
    new = cv2.erode(new.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    m = (new & still).astype(np.uint8)
    zone = np.zeros_like(m)
    zx = int(hw * 0.6)
    zy0, zy1 = int(hh * 0.35), int(hh * 0.65)
    zone[:zy0, zx:] = 1
    zone[zy1:, zx:] = 1
    zone[:zy0, : hw - zx] = 1
    zone[zy1:, : hw - zx] = 1
    m &= zone
    if m.sum() < 40:
        return None
    blob = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(blob, 8)
    best = None
    for k in range(1, n):
        x, y, w, h, area = stats[k]
        if not (0.12 * hw <= w <= 0.45 * hw and 0.05 * hh <= h <= 0.25 * hh):
            continue
        ecount = int(m[y:y + h, x:x + w].sum())
        if area / float(w * h) < 0.5 or ecount < 0.02 * w * h:
            continue
        if best is None or area > best[4]:
            best = (x, y, w, h, area)
    if not best:
        return None
    x, y, w, h, _ = best
    # snap each side outwards to the panel's border (a straight edge line in the frame): up to 30
    # half-res px above / below the text, 80 to the left / right
    e = cv2.dilate(cv2.Canny(d[c + 15], 30, 90), np.ones((3, 1), np.uint8)) > 0
    ev = cv2.dilate(cv2.Canny(d[c + 15], 30, 90), np.ones((1, 3), np.uint8)) > 0
    reach = 30

    def line_h(yy: int, xa: int, xb: int) -> bool:
        return 0 <= yy < hh and float(e[yy, max(0, xa):min(hw, xb)].mean()) > 0.85

    def line_v(xx: int, ya: int, yb: int) -> bool:
        return 0 <= xx < hw and float(ev[max(0, ya):min(hh, yb), xx].mean()) > 0.85

    top = next((yy for yy in range(y, y - reach, -1) if line_h(yy, x, x + w)), None)
    bot = next((yy for yy in range(y + h, y + h + reach) if line_h(yy, x, x + w)), None)
    y0s, y1s = (top if top is not None else y), (bot if bot is not None else y + h)
    lef = next((xx for xx in range(x, x - 80, -1) if line_v(xx, y0s + 3, y1s - 3)), None)
    rig = next((xx for xx in range(x + w, x + w + 80) if line_v(xx, y0s + 3, y1s - 3)), None)
    snapped = sum(v is not None for v in (top, bot, lef, rig))
    x0, y0 = (lef if lef is not None else x) * q - 4, y0s * q - 4
    x1, y1 = (rig if rig is not None else x + w) * q + 4, y1s * q + 4
    W, H = hw * q, hh * q
    # banners hug the screen edge; the gap to the edge is part of what to hide
    at_edge = 0
    if W - x1 < 48:
        x1, at_edge = W, at_edge + (rig is None)
    if x0 < 48:
        x0, at_edge = 0, at_edge + (lef is None)
    if H - y1 < 48:
        y1, at_edge = H, at_edge + (bot is None)
    if y0 < 48:
        at_edge += top is None
    # a banner is a panel: at least three of its sides are a border line or the screen edge
    if snapped + at_edge < 3:
        return None
    return (max(0, x0), max(0, y0), min(W, x1) - max(0, x0), min(H, y1) - max(0, y0))


def _outline(e: np.ndarray, x: int, y: int, w: int, h: int) -> list[float]:
    """Edge support along the four sides of a box (share of the side with an edge pixel within 3 px)."""
    H, W = e.shape
    b = 3
    def band(y0, y1, x0, x1, axis):
        y0, y1, x0, x1 = max(0, y0), min(H, y1), max(0, x0), min(W, x1)
        if y1 <= y0 or x1 <= x0:
            return 0.0
        return float((e[y0:y1, x0:x1] > 0).any(axis=axis).mean())
    top = band(y - b, y + b, x, x + w, 0)
    bot = band(y + h - b, y + h + b, x, x + w, 0)
    lef = band(y, y + h, x - b, x + b, 1)
    rig = band(y, y + h, x + w - b, x + w + b, 1)
    return [top, bot, lef, rig]


# ------------------------------------------------------------------ pass 3: tracking


@dataclass
class Track:
    id: int
    type: str
    template: np.ndarray
    rects: dict[int, tuple[float, float, float, float]] = field(default_factory=dict)
    texts: list[str] = field(default_factory=list)
    conf: list[float] = field(default_factory=list)
    vel: tuple[float, float] = (0.0, 0.0)
    alive: bool = True
    coast: int = 0
    first_hit: int = 0
    thumb: Optional[str] = None

    def last(self) -> tuple[int, tuple[float, float, float, float]]:
        f = max(self.rects)
        return f, self.rects[f]


TEMPLATE_MARGIN = 4


def _ncc_window(frame: np.ndarray, tpl: np.ndarray, cx: float, cy: float, rx: int, ry: int) -> tuple[float, float, float]:
    """Best NCC match of tpl with its top-left within ±(rx, ry) of (cx, cy). Template must fit."""
    H, W = frame.shape
    th, tw = tpl.shape
    x0 = int(max(0, math.floor(cx - rx)))
    y0 = int(max(0, math.floor(cy - ry)))
    x1 = int(min(W, math.ceil(cx + rx) + tw))
    y1 = int(min(H, math.ceil(cy + ry) + th))
    if x1 - x0 < tw or y1 - y0 < th:
        return -1.0, cx, cy
    res = cv2.matchTemplate(frame[y0:y1, x0:x1], tpl, cv2.TM_CCOEFF_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(res)
    return float(mx), float(x0 + loc[0]), float(y0 + loc[1])


def _textured(t: np.ndarray) -> bool:
    return t.size > 0 and float(t.std()) > 8.0


def _follow(frame: np.ndarray, tr: Track, prev_rect, step: int, gshift: tuple[float, float], s: ScanSettings, wide_y: int) -> Optional[tuple[float, float, float, float]]:
    """Where is track tr in `frame`, given its rect in the neighbouring frame? step is +1 forward, -1 backward;
    gshift is the global motion between the two frames in the direction of travel."""
    H, W = frame.shape
    x, y, w, h = prev_rect
    tpl = tr.template
    th, tw = tpl.shape
    # the template is the box padded by a margin, centred on it; a coasted (grown) rect keeps the centre
    tx, ty = x + w / 2 - tw / 2, y + h / 2 - th / 2
    bw, bh = tw - 2 * TEMPLATE_MARGIN, th - 2 * TEMPLATE_MARGIN
    preds = [(tx + tr.vel[0] * step, ty + tr.vel[1] * step), (tx + gshift[0], ty + gshift[1]), (tx, ty)]
    inside = lambda px, py: px >= 0 and py >= 0 and px + tw <= W and py + th <= H  # noqa: E731
    best = (-1.0, tx, ty)
    if all(inside(px, py) for px, py in preds[:2]):
        for px, py in preds:
            r = _ncc_window(frame, tpl, px, py, 6, 6)
            if r[0] > best[0]:
                best = r
            if best[0] >= s.match_threshold + 0.1:
                break
        if best[0] < s.match_threshold:
            r = _ncc_window(frame, tpl, tx, ty, 64, wide_y)
            if r[0] > best[0]:
                best = r
        if best[0] >= s.match_threshold:
            tr.coast = 0
            return (best[1] + TEMPLATE_MARGIN, best[2] + TEMPLATE_MARGIN, bw, bh)
    # partly off-screen, partly covered or clipped by a scroll view's edge: match the template's
    # pieces (a grid of up to 16 columns x 2 rows) that are on screen
    px, py = preds[1] if abs(gshift[0]) + abs(gshift[1]) > abs(tr.vel[0]) + abs(tr.vel[1]) else preds[0]
    cols = max(1, min(16, int(tw // max(24, th))))
    rows = 2 if th >= 16 else 1
    xe = np.linspace(0, tw, cols + 1).astype(int)
    ye = np.linspace(0, th, rows + 1).astype(int)
    found = []
    for a0, a1 in zip(xe, xe[1:]):
        for b0, b1 in zip(ye, ye[1:]):
            sx, sy = int(round(px)) + a0, int(round(py)) + b0
            cx0, cy0 = max(0, sx), max(0, sy)
            cx1, cy1 = min(W, sx + (a1 - a0)), min(H, sy + (b1 - b0))
            if cx1 - cx0 < 12 or cy1 - cy0 < max(5, (b1 - b0) * 2 // 3):
                continue
            part = tpl[b0 + cy0 - sy:b0 + cy1 - sy, a0 + cx0 - sx:a0 + cx1 - sx]
            if not _textured(part):
                continue
            r = _ncc_window(frame, part, cx0, cy0, 8, 10)
            if r[0] >= 0.78:
                found.append((r[1] - (cx0 - sx) - a0, r[2] - (cy0 - sy) - b0))
    if len(found) >= 1:
        fx = float(np.median([f[0] for f in found]))
        fy = float(np.median([f[1] for f in found]))
        tr.coast = 0
        return (fx + TEMPLATE_MARGIN, fy + TEMPLATE_MARGIN, bw, bh)
    # lost: coast with the motion for a few frames (a box sliding under a scroll view's edge or off
    # the screen), longer while part of it is still at the frame edge
    mv = gshift if abs(gshift[0]) + abs(gshift[1]) > 0.3 else (tr.vel[0] * step, tr.vel[1] * step)
    nx, ny = x + mv[0], y + mv[1]
    moving = abs(mv[0]) + abs(mv[1]) >= 0.5
    vis_w = min(W, nx + w) - max(0, nx)
    vis_h = min(H, ny + h) - max(0, ny)
    on_edge = nx < 0 or ny < 0 or nx + w > W or ny + h > H
    limit = 12 if on_edge else 6
    if moving and vis_w > 0 and vis_h > 0 and tr.coast < limit:
        tr.coast += 1
        # the position is a guess now: grow the box by 2 px per coasted frame on every side
        g = 2.0
        return (nx - g, ny - g, w + 2 * g, h + 2 * g)
    return None


def _stay(frame: np.ndarray, tr: Track, rect, s: ScanSettings):
    """A banner stays where it is while its pixels still match (±4 px)."""
    x, y, w, h = rect
    th, tw = tr.template.shape
    tx, ty = x - (tw - w) / 2, y - (th - h) / 2
    r = _ncc_window(frame, tr.template, tx, ty, 4, 4)
    return rect if r[0] >= s.match_threshold else None


def track(video: str, an: Analysis, hits: dict[int, list[FrameHit]], s: ScanSettings, scroll_frames: Optional[set[int]] = None,
          thumbs: Optional[Callable[[int, tuple[int, int, int, int], int], Optional[str]]] = None,
          progress: Optional[Callable[[str, int, int], None]] = None) -> list[Track]:
    W, H = an.width, an.height
    buf: deque[tuple[int, np.ndarray]] = deque(maxlen=s.buffer_frames)
    tracks: list[Track] = []
    live: list[Track] = []
    margin = TEMPLATE_MARGIN
    linger = int(round(0.5 * an.fps))
    for f, g in enumerate(decode(video, W, H, "gray")):
        gs = an.shift[f] if f < len(an.shift) else (0.0, 0.0)
        wide_y = 160 if scroll_frames and f in scroll_frames else 96
        for tr in live:
            lf, lr = tr.last()
            if lf != f - 1:
                continue
            nr = _follow(g, tr, lr, +1, gs, s, wide_y) if tr.type != "notification" else _stay(g, tr, lr, s)
            if nr is None and tr.type == "notification" and tr.coast < linger:
                # a banner sliding or fading out: keep its (screen-edge) box a little longer
                tr.coast += 1
                nr = lr
            if nr is None:
                tr.alive = False
                continue
            tr.vel = (nr[0] - lr[0], nr[1] - lr[1])
            tr.rects[f] = nr
        live = [t for t in live if t.alive]
        for hit in hits.get(f, []):
            x, y, w, h = hit.box
            match = None
            for tr in live:
                if f in tr.rects and _type_compat(tr.type, hit.type) and _contain(hit.box, tr.rects[f]) > 0.6:
                    r = tr.rects[f]
                    if hit.box[2] * hit.box[3] > 1.25 * r[2] * r[3]:
                        # more of the same token was read this time: follow the larger box as its own
                        # track (merge_tracks folds the smaller one into it, geometry included)
                        continue
                    match = tr
                    break
            if match:
                match.texts.append(hit.text)
                match.conf.append(hit.confidence)
                match.coast = 0
                # the OCR box is the truth on this frame when it is the same box
                if _iou(match.rects[f], hit.box) > 0.6:
                    match.rects[f] = (float(x), float(y), float(w), float(h))
                if match.type == "token" and hit.type != "token":
                    match.type = hit.type
                continue
            x0, y0 = max(0, x - margin), max(0, y - margin)
            x1, y1 = min(W, x + w + margin), min(H, y + h + margin)
            tpl = g[y0:y1, x0:x1].copy()
            if tpl.shape[0] < 6 or tpl.shape[1] < 6:
                continue
            tr = Track(id=len(tracks), type=hit.type, template=tpl, texts=[hit.text], conf=[hit.confidence], first_hit=f)
            # the template may be clipped at the frame edge: keep the rect consistent with it
            tr.rects[f] = (float(x0 + margin), float(y0 + margin), float(x1 - x0 - 2 * margin), float(y1 - y0 - 2 * margin))
            if thumbs:
                tr.thumb = thumbs(f, hit.box, tr.id)
            # backwards through the buffer (a banner instead keeps its box back to its appearance)
            cur = tr.rects[f]
            tr.vel = (0.0, 0.0)
            for bf, bg in reversed(buf if tr.type != "notification" else []):
                if bf != min(tr.rects) - 1:
                    break
                back = an.shift[bf + 1] if bf + 1 < len(an.shift) else (0.0, 0.0)
                nr = _follow(bg, tr, cur, -1, (-back[0], -back[1]), s, wide_y)
                if nr is None:
                    break
                tr.vel = (cur[0] - nr[0], cur[1] - nr[1])
                tr.rects[bf] = nr
                cur = nr
            if tr.type == "notification":
                # it appeared at the scene change that confirmed it: cover the slide-in with its box
                for k in range(max(0, f - 18), min(tr.rects)):
                    tr.rects[k] = tr.rects[f]
            tr.vel = (0.0, 0.0)
            tr.coast = 0
            tracks.append(tr)
            live.append(tr)
        buf.append((f, g))
        if progress and f % 30 == 0:
            progress("track", f, an.n)
    return tracks


def _contain(a, b) -> float:
    """Share of the smaller of boxes a, b that lies inside the other."""
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    sm = min(aw * ah, bw * bh)
    return ix * iy / sm if sm > 0 else 0.0


def merge_tracks(tracks: list[Track], an: "Analysis", max_gap_s: float = 3.0) -> list[Track]:
    """Join tracks that are one thing on screen:
    - overlapping in time and space (a fragment of a token inside the whole token's box, or the same
      box tracked twice): the larger box's geometry is carried onto the fragment's frames;
    - the same text lost for a moment (covered by a moving card, a menu) and found again where the
      motion since then puts it: the gap is filled by interpolation."""
    ts = sorted(tracks, key=lambda t: min(t.rects))
    changed = True
    while changed:
        changed = False
        for i in range(len(ts)):
            for j in range(len(ts)):
                if i == j or ts[i] is None or ts[j] is None:
                    continue
                a, b = ts[i], ts[j]
                if not _type_compat(a.type, b.type) or (a.type == "notification") != (b.type == "notification"):
                    continue
                shared = sorted(set(a.rects) & set(b.rects))
                if shared and not _co_moving(a, b, shared):
                    # one passes over the other (a card sliding across a page): two things
                    continue
                if shared:
                    f = next((f for f in shared if _contain(a.rects[f], b.rects[f]) > 0.6), None)
                    if f is None:
                        f = next((f for f in shared if _adjacent(a.rects[f], b.rects[f])), None)
                        if f is None or a.type == "notification":
                            continue
                        _join(a, b, f)
                        ts[j] = None
                        changed = True
                        continue
                    big, small = (a, b) if a.rects[f][2] * a.rects[f][3] >= b.rects[f][2] * b.rects[f][3] else (b, a)
                    _absorb(big, small, f)
                    ts[ts.index(small)] = None
                    changed = True
                    continue
                # bridge: b starts after a ends
                af, bf = max(a.rects), min(b.rects)
                gap = bf - af
                if gap <= 1 or gap > max_gap_s * an.fps:
                    continue
                if _sim(_mode(a.texts), _mode(b.texts)) < 0.8:
                    continue
                sx = sum(an.shift[k][0] for k in range(af + 1, bf + 1) if k < len(an.shift))
                sy = sum(an.shift[k][1] for k in range(af + 1, bf + 1) if k < len(an.shift))
                ra = a.rects[af]
                moved = (ra[0] + sx, ra[1] + sy, ra[2], ra[3])
                if max(_iou(moved, b.rects[bf]), _iou(ra, b.rects[bf])) < 0.5:
                    continue
                rb = b.rects[bf]
                for k in range(af + 1, bf):
                    u = (k - af) / gap
                    a.rects[k] = tuple(ra[n] + (rb[n] - ra[n]) * u for n in range(4))  # type: ignore[assignment]
                a.rects.update(b.rects)
                a.texts += b.texts
                a.conf += b.conf
                if a.type == "token" and b.type != "token":
                    a.type = b.type
                ts[j] = None
                changed = True
        ts = [t for t in ts if t is not None]
    return ts


def _co_moving(a: Track, b: Track, shared: list[int], tol: float = 4.0) -> bool:
    """Do two tracks keep the same offset over every frame they share (pieces of one thing)?"""
    dx = [a.rects[f][0] - b.rects[f][0] for f in shared]
    dy = [a.rects[f][1] - b.rects[f][1] for f in shared]
    return max(dx) - min(dx) <= tol and max(dy) - min(dy) <= tol


def _adjacent(a, b) -> bool:
    """Two pieces of one line of text: same row, side by side with a small gap."""
    ay0, ay1, by0, by1 = a[1], a[1] + a[3], b[1], b[1] + b[3]
    vo = min(ay1, by1) - max(ay0, by0)
    if vo < 0.6 * min(a[3], b[3]):
        return False
    gap = max(a[0], b[0]) - min(a[0] + a[2], b[0] + b[2])
    return gap <= 1.5 * max(a[3], b[3])


def _join(a: Track, b: Track, f: int) -> None:
    """Merge side-by-side pieces into one box (the union), carried through both tracks' frames."""
    ra, rb = a.rects[f], b.rects[f]
    ux0, uy0 = min(ra[0], rb[0]), min(ra[1], rb[1])
    ux1, uy1 = max(ra[0] + ra[2], rb[0] + rb[2]), max(ra[1] + ra[3], rb[1] + rb[3])
    oa = (ux0 - ra[0], uy0 - ra[1])
    ob = (ux0 - rb[0], uy0 - rb[1])
    uw, uh = ux1 - ux0, uy1 - uy0
    out: dict[int, tuple[float, float, float, float]] = {}
    for k in set(a.rects) | set(b.rects):
        cands = []
        if k in a.rects:
            r = a.rects[k]
            cands.append((r[0] + oa[0], r[1] + oa[1], uw, uh))
        if k in b.rects:
            r = b.rects[k]
            cands.append((r[0] + ob[0], r[1] + ob[1], uw, uh))
        x0 = min(c[0] for c in cands)
        y0 = min(c[1] for c in cands)
        x1 = max(c[0] + c[2] for c in cands)
        y1 = max(c[1] + c[3] for c in cands)
        out[k] = (x0, y0, x1 - x0, y1 - y0)
    a.rects = out
    a.texts += b.texts
    a.conf += b.conf
    rank = {"jwt": 0, "api_key": 1, "token": 2}
    if rank.get(b.type, 9) < rank.get(a.type, 9):
        a.type = b.type
    if a.thumb is None:
        a.thumb = b.thumb


def _absorb(big: Track, small: Track, f: int) -> None:
    bx, by, bw, bh = big.rects[f]
    sx, sy, _, _ = small.rects[f]
    ox, oy = bx - sx, by - sy
    for k, r in small.rects.items():
        if k not in big.rects:
            big.rects[k] = (r[0] + ox, r[1] + oy, bw, bh)
    big.texts += small.texts
    big.conf += small.conf
    if big.type == "token" and small.type != "token":
        big.type = small.type
    if big.thumb is None:
        big.thumb = small.thumb


def _mode(texts: list[str]) -> str:
    return Counter(texts).most_common(1)[0][0] if texts else ""


def _type_compat(a: str, b: str) -> bool:
    return a == b or "token" in (a, b) and {a, b} <= {"token", "api_key", "jwt"}


# ------------------------------------------------------------------ detections


def _norm(s: str) -> str:
    return "".join(c for c in s.lower() if c.isalnum())


def _sim(a: str, b: str) -> float:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    # Levenshtein ratio
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1 - prev[-1] / max(len(a), len(b))


def _keys(tr: Track, fps: float, pad: int, W: int, H: int) -> list[dict]:
    keys = []
    for f in sorted(tr.rects):
        x, y, w, h = tr.rects[f]
        x0, y0 = max(0, math.floor(x - pad)), max(0, math.floor(y - pad))
        x1, y1 = min(W, math.ceil(x + w + pad)), min(H, math.ceil(y + h + pad))
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        keys.append({"tMs": round(f * 1000 / fps, 2), "rect": {"x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0)}})
    # drop keys inside runs of identical rects (first and last of each run stay)
    out = []
    for i, k in enumerate(keys):
        if 0 < i < len(keys) - 1 and k["rect"] == keys[i - 1]["rect"] == keys[i + 1]["rect"]:
            continue
        out.append(k)
    return out


def detections_from_tracks(tracks: list[Track], fps: float, W: int, H: int, s: ScanSettings) -> list[dict]:
    frame_ms = 1000 / fps
    groups: list[dict] = []
    for tr in sorted(tracks, key=lambda t: min(t.rects)):
        if tr.type not in s.types:
            continue
        text = Counter(tr.texts).most_common(1)[0][0] if tr.texts else ""
        keys = _keys(tr, fps, s.pad_px if tr.type != "notification" else 2, W, H)
        if not keys:
            continue
        f0, f1 = min(tr.rects), max(tr.rects)
        seg = {"startMs": round(max(0.0, (f0 - 1) * frame_ms), 2), "endMs": round((f1 + 1) * frame_ms, 2), "keys": keys}
        g = None
        if tr.type != "notification":
            for cand in groups:
                if _type_compat(cand["type"], tr.type) and _sim(cand["_text"], text) >= 0.8:
                    g = cand
                    break
        if g is None:
            g = {"type": tr.type, "_text": text, "tracks": [], "conf": [], "thumb": tr.thumb, "_first": f0}
            groups.append(g)
        g["tracks"].append(seg)
        g["conf"].extend(tr.conf)
        if g["type"] == "token" and tr.type != "token":
            g["type"] = tr.type
    out = []
    for i, g in enumerate(sorted(groups, key=lambda g: g["_first"])):
        out.append({
            "id": f"pd{i + 1}",
            "type": g["type"],
            "preview": mask_preview(g["_text"], g["type"]) if g["type"] != "notification" else "Notification banner",
            "confidence": round(float(np.mean(g["conf"])) if g["conf"] else 1.0, 3),
            "state": "pending",
            "thumb": g["thumb"],
            "firstMs": g["tracks"][0]["startMs"],
            "tracks": sorted(g["tracks"], key=lambda t: t["startMs"]),
        })
    return out


# ------------------------------------------------------------------ entry point


def scroll_frames_from_events(events_path: Optional[str], fps: float) -> set[int]:
    if not events_path or not Path(events_path).exists():
        return set()
    out: set[int] = set()
    for line in Path(events_path).read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        e = json.loads(line)
        if e.get("type") == "scroll":
            f = int(round(e["t"] * fps / 1000))
            out.update(range(f - 1, f + 3))
    return out


def scan(video: str, events: Optional[str] = None, settings: Optional[ScanSettings] = None, thumbs_dir: Optional[str] = None,
         progress: Optional[Callable[[str, int, int], None]] = None) -> dict:
    s = settings or ScanSettings()
    t0 = time.time()
    info = probe(video)
    fps = info["fps"]
    scroll = scroll_frames_from_events(events, fps)
    tmp = Path(tempfile.mkdtemp(prefix="lens-redact-"))
    try:
        an = analyse(video, s, scroll, tmp, progress)
        t1 = time.time()
        # OCR every sample in batches (two tesseract processes)
        paths = [str(tmp / f"{f:06d}.png") for f in an.samples]
        if progress:
            progress("ocr", 0, len(paths))
        workers = max(1, min(s.workers, len(paths)))
        chunks = [paths[k::workers] for k in range(workers)]
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(workers) as ex:
            res = list(ex.map(lambda c: _run_batch(c, 11), chunks))
        words: dict[int, list] = {}
        for k, r in enumerate(res):
            for j, ws in enumerate(r):
                words[an.samples[k + j * workers]] = ws
        hits: dict[int, list[FrameHit]] = {}
        for f, ws in words.items():
            hs = [h for h in hits_from_words(ws) if h.type in s.types]
            if hs:
                hits[f] = hs
        for f, box in an.notifications:
            if "notification" in s.types:
                hits.setdefault(f, []).append(FrameHit("notification", box, "", 0.8))
        t2 = time.time()
        tdir = Path(thumbs_dir) if thumbs_dir else None
        if tdir:
            tdir.mkdir(parents=True, exist_ok=True)

        def thumb(f: int, box, tid: int) -> Optional[str]:
            if not tdir:
                return None
            src = tmp / f"{f:06d}.jpg"
            if not src.exists():
                return None
            im = cv2.imread(str(src))
            x, y, w, h = box
            m = 24
            x0, y0 = max(0, x - m), max(0, y - m)
            x1, y1 = min(im.shape[1], x + w + m), min(im.shape[0], y + h + m)
            crop = im[y0:y1, x0:x1]
            sc = min(1.0, 240 / max(1, crop.shape[1]), 72 / max(1, crop.shape[0]))
            if sc < 1:
                crop = cv2.resize(crop, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
            name = f"t{tid}.jpg"
            cv2.imwrite(str(tdir / name), crop, [cv2.IMWRITE_JPEG_QUALITY, 82])
            return name

        tracks = track(video, an, hits, s, scroll, thumb, progress)
        tracks = merge_tracks(tracks, an)
        dets = detections_from_tracks(tracks, fps, an.width, an.height, s)
        # thumbnails are named per track; rename to the detection id so the editor can find them
        if tdir:
            for d in dets:
                if d["thumb"] and (tdir / d["thumb"]).exists():
                    (tdir / d["thumb"]).replace(tdir / f"{d['id']}.jpg")
                    d["thumb"] = f"{d['id']}.jpg"
            for p in tdir.glob("t*.jpg"):
                p.unlink()
        t3 = time.time()
        dur_ms = an.n * 1000 / fps
        return {
            "version": VERSION,
            "engine": {"name": "lens-redact", "ocr": "tesseract (psm 11, eng)", "licence": "Apache-2.0 (tesseract)"},
            "source": {"path": Path(video).name, "width": an.width, "height": an.height, "fps": fps, "frames": an.n, "durationMs": round(dur_ms, 2)},
            "settings": {"intervalMs": s.interval_ms, "notifications": s.notifications, "padPx": s.pad_px},
            "stats": {"samples": len(an.samples), "sampleReasons": dict(Counter(an.sample_reason.values())), "tracks": len(tracks),
                      "seconds": {"analyse": round(t1 - t0, 2), "ocr": round(t2 - t1, 2), "track": round(t3 - t2, 2), "total": round(t3 - t0, 2)},
                      "secondsPerMinute": round((t3 - t0) / max(1e-9, dur_ms / 60000), 2)},
            "detections": dets,
        }
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
