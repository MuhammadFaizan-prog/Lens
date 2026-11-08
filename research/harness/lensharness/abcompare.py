"""Blind A/B material for the gauntlet critic.

Given our clip and the bar clip, randomly assigns them to X and Y, then writes:
  side_by_side.mp4   X left, Y right, same height, labels "X" / "Y" only
  contact_sheet.png  N evenly spaced frame pairs
  key.json           which file is X and which is Y (the critic must not read this)
"""
from __future__ import annotations

import json
import random
import subprocess
from pathlib import Path

import cv2
import numpy as np

from .track import frames, probe


def make_blind_pair(ours: str, bar: str, out_dir: str, samples: int = 10, seed: int | None = None, height: int = 540) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    pair = [("ours", ours), ("bar", bar)]
    rng.shuffle(pair)
    (x_name, x_path), (y_name, y_path) = pair
    (out / "key.json").write_text(json.dumps({"X": x_name, "Y": y_name, "files": {"X": x_path, "Y": y_path}}, indent=2))

    sbs = out / "side_by_side.mp4"
    filt = (
        f"[0:v]scale=-2:{height},drawtext=text='X':x=20:y=20:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6[a];"
        f"[1:v]scale=-2:{height},drawtext=text='Y':x=20:y=20:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6[b];"
        "[a][b]hstack=inputs=2:shortest=1[v]"
    )
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", x_path, "-i", y_path, "-filter_complex", filt, "-map", "[v]", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(sbs)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        # drawtext needs fontconfig; fall back to unlabeled stack
        filt = f"[0:v]scale=-2:{height}[a];[1:v]scale=-2:{height}[b];[a][b]hstack=inputs=2:shortest=1[v]"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", x_path, "-i", y_path, "-filter_complex", filt, "-map", "[v]", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(sbs)], check=True)

    def grab(path: str, n: int) -> list[np.ndarray]:
        info = probe(path)
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip() or 0)
        total = max(1, int(dur * info["fps"]))
        want = {int(total * (k + 0.5) / n) for k in range(n)}
        got = [cv2.resize(f, (int(f.shape[1] * 270 / f.shape[0]), 270)) for i, f in frames(path) if i in want]
        return got[:n]

    xs, ys = grab(x_path, samples), grab(y_path, samples)
    rows = []
    for a, b in zip(xs, ys):
        rows.append(np.hstack([a, np.full((270, 8, 3), 255, np.uint8), b]))
    if rows:
        width = max(r.shape[1] for r in rows)
        rows = [np.pad(r, ((0, 8), (0, width - r.shape[1]), (0, 0)), constant_values=255) for r in rows]
        cv2.imwrite(str(out / "contact_sheet.png"), np.vstack(rows))
    return {"sideBySide": str(sbs), "contactSheet": str(out / "contact_sheet.png"), "key": str(out / "key.json")}
