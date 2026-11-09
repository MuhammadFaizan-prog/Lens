"""Synthetic session for the steps export tests (demand #7): a fake web app with six clicks, and a
magenta marker drawn into the recording at each click point just before (and while) it is clicked.

The marker is the independent truth for the hotspot test: wherever the compositor puts the source
pixel (x, y) in a still (crop, layout, scale, optional zoom), the marker's centroid is there, and
the exported hotspot must sit on it. Everything is generated here (PIL + ffmpeg); no sample media.

  python -m lensharness.steps_synth --out /tmp/steps [--zoom]
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 800, 30
DURATION_MS = 8000
MARKER = (255, 0, 255)
MARKER_R = 6
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# (time ms, x, y, button text, verb); buttons are drawn centred on the click
CLICKS = [
    (1000, 210, 150, "Projects", "Open"),
    (2000, 1100, 118, "Share", "Click"),
    (3000, 640, 420, "New report", "Click"),
    (4000, 120, 700, "Settings", "Open"),
    (5000, 1170, 720, "Save", "Click"),
    (6000, 720, 610, "Export CSV", "Click"),
]
CROP = {"x": 40, "y": 30, "w": 1200, "h": 744}


def _font(path: str, size: int):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def button_boxes() -> list[tuple[float, float, float, float]]:
    f = _font(BOLD, 18)
    out = []
    for _, x, y, text, _ in CLICKS:
        tw = f.getlength(text)
        bw, bh = tw + 36, 40
        out.append((x - bw / 2, y - bh / 2, bw, bh))
    return out


def base_image() -> Image.Image:
    img = Image.new("RGB", (W, H), (244, 246, 250))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 64], fill=(255, 255, 255))
    d.line([0, 64, W, 64], fill=(220, 224, 232))
    d.text((70, 20), "Acme Analytics", font=_font(BOLD, 22), fill=(30, 34, 44))
    d.rectangle([0, 65, 260, H], fill=(236, 239, 245))
    body = _font(FONT, 16)
    for i, w in enumerate(["Overview", "Dashboards", "Alerts", "Team", "Billing"]):
        d.text((40, 230 + 46 * i), w, font=body, fill=(70, 76, 90))
    for r in range(4):
        d.rounded_rectangle([320, 200 + 90 * r, 1180, 270 + 90 * r], radius=8, fill=(255, 255, 255), outline=(225, 228, 236))
        d.text((345, 222 + 90 * r), f"Quarterly revenue by region, table {r + 1}", font=body, fill=(60, 66, 80))
    bf = _font(BOLD, 18)
    for (bx, by, bw, bh), (_, x, y, text, _) in zip(button_boxes(), CLICKS):
        d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=8, fill=(52, 92, 230))
        tw = bf.getlength(text)
        d.text((x - tw / 2, y - 11), text, font=bf, fill=(255, 255, 255))
    return img


def generate(out: Path, zoom: bool = False, brand: bool = True) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    base = base_image()
    n = DURATION_MS * FPS // 1000
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", "yuv444p", str(out / "screen.mp4")], stdin=subprocess.PIPE)
    for f in range(n):
        t = f * 1000 / FPS
        img = base.copy()
        d = ImageDraw.Draw(img)
        for (tc, x, y, *_rest) in CLICKS:
            if tc - 600 <= t <= tc + 300:
                d.ellipse([x - MARKER_R, y - MARKER_R, x + MARKER_R, y + MARKER_R], fill=MARKER)
        ff.stdin.write(np.asarray(img, np.uint8).tobytes())
    ff.stdin.close()
    assert ff.wait() == 0
    events = []
    px, py = W / 2, H / 2
    t = 0.0
    for (tc, x, y, *_r) in CLICKS:
        for k in range(1, 11):
            u = k / 10
            events.append({"t": round(tc - 500 + 40 * k, 1), "type": "move", "x": round(px + (x - px) * u, 1), "y": round(py + (y - py) * u, 1)})
        events.append({"t": tc, "type": "down", "x": x, "y": y, "button": "left"})
        events.append({"t": tc + 90, "type": "up", "x": x, "y": y, "button": "left"})
        px, py = x, y
    (out / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    (out / "meta.json").write_text(json.dumps({"width": W, "height": H, "fps": FPS, "durationMs": DURATION_MS, "pixelRatio": 1}))
    drafts = []
    for i, ((tc, x, y, text, verb), (bx, by, bw, bh)) in enumerate(zip(CLICKS, button_boxes())):
        drafts.append({"id": f"st{i + 1}", "clickMs": tc, "x": x, "y": y, "label": f"{verb} {text}", "target": text, "verb": verb,
                       "confidence": 0.9, "state": "accepted", "box": {"x": round(bx, 1), "y": round(by, 1), "w": round(bw, 1), "h": round(bh, 1)}})
    project = {
        "output": {"aspect": "16:9", "resolution": 720, "fps": 30},
        "background": {"kind": "solid", "colors": ["#1d2433"], "inherit": False},
        "frame": {"padding": 0.06, "radius": 12},
        "crop": CROP,
        "stepLabels": {"drafts": drafts, "generatedAt": None},
        "demo": {"title": "Create and share a report", "description": "Six clicks from login to CSV.",
                 "cta": {"enabled": True, "title": "Ready to try it?", "text": "Start a free trial in under a minute.", "buttonLabel": "Start free trial",
                         "url": "https://example.com/start"}},
    }
    if brand:
        project["brand"] = {"enabled": True, "name": "Acme", "colors": {"primary": "#e8132a", "accent": "#ffc94d"}}
    if zoom:
        project["demo"]["zoom"] = "video"
        project["zoom"] = {"auto": False, "segments": [{"id": "z3", "startMs": 2200, "endMs": 3000, "scale": 1.8, "focus": {"x": 700, "y": 380},
                                                        "style": "classic", "auto": False}]}
    (out / "project.json").write_text(json.dumps(project, indent=1))
    return {"clicks": CLICKS, "crop": CROP, "boxes": button_boxes()}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--zoom", action="store_true")
    a = ap.parse_args()
    generate(Path(a.out), zoom=a.zoom)
    print(a.out)
