"""Per-frame viewport tracking: where in the source screen is each exported frame looking?

Works on ANY exported video (ours, Screen Studio's, FocuSee's) of a session recorded over a known
reference screenshot. For every frame we match SIFT features between the reference (source px) and
the export, fit a similarity transform T (source -> export px) with RANSAC, then derive:

  content rect R   : where the screen sits in the export when unzoomed (padding, H02)
  zoom scale s     : a / a1, a = export px per source px now, a1 = same at zoom 1
  viewport center  : T^-1(center of R) in source px

That is the raw data behind zoom-curve fitting (springfit.py), smart framing checks and the
measurable half of the gauntlet.
"""
from __future__ import annotations

import json
import math
import subprocess
from dataclasses import asdict, dataclass
from typing import Iterator, Optional

import cv2
import numpy as np


def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", path],
        check=True, capture_output=True, text=True,
    ).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": float(num) / float(den)}


def frames(path: str, step: int = 1) -> Iterator[tuple[int, np.ndarray]]:
    info = probe(path)
    w, h = info["width"], info["height"]
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    assert p.stdout
    i = 0
    try:
        while True:
            buf = p.stdout.read(w * h * 3)
            if len(buf) < w * h * 3:
                break
            if i % step == 0:
                yield i, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        p.stdout.close()
        p.wait()


@dataclass
class FrameTrack:
    index: int
    t: float
    ok: bool
    a: float = math.nan      # export px per source px
    tx: float = math.nan     # translation (export px)
    ty: float = math.nan
    inliers: int = 0
    scale: float = math.nan  # zoom relative to unzoomed
    cx: float = math.nan     # viewport center, source px
    cy: float = math.nan


class Matcher:
    def __init__(self, reference: np.ndarray, nfeatures: int = 6000):
        self.ref = reference
        self.sift = cv2.SIFT_create(nfeatures=nfeatures)
        g = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
        self.kp, self.des = self.sift.detectAndCompute(g, None)
        self.flann = cv2.FlannBasedMatcher({"algorithm": 1, "trees": 5}, {"checks": 64})

    def similarity(self, frame: np.ndarray, mask: Optional[np.ndarray] = None) -> Optional[tuple[np.ndarray, int]]:
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        kp, des = self.sift.detectAndCompute(g, mask)
        if des is None or len(kp) < 12 or self.des is None:
            return None
        pairs = self.flann.knnMatch(self.des, des, k=2)
        good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < 0.72 * n.distance]
        if len(good) < 12:
            return None
        src = np.float32([self.kp[m.queryIdx].pt for m in good])
        dst = np.float32([kp[m.trainIdx].pt for m in good])
        M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=4000, confidence=0.995)
        if M is None:
            return None
        n = int(inl.sum()) if inl is not None else 0
        if n < 10:
            return None
        return M, n


def _frame_to_frame(sift, a: np.ndarray, b: np.ndarray) -> Optional[tuple[np.ndarray, int]]:
    ka, da = sift.detectAndCompute(a, None)
    kb, db = sift.detectAndCompute(b, None)
    if da is None or db is None or len(ka) < 12 or len(kb) < 12:
        return None
    bf = cv2.BFMatcher(cv2.NORM_L2)
    pairs = bf.knnMatch(da, db, k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < 0.8 * n.distance]
    if len(good) < 10:
        return None
    src = np.float32([ka[m.queryIdx].pt for m in good])
    dst = np.float32([kb[m.trainIdx].pt for m in good])
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.5)
    if M is None or inl is None or int(inl.sum()) < 8:
        return None
    return M, int(inl.sum())


def track_video(video: str, reference_path: str, step: int = 1, content_rect: Optional[tuple[float, float, float, float]] = None) -> dict:
    """Track every `step`-th frame. Returns content rect, unzoomed scale a1 and per-frame tracks."""
    info = probe(video)
    ref = cv2.imread(reference_path)
    if ref is None:
        raise FileNotFoundError(reference_path)
    rh, rw = ref.shape[:2]
    m = Matcher(ref)
    raw: list[FrameTrack] = []
    sift = cv2.SIFT_create(nfeatures=4000)
    prev_gray = None
    prev_M: Optional[np.ndarray] = None

    def accept(M: np.ndarray) -> Optional[float]:
        a = float(math.hypot(M[0, 0], M[1, 0]))
        rot = abs(math.atan2(M[1, 0], M[0, 0]))
        return a if (a >= 0.05 and rot <= 0.02) else None

    for i, fr in frames(video, step):
        t = i * 1000 / info["fps"]
        gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        M = None
        n = 0
        res = m.similarity(fr)
        if res is not None and accept(res[0]) is not None:
            M, n = res
        elif prev_gray is not None and prev_M is not None:
            # Fallback: chain through the previous tracked frame (same content, small motion).
            h = _frame_to_frame(sift, prev_gray, gray)
            if h is not None:
                H2 = np.vstack([h[0], [0, 0, 1]])
                P = np.vstack([prev_M, [0, 0, 1]])
                M = (H2 @ P)[:2]
                n = -h[1]  # negative inliers mark a chained (not directly anchored) estimate
                if accept(M) is None:
                    M = None
        if M is None:
            raw.append(FrameTrack(i, t, False))
            prev_gray, prev_M = None, None
            continue
        a = accept(M)
        assert a is not None
        raw.append(FrameTrack(i, t, True, a, float(M[0, 2]), float(M[1, 2]), n))
        prev_gray, prev_M = gray, M

    good = [f for f in raw if f.ok]
    if not good:
        raise RuntimeError("no frame matched the reference; wrong reference screenshot?")
    if content_rect is None:
        # Unzoomed frames: the whole reference lands inside the frame. Take the smallest-a cluster.
        anchored = [f for f in good if f.inliers > 0] or good
        a_min = min(f.a for f in anchored)
        unz = [f for f in anchored if f.a < a_min * 1.01]
        a1 = float(np.median([f.a for f in unz]))
        x = float(np.median([f.tx for f in unz]))
        y = float(np.median([f.ty for f in unz]))
        content_rect = (x, y, rw * a1, rh * a1)
    else:
        a1 = content_rect[2] / rw
    X, Y, Wr, Hr = content_rect
    for f in good:
        f.scale = f.a / a1
        # Center of R in export px -> source px through the inverse similarity (rotation-free).
        f.cx = (X + Wr / 2 - f.tx) / f.a
        f.cy = (Y + Hr / 2 - f.ty) / f.a
    return {
        "video": video,
        "fps": info["fps"],
        "export": {"width": info["width"], "height": info["height"]},
        "source": {"width": rw, "height": rh},
        "contentRect": {"x": X, "y": Y, "w": Wr, "h": Hr},
        "a1": a1,
        "frames": [asdict(f) for f in raw],
    }


def padding_metrics(track: dict) -> dict:
    W, H = track["export"]["width"], track["export"]["height"]
    r = track["contentRect"]
    short = min(W, H)
    left, top = r["x"], r["y"]
    right, bottom = W - (r["x"] + r["w"]), H - (r["y"] + r["h"])
    return {
        "leftPx": left, "topPx": top, "rightPx": right, "bottomPx": bottom,
        # The tight side is the configured padding; the other axis grows to keep the screen's aspect.
        "paddingFractionOfShortSide": float(min(left, top, right, bottom) / short),
        "screenFractionOfWidth": r["w"] / W,
    }


def corner_radius(frame: np.ndarray, reference: np.ndarray, rect: dict, max_r: int = 80) -> float:
    """Estimate corner radius in export px by walking the diagonal from the top-left corner until
    the export starts matching the (scaled) reference. A circle of radius r leaves r(sqrt2 - 1)
    of diagonal outside the arc."""
    x, y, w, h = (int(round(rect[k])) for k in ("x", "y", "w", "h"))
    ref = cv2.resize(reference, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
    crop = frame[y:y + h, x:x + w].astype(np.float32)
    if crop.shape != ref.shape:
        return math.nan
    estimates = []
    for flip_x, flip_y in ((False, False), (True, False), (False, True), (True, True)):
        c = crop[:, ::-1] if flip_x else crop
        rr = ref[:, ::-1] if flip_x else ref
        c = c[::-1] if flip_y else c
        rr = rr[::-1] if flip_y else rr
        d = None
        for k in range(min(max_r, w // 2, h // 2)):
            if np.abs(c[k, k] - rr[k, k]).mean() < 18:
                d = k
                break
        if d is not None:
            # The arc crosses the diagonal at r(1 - 1/sqrt2) along each axis.
            estimates.append(d / (1 - 1 / math.sqrt(2)))
    return float(np.median(estimates)) if estimates else math.nan


def shadow_metrics(frame: np.ndarray, rect: dict) -> dict:
    """Darkening profile below the screen relative to the background further out."""
    H, W = frame.shape[:2]
    x, y, w, h = (int(round(rect[k])) for k in ("x", "y", "w", "h"))
    lum = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    cols = slice(x + w // 4, x + 3 * w // 4)
    below = lum[y + h: H, cols].mean(axis=1)
    above = lum[:y, cols].mean(axis=1)[::-1]
    if len(below) < 8:
        return {"available": False}
    far = float(np.median(below[-max(3, len(below) // 6):]))
    dark_below = np.clip(1 - below / max(far, 1), 0, 1)
    far_a = float(np.median(above[-max(3, len(above) // 6):])) if len(above) >= 8 else far
    dark_above = np.clip(1 - above / max(far_a, 1), 0, 1) if len(above) else np.zeros(1)
    peak = float(dark_below.max())
    extent = int(np.argmax(dark_below < peak * 0.1)) if peak > 0.01 else 0
    return {
        "available": True,
        "peakDarkeningBelow": peak,
        "peakDarkeningAbove": float(dark_above.max()) if len(dark_above) else 0.0,
        "extentBelowPx": extent,
        "verticalBias": peak - (float(dark_above.max()) if len(dark_above) else 0.0),
    }
