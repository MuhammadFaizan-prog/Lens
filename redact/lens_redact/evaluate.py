"""Score a privacy scan against the synthetic session's ground truth (gt.json).

Metrics:
  instance recall   share of planted secrets (incl. notification banners) that at least one
                    detection overlaps on at least one frame where the secret is visible
  frame recall      share of (secret, visible frame) pairs whose visible box is >= 95% covered by
                    the masks the detections would draw on that frame
  false positives   detections that never overlap any planted secret on any frame; per minute
"""
from __future__ import annotations

import bisect
from typing import Optional

import numpy as np


def rect_at(track: dict, t_ms: float) -> Optional[tuple[int, int, int, int]]:
    """The mask rect of a track at source time t (same rule as the engine's masksAt for keyed masks:
    the key at t, or the union of the two keys around t)."""
    if not (track["startMs"] <= t_ms < track["endMs"]):
        return None
    keys = track["keys"]
    ts = [k["tMs"] for k in keys]
    i = bisect.bisect_left(ts, t_ms)
    def r(k):
        q = k["rect"]
        return (q["x"], q["y"], q["w"], q["h"])
    if i < len(ts) and abs(ts[i] - t_ms) < 0.5:
        return r(keys[i])
    if i == 0:
        return r(keys[0])
    if i >= len(ts):
        return r(keys[-1])
    a, b = r(keys[i - 1]), r(keys[i])
    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return (x0, y0, x1 - x0, y1 - y0)


def _cover(box, rects) -> float:
    x, y, w, h = box
    if w <= 0 or h <= 0:
        return 1.0
    m = np.zeros((h, w), bool)
    for rx, ry, rw, rh in rects:
        x0, y0 = max(0, rx - x), max(0, ry - y)
        x1, y1 = min(w, rx + rw - x), min(h, ry + rh - y)
        if x1 > x0 and y1 > y0:
            m[y0:y1, x0:x1] = True
    return float(m.mean())


def _overlap(a, b) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def evaluate(scan: dict, gt: dict, detections: Optional[list[dict]] = None, cover_min: float = 0.95) -> dict:
    fps = gt["fps"]
    dets = detections if detections is not None else scan["detections"]
    n_frames = int(round(gt["durationMs"] * fps / 1000))
    det_hit = [False] * len(dets)
    per_secret = {}
    tot = cov = 0
    for key, sec in gt["secrets"].items():
        frames = sec["frames"]
        found = False
        covered = 0
        missed_frames = []
        for fs, box in frames.items():
            f = int(fs)
            t = f * 1000 / fps
            rects = []
            for di, d in enumerate(dets):
                for tr in d["tracks"]:
                    r = rect_at(tr, t)
                    if r and _overlap(r, box):
                        rects.append(r)
                        det_hit[di] = True
                        found = True
            c = _cover(box, rects)
            if c >= cover_min:
                covered += 1
            else:
                missed_frames.append(f)
        tot += len(frames)
        cov += covered
        per_secret[key] = {"type": sec["type"], "visibleFrames": len(frames), "coveredFrames": covered, "found": found,
                           "missedFrames": _ranges(missed_frames)}
    fp = [d for d, h in zip(dets, det_hit) if not h]
    minutes = gt["durationMs"] / 60000
    inst = [v["found"] for v in per_secret.values()]
    return {
        "instanceRecall": sum(inst) / len(inst),
        "frameRecall": cov / tot if tot else 1.0,
        "falsePositives": len(fp),
        "falsePositivesPerMinute": len(fp) / minutes,
        "fpDetections": [{"id": d["id"], "type": d["type"], "preview": d["preview"], "firstMs": d["firstMs"]} for d in fp],
        "perSecret": per_secret,
        "frames": n_frames,
    }


def _ranges(fs: list[int]) -> list[list[int]]:
    out: list[list[int]] = []
    for f in sorted(fs):
        if out and f == out[-1][1] + 1:
            out[-1][1] = f
        else:
            out.append([f, f])
    return out
