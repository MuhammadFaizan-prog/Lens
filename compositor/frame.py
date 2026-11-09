#!/usr/bin/env python3
"""CLI: render plan frames to PNG without encoding a video (used by `lens frame` / the MCP render_frame tool).

  python compositor/frame.py --plan plan.json --screen screen.mp4 [--camera cam.mp4] --out frame.png

The plan is usually built with only the wanted frames (engine `onlyFrames`), so this draws exactly
what the export would draw for those frames (before the lossy encode). With several frames in the
plan, --out must contain `{n}` (replaced by the frame's index in the plan).
"""
import argparse
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lens_compositor import render, RenderOptions  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--screen", required=True)
    ap.add_argument("--camera")
    ap.add_argument("--out", required=True)
    ap.add_argument("--assets", help="folder relative logo / font paths resolve against (default: the plan's folder)")
    a = ap.parse_args()
    written: list[str] = []

    def sink(i: int, frame) -> None:
        out = a.out.replace("{n}", str(i)) if "{n}" in a.out else a.out
        if not cv2.imwrite(out, frame):
            raise RuntimeError(f"could not write {out}")
        written.append(out)

    info = render(a.plan, a.screen, a.out, a.camera, RenderOptions(frame_sink=sink, audio=False, asset_dir=a.assets))
    print(f"frames {len(written)} {info['width']}x{info['height']} -> {', '.join(written)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
