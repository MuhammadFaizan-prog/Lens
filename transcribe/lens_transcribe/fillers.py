"""Filler words and pauses, from real timings."""
from __future__ import annotations

import re

# Same list as packages/engine/src/transcript.ts DEFAULT_FILLERS; keep them in sync.
DEFAULT_FILLERS = ["um", "uh", "erm", "er", "ah", "hmm", "mm", "uhm", "umm"]

# Prompting the decoder with a disfluent sentence makes Whisper-family models write hesitations
# out instead of cleaning them away (they are trained mostly on verbatim-cleaned transcripts).
# Our own sentence, written for this purpose.
FILLER_PROMPT = "Um, so, uh, I was like, hmm, thinking. Er, okay, umm, let's uh start."


def norm(text: str) -> str:
    return re.sub(r"[^\w']", "", text.lower(), flags=re.UNICODE)


def is_filler(text: str, fillers: list[str] | None = None) -> bool:
    return norm(text) in {norm(f) for f in (fillers or DEFAULT_FILLERS)}


def pauses_between(words: list[dict], silences_ms: list[tuple[int, int]], min_ms: int) -> list[dict]:
    """Measured silences of at least min_ms that do not overlap a spoken (non-filler) word."""
    spoken = [(w["startMs"], w["endMs"]) for w in words if not w.get("filler")]
    out = []
    for a, b in silences_ms:
        if b - a < min_ms:
            continue
        if any(s < b and e > a for s, e in spoken):
            # trim to the part outside words (VAD silence overlapping a word edge by a frame or two)
            for s, e in spoken:
                if s < b and e > a:
                    if s <= a < e:
                        a = e
                    if s < b <= e:
                        b = s
            if b - a < min_ms:
                continue
        out.append({"startMs": int(a), "endMs": int(b)})
    return out
