#!/usr/bin/env python3
"""Generate the editor's sample project (all media synthetic, made here; nothing third-party).

  python3 apps/editor/scripts/make_sample.py [--out apps/editor/sample] [--force]
  python3 apps/editor/scripts/make_sample.py --takes [--out apps/editor/sample-takes]
  python3 apps/editor/scripts/make_sample.py --privacy [--out apps/editor/sample-privacy]

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


# Multi-take variant (--takes): the same media, with a fumbled first take of the second sentence.
TAKES_WORDS = [
    ("This", 400, 650), ("is", 700, 820), ("Lens,", 870, 1300), ("um", 1380, 1700), ("a", 1760, 1820),
    ("clean-room", 1870, 2350), ("screen", 2400, 2700), ("recorder.", 2750, 3300),
    ("Watch", 3600, 3850), ("the", 3900, 4000), ("camera", 4050, 4400), ("uh", 4460, 4760),
    ("Watch", 5200, 5500), ("the", 5550, 5650), ("camera", 5700, 6050), ("follow", 6480, 6780),
    ("every", 6830, 7080), ("click.", 7130, 7550),
    ("Private", 7900, 8250), ("bits", 8300, 8500), ("stay", 8550, 8800), ("blurred.", 8850, 9400),
]


def takes_transcript() -> dict:
    t = transcript()
    words = [{"text": w, "startMs": s, "endMs": e, "confidence": 0.9, **({"filler": True} if w in FILLERS else {})} for w, s, e in TAKES_WORDS]
    pauses, prev = [], 0
    for w in words:
        if w["startMs"] - prev > 150:
            pauses.append({"startMs": prev, "endMs": w["startMs"]})
        prev = w["endMs"]
    pauses.append({"startMs": prev, "endMs": DUR})
    t.update(words=words, pauses=pauses)
    return t


def make_takes(out: Path, force: bool) -> int:
    """Link the default sample's media and write a transcript with a retake, takes on."""
    base = ROOT / "apps" / "editor" / "sample"
    if not (base / "screen.mp4").exists():
        import subprocess
        subprocess.run([sys.executable, __file__, "--out", str(base)], check=True)
    if (out / "project.json").exists() and (out / "screen.mp4").exists() and not force:
        print(f"sample exists: {out}")
        return 0
    out.mkdir(parents=True, exist_ok=True)
    for name in ("screen.mp4", "cam.mp4", "mic.wav", "meta.json", "events.jsonl"):
        dst = out / name
        if dst.is_symlink() or dst.exists():
            dst.unlink()
        dst.symlink_to(base / name)
    p = project()
    p["edits"]["takes"] = {"enabled": True, "strategy": "last"}
    (out / "transcript.json").write_text(json.dumps(takes_transcript(), indent=1))
    (out / "project.json").write_text(json.dumps(p, indent=2))
    print(f"takes sample written: {out}")
    return 0


def make_privacy(out: Path, force: bool) -> int:
    """A 15 s fake console with planted fake secrets that scroll and move (privacy_synth, dev variant)."""
    if (out / "project.json").exists() and (out / "screen.mp4").exists() and not force:
        print(f"sample exists: {out}")
        return 0
    from lensharness.privacy_synth import generate  # noqa: E402
    out.mkdir(parents=True, exist_ok=True)
    generate(out, duration_ms=15000, fps=30, variant="dev")
    (out / "gt.json").unlink(missing_ok=True)  # test ground truth is not part of a bundle
    p = {"version": 1, "output": {"aspect": "16:9", "resolution": 720, "fps": 30},
         "background": {"kind": "gradient", "colors": ["#0f2027", "#2c5364", "#7ab8a6"], "angle": 135, "blur": 0},
         "zoom": {"auto": False}, "cursor": {"visible": True}}
    (out / "project.json").write_text(json.dumps(p, indent=2))
    print(f"privacy sample written: {out}")
    return 0


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
    ap.add_argument("--takes", action="store_true", help="write the multi-take sample (default --out apps/editor/sample-takes)")
    ap.add_argument("--privacy", action="store_true", help="write the privacy-redaction sample (default --out apps/editor/sample-privacy)")
    a = ap.parse_args()
    if a.privacy:
        out = Path(a.out) if a.out != ap.get_default("out") else ROOT / "apps" / "editor" / "sample-privacy"
        return make_privacy(out, a.force)
    if a.takes:
        out = Path(a.out) if a.out != ap.get_default("out") else ROOT / "apps" / "editor" / "sample-takes"
        return make_takes(out, a.force)
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
