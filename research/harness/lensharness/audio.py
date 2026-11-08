"""Audio measurements (F01-F04): loudness, true peak, noise floor. Uses ffmpeg filters only."""
from __future__ import annotations

import re
import subprocess


def has_audio(path: str) -> bool:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout
    return bool(out.strip())


def loudness(path: str) -> dict:
    """Integrated loudness (LUFS), loudness range (LU) and true peak (dBTP), EBU R128."""
    if not has_audio(path):
        return {"available": False}
    err = subprocess.run(["ffmpeg", "-nostats", "-i", path, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    summary = err[err.rfind("Summary:"):]
    get = lambda pat: float(m.group(1)) if (m := re.search(pat, summary)) else None  # noqa: E731
    return {
        "available": True,
        "integratedLufs": get(r"I:\s+(-?[\d.]+) LUFS"),
        "loudnessRangeLu": get(r"LRA:\s+(-?[\d.]+) LU"),
        "truePeakDbtp": get(r"Peak:\s+(-?[\d.]+) dBFS"),
    }


def noise_floor(path: str, window_s: float = 0.5) -> dict:
    """RMS level of the quietest windows: a proxy for how much noise reduction was applied."""
    if not has_audio(path):
        return {"available": False}
    err = subprocess.run(
        ["ffmpeg", "-nostats", "-i", path, "-af", f"asetnsamples=n={int(48000 * window_s)},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    levels = sorted(float(v) for v in re.findall(r"RMS_level=(-?[\d.]+)", err) if v not in ("-inf",))
    if not levels:
        return {"available": True, "noiseFloorDb": None}
    k = max(1, len(levels) // 10)
    return {"available": True, "noiseFloorDb": sum(levels[:k]) / k, "speechLevelDb": sum(levels[-k:]) / k}


def decode_mono(path: str, sr: int = 48000):
    """Decode the first audio stream to mono float32 at sr (numpy array)."""
    import numpy as np

    out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, np.float32).copy()


def onsets(x, sr: int = 48000, rel_threshold: float = 0.2, refractory_ms: float = 120.0, win_ms: float = 1.0) -> list:
    """Onset times (ms) of transients: where a short-window peak envelope first crosses
    rel_threshold * global peak, then stays quiet for refractory_ms before the next can fire."""
    import numpy as np

    if len(x) == 0:
        return []
    w = max(1, int(sr * win_ms / 1000))
    n = len(x) // w
    env = np.abs(x[: n * w]).reshape(n, w).max(axis=1)
    thr = rel_threshold * float(env.max() or 1.0)
    hits, last = [], -1e9
    for i, v in enumerate(env):
        t = i * w * 1000 / sr
        if v >= thr and t - last >= refractory_ms:
            hits.append(t)
        if v >= thr:
            last = t
    return hits


def rms_db(x, sr: int, start_ms: float, end_ms: float) -> float:
    """RMS level (dBFS) of x between two times."""
    import numpy as np

    seg = x[int(start_ms * sr / 1000): int(end_ms * sr / 1000)]
    return float(20 * np.log10(np.sqrt(np.mean(seg.astype(np.float64) ** 2)) + 1e-12))
