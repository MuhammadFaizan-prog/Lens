#!/usr/bin/env python3
"""Make blind A/B material for a gauntlet critic.

  python research/harness/blind_ab.py --ours lens.mp4 --bar focusee.mp4 --out research/bars/zoom/round-03
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lensharness.abcompare import make_blind_pair  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ours", required=True)
    ap.add_argument("--bar", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--samples", type=int, default=10)
    a = ap.parse_args()
    res = make_blind_pair(a.ours, a.bar, a.out, a.samples)
    print(f"blind pair ready: {res['sideBySide']} and {res['contactSheet']} (key in {res['key']}, critic must not open it)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
