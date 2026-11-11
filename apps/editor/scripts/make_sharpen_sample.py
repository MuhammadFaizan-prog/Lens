"""Synthetic bundle for the zoom-sharpening e2e (demand #22): apps/editor/sample-sharpen.

1280x720, 30 fps, 4 s, static. Mid-grey (128) screen with, inside the view of a 2.5x zoom on (640, 360):
 - a light panel of small UI text (Inter 11 px, dark grey) at x 400..630, y 240..480: what a zoom is
   meant to make readable;
 - a black bar (x 700..740) and a white bar (x 800..840), y 260..460, on the grey: hard edges where
   any ringing / halo would show on the flat grey beside them.
Lens's own test art. Usage: make_sharpen_sample.py [out_dir]
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

W, H, FPS, SECS = 1280, 720, 30, 4
TEXT_BOX = (400, 240, 630, 480)
BARS = [(700, 260, 740, 460, 0), (800, 260, 840, 460, 255)]
LINES = ["Settings  >  Account  >  Billing", "Invoice #20431   Paid   $1,240.00", "Next charge on 12 Dec 2026",
         "API key  sk_live_****  Rotate", "Members (14)   Invite   Remove", "Two-factor auth   Enabled",
         "Region  eu-west-1   Latency 38 ms", "Export CSV   Download PDF", "Last login 10:42 from Lahore",
         "Storage 71.4 GB of 100 GB used", "Webhooks  3 active  1 failing", "Plan: Team (annual)  Change"]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "sample-sharpen")
    os.makedirs(out, exist_ok=True)
    img = Image.new("RGB", (W, H), (128, 128, 128))
    d = ImageDraw.Draw(img)
    d.rectangle(TEXT_BOX, fill=(244, 245, 247))
    font = ImageFont.truetype(os.path.join(here, "..", "..", "..", "assets", "fonts", "Inter-Regular.ttf"), 11)
    y = TEXT_BOX[1] + 8
    for line in LINES:
        d.text((TEXT_BOX[0] + 8, y), line, fill=(40, 44, 52), font=font)
        y += 19
    for (x0, y0, x1, y1, v) in BARS:
        d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=(v, v, v))
    png = os.path.join(out, "frame.png")
    img.save(png)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", png, "-t", str(SECS), "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "8", "-pix_fmt", "yuv420p", os.path.join(out, "screen.mp4")], check=True)
    os.remove(png)
    json.dump({"width": W, "height": H, "fps": FPS, "durationMs": SECS * 1000, "pixelRatio": 1}, open(os.path.join(out, "meta.json"), "w"))
    with open(os.path.join(out, "events.jsonl"), "w") as f:
        f.write('# lens-events v1 {"capture":{"width":1280,"height":720},"source":"screen","platform":"linux"}\n')
        f.write(json.dumps({"t": 0, "type": "move", "x": 1200, "y": 680}) + "\n")
        f.write(json.dumps({"t": SECS * 1000 - 1, "type": "move", "x": 1200, "y": 680}) + "\n")
    project = {"version": 1, "output": {"aspect": "16:9", "resolution": 720, "fps": 30},
               "zoom": {"auto": False, "segments": [{"id": "z1", "startMs": 600, "endMs": 3600, "scale": 2.5, "focus": {"x": 640, "y": 360}, "style": "classic", "auto": False}]},
               "cursor": {"visible": False, "clickEffect": "none"},
               "frame": {"shadow": {"opacity": 0}},
               "background": {"kind": "solid", "colors": ["#203040"], "inherit": False}, "audio": {"tracks": []}}
    json.dump(project, open(os.path.join(out, "project.json"), "w"), indent=1)
    json.dump({"textBox": TEXT_BOX, "bars": BARS}, open(os.path.join(out, "truth.json"), "w"))
    print(out)


if __name__ == "__main__":
    main()
