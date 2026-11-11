"""Voiceover mixing in the Python compositor (demand #17), mirroring apps/editor/test/voiceover.test.ts.

Bounds (set before the first run): a mono 1 kHz clip at output 1000 ms has its onset within +-5 ms of
1000 ms, is silent (< -80 dBFS) before it, plays at full level in both channels (as the editor preview's
Web Audio does; source RMS +-0.5 dB), and a project without voiceover renders exactly as before.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compositor"))

from lens_compositor.audio import build_audio  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg missing")
SR = 48000


def _plan(voice=None, clicks=None) -> dict:
    a = {
        "sampleRate": SR, "durationMs": 3000, "tracks": [],
        "pieces": [{"srcStart": 0, "srcEnd": 3000, "rate": 1, "outStart": 0, "outEnd": 3000, "gain": 1}],
        "clickSound": clicks or {"enabled": False, "volume": 0, "times": []},
        "noiseReduction": {"enabled": False, "amountDb": 12},
        "loudness": {"enabled": False, "targetLufs": -16, "truePeakDb": -1.5, "lra": 11},
    }
    if voice is not None:
        a["voice"] = voice
    return {"audio": a}


def _db(x: float) -> float:
    return 20 * np.log10(x + 1e-12)


def test_voice_clip_onset_level_and_silence(tmp_path: Path) -> None:
    tone = tmp_path / "tone.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=1000:d=1.25:sample_rate=48000",
                    "-af", "volume=0.25,adelay=250:all=1", "-ac", "1", str(tone)], check=True)
    out = build_audio(_plan([{"id": "a", "path": str(tone), "outMs": 1000, "fileOffsetMs": 250, "durMs": 1000, "gain": 1}]), None, 3 * SR)
    assert out is not None and out.shape == (3 * SR, 2)
    m = out.mean(axis=1)
    on = int(np.argmax(np.abs(m) > 0.02)) / SR
    assert abs(on - 1.0) <= 0.005
    assert _db(float(np.sqrt(np.mean(m[: int(0.99 * SR)] ** 2)))) < -80
    lvl = _db(float(np.sqrt(np.mean(out[int(1.1 * SR): int(1.9 * SR), 0] ** 2))))
    assert abs(lvl - _db(0.125 * 0.25 / np.sqrt(2))) <= 0.5
    # both channels carry it at full level
    assert np.allclose(out[:, 0], out[:, 1])


def test_no_voiceover_unchanged() -> None:
    clicks = {"enabled": True, "volume": 0.5, "times": [500]}
    a = build_audio(_plan(None, clicks), None, 3 * SR)
    b = build_audio(_plan([], clicks), None, 3 * SR)
    assert a is not None and b is not None and np.array_equal(a, b)
