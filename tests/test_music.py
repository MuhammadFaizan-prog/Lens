"""Music bed in the Python reference compositor (demand #23): the same loudness, level, duck, fade and
loop as the in-app export (apps/editor/test/musicExport.test.ts runs the TypeScript side).

Bounds: EBU Tech 3341 case 1 reads -23.0 +- 0.1 LUFS; music in the gap is depthDb (15) +- 0.5 dB
above music under speech; music level in the gap = speech loudness + volumeDb (-10) - music loudness
within 0.1 dB of the stated gain; loop keeps the 2.5 s file going at 9 s.
"""
from __future__ import annotations

import math
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compositor"))

from lens_compositor.audio import build_audio, integrated_loudness  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg missing")
SR = 48000


def tone(f, amp, secs, gate=None):
    t = np.arange(int(round(secs * SR))) / SR
    x = amp * np.sin(2 * np.pi * f * t)
    if gate is not None:
        x = x * gate(t)
    return x.astype(np.float32)


def wav(path: Path, x: np.ndarray):
    st = np.stack([x, x], 1).astype(np.float32)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-", "-c:a", "pcm_s16le", str(path)], input=st.tobytes(), check=True)


def tone_db(x, f, a, b):
    i0, i1 = int(a * SR), int(b * SR)
    n = np.arange(i0, i1)
    v = x[i0:i1, 0]
    re = (v * np.cos(2 * np.pi * f * n / SR)).sum()
    im = (v * np.sin(2 * np.pi * f * n / SR)).sum()
    return 20 * math.log10(2 * math.hypot(re, im) / (i1 - i0) + 1e-12)


def test_ebu_case1():
    x = tone(1000, 10 ** (-23 / 20), 20)
    assert abs(integrated_loudness(np.stack([x, x], 1), SR) - (-23.0)) <= 0.1


def duck_keys(speech, depth, a, h, r):
    low = 10 ** (-depth / 20)
    keys = []
    for s, e in speech:
        keys += [[s - a, 1], [s, low], [e + h, low], [e + h + r, 1]]
    return keys


def test_music_duck_level_loop(tmp_path):
    speech = [(1000, 3000), (6000, 8000)]
    gate = lambda t: np.array([any(s <= tt * 1000 < e for s, e in speech) for tt in t], np.float32)
    mic = tone(1000, 0.25, 10, gate)
    wav(tmp_path / "mic.wav", mic)
    wav(tmp_path / "music.wav", tone(220, 0.5, 2.5))
    plan = {"audio": {
        "sampleRate": SR, "durationMs": 10000,
        "tracks": [{"id": "mic", "kind": "mic", "path": str(tmp_path / "mic.wav"), "offsetMs": 0, "volume": 1}],
        "pieces": [{"srcStart": 0, "srcEnd": 10000, "rate": 1, "outStart": 0, "outEnd": 10000, "gain": 1}],
        "clickSound": {"enabled": False, "volume": 0, "times": []},
        "noiseReduction": {"enabled": False, "amountDb": 12},
        "loudness": {"enabled": False, "targetLufs": -16, "truePeakDb": -1.5, "lra": 11},
        "music": {"path": str(tmp_path / "music.wav"), "volumeDb": -10, "loop": True, "startMs": 0,
                  "speech": [{"startMs": s, "endMs": e} for s, e in speech],
                  "duck": duck_keys(speech, 15, 100, 100, 400), "fade": [[0, 1], [10000, 1]]},
    }}
    x = build_audio(plan, None, 10 * SR)
    m_duck, m_gap = tone_db(x, 220, 1.5, 2.5), tone_db(x, 220, 4.0, 5.5)
    assert abs((m_gap - m_duck) - 15) <= 0.5
    sp = integrated_loudness(np.stack([mic, mic], 1), SR)
    mu = integrated_loudness(np.stack([tone(220, 0.5, 2.5)] * 2, 1), SR)
    expected = 20 * math.log10(0.5) + (sp - 10 - mu)
    assert abs(m_gap - expected) <= 0.1
    assert abs(tone_db(x, 220, 9.0, 9.9) - m_gap) <= 0.5
    assert abs(tone_db(x, 1000, 1.5, 2.5) - 20 * math.log10(0.25)) <= 0.1
