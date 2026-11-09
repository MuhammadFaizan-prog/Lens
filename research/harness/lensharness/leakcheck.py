"""Does a rendered export still show a secret? OCR of each secret's region, frame by frame.

For every frame where a planted secret is visible (ground truth from privacy_synth), its box (plus a
margin) is cut out of the rendered frame, upscaled 2x, polarity-normalised (dark text on light) and
OCR'd. Crops are packed into tall mosaics (one Tesseract call per ~24 crops, words mapped back by
their y position). A frame leaks when the OCR text and the secret share a run of at least
min(6, len) characters (lowercase letters and digits only).
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "redact"))
from lens_redact.ocr import _parse_tsv  # noqa: E402


def norm(s: str) -> str:
    return "".join(c for c in s.lower() if c.isalnum())


def longest_common_run(a: str, b: str) -> int:
    best = 0
    prev = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        ai = a[i - 1]
        for j in range(1, len(b) + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def leaks(ocr_text: str, secret: str) -> bool:
    s = norm(secret)
    return longest_common_run(norm(ocr_text), s) >= min(6, len(s))


def prep_crop(img: np.ndarray, box, margin: int = 4) -> np.ndarray | None:
    x, y, w, h = [int(round(v)) for v in box]
    H, W = img.shape[:2]
    x0, y0, x1, y1 = max(0, x - margin), max(0, y - margin), min(W, x + w + margin), min(H, y + h + margin)
    if x1 - x0 < 6 or y1 - y0 < 6:
        return None
    c = img[y0:y1, x0:x1]
    g = c if c.ndim == 2 else cv2.cvtColor(c, cv2.COLOR_BGR2GRAY)
    if g.mean() < 128:
        g = 255 - g
    return cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)


def ocr_crops(crops: list[np.ndarray], per_mosaic: int = 24, workers: int = 2) -> list[str]:
    """OCR many small crops: stacked into mosaics with white gaps, one tesseract run per mosaic."""
    tmp = Path(tempfile.mkdtemp(prefix="lens-leak-"))
    jobs = []
    for m0 in range(0, len(crops), per_mosaic):
        group = crops[m0:m0 + per_mosaic]
        wmax = max(c.shape[1] for c in group) + 40
        gap = 30
        hs = sum(c.shape[0] + gap for c in group) + gap
        mos = np.full((hs, wmax), 255, np.uint8)
        bands = []
        y = gap
        for c in group:
            mos[y:y + c.shape[0], 20:20 + c.shape[1]] = c
            bands.append((y - gap // 2, y + c.shape[0] + gap // 2))
            y += c.shape[0] + gap
        p = tmp / f"m{m0:06d}.png"
        cv2.imwrite(str(p), mos)
        jobs.append((p, bands))

    def run(job):
        p, bands = job
        env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
        r = subprocess.run(["tesseract", str(p), "stdout", "--psm", "6", "-l", "eng", "tsv"], capture_output=True, text=True, env=env)
        words = _parse_tsv(r.stdout).get(1, [])
        out = ["" for _ in bands]
        for w in sorted(words, key=lambda q: (q.y, q.x)):
            cy = w.y + w.h / 2
            for k, (a, b) in enumerate(bands):
                if a <= cy < b:
                    out[k] += w.text + " "
                    break
        return out

    try:
        with ThreadPoolExecutor(workers) as ex:
            res = list(ex.map(run, jobs))
    finally:
        for f in tmp.glob("*"):
            f.unlink()
        tmp.rmdir()
    return [t for r in res for t in r]
