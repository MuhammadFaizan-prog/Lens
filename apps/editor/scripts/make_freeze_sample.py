#!/usr/bin/env python3
"""Synthetic bundle for the freeze-frame e2e spec (demand #20): apps/editor/sample-freeze.

1280x720, 30 fps, 6 s. A flat green screen with one red 60 px square that moves right at 150 px/s
(x = 100 + 150 t, y = 300), so a held frame is measurable anywhere: its centroid stops moving. The
cursor sweeps from (200, 520) to (1100, 520) over the 6 s (below the square). mic.wav is silent but
for a 1 kHz tone at source 3.0-3.5 s, so a pause's inserted silence and the shift after it can be
measured in the exported audio. Also writes picture.png (400x300, left half blue, right half
yellow) for the image-slide step. Lens's own test art. Usage: make_freeze_sample.py [out_dir]
"""
import json, os, subprocess, sys, wave
import numpy as np
from PIL import Image

W, H, FPS, SECS, SR = 1280, 720, 30, 6, 48000
BG = (40, 140, 90)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sample-freeze")
    os.makedirs(out, exist_ok=True)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", os.path.join(out, "screen.mp4")], stdin=subprocess.PIPE)
    base = np.zeros((H, W, 3), np.uint8)
    base[:] = BG
    for i in range(FPS * SECS):
        t = i / FPS
        f = base.copy()
        x = int(round(100 + 150 * t))
        f[300 - 30:300 + 30, x - 30:x + 30] = (230, 30, 30)
        enc.stdin.write(f.tobytes())
    enc.stdin.close()
    enc.wait()
    json.dump({"width": W, "height": H, "fps": FPS, "durationMs": SECS * 1000, "pixelRatio": 1}, open(os.path.join(out, "meta.json"), "w"))
    with open(os.path.join(out, "events.jsonl"), "w") as fh:
        fh.write('# lens-events v1 {"capture":{"width":1280,"height":720},"source":"screen","platform":"linux"}\n')
        for i in range(0, SECS * 20 + 1):
            t = i * 50
            fh.write(json.dumps({"t": t, "type": "move", "x": round(200 + 900 * t / (SECS * 1000), 1), "y": 520}) + "\n")
    n = SR * SECS
    a = np.zeros(n, np.float32)
    s0, s1 = int(3.0 * SR), int(3.5 * SR)
    a[s0:s1] = 0.3 * np.sin(2 * np.pi * 1000 * np.arange(s1 - s0) / SR)
    with wave.open(os.path.join(out, "mic.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())
    pic = np.zeros((300, 400, 3), np.uint8)
    pic[:, :200] = (30, 80, 220)
    pic[:, 200:] = (240, 200, 40)
    Image.fromarray(pic).save(os.path.join(out, "picture.png"))
    # deterministic look for pixel checks: no auto zoom, no motion blur, no shadow, cursor on, no click effect
    project = {"version": 1, "output": {"aspect": "16:9", "resolution": 360, "fps": 30},
               "zoom": {"auto": False}, "cursor": {"visible": True, "clickEffect": "none", "smoothing": {"enabled": False}},
               "motionBlur": {"enabled": False}, "frame": {"shadow": {"opacity": 0}},
               "background": {"kind": "solid", "colors": ["#203040"], "inherit": False},
               "audio": {"tracks": [{"id": "mic", "kind": "mic", "path": "mic.wav", "offsetMs": 0, "volume": 1, "muted": False}]}}
    json.dump(project, open(os.path.join(out, "project.json"), "w"), indent=1)
    print(out)


if __name__ == "__main__":
    main()
