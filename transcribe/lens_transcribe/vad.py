"""Energy voice-activity detection. Used to measure real pauses and to snap word boundaries
from the recogniser onto them (the recogniser's word timings come from attention alignment and
drift by a few hundred ms, especially around pauses)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

HOP_S = 0.01
WIN_S = 0.025


@dataclass
class VadResult:
    voiced: np.ndarray  # bool per 10 ms frame
    hop_s: float
    floor_db: float
    speech_db: float
    threshold_db: float

    def silences(self, min_s: float) -> list[tuple[float, float]]:
        """Runs of non-voiced frames at least min_s long, as (start_s, end_s)."""
        return _runs(~self.voiced, self.hop_s, min_s)

    def voiced_runs(self, min_s: float = 0.0) -> list[tuple[float, float]]:
        return _runs(self.voiced, self.hop_s, min_s)

    def voiced_fraction(self, a: float, b: float) -> float:
        i, j = int(round(a / self.hop_s)), int(round(b / self.hop_s))
        seg = self.voiced[max(0, i):max(0, j)]
        return float(seg.mean()) if len(seg) else 0.0


def _runs(mask: np.ndarray, hop: float, min_s: float) -> list[tuple[float, float]]:
    out = []
    if not len(mask):
        return out
    m = np.concatenate([[False], mask, [False]]).astype(np.int8)
    d = np.diff(m)
    starts, ends = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
    for s, e in zip(starts, ends):
        if (e - s) * hop >= min_s - 1e-9:
            out.append((s * hop, e * hop))
    return out


def frame_db(x: np.ndarray, sr: int) -> np.ndarray:
    hop, win = int(round(HOP_S * sr)), int(round(WIN_S * sr))
    n = max(1, 1 + (len(x) - win) // hop) if len(x) >= win else 1
    pad = np.pad(x.astype(np.float64), (win // 2, win))
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(pad[idx] ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms + 1e-9)


def detect(x: np.ndarray, sr: int, min_voiced_s: float = 0.03, bridge_s: float = 0.03) -> VadResult:
    """Adaptive threshold between the measured noise floor and speech level, with hysteresis.

    floor = 10th percentile frame level, speech = 95th percentile. A frame is voiced above
    floor + 35% of the range (at least 8 dB above the floor), and stays voiced down to
    floor + 20% of the range. Voiced blips shorter than min_voiced_s are dropped and gaps shorter
    than bridge_s are bridged.
    """
    db = frame_db(x, sr)
    floor = float(np.percentile(db, 10))
    speech = float(np.percentile(db, 95))
    rng = max(speech - floor, 1e-6)
    hi = floor + max(8.0, 0.35 * rng)
    lo = floor + max(5.0, 0.20 * rng)
    if speech - floor < 8.0:  # nothing that rises above the floor: all silence
        return VadResult(np.zeros(len(db), bool), HOP_S, floor, speech, hi)
    voiced = np.zeros(len(db), bool)
    on = False
    for i, v in enumerate(db):
        on = v > hi if not on else v > lo
        voiced[i] = on
    # extend each voiced run backwards/forwards while still above lo (hysteresis on onsets too)
    for s, e in _runs(voiced, 1, 1):
        s, e = int(s), int(e)
        while s > 0 and db[s - 1] > lo:
            s -= 1
        voiced[s:int(e)] = True
    # bridge tiny gaps, then drop tiny blips
    for s, e in _runs(~voiced, HOP_S, 0):
        if (e - s) <= bridge_s + 1e-9 and s > 0 and e < len(db) * HOP_S:
            voiced[int(round(s / HOP_S)):int(round(e / HOP_S))] = True
    for s, e in _runs(voiced, HOP_S, 0):
        if (e - s) < min_voiced_s - 1e-9:
            voiced[int(round(s / HOP_S)):int(round(e / HOP_S))] = False
    return VadResult(voiced, HOP_S, floor, speech, hi)
