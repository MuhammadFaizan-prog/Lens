"""Hallucination suppression for non-speech audio.

Whisper-family decoders write text for audio that has no speech in it: on tones, hum, noise or
silence they loop a short token ("oh, oh, oh, ...", "so, so, so", "Mm hmm. Mm hmm.") or invent a
plausible sentence. Measured on our synthetic non-speech tracks (stt-scratch probes, base.en, int8),
such segments had no_speech_prob 0.83-0.95 and compression ratios 3.1-26, against no_speech_prob
<= 0.01 and compression ratios 0.84-0.89 on espeak speech. Four filters, all on by default:

1. Compression ratio: a segment whose text gzip-compresses better than COMPRESSION_RATIO_MAX
   (2.4, the value Whisper itself uses to reject a decode) is a loop; its words are dropped and its
   span is marked unknown (no inferred fillers are made there either).
2. No-speech probability: a segment with no_speech_prob > NO_SPEECH_MAX (0.6, Whisper's value) is
   dropped when its decode is also unsure (avg_logprob < -1, Whisper's rule) or looping (filter 1)
   or the speech VAD hears speech under less than half of it. Whisper's own rule alone keeps
   confident loops (avg_logprob -0.06 on the editor sample's tone track).
3. Speech VAD gating: Silero VAD v6 (the ONNX model bundled with faster-whisper, MIT) finds speech
   regions; an aligned word that lies less than WORD_IN_SPEECH_MIN (50%) inside them is dropped,
   and an untranscribed voiced run becomes an inferred filler only when it is inside speech and
   outside every dropped segment's span, and only next to recognised words (a recognised word
   within FILLER_CONTEXT_S, 1.5 s): a hesitation sits between words, and a voiced run with no
   words around it is unknown sound, not a filler (on a 60 s speech-shaped buzz the decoder kept
   nothing and every syllable-like burst had become a "[filler]"). The energy VAD (vad.py) still provides the precise
   word-boundary runs; Silero decides only speech vs not-speech.
4. Low-confidence repetition: a run of REPEAT_MIN_RUN (3) or more identical consecutive words
   with mean confidence under REPEAT_MAX_CONF (0.5) keeps its first word only.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import fillers as F

COMPRESSION_RATIO_MAX = 2.4
NO_SPEECH_MAX = 0.6
LOGPROB_MIN = -1.0
SEGMENT_IN_SPEECH_MIN = 0.5
WORD_IN_SPEECH_MIN = 0.5
REPEAT_MIN_RUN = 3
REPEAT_MAX_CONF = 0.5
SPEECH_THRESHOLD = 0.5
SPEECH_PAD_S = 0.10
FILLER_CONTEXT_S = 1.5


@dataclass
class Options:
    enabled: bool = True
    compression_ratio_max: float = COMPRESSION_RATIO_MAX
    no_speech_max: float = NO_SPEECH_MAX
    logprob_min: float = LOGPROB_MIN
    word_in_speech_min: float = WORD_IN_SPEECH_MIN
    repeat_min_run: int = REPEAT_MIN_RUN
    repeat_max_conf: float = REPEAT_MAX_CONF
    filler_context_s: float = FILLER_CONTEXT_S


def speech_regions(audio: np.ndarray, sr: int = 16000) -> list[tuple[float, float]]:
    """Silero VAD speech regions in seconds (padded by SPEECH_PAD_S, merged)."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    opts = VadOptions(threshold=SPEECH_THRESHOLD, min_speech_duration_ms=0, min_silence_duration_ms=100,
                      speech_pad_ms=int(SPEECH_PAD_S * 1000))
    out: list[tuple[float, float]] = []
    for s in get_speech_timestamps(audio, opts, sampling_rate=sr):
        a, b = s["start"] / sr, s["end"] / sr
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def coverage(a: float, b: float, regions: list[tuple[float, float]]) -> float:
    """Fraction of [a, b] inside regions (a zero-length span counts as inside if its point is)."""
    if b <= a:
        return 1.0 if any(p <= a <= q for p, q in regions) else 0.0
    return sum(max(0.0, min(b, q) - max(a, p)) for p, q in regions) / (b - a)


def bad_segments(segments, speech: list[tuple[float, float]], o: Options) -> set[int]:
    """Indices of segments judged hallucinated (filters 1 and 2)."""
    bad: set[int] = set()
    for i, s in enumerate(segments):
        loop = s.compression_ratio > o.compression_ratio_max
        unsure = s.avg_logprob < o.logprob_min
        heard = coverage(s.start, s.end, speech) >= SEGMENT_IN_SPEECH_MIN
        if loop or (s.no_speech_prob > o.no_speech_max and (unsure or not heard)):
            bad.add(i)
    return bad


def drop_repeats(words: list, o: Options) -> list:
    """Filter 4. words: objects with .text and .confidence, in time order."""
    out, i = [], 0
    while i < len(words):
        j = i + 1
        key = F.norm(words[i].text)
        while j < len(words) and key and F.norm(words[j].text) == key:
            j += 1
        run = words[i:j]
        if len(run) >= o.repeat_min_run and sum(w.confidence for w in run) / len(run) < o.repeat_max_conf:
            out.append(run[0])
        else:
            out.extend(run)
        i = j
    return out
