#!/usr/bin/env python3
"""Preview/export parity: render a plan with the reference compositor and compare chosen frames with
PNGs rendered by the browser preview, pixel for pixel before any video encode.

  python3 parity_ssim.py --plan plan.json --screen screen.mp4 [--camera cam.mp4] --pngs dir \
      --frames 0,30,60 --out result.json [--diff-dir dir]

Browser frames are read from <pngs>/frame-<i>.png. Reference frames come straight from the
compositor (RenderOptions.frame_sink), not from a decoded MP4. SSIM (Wang et al. 2004: 11x11 Gaussian window,
sigma 1.5, K1 0.01, K2 0.03) is computed on luma (BT.601 grey) over the whole frame. Writes per-frame
SSIM plus mean / min, and a side-by-side + amplified diff image per frame when --diff-dir is given.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "compositor"))

from lens_compositor import RenderOptions, render  # noqa: E402


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    blur = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)  # noqa: E731
    mu_a, mu_b = blur(a), blur(b)
    saa = blur(a * a) - mu_a ** 2
    sbb = blur(b * b) - mu_b ** 2
    sab = blur(a * b) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + c1) * (2 * sab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (saa + sbb + c2))
    return float(m.mean())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--screen", required=True)
    ap.add_argument("--camera")
    ap.add_argument("--pngs", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--diff-dir")
    a = ap.parse_args()
    frames = [int(x) for x in a.frames.split(",")]
    want = set(frames)
    refs: dict[int, np.ndarray] = {}

    def keep(i: int, frame: np.ndarray) -> None:
        if i in want:
            refs[i] = frame.copy()

    # Compare against the compositor's frames before the YUV encode, so the score measures the
    # renderers and not x264 / swscale rounding (which shifts some channels by ~3-4 levels).
    render(a.plan, a.screen, "unused.mp4", a.camera, RenderOptions(max_frames=max(frames) + 1, audio=False, frame_sink=keep))
    rows = []
    for i in frames:
        web = cv2.imread(str(Path(a.pngs) / f"frame-{i}.png"), cv2.IMREAD_COLOR)
        r = refs[i]
        if web is None or web.shape != r.shape:
            raise SystemExit(f"frame {i}: browser PNG missing or wrong size")
        s = ssim(cv2.cvtColor(r, cv2.COLOR_BGR2GRAY), cv2.cvtColor(web, cv2.COLOR_BGR2GRAY))
        mad = float(np.abs(r.astype(np.int16) - web.astype(np.int16)).mean())
        rows.append({"frame": i, "ssim": round(s, 5), "meanAbsDiff": round(mad, 3)})
        if a.diff_dir:
            Path(a.diff_dir).mkdir(parents=True, exist_ok=True)
            diff = np.clip(np.abs(r.astype(np.int16) - web.astype(np.int16)) * 4, 0, 255).astype(np.uint8)
            cv2.imwrite(str(Path(a.diff_dir) / f"parity-{i:04d}.png"), np.vstack([np.hstack([r, web]), np.hstack([diff, np.zeros_like(diff)])]))
    vals = [r["ssim"] for r in rows]
    out = {"frames": rows, "mean": round(float(np.mean(vals)), 5), "min": round(float(np.min(vals)), 5)}
    Path(a.out).write_text(json.dumps(out, indent=1))
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
