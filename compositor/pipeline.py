#!/usr/bin/env python3
"""CLI: events + recording (+ audio) -> finished video, transcribing speech on-device when needed.

  python3 compositor/pipeline.py --meta meta.json --events events.jsonl --project project.json \
      --screen screen.mp4 [--camera cam.mp4] [--words transcript.json] --out final.mp4

With captions or edits.cleanup enabled and no --words, the project's mic track is transcribed with
lens-transcribe first (see project.transcription). Writes <out>.plan.json, <out>.project.json and
<out>.transcript.json next to the output.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lens_compositor import RenderOptions  # noqa: E402
from lens_compositor.pipeline import run  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--events", required=True)
    ap.add_argument("--project")
    ap.add_argument("--screen", required=True)
    ap.add_argument("--camera")
    ap.add_argument("--words", help="transcript JSON (skips transcription)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    a = ap.parse_args()
    r = run(a.meta, a.events, a.project, a.screen, a.out, a.camera, a.words, RenderOptions(crf=a.crf, preset=a.preset))
    extra = f", transcript {r.transcript}" if r.transcript else ""
    print(f"rendered {r.render['frames']} frames -> {r.render['out']} (plan {r.plan}{extra})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
