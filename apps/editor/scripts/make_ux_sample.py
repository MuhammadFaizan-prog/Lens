#!/usr/bin/env python3
"""Synthetic bundle for the editor UX e2e specs (Windows bugs #2-#20): apps/editor/sample-ux.

1280x720, 30 fps, 6 s, static: an 8 px black / white checkerboard (so a blur is measurable anywhere)
with red marker dots at known source points (so a zoom's crop centre can be measured in the export).
Lens's own test art. Usage: make_ux_sample.py [out_dir]
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw

W, H, FPS, SECS = 1280, 720, 30, 6
MARKERS = [(900, 250), (320, 520)]

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sample-ux")
    os.makedirs(out, exist_ok=True)
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    for y in range(0, H, 8):
        for x in range(0, W, 8):
            if (x // 8 + y // 8) % 2 == 0:
                d.rectangle([x, y, x + 7, y + 7], fill=(0, 0, 0))
    for (mx, my) in MARKERS:
        d.rectangle([mx - 14, my - 14, mx + 14, my + 14], fill=(128, 128, 128))  # quiet surround
        d.ellipse([mx - 5, my - 5, mx + 5, my + 5], fill=(255, 0, 0))
    png = os.path.join(out, "frame.png")
    img.save(png)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", png, "-t", str(SECS), "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "12", "-pix_fmt", "yuv420p", os.path.join(out, "screen.mp4")], check=True)
    os.remove(png)
    json.dump({"width": W, "height": H, "fps": FPS, "durationMs": SECS * 1000, "pixelRatio": 1}, open(os.path.join(out, "meta.json"), "w"))
    with open(os.path.join(out, "events.jsonl"), "w") as f:
        f.write('# lens-events v1 {"capture":{"width":1280,"height":720},"source":"screen","platform":"linux"}\n')
        for i in range(0, SECS * 10):
            t = i * 100
            f.write(json.dumps({"t": t, "type": "move", "x": 200 + i * 12, "y": 200 + (i % 20) * 10}) + "\n")
    # deterministic look for pixel checks: no cursor, no auto zoom, no motion blur, no webcam
    project = {"version": 1, "output": {"aspect": "16:9", "resolution": 720, "fps": 30},
               "zoom": {"auto": False}, "cursor": {"visible": False, "clickEffect": "none"},
               "motionBlur": {"enabled": False}, "frame": {"shadow": {"opacity": 0}},
               "background": {"kind": "solid", "colors": ["#203040"], "inherit": False}, "audio": {"tracks": []}}
    json.dump(project, open(os.path.join(out, "project.json"), "w"), indent=1)
    print(out)

if __name__ == "__main__":
    main()
