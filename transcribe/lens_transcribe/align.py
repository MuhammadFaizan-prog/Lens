"""Align recogniser words to measured voiced runs.

Whisper-family word timestamps come from cross-attention alignment. They are good to a few
hundred ms but drift around pauses, and when the decoder drops a word (it is trained on cleaned
transcripts, so hesitations are often dropped) the neighbouring words slide over to cover its
audio. Energy VAD, on the other hand, knows exactly where the speaker paused but not what was
said. We combine the two with a monotonic dynamic programme over (word, voiced run):

- one word covers one or more consecutive runs (a word may contain a short closure), or
- several words share one run (connected speech: no pause between them), or
- a run is left with no word: voiced audio the recogniser wrote nothing for, returned as an
  untranscribed vocalisation (the caller treats short ones as fillers), or
- a word is dropped: a recogniser word with no audio under it (hallucinated text in silence).

The cost of a placement is how far the recogniser's start/end times are from the run edges, plus
a weak term for how far the duration is from a length expected from the word's letters. Within a
run shared by several words, the recogniser's boundaries are shifted onto the run (see _share).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

INF = float("inf")

# Cost weights (seconds-equivalent). Set once from the reasoning in the module docstring and the
# synthetic test set; see docs/Tracker.md before changing.
SKIP_RUN_BASE = 0.30       # leaving a voiced run untranscribed
SKIP_RUN_PER_S = 1.0
DROP_WORD_BASE = 0.40      # dropping a recogniser word (scaled up by its confidence)
DROP_WORD_PER_CONF = 0.80
DROP_IN_SILENCE = 0.10     # dropping a word whose recogniser span touches no voiced run
EXTRA_RUN = 0.15           # each extra run inside one word (a pause inside a word)
EXTRA_RUN_PER_GAP_S = 2.0
DURATION_WEIGHT = 0.30     # |ln(actual / expected)|
EARLY_START_WEIGHT = 0.30  # recogniser start earlier than the run start (silence absorbed)
SEARCH_S = 2.5             # runs considered for a word: within this of its recogniser time
MAX_WORDS_PER_RUN = 60
MAX_RUNS_PER_WORD = 4
MIN_WORD_S = 0.03          # narrowest word inside a shared run


@dataclass
class TimedWord:
    text: str
    start: float
    end: float
    confidence: float
    filler: bool = False
    inferred: bool = False
    dropped: bool = False


def edge_cost(rec_start: float, rec_end: float, s: float, e: float) -> float:
    """Whisper's DTW word boundaries sit near the end of the previous word, so a word's start
    usually includes the pause before it: an early start is cheap, the end is trusted."""
    ds = rec_start - s
    return (EARLY_START_WEIGHT * -ds if ds < 0 else ds) + abs(rec_end - e)


def expected_duration(text: str) -> float:
    letters = sum(c.isalnum() for c in text)
    return 0.10 + 0.055 * max(1, letters)


def align(words: list[TimedWord], runs: list[tuple[float, float]], refine: bool = True) -> tuple[list[TimedWord], list[tuple[float, float]]]:
    """Returns (words with aligned times; dropped words have dropped=True), untranscribed runs.

    With refine, a first alignment measures the recogniser's systematic lag (median of run end
    minus recogniser end over words that got exactly one run; Whisper's DTW ends are often early
    by 0.1-0.3 s), the recogniser times are shifted by it (clamped to +-0.5 s), and the alignment
    runs again on the corrected times.
    """
    if refine and words and runs:
        probe = [TimedWord(w.text, w.start, w.end, w.confidence) for w in words]
        _, _, single = _align(probe, runs)
        diffs = [runs[r][1] - words[w].end for w, r in single]
        if len(diffs) >= 3:
            lag = max(-0.5, min(0.5, sorted(diffs)[len(diffs) // 2]))
            for w in words:
                w.start += lag
                w.end += lag
    out, untr, _ = _align(words, runs)
    return out, untr


def _align(words: list[TimedWord], runs: list[tuple[float, float]]) -> tuple[list[TimedWord], list[tuple[float, float]], list[tuple[int, int]]]:
    n, m = len(words), len(runs)
    if n == 0:
        return words, list(runs), []
    if m == 0:
        for w in words:
            w.dropped = True
        return words, [], []
    exp = [expected_duration(w.text) for w in words]
    cum_exp = [0.0]
    for e in exp:
        cum_exp.append(cum_exp[-1] + e)

    def in_silence(w: int) -> bool:
        return not any(a < words[w].end and b > words[w].start for a, b in runs)

    drop_cost = [DROP_IN_SILENCE if in_silence(w) else DROP_WORD_BASE + DROP_WORD_PER_CONF * words[w].confidence for w in range(n)]

    def near(w: int, r: int) -> bool:
        return abs(runs[r][0] - words[w].start) <= SEARCH_S or abs(runs[r][1] - words[w].end) <= SEARCH_S

    # dp[(w, r)] = cost having placed words < w and consumed runs < r
    dp: dict[tuple[int, int], float] = {(0, 0): 0.0}
    back: dict[tuple[int, int], tuple] = {}

    def relax(state, cost, frm, move):
        if cost < dp.get(state, INF):
            dp[state] = cost
            back[state] = (frm, move)

    for w in range(n + 1):
        for r in range(m + 1):
            c = dp.get((w, r))
            if c is None:
                continue
            if r < m:  # skip run r
                ln = runs[r][1] - runs[r][0]
                relax((w, r + 1), c + SKIP_RUN_BASE + SKIP_RUN_PER_S * ln, (w, r), ("skip",))
            if w < n:  # drop word w
                relax((w + 1, r), c + drop_cost[w], (w, r), ("drop",))
            if w < n and r < m and near(w, r):
                # one word over b runs
                for b in range(1, MAX_RUNS_PER_WORD + 1):
                    if r + b > m:
                        break
                    s, e = runs[r][0], runs[r + b - 1][1]
                    gaps = sum(runs[r + i + 1][0] - runs[r + i][1] for i in range(b - 1))
                    cost = edge_cost(words[w].start, words[w].end, s, e)
                    cost += DURATION_WEIGHT * abs(math.log(max(e - s, 0.02) / exp[w]))
                    cost += (b - 1) * EXTRA_RUN + EXTRA_RUN_PER_GAP_S * gaps
                    relax((w + 1, r + b), c + cost, (w, r), ("word", b))
                # a >= 2 words share run r
                s, e = runs[r]
                for a in range(2, MAX_WORDS_PER_RUN + 1):
                    if w + a > n:
                        break
                    cost = edge_cost(words[w].start, words[w + a - 1].end, s, e)
                    cost += DURATION_WEIGHT * abs(math.log(max(e - s, 0.02) / (cum_exp[w + a] - cum_exp[w])))
                    relax((w + a, r + 1), c + cost, (w, r), ("share", a))
    state = (n, m)
    if state not in dp:  # cannot happen (skip/drop always reach it), kept for safety
        return words, [], []
    untranscribed: list[tuple[float, float]] = []
    single: list[tuple[int, int]] = []
    while state != (0, 0):
        frm, move = back[state]
        w, r = frm
        if move[0] == "skip":
            untranscribed.append(runs[r])
        elif move[0] == "drop":
            words[w].dropped = True
        elif move[0] == "word":
            if move[1] == 1:
                single.append((w, r))
            words[w].start, words[w].end = runs[r][0], runs[r + move[1] - 1][1]
        else:
            _share(words[w:w + move[1]], runs[r], exp[w:w + move[1]])
        state = frm
    untranscribed.reverse()
    return words, untranscribed, single


def _share(ws: list[TimedWord], run: tuple[float, float], exp: list[float]) -> None:
    """Spread words over one run (connected speech, no pause between them).

    Whisper's DTW word ends are the reliable edge (see edge_cost) while its first start in a
    segment often sits at the segment start, so the recogniser's boundaries are shifted, not
    stretched: they move by (run end - recogniser end of the last word). Boundaries are clamped
    into the run. When the recogniser's span is degenerate, letter-length proportions are used.
    Measured on espeak connected speech against the synthesizer's own word events, this put word
    starts at median 91 ms / p95 226 ms error, against 123 / 266 ms for a linear stretch.
    """
    s, e = run
    a0, a1 = ws[0].start, ws[-1].end
    cuts: list[float] = []
    if a1 - a0 > 0.05:
        shift = e - a1
        for i in range(1, len(ws)):
            cuts.append((ws[i - 1].end + ws[i].start) / 2 + shift)
    else:
        tot = sum(exp)
        acc = 0.0
        for x in exp[:-1]:
            acc += x
            cuts.append(s + acc / tot * (e - s))
    # keep every word at least MIN_WORD_S wide, ordered, inside the run. A run too short for that
    # (many words squeezed into one short burst, as in a hallucinated loop) gets equal widths.
    n = len(ws)
    gap = min(MIN_WORD_S, (e - s) / n)
    edges = [s] + cuts + [e]
    for i in range(1, n):
        edges[i] = min(max(edges[i], edges[i - 1] + gap), e - gap * (n - i))
    for i, w in enumerate(ws):
        w.start, w.end = edges[i], max(edges[i], edges[i + 1])
