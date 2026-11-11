"""Synthetic bundle for the cursor-type e2e (demand #12): apps/editor/sample-cursor.

1280x720, 30 fps, 7 s of a flat light-grey screen (so the cursor art is the only thing in its crop).
The cursor parks at one point per second; a logged `cursor-shape` event 250 ms into each second
changes the type (arrow, hand, I-beam, resize <->, busy, resize up/down, arrow), the way the desktop
recorder logs the system cursor on Windows. events-untyped.jsonl is the same log without those lines
(a recording made before types were logged). Lens's own test art. Usage: make_cursor_sample.py [out_dir]
"""
import json, os, subprocess, sys

W, H, FPS, SECS = 1280, 720, 30, 7
BG = (200, 204, 212)
POINTS = [(300, 250), (520, 300), (740, 360), (960, 420), (420, 500), (640, 230), (860, 480)]
SHAPES = ["arrow", "pointer", "text", "resize-ew", "wait", "resize-ns", "arrow"]
SHAPE_AT_MS = 250  # into each second
MOVE_MS = 150


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sample-cursor")
    os.makedirs(out, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x{BG[0]:02x}{BG[1]:02x}{BG[2]:02x}:s={W}x{H}:r={FPS}:d={SECS}",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", os.path.join(out, "screen.mp4")], check=True)
    json.dump({"width": W, "height": H, "fps": FPS, "durationMs": SECS * 1000, "pixelRatio": 1}, open(os.path.join(out, "meta.json"), "w"))
    ev = []
    for i, (x, y) in enumerate(POINTS):
        t0 = i * 1000
        if i == 0:
            ev.append({"t": 0, "type": "move", "x": x, "y": y})
        else:
            px, py = POINTS[i - 1]
            for k in range(11):
                u = k / 10
                ev.append({"t": t0 + u * MOVE_MS, "type": "move", "x": round(px + (x - px) * u, 2), "y": round(py + (y - py) * u, 2)})
        ev.append({"t": t0 + SHAPE_AT_MS, "type": "cursor-shape", "shape": SHAPES[i]})
        for k in range(3, 10):
            ev.append({"t": t0 + k * 100, "type": "move", "x": x, "y": y})
    ev.append({"t": SECS * 1000 - 1, "type": "move", "x": POINTS[-1][0], "y": POINTS[-1][1]})
    ev.sort(key=lambda e: e["t"])
    head = '# lens-events v1 {"capture":{"width":1280,"height":720},"source":"screen","platform":"win32"}\n'
    with open(os.path.join(out, "events.jsonl"), "w") as f:
        f.write(head)
        for e in ev:
            f.write(json.dumps(e) + "\n")
    with open(os.path.join(out, "events-untyped.jsonl"), "w") as f:
        f.write(head)
        for e in ev:
            if e["type"] != "cursor-shape":
                f.write(json.dumps(e) + "\n")
    project = {"version": 1, "output": {"aspect": "16:9", "resolution": 540, "fps": 30},
               "zoom": {"auto": False}, "cursor": {"visible": True, "size": 2.5, "clickEffect": "none", "hideWhenIdle": False},
               "motionBlur": {"enabled": False}, "frame": {"shadow": {"opacity": 0}},
               "background": {"kind": "solid", "colors": ["#203040"], "inherit": False}, "audio": {"tracks": []}}
    json.dump(project, open(os.path.join(out, "project.json"), "w"), indent=1)
    json.dump({"points": POINTS, "shapes": SHAPES, "shapeAtMs": SHAPE_AT_MS}, open(os.path.join(out, "truth.json"), "w"))
    print(out)


if __name__ == "__main__":
    main()
