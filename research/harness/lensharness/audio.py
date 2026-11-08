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
