"""Corpus-level chrF (Popović 2015) as sacrebleu computes it by default (chrF2): character n-grams
1..6 with whitespace removed, statistics summed over the corpus, precision and recall averaged
over the n-gram orders that have n-grams, then F-beta with beta = 2, reported on a 0..100 scale. Own implementation so the
test needs no extra package; test_translation cross-checks it against sacrebleu when installed."""
from __future__ import annotations

from collections import Counter


def _ngrams(s: str, n: int) -> Counter:
    s = "".join(s.split())
    return Counter(s[i:i + n] for i in range(len(s) - n + 1))


def chrf(hyps: list[str], refs: list[str], order: int = 6, beta: float = 2.0) -> float:
    match = [0] * order
    hyp_n = [0] * order
    ref_n = [0] * order
    for h, r in zip(hyps, refs):
        for n in range(1, order + 1):
            hc, rc = _ngrams(h, n), _ngrams(r, n)
            match[n - 1] += sum((hc & rc).values())
            hyp_n[n - 1] += sum(hc.values()) if rc else 0  # sacrebleu: no hits counted where the reference has no n-grams
            ref_n[n - 1] += sum(rc.values())
    prec, rec, eff = 0.0, 0.0, 0
    for n in range(order):
        if hyp_n[n] > 0 and ref_n[n] > 0:
            prec += match[n] / hyp_n[n]
            rec += match[n] / ref_n[n]
            eff += 1
    if eff == 0:
        return 0.0
    prec, rec = prec / eff, rec / eff
    if prec + rec == 0:
        return 0.0
    b2 = beta * beta
    return 100.0 * (1 + b2) * prec * rec / (b2 * prec + rec)
