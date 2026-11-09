#!/usr/bin/env python3
"""Generate the editor's sample project (all media synthetic, made here; nothing third-party).

  python3 apps/editor/scripts/make_sample.py [--out apps/editor/sample] [--force]
  python3 apps/editor/scripts/make_sample.py --takes [--out apps/editor/sample-takes]
  python3 apps/editor/scripts/make_sample.py --privacy [--out apps/editor/sample-privacy]
  python3 apps/editor/scripts/make_sample.py --annotations [--out apps/editor/sample-annotations]
  python3 apps/editor/scripts/make_sample.py --brand [--out apps/editor/sample-brand]

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


def annotations_project() -> dict:
    """Every annotation kind, both anchors, every animation, a zoom (screen anchors follow it) and a text slide."""
    none = {"kind": "none", "ms": 0}
    return {
        "version": 1,
        "output": {"aspect": "16:9", "resolution": 720, "fps": 30},
        "background": {"kind": "gradient", "colors": ["#0f2027", "#2c5364", "#7ab8a6"], "angle": 135, "blur": 0},
        "zoom": {"auto": False, "segments": [{"id": "z1", "startMs": 4200, "endMs": 7600, "scale": 1.7, "focus": {"x": 420, "y": 200},
                                               "style": "classic", "auto": False}]},
        "cursor": {"visible": True},
        "annotations": [
            {"id": "title", "kind": "text", "role": "title", "anchor": "frame", "startMs": 0, "endMs": 2600, "rect": {"x": 0.12, "y": 0.06, "w": 0.76, "h": 0},
             "align": "center", "text": "Create a project in three clicks", "in": {"kind": "pop", "ms": 500}, "out": {"kind": "fade", "ms": 300},
             "style": {"fontSize": 54, "fill": "#11131a", "fillOpacity": 0.72, "radius": 16}},
            {"id": "arrow1", "kind": "arrow", "startMs": 300, "endMs": 2500, "from": {"x": 470, "y": 330}, "to": {"x": 150, "y": 118}, "curve": -0.22,
             "in": {"kind": "draw", "ms": 700}, "out": {"kind": "fade", "ms": 250}},
            {"id": "box1", "kind": "rect", "startMs": 2700, "endMs": 5600, "rect": {"x": 228, "y": 110, "w": 116, "h": 58},
             "in": {"kind": "draw", "ms": 600}, "out": {"kind": "fade", "ms": 300}},
            {"id": "badge1", "kind": "badge", "startMs": 2900, "endMs": 5600, "at": {"x": 360, "y": 96}, "text": "Pick Create"},
            {"id": "lower", "kind": "text", "role": "lower-third", "anchor": "frame", "startMs": 4400, "endMs": 9800, "rect": {"x": 0.08, "y": 0.8, "w": 0.6, "h": 0},
             "text": "Projects \u00b7 Create", "in": {"kind": "typewriter", "ms": 800}, "out": {"kind": "fade", "ms": 300},
             "style": {"fontSize": 38, "strokeWidth": 8, "fill": "#11131a", "fillOpacity": 0.8, "radius": 8}},
            {"id": "ring", "kind": "ellipse", "startMs": 7700, "endMs": 10400, "rect": {"x": 500, "y": 104, "w": 200, "h": 72},
             "in": {"kind": "draw", "ms": 500}, "out": {"kind": "pop", "ms": 300}, "style": {"color": "#ffd23f", "fill": "#ffd23f", "fillOpacity": 0.15}},
            {"id": "note", "kind": "callout", "anchor": "frame", "startMs": 8000, "endMs": 11000, "rect": {"x": 0.6, "y": 0.42, "w": 0.3, "h": 0.12},
             "to": {"x": 0.47, "y": 0.27}, "text": "Exports land in Downloads", "in": {"kind": "pop", "ms": 450}, "out": none},
        ],
        "slides": [{"id": "slide1", "atMs": 6000, "durationMs": 1500, "title": "Step two", "subtitle": "Export the list", "fadeMs": 300}],
    }


def make_annotations(out: Path, force: bool) -> int:
    """A short click-through of a fake app (steps_synth dev, 6 clicks) with every annotation kind."""
    if (out / "project.json").exists() and (out / "screen.mp4").exists() and not force:
        print(f"sample exists: {out}")
        return 0
    from lensharness.steps_synth import generate  # noqa: E402
    out.mkdir(parents=True, exist_ok=True)
    generate(out, "dev", max_steps=6)
    (out / "gt.json").unlink(missing_ok=True)  # test ground truth is not part of a bundle
    (out / "project.json").write_text(json.dumps(annotations_project(), indent=2))
    print(f"annotations sample written: {out}")
    return 0


def make_logo(path: Path) -> float:
    """An original placeholder logo (Lens's own drawing): a two-ring mark and the word 'acme', with
    anti-aliased alpha edges. Returns width / height."""
    from PIL import Image, ImageDraw, ImageFont
    w, h, ss = 300, 120, 4
    img = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy, r = 60 * ss, 60 * ss, 44 * ss
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, 235))
    r2 = 26 * ss
    d.ellipse((cx - r2 + 10 * ss, cy - r2, cx + r2 + 10 * ss, cy + r2), fill=(0, 0, 0, 0))
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 56 * ss)
    tw = d.textlength("acme", font=font)
    x0 = 116 * ss
    d.text((x0 + (w * ss - 10 * ss - x0 - tw) / 2, 26 * ss), "acme", font=font, fill=(255, 255, 255, 255))
    img = img.resize((w, h), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    return w / h


def brand_project(aspect: float) -> dict:
    """The main sample's look with a brand kit on: violet primary, Inter, a logo watermark, intro and
    outro cards; captions, a box, a badge and a lower-third that all inherit the brand colours."""
    p = project()
    p.pop("camera")
    p.pop("audio")
    p["background"] = {"blur": 0}  # inherits the brand backdrop
    p["captions"]["style"]["highlightColor"] = "@highlight"
    p["annotations"] = [
        {"id": "box", "kind": "rect", "startMs": 1200, "endMs": 4200, "rect": {"x": 140, "y": 90, "w": 360, "h": 120}},
        {"id": "badge", "kind": "badge", "startMs": 4600, "endMs": 8200, "at": {"x": 1100, "y": 560}, "text": "Save"},
        {"id": "lower", "kind": "text", "role": "lower-third", "anchor": "frame", "startMs": 5600, "endMs": 9600, "rect": {"x": 0.08, "y": 0.66, "w": 0.6, "h": 0},
         "text": "Acme Cloud \u00b7 Settings", "style": {"fontSize": 38, "strokeWidth": 8, "fill": "#11131a", "fillOpacity": 0.8, "radius": 8}},
    ]
    p["brand"] = {
        "enabled": True, "name": "Acme Cloud",
        "colors": {"primary": "#7c5cff", "accent": "#ffc94d", "background": {"mode": "derived", "colors": [], "angle": 135}},
        "captionHighlight": "primary", "font": "Inter",
        "logo": {"path": "brand/logo.png", "aspect": round(aspect, 4), "watermark": True, "corner": "bottom-right", "size": 0.12, "opacity": 0.8, "margin": 0.035},
        "intro": {"enabled": True, "title": "Acme Cloud", "subtitle": "A two-minute product tour", "durationMs": 1500, "logo": True},
        "outro": {"enabled": True, "title": "acme.dev", "subtitle": "Start free today", "durationMs": 1200, "logo": True},
    }
    return p


def make_brand(out: Path, force: bool) -> int:
    """The main sample's screen + transcript (no webcam / audio) with a brand kit (demand #9)."""
    if (out / "project.json").exists() and (out / "screen.mp4").exists() and not force:
        print(f"sample exists: {out}")
        return 0
    out.mkdir(parents=True, exist_ok=True)
    synthesize(out, W, H, FPS, DUR)
    (out / "transcript.json").write_text(json.dumps(transcript(), indent=1))
    aspect = make_logo(out / "brand" / "logo.png")
    (out / "project.json").write_text(json.dumps(brand_project(aspect), indent=2))
    (out / "reference.png").unlink(missing_ok=True)
    print(f"brand sample written: {out}")
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
    ap.add_argument("--annotations", action="store_true", help="write the annotations sample (default --out apps/editor/sample-annotations)")
    ap.add_argument("--brand", action="store_true", help="write the brand-kit sample (default --out apps/editor/sample-brand)")
    a = ap.parse_args()
    if a.brand:
        out = Path(a.out) if a.out != ap.get_default("out") else ROOT / "apps" / "editor" / "sample-brand"
        return make_brand(out, a.force)
    if a.annotations:
        out = Path(a.out) if a.out != ap.get_default("out") else ROOT / "apps" / "editor" / "sample-annotations"
        return make_annotations(out, a.force)
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
