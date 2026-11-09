"""On-device OCR with the Tesseract CLI (Apache-2.0), in batches, plus Lens's own line grouping.

Tesseract runs as a subprocess on a list of images (one model load per batch) with sparse-text page
segmentation (--psm 11), which suits UI screenshots. Words come back with boxes; we group them into
lines ourselves (vertical overlap + horizontal gap) because sparse mode splits UI rows into blocks.
"""
from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
import tempfile
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

# OCR confusions folded before classification (lookalikes that break patterns)
_FOLD = str.maketrans({"©": "@", "®": "@", "—": "-", "–": "-", "‐": "-", "“": '"', "”": '"', "’": "'", "‘": "'", "|": "I"})


def fold(s: str) -> str:
    s = s.translate(_FOLD)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if ord(c) < 128)


@dataclass
class OcrWord:
    text: str
    x: int
    y: int
    w: int
    h: int
    conf: float


@dataclass
class OcrLine:
    words: list[OcrWord]

    @property
    def box(self) -> tuple[int, int, int, int]:
        x0 = min(w.x for w in self.words)
        y0 = min(w.y for w in self.words)
        x1 = max(w.x + w.w for w in self.words)
        y1 = max(w.y + w.h for w in self.words)
        return x0, y0, x1 - x0, y1 - y0


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def _parse_tsv(tsv: str) -> dict[int, list[OcrWord]]:
    pages: dict[int, list[OcrWord]] = {}
    rd = csv.reader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE)
    head = next(rd, None)
    if not head:
        return pages
    ix = {k: i for i, k in enumerate(head)}
    for row in rd:
        if len(row) < len(head) or row[ix["level"]] != "5":
            continue
        txt = fold(row[ix["text"]]).strip()
        if not txt:
            continue
        page = int(row[ix["page_num"]])
        pages.setdefault(page, []).append(OcrWord(txt, int(row[ix["left"]]), int(row[ix["top"]]), int(row[ix["width"]]), int(row[ix["height"]]),
                                                  float(row[ix["conf"]])))
    return pages


def _run_batch(paths: list[str], psm: int) -> list[list[OcrWord]]:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as lst:
        lst.write("\n".join(paths) + "\n")
        name = lst.name
    try:
        env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
        r = subprocess.run(["tesseract", name, "stdout", "--psm", str(psm), "-l", "eng", "tsv"], capture_output=True, text=True, env=env)
        if r.returncode != 0:
            raise RuntimeError(f"tesseract failed: {r.stderr.strip()[-400:]}")
        pages = _parse_tsv(r.stdout)
    finally:
        os.unlink(name)
    return [pages.get(i + 1, []) for i in range(len(paths))]


def ocr_images(images: list[np.ndarray], psm: int = 11, workers: int = 2, scale: float = 1.0) -> list[list[OcrWord]]:
    """OCR a list of BGR/gray images; returns words per image in that image's pixel coordinates."""
    if not images:
        return []
    tmp = Path(tempfile.mkdtemp(prefix="lens-ocr-"))
    try:
        paths = []
        for i, im in enumerate(images):
            g = im if im.ndim == 2 else cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
            if scale != 1.0:
                g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            p = tmp / f"{i:05d}.png"
            cv2.imwrite(str(p), g, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            paths.append(str(p))
        workers = max(1, min(workers, len(paths)))
        chunks = [paths[k::workers] for k in range(workers)]
        with ThreadPoolExecutor(workers) as ex:
            results = list(ex.map(lambda c: _run_batch(c, psm), chunks))
        out: list[list[OcrWord]] = [[] for _ in paths]
        for k, res in enumerate(results):
            for j, words in enumerate(res):
                out[k + j * workers] = words
        if scale != 1.0:
            for words in out:
                for w in words:
                    w.x, w.y, w.w, w.h = (int(round(v / scale)) for v in (w.x, w.y, w.w, w.h))
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def group_lines(words: list[OcrWord]) -> list[OcrLine]:
    """Group words into text lines: same row (centres within half a word height) and a gap smaller
    than 2.5 word heights between neighbours."""
    ws = sorted(words, key=lambda w: (w.y + w.h / 2, w.x))
    rows: list[list[OcrWord]] = []
    for w in ws:
        cy = w.y + w.h / 2
        for r in rows:
            rh = np.median([q.h for q in r])
            rcy = np.median([q.y + q.h / 2 for q in r])
            if abs(cy - rcy) <= 0.5 * max(rh, w.h):
                r.append(w)
                break
        else:
            rows.append([w])
    lines: list[OcrLine] = []
    for r in rows:
        r.sort(key=lambda q: q.x)
        cur = [r[0]]
        for q in r[1:]:
            p = cur[-1]
            gap = q.x - (p.x + p.w)
            hh = max(8, np.median([z.h for z in cur]))
            if gap <= 2.5 * hh:
                cur.append(q)
            else:
                lines.append(OcrLine(cur))
                cur = [q]
        lines.append(OcrLine(cur))
    return lines
