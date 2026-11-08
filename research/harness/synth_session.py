#!/usr/bin/env python3
"""Generate a synthetic cursorless recording + event log for pipeline self-tests.

  python research/harness/synth_session.py --out out/synth [--width 1280 --height 720 --fps 30 --sync-flash]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lensharness.synth import synthesize  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--duration-ms", type=int, default=8000)
    ap.add_argument("--sync-flash", action="store_true")
    a = ap.parse_args()
    res = synthesize(a.out, a.width, a.height, a.fps, a.duration_ms, a.sync_flash)
    for k, v in res.items():
        print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
