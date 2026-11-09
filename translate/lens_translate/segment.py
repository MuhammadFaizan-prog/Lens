"""Source caption segments: the units Lens translates.

Mirror of packages/engine/src/translation.ts segmentTranscript (tests check both give the same
segments). A segment is a sentence, closed early at a pause longer than 700 ms or at 24 words /
9 s (at a comma in the last third when there is one). Fillers (um, uh, ...) and VAD placeholders are
not translated, so they are left out of the text, but the segment's time span still covers them.
"""
from __future__ import annotations

import re
import unicodedata

DEFAULT_FILLERS = ["um", "uh", "erm", "er", "ah", "hmm", "mm", "uhm", "umm"]
PAUSE_MS, MAX_WORDS, MAX_MS = 700, 24, 9000


def _norm(w: str) -> str:
    return "".join(ch for ch in w.lower() if unicodedata.category(ch)[0] in "LN" or ch == "'")


def is_filler(w: dict, fillers=DEFAULT_FILLERS) -> bool:
    return bool(w.get("filler")) or _norm(w["text"]) in {_norm(f) for f in fillers}


_END = re.compile(r"[.!?][\"')\]]?$")
_COMMA = re.compile(r"[,;:]$")


def segment_transcript(words: list[dict], pause_ms: int = PAUSE_MS, max_words: int = MAX_WORDS, max_ms: int = MAX_MS) -> list[dict]:
    ws = sorted((w for w in words if not w.get("inferred") and not is_filler(w)), key=lambda w: w["startMs"])
    out: list[dict] = []
    cur: list[dict] = []

    def flush(n: int | None = None) -> None:
        nonlocal cur
        n = len(cur) if n is None else n
        if not n:
            return
        take = cur[:n]
        out.append({"startMs": take[0]["startMs"], "endMs": take[-1]["endMs"], "source": " ".join(w["text"] for w in take)})
        cur = cur[n:]

    for w in ws:
        if cur and w["startMs"] - cur[-1]["endMs"] > pause_ms:
            flush()
        if cur and (len(cur) >= max_words or w["endMs"] - cur[0]["startMs"] > max_ms):
            cut = len(cur)
            for i in range(len(cur) - 1, (len(cur) * 2) // 3 - 1, -1):
                if _COMMA.search(cur[i]["text"]):
                    cut = i + 1
                    break
            flush(cut)
        cur.append(w)
        if _END.search(w["text"]):
            flush()
    flush()
    return out
