"""lens-redact: find sensitive text in a screen recording, on-device.

  lens-redact screen.mp4 [--events events.jsonl] -o privacy.json [--thumbs DIR] [--interval-ms 1000]
              [--no-notifications] [--progress]

Writes the scan (version, engine, source, settings, stats, detections). Each detection is a review
item with a type, a redacted preview (the secret itself is never written), a thumbnail name and one
or more tracks, each a time range with a key rect per frame where the box moved.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .scan import ScanSettings, scan


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="lens-redact", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--events", help="events.jsonl (scroll events widen the tracker's search)")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--thumbs", help="folder for review thumbnails")
    ap.add_argument("--interval-ms", type=float, default=1000.0)
    ap.add_argument("--no-notifications", action="store_true")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--progress", action="store_true", help="print 'progress <stage> <done> <total>' lines on stderr")
    a = ap.parse_args(argv)
    s = ScanSettings(interval_ms=a.interval_ms, notifications=not a.no_notifications, workers=a.workers)

    def prog(stage: str, done: int, total: int) -> None:
        if a.progress:
            print(f"progress {stage} {done} {total}", file=sys.stderr, flush=True)

    res = scan(a.video, a.events, s, a.thumbs, prog)
    Path(a.out).write_text(json.dumps(res, indent=1))
    print(f"{len(res['detections'])} detections, {res['stats']['samples']} OCR samples, {res['stats']['seconds']['total']} s", file=sys.stderr)
    return 0
