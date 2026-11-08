"""Synthetic speech for the speech-to-text tests, made locally with espeak-ng (no downloaded clips).

Ground truth for word timing is measured here from the clean synthesized signal with a plain
envelope threshold, independently of the transcriber's own VAD (which only ever sees the noisy
mix the tests feed it).
"""
from __future__ import annotations

import io
import re
import shutil
import subprocess
import wave

import numpy as np
from scipy.signal import resample_poly

SR = 16000
ESPEAK = shutil.which("espeak-ng")


FILLERS = {"um", "uh", "er", "erm", "ah", "hmm"}


def hesitant_ssml(text: str) -> str:
    """SSML in which filler words are drawn out the way people hesitate (espeak x-slow: 0.3-0.45 s).
    At normal rate espeak reads "uh" as the article "a" and "er" like "were" (~0.15 s), which is
    not a hesitation sound."""
    out = []
    for w in text.split():
        out.append(f'<prosody rate="x-slow">{w}</prosody>' if w.lower() in FILLERS else w)
    return "<speak>" + " ".join(out) + "</speak>"


def tts(text: str, sr: int = SR, speed: int = 160, word_gap: int | None = None, voice: str = "en-us", ssml: bool = False) -> np.ndarray:
    """espeak-ng speech as float32 mono at sr. word_gap is espeak's -g (units of 10 ms)."""
    args = [ESPEAK or "espeak-ng", "-v", voice, "-s", str(speed)]
    if word_gap:
        args += ["-g", str(word_gap)]
    if ssml:
        args += ["-m"]
    out = subprocess.run(args + ["--stdout", text], capture_output=True, check=True).stdout
    w = wave.open(io.BytesIO(out))
    src = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    from math import gcd

    g = gcd(sr, src)
    return resample_poly(x, sr // g, src // g).astype(np.float32)


def pad(x: np.ndarray, lead_s: float = 0.3, tail_s: float = 0.5, sr: int = SR) -> np.ndarray:
    return np.concatenate([np.zeros(int(lead_s * sr), np.float32), x, np.zeros(int(tail_s * sr), np.float32)])


def add_noise(x: np.ndarray, rms_dbfs: float = -50.0, seed: int = 1, sr: int = SR) -> np.ndarray:
    """Room-tone stand-in: pink-ish noise plus a quiet 50 Hz hum at the given total RMS."""
    rng = np.random.default_rng(seed)
    white = rng.standard_normal(len(x))
    pink = np.cumsum(white)
    pink -= np.convolve(pink, np.ones(64) / 64, mode="same")  # high-pass the random walk
    pink /= np.sqrt(np.mean(pink ** 2)) + 1e-12
    hum = np.sin(2 * np.pi * 50 * np.arange(len(x)) / sr) * 0.5
    n = pink + hum
    n *= 10 ** (rms_dbfs / 20) / (np.sqrt(np.mean(n ** 2)) + 1e-12)
    return (x + n).astype(np.float32)


def word_runs(clean: np.ndarray, sr: int = SR, min_gap_s: float = 0.12, thresh_dbfs: float = -45.0) -> list[tuple[float, float]]:
    """Voiced runs of a clean (noise-free) signal: 10 ms RMS above thresh_dbfs, gaps shorter than
    min_gap_s bridged. With espeak's word gap on, one run per word."""
    hop = int(0.01 * sr)
    n = len(clean) // hop
    rms = np.sqrt(np.mean(clean[: n * hop].reshape(n, hop).astype(np.float64) ** 2, axis=1) + 1e-12)
    on = 20 * np.log10(rms) > thresh_dbfs
    runs: list[list[float]] = []
    for i, v in enumerate(on):
        if not v:
            continue
        t = i * hop / sr
        if runs and t - runs[-1][1] < min_gap_s:
            runs[-1][1] = t + hop / sr
        else:
            runs.append([t, t + hop / sr])
    return [(a, b) for a, b in runs]


def norm(w: str) -> str:
    return re.sub(r"[^\w']", "", w.lower())


def tokens(words: list[str]) -> list[str]:
    return [t for t in (norm(w) for w in words) if t]


def wer_counts(ref: list[str], hyp: list[str]) -> tuple[int, int]:
    """(edit distance, reference length) on normalised tokens."""
    r, h = tokens(ref), tokens(hyp)
    d = np.zeros((len(r) + 1, len(h) + 1), int)
    d[:, 0] = range(len(r) + 1)
    d[0, :] = range(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
    return int(d[-1, -1]), len(r)


def tts_with_word_starts(text: str, sr: int = SR, speed: int = 160, voice: str = "en-us") -> tuple[np.ndarray, list[float]]:
    """Connected speech plus the synthesizer's own word-start times (s), read from libespeak-ng's
    word events (espeakEVENT_WORD audio_position). These are the TTS-known boundaries for speech
    with no pauses between words, where an energy envelope cannot separate words."""
    import ctypes
    import ctypes.util

    name = ctypes.util.find_library("espeak-ng") or "libespeak-ng.so.1"
    lib = ctypes.CDLL(name)

    class Event(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("unique_identifier", ctypes.c_uint), ("text_position", ctypes.c_int),
                    ("length", ctypes.c_int), ("audio_position", ctypes.c_int), ("sample", ctypes.c_int),
                    ("user_data", ctypes.c_void_p), ("id", ctypes.c_void_p)]

    callback_t = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.POINTER(Event))
    pcm: list[np.ndarray] = []
    starts: list[float] = []

    def cb(wav, n, ev):
        if wav and n > 0:
            pcm.append(np.ctypeslib.as_array(wav, (n,)).copy())
        i = 0
        while ev[i].type != 0:  # espeakEVENT_LIST_TERMINATED
            if ev[i].type == 1:  # espeakEVENT_WORD
                starts.append(ev[i].audio_position / 1000)
            i += 1
        return 0

    keep = callback_t(cb)
    src = lib.espeak_Initialize(1, 0, None, 0)  # AUDIO_OUTPUT_RETRIEVAL
    if src <= 0:
        raise RuntimeError("espeak_Initialize failed")
    lib.espeak_SetSynthCallback(keep)
    lib.espeak_SetVoiceByName(voice.encode())
    lib.espeak_SetParameter(1, speed, 0)  # espeakRATE
    lib.espeak_SetParameter(7, 0, 0)  # espeakWORDGAP: none
    b = text.encode()
    lib.espeak_Synth(b, len(b) + 1, 0, 0, 0, 0, None, None)  # POS_CHARACTER, espeakCHARS_AUTO
    lib.espeak_Synchronize()
    lib.espeak_Terminate()
    x = np.concatenate(pcm).astype(np.float32) / 32768
    from math import gcd

    g = gcd(sr, src)
    return resample_poly(x, sr // g, src // g).astype(np.float32), starts
