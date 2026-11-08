#!/usr/bin/env python3
"""Measure an exported screen recording against the scripted session that produced it.

  python research/harness/measure.py --video export.mp4 --reference reference.png \
      --events events.jsonl [--sync auto|<ms>] [--step 1] --out measurements.json

Works the same on Lens, Screen Studio and FocuSee exports, which is the point: the numbers it
writes (padding, corner radius, shadow, zoom spring, zoom lead/hold, cursor smoothing, loudness)
become Lens defaults and the measurable half of every gauntlet round.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lensharness.audio import loudness, noise_floor  # noqa: E402
from lensharness.cursortrack import raw_position, track_cursor  # noqa: E402
from lensharness.springfit import fit_cursor_smoothing, fit_zoom_curve  # noqa: E402
from lensharness.track import corner_radius, frames, padding_metrics, shadow_metrics, track_video  # noqa: E402


def load_events(path: str) -> list[dict]:
    out = []
    for line in Path(path).read_text().splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            out.append(json.loads(s))
    return sorted(out, key=lambda e: e["t"])


def detect_sync_flash(video: str, max_frames: int = 600) -> float | None:
    """Export time (ms) of the first near-white frame: the test app flashes white at event t=0."""
    from lensharness.track import probe
    fps = probe(video)["fps"]
    for i, fr in frames(video):
        if i > max_frames:
            break
        h, w = fr.shape[:2]
        if fr[h // 4: 3 * h // 4, w // 4: 3 * w // 4].mean() > 245:
            return i * 1000 / fps
    return None


def measure(video: str, reference: str, events_path: str, sync: str = "0", step: int = 1, cursor: bool = True) -> dict:
    events = load_events(events_path)
    if sync == "auto":
        flash = detect_sync_flash(video)
        offset = flash if flash is not None else 0.0
    else:
        offset = float(sync)
    tr = track_video(video, reference, step=step)
    ok = [f for f in tr["frames"] if f["ok"]]
    t = np.array([f["t"] - offset for f in ok])
    scale = np.array([f["scale"] for f in ok])
    cx = np.array([f["cx"] for f in ok])
    cy = np.array([f["cy"] for f in ok])

    zooms = fit_zoom_curve(t, scale)
    clicks = [e["t"] for e in events if e["type"] == "down"]
    activity = sorted(clicks + [e["t"] for e in events if e["type"] == "key"])
    for z in zooms:
        if z["direction"] == "in":
            nxt = [c for c in clicks if c >= z["t0_ms"] - 50]
            z["leadMs"] = (nxt[0] - z["t0_ms"]) if nxt else None
        else:
            prev = [a for a in activity if a <= z["t0_ms"]]
            z["holdMs"] = (z["t0_ms"] - prev[-1]) if prev else None

    # Static frame look, from the first unzoomed frame.
    ref = cv2.imread(reference)
    first_unzoomed = next((f for f in ok if abs(f["scale"] - 1) < 0.01), None)
    look: dict = {"padding": padding_metrics(tr)}
    if first_unzoomed is not None:
        fr = next(fr for i, fr in frames(video) if i == first_unzoomed["index"])
        look["cornerRadiusPx"] = corner_radius(fr, ref, tr["contentRect"])
        look["cornerRadiusAt1080"] = look["cornerRadiusPx"] * 1080 / min(tr["export"]["width"], tr["export"]["height"]) if not math.isnan(look["cornerRadiusPx"]) else None
        look["shadow"] = shadow_metrics(fr, tr["contentRect"])

    result: dict = {
        "video": video,
        "syncOffsetMs": offset,
        "export": tr["export"],
        "source": tr["source"],
        "trackedFrames": len(ok),
        "totalFrames": len(tr["frames"]),
        "look": look,
        "zoom": {
            "transitions": zooms,
            "maxScale": float(np.nanmax(scale)) if len(scale) else None,
            "curve": {"t": [round(v, 1) for v in t.tolist()], "scale": [round(v, 4) for v in scale.tolist()], "cx": [round(v, 1) for v in cx.tolist()], "cy": [round(v, 1) for v in cy.tolist()]},
        },
        "audio": {**loudness(video), **noise_floor(video)},
    }

    if cursor:
        ct = track_cursor(video, reference, tr, events, sync_offset_ms=offset)
        found = [c for c in ct if c["found"]]
        if len(found) >= 20:
            tt = np.array([c["t"] for c in ct])
            raw = np.array([raw_position(events, v) or (math.nan, math.nan) for v in tt])
            meas = np.array([[c["x"], c["y"]] for c in ct])
            fit = fit_cursor_smoothing(tt, raw, meas)
            result["cursor"] = {"foundFrames": len(found), "smoothing": fit}
        else:
            result["cursor"] = {"foundFrames": len(found), "smoothing": None}
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--reference", required=True, help="screenshot of the test app at the recording resolution")
    ap.add_argument("--events", required=True)
    ap.add_argument("--sync", default="auto", help="'auto' to detect the white sync flash, or an offset in ms")
    ap.add_argument("--step", type=int, default=1)
    ap.add_argument("--no-cursor", action="store_true")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    res = measure(a.video, a.reference, a.events, a.sync, a.step, not a.no_cursor)
    Path(a.out).write_text(json.dumps(res, indent=2, default=lambda o: None if isinstance(o, float) and math.isnan(o) else o))
    z = res["zoom"]["transitions"]
    print(f"tracked {res['trackedFrames']}/{res['totalFrames']} frames, {len(z)} zoom transitions -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
