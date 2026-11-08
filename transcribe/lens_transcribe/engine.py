"""Local speech recognition with faster-whisper (MIT) running CTranslate2 (MIT) on the CPU.

Models are the CTranslate2 conversions of OpenAI's Whisper checkpoints (weights released under
MIT by OpenAI; conversions published under MIT by Systran). Nothing leaves the machine: the model
is downloaded once into the Hugging Face cache (or LENS_STT_MODEL_DIR) and runs offline after.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

DEFAULT_MODEL = "base.en"

MODELS = {
    # name: (Hugging Face repo, licence)
    "tiny.en": ("Systran/faster-whisper-tiny.en", "MIT"),
    "base.en": ("Systran/faster-whisper-base.en", "MIT"),
    "small.en": ("Systran/faster-whisper-small.en", "MIT"),
    "tiny": ("Systran/faster-whisper-tiny", "MIT"),
    "base": ("Systran/faster-whisper-base", "MIT"),
    "small": ("Systran/faster-whisper-small", "MIT"),
}

_cache: dict[tuple[str, str], object] = {}


@dataclass
class RawWord:
    text: str
    start: float
    end: float
    probability: float


@dataclass
class RawResult:
    words: list[RawWord]
    language: str
    language_probability: float
    duration: float


def licence_of(model: str) -> str:
    return MODELS.get(model, ("", "unknown (custom model path)"))[1]


def load(model: str = DEFAULT_MODEL, compute_type: str = "int8"):
    key = (model, compute_type)
    if key not in _cache:
        from faster_whisper import WhisperModel  # imported lazily: heavy, and optional for the engine

        threads = int(os.environ.get("LENS_STT_THREADS", "0")) or (os.cpu_count() or 2)
        _cache[key] = WhisperModel(model, device="cpu", compute_type=compute_type, cpu_threads=threads,
                                   download_root=os.environ.get("LENS_STT_MODEL_DIR") or None)
    return _cache[key]


def recognise(audio: np.ndarray, model: str = DEFAULT_MODEL, language: str | None = None, prompt: str | None = None,
              beam_size: int = 5) -> RawResult:
    """audio: mono float32 at 16 kHz."""
    m = load(model)
    if model.endswith(".en"):
        language = "en"
    segments, info = m.transcribe(
        audio,
        language=language,
        beam_size=beam_size,
        word_timestamps=True,
        initial_prompt=prompt,
        condition_on_previous_text=False,
        vad_filter=False,
        temperature=0.0,
    )
    words = [RawWord(w.word, float(w.start), float(w.end), float(w.probability)) for s in segments for w in (s.words or [])]
    return RawResult(words, info.language, float(info.language_probability), float(info.duration))
