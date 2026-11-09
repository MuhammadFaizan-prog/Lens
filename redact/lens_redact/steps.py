"""Automatic step labels (demand #4): from the click log plus local OCR around each click, draft
"Click Save" / "Open Settings" labels for numbered step badges. On-device (Tesseract, Apache-2.0),
the same OCR helpers as the privacy scan.

For each left click (double clicks merged):
  1. the frame just before the press (the UI before any pressed / opened state),
  2. a region around the click (±260 x ±100 source px), upscaled 2x, OCR'd twice with sparse-text
     segmentation: as it is, and as a polarity-free contrast map (distance from the local
     background), so white text on a coloured button reads too; overlapping words keep the more
     confident reading,
  3. words grouped into lines (ocr.group_lines), lines split into controls at gaps wider than one
     text height (toolbar buttons sit closer than lines but further apart than words),
  4. the control under the click (its text box padded to roughly a button's size), else the nearest
     one within 40 px, else nothing ("Click here", confidence 0),
  5. a verb: "Open" for navigation (a menu / tab / sidebar word, or an item in a top menu row or a
     left-aligned vertical list of short items), "Click" otherwise.

Only the drafted label and the control text are written; review happens in the editor.
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .ocr import OcrLine, OcrWord, group_lines, ocr_images

NAV_WORDS = {
    "settings", "preferences", "profile", "account", "menu", "file", "edit", "view", "help", "dashboard", "home", "tools",
    "window", "options", "notifications", "billing", "reports", "projects", "inbox", "overview", "analytics", "team",
    "members", "integrations", "library", "history", "messages", "documents", "files", "calendar", "tab", "page",
}

ROI_W, ROI_H = 260, 100


@dataclass
class Click:
    t: float
    x: float
    y: float


def load_clicks(events_path: str, merge_ms: float = 400, merge_px: float = 6) -> list[Click]:
    out: list[Click] = []
    for line in Path(events_path).read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        e = json.loads(line)
        if e.get("type") != "down" or e.get("button", "left") != "left":
            continue
        c = Click(float(e["t"]), float(e["x"]), float(e["y"]))
        if out and c.t - out[-1].t < merge_ms and abs(c.x - out[-1].x) < merge_px and abs(c.y - out[-1].y) < merge_px:
            continue  # second click of a double click
        out.append(c)
    return sorted(out, key=lambda c: c.t)


def _probe(path: str) -> dict:
    o = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", path],
                       check=True, capture_output=True, text=True).stdout
    s = json.loads(o)["streams"][0]
    n, d = s["r_frame_rate"].split("/")
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": float(n) / float(d)}


def frames_at(path: str, indices: list[int]) -> dict[int, np.ndarray]:
    """Grey frames at the given indices (one sequential decode)."""
    info = _probe(path)
    w, h = info["width"], info["height"]
    want = set(indices)
    got: dict[int, np.ndarray] = {}
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "gray", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert p.stdout
    i = 0
    last = max(want) if want else -1
    try:
        while i <= last:
            buf = p.stdout.read(w * h)
            if len(buf) < w * h:
                break
            if i in want:
                got[i] = np.frombuffer(buf, np.uint8).reshape(h, w).copy()
            i += 1
    finally:
        p.stdout.close()
        p.kill()
        p.wait()
    # past the end: use the last frame read
    for j in want:
        if j not in got and got:
            got[j] = got[max(got)]
    return got


def contrast_map(g: np.ndarray) -> np.ndarray:
    """Polarity-free text image: distance from the local background (median over 21 px), dark on
    white. White text on a coloured button and dark text on a page both come out as dark text."""
    bg = cv2.medianBlur(g, 21)
    d = np.abs(g.astype(np.int16) - bg.astype(np.int16))
    return np.clip(255 - d * 2.2, 0, 255).astype(np.uint8)


def _clean(words: list[OcrWord]) -> str:
    toks = []
    for w in words:
        t = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", w.text)
        if not t:
            continue
        if w.conf < 30 and len(t) <= 2:
            continue  # icon glyphs read as letters
        toks.append(t)
    return " ".join(toks)


def _controls(lines: list[OcrLine]) -> list[OcrLine]:
    out: list[OcrLine] = []
    for ln in lines:
        ws = sorted(ln.words, key=lambda q: q.x)
        cur = [ws[0]]
        for q in ws[1:]:
            p = cur[-1]
            hh = max(8.0, float(np.median([z.h for z in cur])))
            if q.x - (p.x + p.w) > 1.0 * hh:
                out.append(OcrLine(cur))
                cur = [q]
            else:
                cur.append(q)
        out.append(OcrLine(cur))
    return out


def _merge_polarities(a: list[OcrWord], b: list[OcrWord]) -> list[OcrWord]:
    """Union of two OCR passes; where boxes overlap keep the more confident word."""
    out = list(a)
    for w in b:
        clash = None
        for i, v in enumerate(out):
            ix = min(w.x + w.w, v.x + v.w) - max(w.x, v.x)
            iy = min(w.y + w.h, v.y + v.h) - max(w.y, v.y)
            if ix > 0 and iy > 0 and ix * iy > 0.3 * min(w.w * w.h, v.w * v.h):
                clash = i
                break
        if clash is None:
            out.append(w)
        elif w.conf > out[clash].conf:
            out[clash] = w
    return out


def _is_nav(ctrl: OcrLine, all_ctrls: list[OcrLine], text: str, click: Click, frame_h: int) -> bool:
    if text.lower() in NAV_WORDS or (text.split() and text.split()[-1].lower() in NAV_WORDS and len(text.split()) <= 2):
        return True
    x0, y0, w0, h0 = ctrl.box
    # an item of a top menu row: near the top edge with at least two other short items on the row
    row = [c for c in all_ctrls if abs((c.box[1] + c.box[3] / 2) - (y0 + h0 / 2)) < 0.6 * h0 and len(_clean(c.words).split()) <= 2]
    if click.y < frame_h * 0.08 and len(row) >= 3:
        return True
    # an item of a vertical list: left edges aligned with at least two other short items above / below
    col = [c for c in all_ctrls if abs(c.box[0] - x0) <= max(4, 0.4 * h0) and c is not ctrl and abs(c.box[1] - y0) < 5 * h0 and len(_clean(c.words).split()) <= 3]
    return len(col) >= 2


def label_click(gray: np.ndarray, click: Click, ocr_both: tuple[list[OcrWord], list[OcrWord]], ox: int, oy: int) -> dict:
    words = _merge_polarities(*ocr_both)
    for w in words:
        w.x += ox
        w.y += oy
    words = [w for w in words if w.conf >= 20 or len(w.text) > 2]
    lines = group_lines(words) if words else []
    ctrls = [c for c in _controls(lines) if _clean(c.words)]
    best, best_d, inside = None, 1e9, False
    for c in ctrls:
        x, y, w, h = c.box
        px, py = 0.6 * h + 6, 0.9 * h + 4
        if x - px <= click.x <= x + w + px and y - py <= click.y <= y + h + py:
            d = abs(click.x - (x + w / 2)) / max(1, w) + abs(click.y - (y + h / 2)) / max(1, h)
            if not inside or d < best_d:
                best, best_d, inside = c, d, True
            continue
        if inside:
            continue
        dx = max(x - click.x, 0, click.x - (x + w))
        dy = max(y - click.y, 0, click.y - (y + h))
        d = float(np.hypot(dx, dy))
        if d <= 40 and d < best_d:
            best, best_d = c, d
    if best is None:
        return {"label": "Click here", "target": "", "verb": "Click", "confidence": 0.0, "box": None}
    text = _clean(best.words)
    verb = "Open" if _is_nav(best, ctrls, text, click, gray.shape[0]) else "Click"
    conf = float(np.mean([w.conf for w in best.words])) / 100.0 * (1.0 if inside else 0.6)
    # the control's box: its text padded the way the click test above pads it (roughly a button)
    x, y, w, h = best.box
    px, py = 0.6 * h + 6, 0.9 * h + 4
    box = {"x": round(x - px, 1), "y": round(y - py, 1), "w": round(w + 2 * px, 1), "h": round(h + 2 * py, 1)}
    return {"label": f"{verb} {text}", "target": text, "verb": verb, "confidence": round(conf, 3), "box": box}


def step_labels(video: str, events: str, lead_ms: float = 80.0, workers: int = 2) -> dict:
    info = _probe(video)
    fps, W, H = info["fps"], info["width"], info["height"]
    clicks = load_clicks(events)
    idx = [max(0, int(round((c.t - lead_ms) * fps / 1000))) for c in clicks]
    frames = frames_at(video, sorted(set(idx)))
    crops, offs = [], []
    for c, i in zip(clicks, idx):
        g = frames[i]
        x0, y0 = int(max(0, min(W - 2 * ROI_W, c.x - ROI_W))), int(max(0, min(H - 2 * ROI_H, c.y - ROI_H)))
        roi = g[y0:y0 + 2 * ROI_H, x0:x0 + 2 * ROI_W]
        crops += [roi, contrast_map(roi)]
        offs.append((x0, y0))
    res = ocr_images(crops, psm=11, workers=workers, scale=2.0)
    drafts = []
    for n, (c, i, (ox, oy)) in enumerate(zip(clicks, idx, offs)):
        d = label_click(frames[i], c, (res[2 * n], res[2 * n + 1]), ox, oy)
        drafts.append({"id": f"st{n + 1}", "clickMs": round(c.t, 2), "x": round(c.x, 1), "y": round(c.y, 1), **d})
    return {"version": 1, "engine": {"ocr": "tesseract", "psm": 11, "roi": [2 * ROI_W, 2 * ROI_H], "leadMs": lead_ms},
            "source": {"video": str(video), "events": str(events)}, "drafts": drafts}


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    import sys
    ap = argparse.ArgumentParser(prog="lens-redact steps", description="Draft step labels from clicks + local OCR")
    ap.add_argument("video")
    ap.add_argument("--events", required=True)
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args(argv)
    r = step_labels(a.video, a.events, workers=a.workers)
    Path(a.out).write_text(json.dumps(r, indent=1))
    print(f"{len(r['drafts'])} step drafts", file=sys.stderr)
    return 0
