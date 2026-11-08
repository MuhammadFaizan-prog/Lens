#!/usr/bin/env python3
"""Render one demo that exercises every P1 feature together, plus a contact sheet.

  python3 research/harness/demo_p1.py [--out out/demo-p1.mp4] [--sheet out/demo-p1-sheet.png]

Synthetic session (fake app UI, cursorless) + procedural webcam + procedural voice-like mic track.
Features on: mic audio with offset, cut and 2x speed range, denoise + loudnorm (-16 LUFS), click
sounds, source crop, blur / pixelate / spotlight masks, webcam mirror + crop + shrink while zoomed,
styled captions with word highlight, per-segment overrides (hidden cursor, bigger cursor, volume).
All media is generated here; nothing third-party.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(ROOT / "compositor"))
sys.path.insert(0, str(ROOT / "tests"))

from lensharness.audio import loudness  # noqa: E402
from lensharness.synth import synthesize  # noqa: E402
from lens_compositor import RenderOptions, render  # noqa: E402
from media import CLI, SR, speechy, write_wav  # noqa: E402

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def presenter_webcam(path: Path, w: int = 480, h: int = 360, fps: int = 30, dur_ms: int = 10000) -> str:
    """Procedural stand-in for a webcam: backdrop, a softly swaying head-and-shoulders silhouette and
    an "L" badge on the left of the frame so mirroring is visible."""
    n = int(dur_ms * fps / 1000)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    back = np.stack([90 + 60 * yy / h, 70 + 40 * xx / w, 50 + 30 * yy / h], -1)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    assert enc.stdin
    for i in range(n):
        t = i / fps
        img = back.copy()
        cx = w * 0.5 + 12 * np.sin(2 * np.pi * 0.4 * t)
        cv2.ellipse(img, (int(cx), int(h * 1.02)), (int(w * 0.34), int(h * 0.3)), 0, 180, 360, (70, 60, 160), -1, cv2.LINE_AA)
        cv2.circle(img, (int(cx), int(h * 0.48)), int(h * 0.2), (150, 180, 225), -1, cv2.LINE_AA)
        cv2.rectangle(img, (int(w * 0.06), int(h * 0.08)), (int(w * 0.2), int(h * 0.22)), (240, 240, 240), -1)
        cv2.putText(img, "L", (int(w * 0.09), int(h * 0.2)), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (40, 40, 200), 3, cv2.LINE_AA)
        enc.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
    enc.stdin.close()
    enc.wait()
    return str(path)


WORDS = [
    {"text": "This", "startMs": 400, "endMs": 650}, {"text": "is", "startMs": 700, "endMs": 820},
    {"text": "Lens,", "startMs": 870, "endMs": 1300}, {"text": "a", "startMs": 1350, "endMs": 1420},
    {"text": "clean-room", "startMs": 1470, "endMs": 1950}, {"text": "screen", "startMs": 2000, "endMs": 2300},
    {"text": "recorder.", "startMs": 2350, "endMs": 2900},
    {"text": "Watch", "startMs": 5200, "endMs": 5500}, {"text": "the", "startMs": 5550, "endMs": 5650},
    {"text": "camera", "startMs": 5700, "endMs": 6050}, {"text": "follow", "startMs": 6100, "endMs": 6400},
    {"text": "every", "startMs": 6450, "endMs": 6700}, {"text": "click.", "startMs": 6750, "endMs": 7200},
    {"text": "Private", "startMs": 7600, "endMs": 8000}, {"text": "bits", "startMs": 8050, "endMs": 8300},
    {"text": "stay", "startMs": 8350, "endMs": 8600}, {"text": "blurred.", "startMs": 8650, "endMs": 9300},
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "out" / "demo-p1.mp4"))
    ap.add_argument("--sheet", default=str(ROOT / "out" / "demo-p1-sheet.png"))
    ap.add_argument("--gif", default=None, help="also write a GIF of the same plan")
    a = ap.parse_args()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        W, H = 1280, 720
        s = synthesize(d, W, H, 30, 10000)
        cam = presenter_webcam(d / "cam.mp4")
        rng = np.random.default_rng(11)
        mic = speechy(10400, level=0.025) + rng.normal(0, 0.004, int(10.4 * SR)).astype(np.float32)
        write_wav(d / "mic.wav", mic)
        sx = W / 1920
        project = {
            "output": {"fps": 30, "resolution": 720},
            "crop": {"x": 0, "y": 0, "w": int(1800 * sx), "h": int(1012 * sx)},
            "camera": {"enabled": True, "corner": "bottom-right", "size": 0.26, "shape": "rounded", "mirror": True,
                       "crop": {"x": 60, "y": 0, "w": 360, "h": 360}, "zoomedSize": 0.6},
            "cursor": {"clickSound": True, "clickSoundVolume": 0.6},
            "edits": {"cuts": [{"startMs": 3000, "endMs": 3600}], "speed": [{"startMs": 1800, "endMs": 2800, "rate": 2}]},
            "audio": {"tracks": [{"id": "mic", "kind": "mic", "path": str(d / "mic.wav"), "offsetMs": -200, "volume": 1, "muted": False}],
                      "noiseReduction": {"enabled": True, "amountDb": 15}, "loudness": {"enabled": True, "targetLufs": -16}},
            "masks": [
                {"id": "sidebar-blur", "kind": "blur", "rect": {"x": 0, "y": int(80 * sx), "w": int(300 * sx), "h": int(620 * sx)},
                 "startMs": 0, "endMs": 10000, "feather": 10, "fadeMs": 250, "strength": 10},
                {"id": "field-pixelate", "kind": "pixelate", "rect": {"x": int(330 * sx), "y": int(340 * sx), "w": int(600 * sx), "h": int(44 * sx)},
                 "startMs": 4300, "endMs": 5600, "feather": 0, "fadeMs": 150, "strength": 8},
                {"id": "save-spotlight", "kind": "spotlight", "rect": {"x": int(1500 * sx), "y": int(850 * sx), "w": int(200 * sx), "h": int(100 * sx)},
                 "startMs": 5600, "endMs": 7600, "feather": 14, "fadeMs": 300, "strength": 0.55},
            ],
            "overrides": [{"startMs": 4300, "endMs": 5000, "cursor": {"hidden": True}},
                          {"startMs": 5100, "endMs": 6900, "cursor": {"size": 2.8}},
                          {"startMs": 7600, "endMs": 9800, "volume": 0.6}],
            "captions": {"enabled": True, "wordHighlight": True, "maxWordsPerBlock": 7,
                         "style": {"fontSize": 46, "highlightColor": "#ffd23f", "position": "top", "maxWordsPerLine": 4}},
            "export": {"gif": {"fps": 12, "width": 480, "loop": True}},
        }
        (d / "project.json").write_text(json.dumps(project))
        (d / "words.json").write_text(json.dumps(WORDS))
        subprocess.run(["node", str(CLI), "--meta", s["meta"], "--events", s["events"], "--project", str(d / "project.json"),
                        "--words", str(d / "words.json"), "--out", str(d / "plan.json")], check=True)
        info = render(str(d / "plan.json"), s["screen"], str(out), camera_path=cam, opts=RenderOptions(preset="veryfast", crf=18))
        if a.gif:
            render(str(d / "plan.json"), s["screen"], a.gif, camera_path=cam, opts=RenderOptions(preset="veryfast"))
        plan = json.loads((d / "plan.json").read_text())
    # Contact sheet: 16 frames across the output with timestamps.
    dur = plan["output"]["durationMs"] / 1000
    step = dur / 16
    sheet = Path(a.sheet)
    vf = (f"fps=1/{step:.4f},scale=480:-2,drawtext=fontfile={FONT}:text='%{{pts\\:hms}}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,"
          f"tile=4x4:padding=6:color=0x111111")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(out), "-vf", vf, "-frames:v", "1", "-update", "1", str(sheet)], check=True)
    lo = loudness(str(out))
    print(json.dumps({"video": str(out), "sheet": str(sheet), "frames": info["frames"], "audio": info["audio"],
                      "durationMs": plan["output"]["durationMs"], "integratedLufs": lo.get("integratedLufs"),
                      "clickTimes": plan["audio"]["clickSound"]["times"]}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
