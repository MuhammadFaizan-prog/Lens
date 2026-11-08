#!/usr/bin/env python3
"""Generate the editor's sample project (all media synthetic, made here; nothing third-party).

  python3 apps/editor/scripts/make_sample.py [--out apps/editor/sample] [--force]

Writes a Lens bundle the editor opens by default:
  screen.mp4  cursorless fake-app recording (1280x720 @ 30 fps, 10 s) + meta.json + events.jsonl
  cam.mp4     procedural presenter webcam
  mic.wav     speech-shaped tone track
  transcript.json  lens-transcribe format (words with fillers flagged, measured pauses)
  project.json     720p / 30 fps project with webcam, masks, captions and a manual zoom
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(ROOT / "tests"))

from lensharness.synth import synthesize  # noqa: E402
from media import SR, speechy, write_wav  # noqa: E402
from demo_p1 import presenter_webcam  # noqa: E402

W, H, FPS, DUR = 1280, 720, 30, 10000

WORDS = [
    ("This", 400, 650), ("is", 700, 820), ("Lens,", 870, 1300), ("um", 1380, 1700), ("a", 1760, 1820),
    ("clean-room", 1870, 2350), ("screen", 2400, 2700), ("recorder.", 2750, 3300),
    ("Watch", 5200, 5500), ("the", 5550, 5650), ("camera", 5700, 6050), ("uh", 6120, 6420), ("follow", 6480, 6780),
    ("every", 6830, 7080), ("click.", 7130, 7550),
    ("Private", 7900, 8250), ("bits", 8300, 8500), ("stay", 8550, 8800), ("blurred.", 8850, 9400),
]
FILLERS = {"um", "uh"}


def transcript() -> dict:
    words = [{"text": t, "startMs": s, "endMs": e, "confidence": 0.9, **({"filler": True} if t in FILLERS else {})} for t, s, e in WORDS]
    pauses, prev = [], 0
    for w in words:
        if w["startMs"] - prev > 150:
            pauses.append({"startMs": prev, "endMs": w["startMs"]})
        prev = w["endMs"]
    pauses.append({"startMs": prev, "endMs": DUR})
    return {"version": 1, "language": "en", "durationMs": DUR, "offsetMs": 0,
            "engine": {"name": "hand-written sample", "model": "none", "licence": "n/a"},
            "source": {"path": "mic.wav", "trackId": "mic"}, "words": words, "pauses": pauses}


def project() -> dict:
    sx = W / 1920
    return {
        "version": 1,
        "output": {"aspect": "16:9", "resolution": 720, "fps": 30},
        "background": {"kind": "gradient", "colors": ["#0f2027", "#2c5364", "#7ab8a6"], "angle": 135, "blur": 0},
        "camera": {"enabled": True, "corner": "bottom-right", "size": 0.26, "shape": "rounded", "mirror": True,
                   "crop": {"x": 60, "y": 0, "w": 360, "h": 360}, "zoomedSize": 0.6},
        "edits": {"cuts": [], "speed": []},
        "audio": {"tracks": [{"id": "mic", "kind": "mic", "path": "mic.wav", "offsetMs": 0, "volume": 1, "muted": False}],
                  "noiseReduction": {"enabled": False, "amountDb": 12}, "loudness": {"enabled": True, "targetLufs": -16}},
        "masks": [
            {"id": "sidebar-blur", "kind": "blur", "rect": {"x": 0, "y": int(80 * sx), "w": int(300 * sx), "h": int(620 * sx)},
             "startMs": 0, "endMs": 3200, "feather": 10, "fadeMs": 250, "strength": 10},
            {"id": "save-spotlight", "kind": "spotlight", "rect": {"x": int(1500 * sx), "y": int(850 * sx), "w": int(200 * sx), "h": int(100 * sx)},
             "startMs": 5600, "endMs": 7600, "feather": 14, "fadeMs": 300, "strength": 0.55},
        ],
        "captions": {"enabled": True, "wordHighlight": True, "maxWordsPerBlock": 7,
                     "style": {"fontSize": 46, "highlightColor": "#ffd23f", "position": "bottom", "maxWordsPerLine": 5}},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "apps" / "editor" / "sample"))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    if (out / "project.json").exists() and (out / "screen.mp4").exists() and not a.force:
        print(f"sample exists: {out}")
        return 0
    out.mkdir(parents=True, exist_ok=True)
    synthesize(out, W, H, FPS, DUR)
    presenter_webcam(out / "cam.mp4", dur_ms=DUR)
    rng = np.random.default_rng(11)
    mic = speechy(DUR, level=0.05) + rng.normal(0, 0.003, int(DUR / 1000 * SR)).astype(np.float32)
    write_wav(out / "mic.wav", mic)
    (out / "transcript.json").write_text(json.dumps(transcript(), indent=1))
    (out / "project.json").write_text(json.dumps(project(), indent=2))
    (out / "reference.png").unlink(missing_ok=True)
    print(f"sample written: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
