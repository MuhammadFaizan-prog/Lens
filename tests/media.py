"""Synthetic media for the P1 feature tests: test tones, webcam bars, and a plan/render helper.
All generated here; no external sample media."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "packages" / "engine" / "dist" / "cli.js"
SR = 48000


def write_wav(path: Path, x: np.ndarray, sr: int = SR) -> str:
    x = np.asarray(x, np.float32)
    ch = 1 if x.ndim == 1 else x.shape[1]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-", "-c:a", "pcm_s16le", str(path)],
                   input=np.ascontiguousarray(x).tobytes(), check=True)
    return str(path)


def beeps(times_ms: list[float], dur_ms: float, freq: float = 1000.0, beep_ms: float = 40.0, amp: float = 0.5, sr: int = SR) -> np.ndarray:
    x = np.zeros(int(dur_ms * sr / 1000), np.float32)
    n = int(beep_ms * sr / 1000)
    t = np.arange(n) / sr
    b = amp * np.sin(2 * np.pi * freq * t) * np.minimum(1, t / 0.0005)
    for tm in times_ms:
        i = int(round(tm * sr / 1000))
        x[i:i + n] += b[: len(x[i:i + n])]
    return x


def speechy(dur_ms: float, level: float = 0.05, seed: int = 3, sr: int = SR) -> np.ndarray:
    """Syllable-like bursts of harmonic tone with gaps (~4 Hz), roughly speech-shaped loudness."""
    rng = np.random.default_rng(seed)
    n = int(dur_ms * sr / 1000)
    t = np.arange(n) / sr
    f0 = 140 + 30 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / sr
    voice = sum((1 / k) * np.sin(k * phase) for k in range(1, 8))
    env = np.clip(np.sin(2 * np.pi * 3.7 * t + rng.uniform(0, 6)) * 1.4, 0, 1) ** 1.5
    env *= (np.sin(2 * np.pi * 0.31 * t) > -0.6)  # occasional pauses
    return (level * voice * env).astype(np.float32)


def webcam_bars(path: Path, w: int = 320, h: int = 240, fps: int = 30, dur_ms: int = 4000) -> str:
    """Four vertical bands: red | green | blue | yellow (BGR order written correctly)."""
    frame = np.zeros((h, w, 3), np.uint8)
    cols = [(0, 0, 255), (0, 255, 0), (255, 0, 0), (0, 255, 255)]  # BGR
    for i, c in enumerate(cols):
        frame[:, i * w // 4:(i + 1) * w // 4] = c
    n = int(dur_ms * fps / 1000)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv444p", str(path)],
                   input=frame.tobytes() * n, check=True)
    return str(path)


def make_plan(d: Path, meta: str, events: str, project: dict, name: str = "plan", words: list | None = None) -> dict:
    pj = d / f"{name}.project.json"
    pj.write_text(json.dumps(project))
    args = ["node", str(CLI), "--meta", meta, "--events", events, "--project", str(pj), "--out", str(d / f"{name}.json")]
    if words is not None:
        (d / f"{name}.words.json").write_text(json.dumps(words))
        args += ["--words", str(d / f"{name}.words.json")]
    subprocess.run(args, check=True, capture_output=True)
    return json.loads((d / f"{name}.json").read_text())


def read_all_frames(path: str) -> np.ndarray:
    sys.path.insert(0, str(ROOT / "compositor"))
    from lens_compositor.render import probe, read_frames  # noqa: E402

    info = probe(path)
    return np.stack(list(read_frames(path, info["width"], info["height"])))


def ffprobe(path: str, entries: str, stream: str = "v:0", count: bool = False) -> dict:
    args = ["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "json", path]
    if count:
        args.insert(1, "-count_frames")
    return json.loads(subprocess.run(args, capture_output=True, text=True, check=True).stdout)


def screen_point(plan_frame: dict, plan: dict, x: float, y: float) -> tuple[float, float]:
    """Map a (cropped) source point to output px through the frame's camera + layout."""
    cx, cy, s = plan_frame["cam"]
    _, _, src_w, src_h = plan["source"]["crop"]
    sx, sy, sw, sh = plan_frame["layout"]["screen"]
    vw, vh = src_w / s, src_h / s
    return sx + (x - (cx - vw / 2)) * sw / vw, sy + (y - (cy - vh / 2)) * sh / vh
