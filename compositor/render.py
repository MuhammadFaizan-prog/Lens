#!/usr/bin/env python3
"""CLI: render a Lens plan.

  python compositor/render.py --plan plan.json --screen screen.mp4 [--camera cam.mp4] --out final.mp4
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lens_compositor import render, RenderOptions  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--screen", required=True, help="cursorless screen recording")
    ap.add_argument("--camera", help="optional webcam track")
    ap.add_argument("--out", required=True)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--max-frames", type=int)
    a = ap.parse_args()
    info = render(a.plan, a.screen, a.out, a.camera, RenderOptions(crf=a.crf, preset=a.preset, max_frames=a.max_frames))
    print(f"rendered {info['frames']} frames {info['width']}x{info['height']}@{info['fps']} -> {info['out']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
