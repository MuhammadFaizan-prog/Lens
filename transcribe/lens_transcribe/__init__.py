"""Lens local speech-to-text: audio -> transcript JSON (packages/engine/src/transcript.ts schema).

Pipeline: decode (ffmpeg) -> recognise twice (faster-whisper with word timestamps: plain, and with
a filler-friendly prompt) -> merge the second pass's fillers into the first -> energy VAD -> align
words to voiced runs (align.py) -> flag fillers (recognised filler words plus untranscribed voiced
runs) -> measured pauses. See docs/STT.md.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import align, engine, fillers as F, hallucination as H, vad
from .audio import SR, decode_audio

SCHEMA_VERSION = 1


@dataclass
class TranscribeOptions:
    model: str = engine.DEFAULT_MODEL
    language: str | None = None
    #: Ask the decoder to write hesitations out (see fillers.FILLER_PROMPT).
    keep_fillers: bool = True
    #: Silences at least this long split voiced runs for alignment (shorter ones count as inside a word).
    snap_pause_ms: int = 80
    #: Voiced runs the recogniser wrote nothing for, within this length range, become inferred
    #: fillers (text "[filler]", inferred: true).
    infer_untranscribed: bool = True
    untranscribed_min_ms: int = 100
    untranscribed_max_ms: int = 800
    #: Pauses written to the transcript (for the engine's pause shortening) are at least this long.
    min_pause_ms: int = 150
    fillers: list[str] = field(default_factory=lambda: list(F.DEFAULT_FILLERS))
    beam_size: int = 5
    #: Hallucination suppression on non-speech audio (hallucination.py): segment compression-ratio
    #: and no-speech filters, speech-VAD gating of words and inferred fillers, low-confidence
    #: repetition filter.
    hallucination: H.Options = field(default_factory=H.Options)


def _ms(s: float) -> int:
    return int(round(s * 1000))


def merge_fillers(base: list["align.TimedWord"], prompted: list["align.TimedWord"], fillers: list[str]) -> list["align.TimedWord"]:
    """Combine the plain pass (trusted words) with the prompted pass (which writes hesitations).

    Content words both passes agree on are anchors; anchors take the prompted pass's times (it was
    decoded with the fillers in place, so neighbours have not slid over the filler's audio) unless
    the prompted word is under 40% of the plain word's length. In each
    gap between anchors:
    - the prompted pass has fillers and the plain pass has no content words: use the plain pass's
      fillers if it has any, else the prompted pass's;
    - the prompted pass has only fillers there and the plain pass has words it did not write: see
      _resolve_gap (a short plain word sitting on a filler is a misheard hesitation);
    - anything else: keep the plain pass's gap unchanged (the passes disagree on content and we do
      not guess).
    """
    import difflib

    isf = lambda w: F.is_filler(w.text, fillers)  # noqa: E731
    a_idx = [i for i, w in enumerate(base) if not isf(w)]
    b_idx = [i for i, w in enumerate(prompted) if not isf(w)]
    sm = difflib.SequenceMatcher(a=[F.norm(base[i].text) for i in a_idx], b=[F.norm(prompted[i].text) for i in b_idx], autojunk=False)
    anchors: list[tuple[int, int]] = []  # (base index, prompted index)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            anchors.append((a_idx[blk.a + k], b_idx[blk.b + k]))
    for ai, bi in anchors:
        a, b = base[ai], prompted[bi]
        # ...unless the prompted word is degenerate (squeezed to a sliver, as happens next to text
        # it invented): then the plain pass's times stay.
        if b.end - b.start >= 0.4 * (a.end - a.start):
            a.start, a.end = b.start, b.end
    out: list[align.TimedWord] = []
    bounds = [(-1, -1)] + anchors + [(len(base), len(prompted))]
    for (pa, pb), (na, nb) in zip(bounds, bounds[1:]):
        a_gap, b_gap = base[pa + 1:na], prompted[pb + 1:nb]
        b_fill = [w for w in b_gap if isf(w)]
        a_content = [w for w in a_gap if not isf(w)]
        if b_fill and not a_content:
            out.extend(a_gap if a_gap else b_fill)
        elif b_fill and len(b_fill) == len(b_gap):
            out.extend(_resolve_gap(a_gap, b_fill, fillers))
        else:
            out.extend(a_gap)
        if na < len(base):
            out.append(base[na])
    return out


def _resolve_gap(a_gap: list["align.TimedWord"], b_fill: list["align.TimedWord"], fillers: list[str]) -> list["align.TimedWord"]:
    """A gap where the prompted pass wrote only fillers and the plain pass wrote some words.

    A plain-pass content word that is short and unsure (<= 4 letters, confidence < 0.6) and whose centre lies
    within 100 ms of one filler's span is the hesitation misheard as a word ("um" -> "I'm",
    "er" -> "or"): that filler replaces it. Other plain words stay. A filler that replaced nothing
    is added only if it does not sit mostly (> 50% of its length) on a word that stays, because the
    prompted pass also hears fillers that are not there ("the" -> "uh")."""
    def centre(w):
        return (w.start + w.end) / 2

    kept: list[align.TimedWord] = []
    used: set[int] = set()
    for w in a_gap:
        if F.is_filler(w.text, fillers):
            kept.append(w)
            continue
        short = sum(c.isalnum() for c in w.text) <= 4 and w.confidence < 0.6
        hit = [k for k, f in enumerate(b_fill) if f.start - 0.1 <= centre(w) <= f.end + 0.1]
        if short and hit:
            k = min(hit, key=lambda k: abs(centre(b_fill[k]) - centre(w)))
            if k not in used:
                used.add(k)
                kept.append(b_fill[k])
            continue
        kept.append(w)
    stay = [w for w in kept if not F.is_filler(w.text, fillers)]
    for k, f in enumerate(b_fill):
        if k in used:
            continue
        d = max(f.end - f.start, 1e-3)
        if any(min(f.end, w.end) - max(f.start, w.start) > 0.5 * d for w in stay):
            continue
        if any(F.is_filler(w.text, fillers) and min(f.end, w.end) > max(f.start, w.start) for w in kept):
            continue
        kept.append(f)
    return sorted(kept, key=lambda w: w.start)


def _runs_between(v: "vad.VadResult", min_pause_s: float, duration: float) -> list[tuple[float, float]]:
    """Voiced runs separated by silences of at least min_pause_s (shorter silences are bridged)."""
    sil = v.silences(min_pause_s)
    runs, t = [], 0.0
    for a, b in sil:
        if a > t:
            runs.append((t, a))
        t = b
    if t < duration - 1e-6:
        runs.append((t, duration))
    return [(a, b) for a, b in runs if v.voiced_fraction(a, b) > 0]


def transcribe_array(audio: np.ndarray, opts: TranscribeOptions | None = None, offset_ms: int = 0, source: dict | None = None) -> dict:
    """audio: mono float32 at 16 kHz. offset_ms shifts every time (e.g. an audio track's offset on
    the recording clock)."""
    opts = opts or TranscribeOptions()
    duration = len(audio) / SR
    # Pass 1: plain decode, the words we trust. Pass 2 (keep_fillers): decode with a disfluent
    # prompt so the model writes hesitations out; only its fillers are taken, inserted between the
    # pass-1 words they sit between (the prompt also makes the model invent text in silences, so
    # nothing else from pass 2 is used).
    ho = opts.hallucination
    speech = H.speech_regions(audio, SR) if ho.enabled else None
    unknown: list[tuple[float, float]] = []  # spans of dropped segments: no inferred fillers there

    def kept_words(res: "engine.RawResult") -> list[align.TimedWord]:
        bad = H.bad_segments(res.segments, speech, ho) if ho.enabled else set()
        unknown.extend((res.segments[i].start, res.segments[i].end) for i in bad)
        ws = [align.TimedWord(w.text.strip(), w.start, w.end, w.probability) for w in res.words
              if w.text.strip() and w.segment not in bad]
        return H.drop_repeats(ws, ho) if ho.enabled else ws

    raw = engine.recognise(audio, opts.model, opts.language, None, opts.beam_size)
    words = kept_words(raw)
    if opts.keep_fillers:
        prompted = engine.recognise(audio, opts.model, opts.language, F.FILLER_PROMPT, opts.beam_size)
        words = merge_fillers(words, kept_words(prompted), opts.fillers)
    v = vad.detect(audio, SR)
    runs = _runs_between(v, opts.snap_pause_ms / 1000, duration)
    words, untranscribed = align.align(words, runs)
    words = [w for w in words if not w.dropped]
    if speech is not None:  # speech-VAD gating of the aligned words
        words = [w for w in words if H.coverage(w.start, w.end, speech) >= ho.word_in_speech_min]
    for w in words:
        w.filler = F.is_filler(w.text, opts.fillers)
    if opts.infer_untranscribed:
        recognised = list(words)
        for a, b in untranscribed:
            d = (b - a) * 1000
            if not (opts.untranscribed_min_ms <= d <= opts.untranscribed_max_ms and v.voiced_fraction(a, b) > 0.5):
                continue
            if speech is not None and (H.coverage(a, b, speech) < ho.word_in_speech_min
                                       or any(p < b and q > a for p, q in unknown)
                                       or not any(w.end >= a - ho.filler_context_s and w.start <= b + ho.filler_context_s for w in recognised)):
                continue
            words.append(align.TimedWord("[filler]", a, b, 0.0, filler=True, inferred=True))
    words.sort(key=lambda w: w.start)
    out_words = []
    for w in words:
        assert w.end >= w.start, (w.text, w.start, w.end)  # align guarantees it; never emit otherwise
        d = {"text": w.text, "startMs": _ms(w.start) + offset_ms, "endMs": _ms(w.end) + offset_ms, "confidence": round(w.confidence, 3)}
        if w.filler:
            d["filler"] = True
        if w.inferred:
            d["inferred"] = True
        out_words.append(d)
    silences = [(_ms(a) + offset_ms, _ms(b) + offset_ms) for a, b in v.silences(opts.snap_pause_ms / 1000)]
    return {
        "version": SCHEMA_VERSION,
        "language": raw.language,
        "languageProbability": round(raw.language_probability, 3),
        "durationMs": _ms(duration),
        "offsetMs": offset_ms,
        "engine": {"name": "faster-whisper", "model": opts.model, "licence": engine.licence_of(opts.model)},
        **({"source": source} if source else {}),
        "words": out_words,
        "pauses": F.pauses_between(out_words, silences, opts.min_pause_ms),
    }


def transcribe_file(path: str, opts: TranscribeOptions | None = None, offset_ms: int = 0) -> dict:
    return transcribe_array(decode_audio(path), opts, offset_ms, {"path": path})


__all__ = ["TranscribeOptions", "transcribe_array", "transcribe_file", "merge_fillers", "decode_audio", "SR", "SCHEMA_VERSION"]
