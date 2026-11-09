"""Findings on one OCR'd frame: classifier matches mapped back to pixel boxes."""
from __future__ import annotations

from dataclasses import dataclass

from .classify import find_line, find_token
from .ocr import OcrLine, OcrWord, group_lines


@dataclass
class FrameHit:
    type: str
    box: tuple[int, int, int, int]  # x, y, w, h in frame px
    text: str
    confidence: float


def _union(ws: list[OcrWord]) -> tuple[int, int, int, int]:
    x0 = min(w.x for w in ws)
    y0 = min(w.y for w in ws)
    x1 = max(w.x + w.w for w in ws)
    y1 = max(w.y + w.h for w in ws)
    return x0, y0, x1 - x0, y1 - y0


def _spans(ws: list[OcrWord], sep: str) -> tuple[str, list[tuple[int, int]]]:
    parts, spans, pos = [], [], 0
    for w in ws:
        spans.append((pos, pos + len(w.text)))
        parts.append(w.text)
        pos += len(w.text) + len(sep)
    return sep.join(parts), spans


def _words_in(ws: list[OcrWord], spans: list[tuple[int, int]], a: int, b: int) -> list[OcrWord]:
    return [w for w, (s, e) in zip(ws, spans) if s < b and e > a]


def _glued_runs(line: OcrLine) -> list[list[OcrWord]]:
    """Neighbouring words OCR split at a small gap (< 0.5 of the text height) are one token. A real
    space is ~0.6 of the font size, which is ~0.8 of a word box's height."""
    runs: list[list[OcrWord]] = []
    cur = [line.words[0]]
    for q in line.words[1:]:
        p = cur[-1]
        gap = q.x - (p.x + p.w)
        if gap < 0.5 * max(p.h, q.h, 8):
            cur.append(q)
        else:
            runs.append(cur)
            cur = [q]
    runs.append(cur)
    return runs


import re

_B64ISH = re.compile(r"^[A-Za-z0-9_.+/=-]{3,}$")


def _extend_token(run_words: list[OcrWord], line: OcrLine, sel: list[OcrWord]) -> list[OcrWord]:
    """A key or JWT that OCR split at a wider gap: carry the box over the following fragments on the
    line while they look like the same token (base64-ish, with a digit or a capital inside)."""
    ws = line.words
    def tokenish(q: OcrWord) -> bool:
        return bool(_B64ISH.match(q.text) and re.search(r"[0-9]|[a-z][A-Z]|[A-Z][a-z]*[A-Z]", q.text))
    # leftwards first (the start of the token read as a separate word)
    i = ws.index(sel[0])
    out = list(sel)
    while i > 0:
        p, q = ws[i - 1], ws[i]
        if q.x - (p.x + p.w) > 1.0 * max(p.h, q.h, 8) or not tokenish(p):
            break
        out.insert(0, p)
        i -= 1
    i = ws.index(sel[-1])
    while i + 1 < len(ws):
        q = ws[i + 1]
        p = ws[i]
        gap = q.x - (p.x + p.w)
        if gap > 1.0 * max(p.h, q.h, 8) or not _B64ISH.match(q.text) or not re.search(r"[0-9]|[a-z][A-Z]|[A-Z][a-z]*[A-Z]", q.text):
            break
        out.append(q)
        i += 1
    return out


def _iou(a, b) -> float:
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = ix * iy
    u = aw * ah + bw * bh - inter
    return inter / u if u > 0 else 0.0


def hits_from_words(words: list[OcrWord]) -> list[FrameHit]:
    hits: list[FrameHit] = []
    for line in group_lines(words):
        ws = line.words
        text, spans = _spans(ws, " ")
        for f in find_line(text):
            sel = _words_in(ws, spans, f.start, f.end)
            if sel:
                hits.append(FrameHit(f.type, _union(sel), f.text, f.confidence))
        for run in _glued_runs(line):
            tok, tsp = _spans(run, "")
            for f in find_token(tok):
                sel = _words_in(run, tsp, f.start, f.end)
                if sel and f.type in ("jwt", "api_key", "token") and f.end >= len(tok) - 1:
                    sel = _extend_token(run, line, sel)
                if sel:
                    hits.append(FrameHit(f.type, _union(sel), f.text, f.confidence))
    # de-duplicate: a box found twice (line + token view) keeps the more specific type
    rank = {"jwt": 0, "api_key": 1, "card": 2, "email": 3, "phone": 4, "ip": 5, "token": 6}
    hits.sort(key=lambda h: rank.get(h.type, 9))
    out: list[FrameHit] = []
    for h in hits:
        if any(_iou(h.box, o.box) > 0.5 for o in out):
            continue
        out.append(h)
    return out
