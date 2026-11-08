"""Audio side of the reference compositor (AUD-01..06, EDT-05, CUR-08) and GIF export (EXP-04).

The render plan's `audio` block says which source ranges play, at what rate and gain, and where
they land on the output clock (the same edit timeline the video frames follow). This module:

  1. decodes each unmuted track to float PCM aligned to the recording clock (track offset),
  2. lays each plan piece onto the output clock: slice, time-stretch with ffmpeg `atempo` when the
     piece is sped up, force the exact output sample length, apply the per-segment gain, and fade
     3 ms at every cut so joins do not pop,
  3. optional cleanup: FFT denoise (`afftdn`, noise floor measured from quiet windows) then two-pass EBU R128 `loudnorm` to a target LUFS,
  4. mixes the procedurally synthesized click sound at each click's output time,
  5. muxes the result as AAC next to the already encoded video.

Everything audible is generated or transformed here; no third-party sample media is used.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np

CHANNELS = 2


# ---------------------------------------------------------------- click sound (original Lens design)

def synth_click(sr: int = 48000, ms: float = 30.0) -> np.ndarray:
    """A short, soft "tick": two exponentially damped partials plus a very short high-passed noise
    transient for the attack. Deterministic (fixed seed). Returns mono float32, peak 0.9."""
    n = int(sr * ms / 1000)
    t = np.arange(n) / sr
    body = np.exp(-t / 0.0038)
    snap = np.exp(-t / 0.0009)
    rng = np.random.default_rng(20261109)
    noise = np.diff(rng.standard_normal(n + 1)).astype(np.float64)  # first difference = gentle high-pass
    x = 0.55 * np.sin(2 * np.pi * 1870 * t) * body + 0.28 * np.sin(2 * np.pi * 3320 * t + 0.6) * body + 0.30 * noise * snap
    attack = np.clip(t / 0.0003, 0, 1)  # 0.3 ms ramp, no DC step
    x *= attack
    x *= 0.9 / np.max(np.abs(x))
    return x.astype(np.float32)


# ---------------------------------------------------------------- pcm io

def _ff(args: list[str], stdin: Optional[bytes] = None) -> subprocess.CompletedProcess:
    p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", *args], input=stdin, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(args)}\n{p.stderr.decode(errors='replace')}")
    return p


def decode_pcm(path: str, sr: int) -> np.ndarray:
    """Decode any audio (or the audio of a video) to float32 [n, 2] at sr."""
    p = _ff(["-i", path, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(CHANNELS), "-ar", str(sr), "-"])
    return np.frombuffer(p.stdout, np.float32).reshape(-1, CHANNELS).copy()


def _filter_pcm(x: np.ndarray, sr: int, af: str) -> np.ndarray:
    """Run float PCM through an ffmpeg audio filter chain (raw in, raw out)."""
    p = _ff(["-f", "f32le", "-ar", str(sr), "-ac", str(CHANNELS), "-i", "-", "-af", af,
             "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(CHANNELS), "-ar", str(sr), "-"], stdin=np.ascontiguousarray(x, np.float32).tobytes())
    return np.frombuffer(p.stdout, np.float32).reshape(-1, CHANNELS).copy()


def write_wav(x: np.ndarray, sr: int, path: str) -> None:
    _ff(["-f", "f32le", "-ar", str(sr), "-ac", str(CHANNELS), "-i", "-", "-c:a", "pcm_s16le", path], stdin=np.ascontiguousarray(x, np.float32).tobytes())


def atempo_chain(rate: float) -> str:
    """atempo accepts 0.5..100 per stage; chain stages for slower rates."""
    stages = []
    r = rate
    while r < 0.5:
        stages.append(0.5)
        r /= 0.5
    while r > 100:
        stages.append(100.0)
        r /= 100
    stages.append(r)
    return ",".join(f"atempo={s:.6f}" for s in stages)


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    if len(x) >= n:
        return x[:n]
    return np.concatenate([x, np.zeros((n - len(x), CHANNELS), np.float32)])


# ---------------------------------------------------------------- plan -> pcm

def _resolve(path: str, plan_dir: Optional[Path]) -> str:
    p = Path(path)
    if p.is_absolute() or p.exists() or plan_dir is None:
        return str(p)
    return str(plan_dir / p)


def lay_track(src: np.ndarray, offset_ms: float, pieces: list[dict], sr: int, n_out: int) -> np.ndarray:
    """Place one recording-clock track onto the output clock following the plan pieces."""
    out = np.zeros((n_out, CHANNELS), np.float32)
    off = int(round(offset_ms * sr / 1000))  # recording sample index of the file's first sample
    fade = max(1, int(0.003 * sr))
    prev_src_end = None
    for i, pc in enumerate(pieces):
        s0 = int(round(pc["srcStart"] * sr / 1000))
        s1 = int(round(pc["srcEnd"] * sr / 1000))
        o0 = int(round(pc["outStart"] * sr / 1000))
        o1 = min(n_out, int(round(pc["outEnd"] * sr / 1000)))
        if o1 <= o0 or s1 <= s0:
            prev_src_end = pc["srcEnd"]
            continue
        # recording-clock slice [s0, s1) -> file indices [s0-off, s1-off), silence outside the file
        seg = np.zeros((s1 - s0, CHANNELS), np.float32)
        a, b = s0 - off, s1 - off
        fa, fb = max(0, a), min(len(src), b)
        if fb > fa:
            seg[fa - a:fb - a] = src[fa:fb]
        if abs(pc["rate"] - 1) > 1e-6 and np.any(seg):
            seg = _filter_pcm(seg, sr, atempo_chain(pc["rate"]))
        seg = _fit(seg, o1 - o0) * float(pc.get("gain", 1.0))
        cut_before = prev_src_end is not None and abs(prev_src_end - pc["srcStart"]) > 0.5
        nxt = pieces[i + 1] if i + 1 < len(pieces) else None
        cut_after = nxt is not None and abs(nxt["srcStart"] - pc["srcEnd"]) > 0.5
        f = min(fade, len(seg) // 2)
        if f > 0 and cut_before:
            seg[:f] *= np.linspace(0, 1, f, dtype=np.float32)[:, None]
        if f > 0 and cut_after:
            seg[-f:] *= np.linspace(1, 0, f, dtype=np.float32)[:, None]
        out[o0:o1] += seg
        prev_src_end = pc["srcEnd"]
    return out


def loudnorm_two_pass(x: np.ndarray, sr: int, target: float, tp: float, lra: float) -> np.ndarray:
    """EBU R128 two-pass normalisation. Pass 1 measures, pass 2 applies with the measured values
    (linear mode when the target is reachable without exceeding the true-peak ceiling)."""
    base = f"loudnorm=I={target}:TP={tp}:LRA={lra}"
    p = subprocess.run(["ffmpeg", "-v", "info", "-nostdin", "-hide_banner", "-f", "f32le", "-ar", str(sr), "-ac", str(CHANNELS), "-i", "-",
                        "-af", base + ":print_format=json", "-f", "null", "-"], input=np.ascontiguousarray(x, np.float32).tobytes(), capture_output=True)
    err = p.stderr.decode(errors="replace")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if p.returncode != 0 or not m:
        raise RuntimeError("loudnorm pass 1 failed:\n" + err)
    meas = json.loads(m.group(0))
    if not math.isfinite(float(meas["input_i"])) or float(meas["input_i"]) < -70:
        return x  # silence: nothing to normalise
    af = (f"{base}:measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:measured_LRA={meas['input_lra']}"
          f":measured_thresh={meas['input_thresh']}:offset={meas['target_offset']}:linear=true,aresample={sr}")
    return _fit(_filter_pcm(x, sr, af), len(x))


def estimate_noise_floor_db(x: np.ndarray, sr: int, window_ms: float = 50.0) -> float:
    """Noise floor estimate: 10th percentile of short-window RMS levels (dBFS), skipping digital silence."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    w = max(1, int(sr * window_ms / 1000))
    n = len(mono) // w
    if n == 0:
        return -80.0
    rms = np.sqrt(np.mean(mono[: n * w].reshape(n, w).astype(np.float64) ** 2, axis=1))
    rms = rms[rms > 1e-6]
    if len(rms) == 0:
        return -80.0
    return float(20 * np.log10(np.percentile(rms, 10)))


def denoise(x: np.ndarray, sr: int, amount_db: float) -> np.ndarray:
    """FFT denoise (ffmpeg afftdn). afftdn needs to know the noise floor; its own tracking under-reads
    it on speech, so we measure it from the quiet windows and pass it as nf."""
    nr = max(0.01, min(97.0, float(amount_db)))
    nf = max(-80.0, min(-20.0, round(estimate_noise_floor_db(x, sr))))
    return _fit(_filter_pcm(x, sr, f"afftdn=nr={nr}:nf={nf}"), len(x))


def build_audio(plan: dict, plan_dir: Optional[Path], n_out: int) -> Optional[np.ndarray]:
    """Render the plan's audio block to float32 [n_out, 2] at plan sampleRate, or None if silent."""
    a = plan.get("audio")
    if not a:
        return None
    sr = int(a["sampleRate"])
    voice = np.zeros((n_out, CHANNELS), np.float32)
    have_voice = False
    for tr in a["tracks"]:
        src = decode_pcm(_resolve(tr["path"], plan_dir), sr)
        voice += lay_track(src, tr["offsetMs"], a["pieces"], sr, n_out) * float(tr["volume"])
        have_voice = True
    if have_voice:
        if a["noiseReduction"]["enabled"]:
            voice = denoise(voice, sr, a["noiseReduction"]["amountDb"])
        if a["loudness"]["enabled"]:
            L = a["loudness"]
            voice = loudnorm_two_pass(voice, sr, L["targetLufs"], L["truePeakDb"], L["lra"])
    mix = voice
    cs = a.get("clickSound") or {}
    if cs.get("enabled") and cs.get("times"):
        click = synth_click(sr) * float(cs["volume"])
        for t in cs["times"]:
            i = int(round(t * sr / 1000))
            if i >= n_out:
                continue
            j = min(n_out, i + len(click))
            mix[i:j] += click[: j - i, None]
    return np.clip(mix, -1.0, 1.0)


def mux_audio(video_path: str, pcm: np.ndarray, sr: int, out_path: str, bitrate: str = "192k") -> None:
    """Copy the video stream and add the PCM as AAC."""
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "mix.f32")
        np.ascontiguousarray(pcm, np.float32).tofile(raw)
        _ff(["-i", video_path, "-f", "f32le", "-ar", str(sr), "-ac", str(CHANNELS), "-i", raw,
             "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", out_path])


# ---------------------------------------------------------------- gif

def export_gif(video_path: str, out_path: str, fps: float, width: int, loop: bool) -> None:
    """Two-stage palette GIF: palettegen builds an optimal 256-colour palette for the whole clip
    (stats_mode=diff favours moving regions), paletteuse maps frames onto it with error diffusion."""
    vf = (f"fps={fps},scale={int(width)}:-1:flags=lanczos,split[a][b];"
          f"[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle")
    _ff(["-i", video_path, "-filter_complex", vf, "-loop", "0" if loop else "-1", out_path])
