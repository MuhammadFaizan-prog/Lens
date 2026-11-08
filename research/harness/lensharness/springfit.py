"""Fit damped-spring motion to measured curves (zoom scale, pan, cursor).

Every animated property in a polished recording (zoom in/out, pan, layout transitions) is close
to a damped harmonic oscillator stepping between targets. Fitting stiffness and damping to the
measured curve turns "it feels smooth" into numbers we can copy into project defaults.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np
from scipy.optimize import least_squares


def step_response(t: np.ndarray, omega: float, zeta: float) -> np.ndarray:
    """Normalized step response (0 -> 1) of a spring starting at rest, t in seconds (t<0 -> 0)."""
    t = np.maximum(t, 0)
    if abs(zeta - 1) < 1e-4:
        x = 1 - (1 + omega * t) * np.exp(-omega * t)
    elif zeta < 1:
        wd = omega * math.sqrt(1 - zeta * zeta)
        x = 1 - np.exp(-zeta * omega * t) * (np.cos(wd * t) + zeta * omega / wd * np.sin(wd * t))
    else:
        s = omega * math.sqrt(zeta * zeta - 1)
        r1, r2 = -zeta * omega + s, -zeta * omega - s
        x = 1 - (r2 * np.exp(r1 * t) - r1 * np.exp(r2 * t)) / (r2 - r1)
    return x


def settle_time_ms(omega: float, zeta: float, tol: float = 0.01) -> float:
    t = np.linspace(0, 20 / max(omega, 1e-3), 20000)
    x = step_response(t, omega, zeta)
    outside = np.where(np.abs(1 - x) > tol)[0]
    return float(t[outside[-1]] * 1000) if len(outside) else 0.0


@dataclass
class SpringFit:
    t0_ms: float
    start: float
    end: float
    omega: float
    zeta: float
    stiffness: float
    damping: float
    settle_ms: float
    rms: float
    n: int


def fit_transition(t_ms: np.ndarray, y: np.ndarray) -> SpringFit:
    """Fit one transition (y moves from a plateau to another plateau) with a spring step."""
    t_ms = np.asarray(t_ms, float)
    y = np.asarray(y, float)
    a0, b0 = float(np.median(y[: max(2, len(y) // 10)])), float(np.median(y[-max(2, len(y) // 10):]))
    span = b0 - a0
    if abs(span) < 1e-6:
        raise ValueError("no transition in window")
    # Initial t0: first sample that moved 2% of the way.
    moved = np.where(np.abs(y - a0) > 0.02 * abs(span))[0]
    t0_guess = float(t_ms[moved[0]]) if len(moved) else float(t_ms[0])

    def model(p):
        t0, logw, zeta, a, b = p
        return a + (b - a) * step_response((t_ms - t0) / 1000, math.exp(logw), zeta)

    best = None
    for zeta0 in (0.6, 1.0, 1.4):
        for w0 in (4.0, 8.0, 14.0):
            try:
                r = least_squares(lambda p: model(p) - y, [t0_guess - 30, math.log(w0), zeta0, a0, b0],
                                  bounds=([t_ms[0] - 2000, math.log(0.5), 0.2, -np.inf, -np.inf], [t_ms[-1], math.log(80), 3.0, np.inf, np.inf]))
            except ValueError:
                continue
            if best is None or r.cost < best.cost:
                best = r
    assert best is not None
    t0, logw, zeta, a, b = best.x
    omega = math.exp(logw)
    rms = float(np.sqrt(np.mean((model(best.x) - y) ** 2)))
    return SpringFit(float(t0), float(a), float(b), omega, float(zeta), omega * omega, 2 * zeta * omega, settle_time_ms(omega, zeta), rms, len(y))


def find_transitions(t_ms: np.ndarray, y: np.ndarray, min_delta: float, quiet_ms: float = 150) -> list[tuple[int, int]]:
    """Split a curve into windows around each transition between plateaus.
    Returns index ranges [i0, i1) that include some plateau on both sides."""
    t_ms = np.asarray(t_ms, float)
    y = np.asarray(y, float)
    dy = np.abs(np.gradient(y, t_ms))
    thresh = max(np.percentile(dy, 50) * 3, 1e-9)
    moving = dy > thresh
    windows = []
    i = 0
    n = len(y)
    while i < n:
        if not moving[i]:
            i += 1
            continue
        j = i
        while j < n and (moving[j] or (j + 1 < n and moving[j + 1])):
            j += 1
        if abs(y[min(j, n - 1)] - y[max(i - 1, 0)]) >= min_delta:
            pad_l = np.searchsorted(t_ms, t_ms[i] - quiet_ms * 2)
            pad_r = np.searchsorted(t_ms, t_ms[min(j, n - 1)] + quiet_ms * 2)
            windows.append((int(max(0, pad_l)), int(min(n, pad_r))))
        i = j + 1
    # Merge overlapping windows.
    merged: list[tuple[int, int]] = []
    for w in windows:
        if merged and w[0] <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], w[1]))
        else:
            merged.append(w)
    return merged


def fit_zoom_curve(t_ms, scale) -> list[dict]:
    """Fit every zoom-in / zoom-out in a scale curve. Fits in log space (perceptual zoom)."""
    t = np.asarray(t_ms, float)
    s = np.asarray(scale, float)
    ok = np.isfinite(s) & (s > 0)
    t, ls = t[ok], np.log(s[ok])
    out = []
    for i0, i1 in find_transitions(t, ls, min_delta=math.log(1.15)):
        try:
            f = fit_transition(t[i0:i1], ls[i0:i1])
        except ValueError:
            continue
        d = asdict(f)
        d["direction"] = "in" if f.end > f.start else "out"
        d["fromScale"] = math.exp(f.start)
        d["toScale"] = math.exp(f.end)
        out.append(d)
    return out


def simulate_follower(t_ms: np.ndarray, target: np.ndarray, settle_ms: float, lookahead_ms: float) -> np.ndarray:
    """Critically damped follower of a target signal (same math as the engine's cursor spring)."""
    t_ms = np.asarray(t_ms, float)
    target = np.interp(t_ms + lookahead_ms, t_ms, target)
    if settle_ms <= 0:
        return target.copy()
    omega = 6.638 / (settle_ms / 1000)
    x, v = target[0], 0.0
    out = [x]
    for i in range(1, len(t_ms)):
        dt = (t_ms[i] - t_ms[i - 1]) / 1000
        x0 = x - target[i - 1]
        b = v + omega * x0
        e = math.exp(-omega * dt)
        x = (x0 + b * dt) * e + target[i - 1]
        v = (b - omega * (x0 + b * dt)) * e
        out.append(x)
    return np.array(out)


def fit_cursor_smoothing(t_ms, raw_xy, measured_xy) -> dict:
    """Grid-search the follower settle time and lookahead that best explain a measured cursor path."""
    t = np.asarray(t_ms, float)
    raw = np.asarray(raw_xy, float)
    meas = np.asarray(measured_xy, float)
    ok = np.all(np.isfinite(meas), axis=1) & np.all(np.isfinite(raw), axis=1)
    # Remove the constant offset between the detected blob anchor and the true hotspot, estimated
    # where the mouse is at rest (smoothing has no effect there).
    speed = np.r_[0, np.hypot(*np.diff(raw, axis=0).T)]
    rest = ok & (speed < 0.5)
    bias = np.median(meas[rest] - raw[rest], axis=0) if rest.sum() >= 5 else np.zeros(2)
    meas = meas - bias
    best = (math.inf, 0.0, 0.0)
    for settle in range(0, 601, 20):
        for look in range(0, 301, 10):
            sx = simulate_follower(t, raw[:, 0], settle, look)
            sy = simulate_follower(t, raw[:, 1], settle, look)
            err = np.sqrt(np.mean(((sx - meas[:, 0]) ** 2 + (sy - meas[:, 1]) ** 2)[ok]))
            if err < best[0]:
                best = (float(err), float(settle), float(look))
    # Approximate single-spring explanation of the path (One Euro prefilter and lookahead make it
    # an equivalent, not the exact pipeline). Compare Lens vs bar with the same fitter.
    return {"rmsPx": best[0], "settleMs": best[1], "lookaheadMs": best[2], "samples": int(ok.sum()), "anchorBiasPx": [float(bias[0]), float(bias[1])]}
