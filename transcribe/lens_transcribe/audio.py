"""Audio loading for the transcriber: anything ffmpeg reads -> mono float32 at 16 kHz."""
from __future__ import annotations

import subprocess

import numpy as np

SR = 16000


def decode_audio(path: str, sr: int = SR, offset_s: float = 0.0, duration_s: float | None = None) -> np.ndarray:
    """Decode with the ffmpeg binary (no PyAV dependency), downmixed to mono, resampled to sr."""
    args = ["ffmpeg", "-v", "error", "-nostdin"]
    if offset_s > 0:
        args += ["-ss", f"{offset_s:.3f}"]
    args += ["-i", path]
    if duration_s is not None:
        args += ["-t", f"{duration_s:.3f}"]
    args += ["-map", "0:a:0", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    out = subprocess.run(args, capture_output=True, check=False)
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg could not decode {path}: {out.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(out.stdout, np.float32).copy()
