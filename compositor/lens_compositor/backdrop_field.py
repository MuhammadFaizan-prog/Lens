"""Lens's procedural backdrop "fields" (v0.1.4), the numpy twin of packages/engine/src/backdropField.ts.

The newer built-in backdrops are per-pixel functions of (x, y), a seed and a palette, evaluated at the
output size. This module mirrors the TypeScript line by line: the same uint32 lattice hash, value
noise, fbm, mulberry32 parameter sequence and per-pixel shading, so the reference compositor draws
the picture the editor's preview and in-app export draw. Rows are rendered in chunks to bound memory
at 4K. Original designs, no third-party wallpapers or assets. Output is BGR float32.
"""
from __future__ import annotations

import math

import numpy as np

from .backdrop_art import mulberry32

FIELD_STYLES = ("mesh", "aurora", "blur", "bokeh", "lowpoly", "grid", "iso", "grain2", "topo", "silk",
                "burst", "spot", "synth", "dunes", "mountains", "sky")
M32 = 0xFFFFFFFF
TAU = math.pi * 2
CHUNK = 128


def _u32(v) -> np.ndarray:
    return (np.asarray(v).astype(np.int64) & M32).astype(np.uint32)


def hash3(ix, iy, s: int) -> np.ndarray:
    """Same as backdropField.ts hash3(): uint32 arithmetic, float in [0, 1)."""
    with np.errstate(over="ignore"):
        h = (_u32(ix) * np.uint32(0x27D4EB2D)) ^ (_u32(iy) * np.uint32(0x165667B1)) ^ np.uint32((int(s) * 0x9E3779B1) & M32)
        h = (h ^ (h >> np.uint32(15))) * np.uint32(0x85EBCA6B)
        h = (h ^ (h >> np.uint32(13))) * np.uint32(0xC2B2AE35)
        h = h ^ (h >> np.uint32(16))
    return h.astype(np.float64) / 4294967296


def vnoise(x, y, s: int) -> np.ndarray:
    x = np.asarray(x, np.float64)
    y = np.asarray(y, np.float64)
    fxl = np.floor(x)
    fyl = np.floor(y)
    ix = fxl.astype(np.int64)
    iy = fyl.astype(np.int64)
    fx = x - fxl
    fy = y - fyl
    ux = fx * fx * (3 - 2 * fx)
    uy = fy * fy * (3 - 2 * fy)
    a = hash3(ix, iy, s)
    b = hash3(ix + 1, iy, s)
    c = hash3(ix, iy + 1, s)
    d = hash3(ix + 1, iy + 1, s)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy


def fbm(x, y, s: int, octaves: int) -> np.ndarray:
    total = 0.0
    amp = 0.5
    norm = 0.0
    for i in range(octaves):
        total = total + amp * vnoise(x, y, s + i * 101)
        norm += amp
        x = x * 2.03 + 1.7
        y = y * 2.03 + 9.2
        amp *= 0.5
    return total / norm


def ridged(x, y, s: int, octaves: int) -> np.ndarray:
    total = 0.0
    amp = 0.5
    norm = 0.0
    for i in range(octaves):
        n = 1 - np.abs(2 * vnoise(x, y, s + i * 101) - 1)
        total = total + amp * n * n
        norm += amp
        x = x * 2.03 + 1.7
        y = y * 2.03 + 9.2
        amp *= 0.5
    return total / norm


def _rgb(h: str) -> np.ndarray:
    n = int(h.lstrip("#"), 16)
    return np.array([(n >> 16) & 255, (n >> 8) & 255, n & 255], np.float64)


def _c01(v):
    return np.clip(v, 0.0, 1.0)


def _fract(v):
    return v - np.floor(v)


def ramp(t, cs: list[np.ndarray]) -> np.ndarray:
    t = np.asarray(t, np.float64)
    if len(cs) == 1:
        return np.broadcast_to(cs[0], t.shape + (3,)).copy()
    P = np.stack(cs)
    t = _c01(t)
    f = t * (len(cs) - 1)
    i = np.minimum(np.floor(f), len(cs) - 2).astype(np.int64)
    k = (f - i)[..., None]
    return P[i] + (P[i + 1] - P[i]) * k


def ramp1(t: float, cs: list[np.ndarray]) -> np.ndarray:
    return ramp(np.array(t), cs)


def _lerp(a, b, t):
    t = np.asarray(t, np.float64)[..., None]
    return a + (b - a) * t


def _mix(o: np.ndarray, c, a) -> None:
    o += (c - o) * np.asarray(a, np.float64)[..., None]


def _build(art: dict, W: int, H: int):
    """(shade(X, Y, xi, yi) -> rgb, dither, cell): the style's shader over a chunk of rows."""
    S = max(W, H)
    A = W / S
    B = H / S
    r = mulberry32(int(art["seed"]))
    sd = int(art["seed"])
    C = [_rgb(c) for c in art["colors"]]
    n = len(C)
    v = int(art.get("variant") or 0)
    px = 1 / S
    lineW = max(1.0, S / 1080)
    style = art["style"]

    if style == "mesh":
        pts = []
        for _ in range(n):
            x = r() * A
            pts.append((x, r() * B))

        def shade(X, Y, xi, yi):
            wx = X + 0.18 * (fbm(X * 2.2, Y * 2.2, sd, 3) - 0.5)
            wy = Y + 0.18 * (fbm(X * 2.2 + 17.3, Y * 2.2 + 5.1, sd + 500, 3) - 0.5)
            sw = 0.0
            acc = 0.0
            for k in range(n):
                dx = wx - pts[k][0]
                dy = wy - pts[k][1]
                w = np.exp(-(dx * dx + dy * dy) / 0.045) + 1e-9
                sw = sw + w
                acc = acc + w[..., None] * C[k]
            return acc / sw[..., None]

        return shade, 1.5, 1

    if style == "aurora":
        cur = []
        for k in range(3):
            y0 = B * (0.28 + 0.14 * k + (r() - 0.5) * 0.08)
            amp = 0.05 + r() * 0.07
            fr = (0.6 + r() * 0.8) * TAU
            ph = r() * TAU
            cur.append((y0, amp, fr, ph, C[2 + (k % (n - 2))]))
        sr = max(0.0008, 0.6 * px)
        Xc = (np.arange(W) + 0.5) / S
        yc = []
        sh = []
        for k in range(3):
            y0, amp, fr, ph, _ = cur[k]
            yc.append(y0 + amp * np.sin(Xc * fr + ph) + 0.18 * (fbm(Xc * 1.6, np.full(W, k * 7.7), sd + k * 31, 3) - 0.5))
            s = 0.45 + 0.55 * fbm(Xc * 24 + k * 5.3, np.full(W, k * 1.9), sd + k * 31 + 7, 2)
            h = 0.55 + 0.45 * fbm(Xc * 2.4, np.full(W, k * 3.7 + 1), sd + k * 31 + 13, 2)
            sh.append(s * h * 0.85)

        def shade(X, Y, xi, yi):
            o = _lerp(C[0], C[1], _c01(Y / B))
            cx = np.floor(X / 0.004)
            cy = np.floor(Y / 0.004)
            lit = hash3(cx, cy, sd + 99) > 0.994
            sx = (cx + 0.2 + 0.6 * hash3(cx, cy, sd + 98)) * 0.004
            sy = (cy + 0.2 + 0.6 * hash3(cx, cy, sd + 97)) * 0.004
            d2 = (X - sx) * (X - sx) + (Y - sy) * (Y - sy)
            _mix(o, np.array([255.0, 255.0, 255.0]), np.where(lit, 0.8 * np.exp(-d2 / (sr * sr)) * _c01(1 - Y / B), 0.0))
            for k in range(3):
                dy = Y - yc[k][xi]
                I = np.where(dy > 0, np.exp(-(dy * dy) / 0.0009), np.exp(np.minimum(dy, 0) / 0.16))
                _mix(o, cur[k][4], _c01(I * sh[k][xi]))
            return o

        return shade, 1.5, 1

    if style == "blur":
        blobs = []
        for i in range(6):
            x = r() * A
            y = r() * B
            rad = 0.16 + r() * 0.26
            blobs.append((x, y, rad, C[2 + (i % (n - 2))]))

        def shade(X, Y, xi, yi):
            o = _lerp(C[0], C[1], _c01((X / A + Y / B) / 2))
            for bx, by, rad, col in blobs:
                d2 = (X - bx) * (X - bx) + (Y - by) * (Y - by)
                _mix(o, col, 0.9 * np.exp(-d2 / (rad * rad)))
            return o

        return shade, 4.0, 1

    if style == "bokeh":
        gx = r() * A
        gy = r() * B
        circ = []
        for i in range(28):
            x = r() * A
            y = r() * B
            rad = 0.015 + r() * r() * 0.08
            al = 0.18 + r() * 0.4
            circ.append((x, y, rad, C[2 + (i % (n - 2))], al))

        def shade(X, Y, xi, yi):
            o = _lerp(C[0], C[1], _c01((X / A) * 0.3 + (Y / B) * 0.7))
            g2 = (X - gx) * (X - gx) + (Y - gy) * (Y - gy)
            _mix(o, C[2], 0.5 * np.exp(-g2 / 0.25))
            for cx, cy, rad, col, al in circ:
                d = np.sqrt((X - cx) * (X - cx) + (Y - cy) * (Y - cy))
                edge = max(0.08 * rad, px)
                cov = _c01((rad - d) / edge + 0.5)
                rf = _c01(d / rad)
                _mix(o, col, al * cov * (0.75 + 0.25 * rf * rf))
            return o

        return shade, 1.5, 1

    if style == "lowpoly":
        cell = 0.11 * (0.8 + r() * 0.4)

        def vy(i, j):
            return j * cell + (hash3(i, j, sd) - 0.5) * 0.6 * cell

        def shade(X, Y, xi, yi):
            fi = np.floor(X / cell)
            i = fi.astype(np.int64)
            fx = X / cell - fi

            def line(j):
                a = vy(i, j)
                return a + (vy(i + 1, j) - a) * fx

            j0 = np.floor(Y / cell).astype(np.int64)
            j = np.where(Y < line(j0), j0 - 1, np.where(Y >= line(j0 + 1), j0 + 1, j0))
            ax = i * cell
            ay = vy(i, j)
            bx = (i + 1) * cell
            by = vy(i + 1, j)
            cx = bx
            cy = vy(i + 1, j + 1)
            dx = ax
            dy = vy(i, j + 1)
            dg = hash3(i, j, sd + 1) < 0.5
            side1 = (cx - ax) * (Y - ay) - (cy - ay) * (X - ax)
            side2 = (dx - bx) * (Y - by) - (dy - by) * (X - bx)
            t1a = side1 < 0
            t2a = side2 > 0
            tri = np.where(dg, np.where(t1a, 0, 1), np.where(t2a, 0, 1))
            gx = np.where(dg, np.where(t1a, (ax + bx + cx) / 3, (ax + cx + dx) / 3), np.where(t2a, (ax + bx + dx) / 3, (bx + cx + dx) / 3))
            gy = np.where(dg, np.where(t1a, (ay + by + cy) / 3, (ay + cy + dy) / 3), np.where(t2a, (ay + by + dy) / 3, (by + cy + dy) / 3))
            o = ramp(0.55 * (gx / A) + 0.45 * (gy / B) + (hash3(i * 2 + tri, j, sd + 2) - 0.5) * 0.12, C)
            return o * (0.9 + 0.2 * hash3(i * 2 + tri, j, sd + 3))[..., None]

        return shade, 0.0, 1

    if style == "grid":
        gx = r() * A
        gy = r() * B
        g = 0.032
        M = max(A, B)

        def shade(X, Y, xi, yi):
            dc = np.sqrt((X - A / 2) * (X - A / 2) + (Y - B / 2) * (Y - B / 2))
            o = _lerp(C[1], C[0], _c01(dc / (0.75 * M)))
            g2 = (X - gx) * (X - gx) + (Y - gy) * (Y - gy)
            _mix(o, C[3 % n], 0.55 * np.exp(-g2 / 0.12))
            fx = np.abs(_fract(X / g + 0.5) - 0.5) * g
            fy = np.abs(_fract(Y / g + 0.5) - 0.5) * g
            fade = 1 - 0.6 * _c01(dc / (0.8 * M))
            if v == 0:
                d = np.sqrt(fx * fx + fy * fy)
                rad = 0.0021
                re = max(rad, 0.75 * px)
                cov = _c01((re - d) / px + 0.5) * (rad / re) * (rad / re)
            else:
                d = np.minimum(fx, fy)
                w = 0.0011
                we = max(w, px)
                cov = _c01((we / 2 - d) / px + 0.5) * (w / we)
            if v == 2:
                _mix(o, C[2], 0.25 * np.exp(-(d / 0.004) * (d / 0.004)) * fade)
            _mix(o, C[2], cov * fade * (0.9 if v == 2 else 0.45))
            return o

        return shade, 1.0, 1

    if style == "iso":
        R = 0.06 * (1.5 if v == 1 else 1)
        s3 = math.sqrt(3)
        faces = C[1:]

        def shade(X, Y, xi, yi):
            q = ((s3 / 3) * X - Y / 3) / R
            rr = ((2 / 3) * Y) / R
            cy0 = -q - rr
            rx = np.floor(q + 0.5)
            ry = np.floor(cy0 + 0.5)
            rz = np.floor(rr + 0.5)
            ex = np.abs(rx - q)
            ey = np.abs(ry - cy0)
            ez = np.abs(rz - rr)
            c1 = (ex > ey) & (ex > ez)
            c2 = ~c1 & (ey > ez)
            c3 = ~c1 & ~c2
            rx2 = np.where(c1, -ry - rz, rx)
            ry2 = np.where(c2, -rx - rz, ry)
            rz2 = np.where(c3, -rx - ry, rz)
            rx, ry, rz = rx2, ry2, rz2
            hx = R * s3 * (rx + rz / 2)
            hy = R * 1.5 * rz
            th = np.arctan2(Y - hy, X - hx)
            top = (th > (-5 * math.pi) / 6) & (th < -math.pi / 6)
            right = (th >= -math.pi / 6) & (th < math.pi / 2)
            sh = np.where(top, 1.12, np.where(right, 0.6, 0.82))
            o = ramp(hash3(rx, rz, sd), faces)
            return o * (sh * (0.85 + 0.3 * (1 - Y / B)))[..., None]

        return shade, 0.0, 1

    if style == "grain2":
        ang = r() * TAU
        dx = math.cos(ang)
        dy = math.sin(ang)
        span = abs((A / 2) * dx) + abs((B / 2) * dy)

        def shade(X, Y, xi, yi):
            proj = (X - A / 2) * dx + (Y - B / 2) * dy
            return ramp((proj / span + 1) / 2 + 0.18 * (fbm(X * 1.8, Y * 1.8, sd, 3) - 0.5), C)

        return shade, 18.0, max(1, math.floor(S / 1600 + 0.5))

    if style == "topo":
        N = 12
        F = np.empty((H + 1, W + 1), np.float64)
        Xg = (np.arange(W + 1) + 0.5) / S
        for y0 in range(0, H + 1, CHUNK):
            ys = (np.arange(y0, min(H + 1, y0 + CHUNK)) + 0.5) / S
            Yg, XX = np.meshgrid(ys, Xg, indexing="ij")
            F[y0:y0 + len(ys)] = fbm(XX * 2, Yg * 2, sd, 4) + 0.25 * (Yg / B)

        def shade(X, Y, xi, yi):
            yy, xx = np.meshgrid(yi, xi, indexing="ij")
            f0 = F[yy, xx]
            v0 = f0 * N
            gx = F[yy, xx + 1] * N - v0
            gy = F[yy + 1, xx] * N - v0
            g = np.maximum(np.sqrt(gx * gx + gy * gy), 1e-4)
            lvl = np.floor(v0 + 0.5)
            dpx = np.abs(v0 - lvl) / g
            major = np.mod(lvl, 5) == 0
            lw = lineW * np.where(major, 1.8, 1.1)
            cov = _c01(lw / 2 - dpx + 0.5)
            o = _lerp(C[0], C[1], _c01(f0 * 1.4 - 0.2))
            col = np.where(major[..., None], C[3 % n], C[2])
            _mix(o, col, cov * np.where(major, 0.7, 0.55))
            return o

        return shade, 1.0, 1

    if style == "silk":
        K = 30
        f1 = TAU * (0.5 + r() * 0.6)
        ph1 = r() * TAU
        f2 = TAU * (0.3 + r() * 0.5)
        ph2 = r() * TAU
        tilt = (r() - 0.5) * 0.3
        mid = B * (0.45 + (r() - 0.5) * 0.1)

        def yk(X, k):
            return mid + tilt * (X - A / 2) + (k / (K - 1) - 0.5) * B * (0.55 + 0.35 * np.sin(X * f1 + ph1)) + B * 0.12 * np.sin(X * f2 + ph2 + k * 0.06)

        Xc = (np.arange(W) + 0.5) / S
        e = 1e-4
        ys = [yk(Xc, k) for k in range(K)]
        cs = []
        for k in range(K):
            sl = (yk(Xc + e, k) - yk(Xc - e, k)) / (2 * e)
            cs.append(1 / np.sqrt(1 + sl * sl))
        lc = C[2:]
        cols = [ramp1(k / (K - 1), lc) for k in range(K)]
        lw = lineW * 1.1
        gw = lineW * 10

        def shade(X, Y, xi, yi):
            o = _lerp(C[0], C[1], _c01(Y / B))
            for k in range(K):
                d = np.abs(Y - ys[k][xi]) * cs[k][xi] * S
                if v == 1:
                    _mix(o, cols[k], np.where(d < 4 * gw, 0.18 * np.exp(-(d / gw) * (d / gw)), 0.0))
                _mix(o, cols[k], _c01(lw / 2 - d + 0.5) * 0.8)
            return o

        return shade, 1.0, 1

    if style == "burst":
        cx = A * (0.2 + 0.6 * r())
        u = r()
        cy = B * (u * 0.5 - 0.15) if v == 0 else B * (0.3 + 0.4 * u)
        N = 14 + 2 * math.floor(r() * 6)
        ph = r() * TAU
        M = max(A, B)
        loop = C + [C[0]]
        avg = sum(C) / n

        def shade(X, Y, xi, yi):
            dx = X - cx
            dy = Y - cy
            d = np.sqrt(dx * dx + dy * dy)
            th = np.arctan2(dy, dx)
            if v == 0:
                s = np.sin(th * N + 0.5 * np.sin(th * 3 + ph))
                cov = _c01(0.5 + (s * d * S) / (N * 1.2))
                o = _lerp(C[0], C[1], _c01(d / (1.2 * M)))
                _mix(o, C[2], cov * 0.35)
                _mix(o, C[3 % n], 0.85 * np.exp(-(d * d) / 0.06))
                return o
            o = ramp(_fract(th / TAU + 0.5 + d * 0.6 + 0.08 * (fbm(X * 2, Y * 2, sd, 3) - 0.5)), loop)
            _mix(o, avg, np.exp(-(d * d) / 0.002))
            return o * (1 - 0.3 * _c01(d / M) * _c01(d / M))[..., None]

        return shade, 1.5, 1

    if style == "spot":
        u1 = r()
        u2 = r()
        M = max(A, B)
        sx = A * (0.3 + 0.4 * u1)
        sy = B * (0.2 + 0.3 * u2)
        y0 = B * (0.55 + 0.15 * u2)
        ang = math.pi / 4 + (u1 - 0.5) * 0.4
        ca = math.cos(ang)
        sa = math.sin(ang)

        def shade(X, Y, xi, yi):
            if v == 0:
                o = np.broadcast_to(C[0], X.shape + (3,)).copy()
                _mix(o, C[1], 0.9 * np.exp(-((X - sx) * (X - sx) + (Y - sy) * (Y - sy) * 1.6) / 0.12))
                ex = A - sx * 0.6
                ey = B * 0.9
                _mix(o, C[2 % n], 0.35 * np.exp(-((X - ex) * (X - ex) + (Y - ey) * (Y - ey)) / 0.05))
            elif v == 1:
                o = _lerp(C[0], C[1], _c01(Y / B))
                t1 = (Y - y0) / 0.0025
                t2 = (Y - y0) / 0.05
                hx = (X - A / 2) / (0.45 * A)
                _mix(o, C[2 % n], _c01((np.exp(-t1 * t1) + 0.35 * np.exp(-t2 * t2)) * np.exp(-hx * hx)))
            else:
                o = np.broadcast_to(C[0] + (C[1] - C[0]) * 0.15, X.shape + (3,)).copy()
                along = ca * X + sa * Y
                perp = np.abs(-sa * X + ca * Y)
                w = 0.08 + 0.25 * along
                _mix(o, C[2 % n], _c01(np.exp(-(perp / w) * (perp / w)) * np.exp(-along / 1.1) * 0.7))
            dc = _c01(np.sqrt((X - A / 2) * (X - A / 2) + (Y - B / 2) * (Y - B / 2)) / (0.8 * M))
            return o * (1 - 0.35 * dc * dc)[..., None]

        return shade, 2.0, 1

    if style == "synth":
        h = B * 0.62
        scx = A / 2 + (r() - 0.5) * 0.3 * A
        R = 0.3 * B
        sy = h - R * 0.55
        per = 0.14 * R
        floorC = C[0] * 0.55
        lw = lineW * 1.5

        def shade(X, Y, xi, yi):
            sky = Y < h
            # sky
            t = _c01(Y / h)
            o = _lerp(C[0], C[1], np.power(t, 1.5))
            d = np.sqrt((X - scx) * (X - scx) + (Y - sy) * (Y - sy))
            if v == 0:
                _mix(o, C[2], 0.35 * np.exp(-np.maximum(0, d - R) / 0.08))
                cov = _c01((R - d) * S + 0.5)
                uu = (Y - sy) / R
                gpos = _fract((Y - sy) / per)
                gw = uu * 0.55
                gap = np.where((Y > sy) & (gpos < gw), _c01(np.minimum(gpos, gw - gpos) * per * S + 0.5), 0.0)
                sun = _lerp(C[3 % n], C[2], _c01((Y - (sy - R)) / (2 * R)))
                _mix(o, sun, cov * (1 - gap))
            else:
                _mix(o, C[2], 0.3 * np.exp(-(d * d) / 0.05))
            # floor
            dz = np.where(sky, 1.0, Y - h)
            depth = 0.6 / np.maximum(dz, 1e-6)
            dvpx = 0.6 / (dz * dz) / S
            dl = np.abs(_fract(depth + 0.5) - 0.5)
            ch = _c01(lw / 2 - dl / dvpx + 0.5) * _c01(1 / (dvpx * 10))
            xw = ((X - A / 2) / dz) * 1.2
            dxpx = 1.2 / dz / S
            dl2 = np.abs(_fract(xw + 0.5) - 0.5)
            cv = _c01(lw / 2 - dl2 / dxpx + 0.5) * _c01(1 / (dxpx * 10))
            fl = np.broadcast_to(floorC, X.shape + (3,)).copy()
            hf = _c01(dz / 0.08)
            _mix(fl, C[2], np.maximum(ch, cv) * 0.9 * hf * hf)
            o = np.where(sky[..., None], o, fl)
            hg = (Y - h) / 0.01
            _mix(o, C[2], 0.6 * np.exp(-hg * hg))
            return o

        return shade, 1.0, 1

    if style in ("dunes", "mountains"):
        L = 5
        mtn = style == "mountains"
        lp = []
        for _ in range(L):
            ph = r() * TAU
            f = TAU * (0.4 + r() * 0.5)
            off = r() * 100
            lp.append((ph, f, off))
        sunx = A * (0.2 + 0.6 * r())
        suny = B * (0.15 + 0.2 * r())

        def ridge(X, l):
            ph, f, off = lp[l]
            if not mtn:
                return B * (0.42 + 0.11 * l) + 0.045 * np.sin(X * f + ph) + 0.05 * (fbm(X * 1.3 + off, np.full(X.shape, l * 3.3), sd + l * 17, 3) - 0.5)
            return B * (0.36 + 0.13 * l) - B * (0.3 - 0.04 * l) * ridged(X * (1.4 + 0.6 * l) + off, np.full(X.shape, l * 5.1), sd + l * 17, 4)

        Xc = (np.arange(W) + 0.5) / S
        e = 1e-4
        rs = [ridge(Xc, l) for l in range(L)]
        sl = [(ridge(Xc + e, l) - ridge(Xc - e, l)) / (2 * e) for l in range(L)]
        lc = [ramp1((l + 1) / L, C[1:]) for l in range(L)]

        def shade(X, Y, xi, yi):
            o = _lerp(C[0], C[1], _c01(Y / (B * 0.6)))
            d2 = (X - sunx) * (X - sunx) + (Y - suny) * (Y - suny)
            _mix(o, np.array([255.0, 245.0, 230.0]), 0.35 * np.exp(-d2 / 0.02))
            for l in range(L):
                ry = rs[l][xi]
                cov = _c01((Y - ry) * S + 0.5)
                if mtn:
                    sh = 1 - 0.15 * _c01((Y - ry) / 0.2)
                else:
                    sh = (1 - 0.22 * _c01((Y - ry) / 0.12)) * (1 + 0.12 * np.tanh(-sl[l][xi] * 4))
                _mix(o, lc[l] * sh[..., None], cov)
            return o

        return shade, 1.5, 1

    if style == "sky":
        sx = A * (0.2 + 0.6 * r())
        sy = B * (0.25 + 0.3 * r())
        wind = r() * 10

        def shade(X, Y, xi, yi):
            o = _lerp(C[0], C[1], np.power(_c01(Y / B), 0.8))
            d2 = (X - sx) * (X - sx) + (Y - sy) * (Y - sy)
            _mix(o, C[2], _c01(0.85 * np.exp(-d2 / 0.004) + 0.4 * np.exp(-d2 / 0.06)))
            nz = fbm(X * 2.4 + wind, Y * 5.5, sd, 5)
            bt = (Y / B - 0.55) / 0.35
            band = np.exp(-bt * bt)
            t = _c01((nz - 0.48) / 0.24)
            c = t * t * (3 - 2 * t) * band
            n2 = fbm(X * 2.4 + wind, (Y + 0.012) * 5.5, sd, 5)
            lit = _c01(0.75 + (nz - n2) * 4)
            _mix(o, C[3 % n] * lit[..., None], c * 0.9)
            return o

        return shade, 1.5, 1

    raise ValueError(f"not a field backdrop style: {style}")


def draw_backdrop_field(art: dict, W: int, H: int) -> np.ndarray:
    """The field backdrop at W x H as BGR float32 (0..255), same bytes as renderBackdropField()."""
    W = max(1, int(round(W)))
    H = max(1, int(round(H)))
    shade, D, cell = _build(art, W, H)
    S = max(W, H)
    seed = int(art["seed"])
    out = np.empty((H, W, 3), np.float32)
    xi = np.arange(W)
    for y0 in range(0, H, CHUNK):
        yi = np.arange(y0, min(H, y0 + CHUNK))
        Y, X = np.meshgrid((yi + 0.5) / S, (xi + 0.5) / S, indexing="ij")
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            o = shade(X, Y, xi, yi)
        if D > 0:
            gy, gx = np.meshgrid(yi // cell, xi // cell, indexing="ij")
            nz = (hash3(gx, gy, seed + 7919) - 0.5) * D
            o = o + nz[..., None]
        rgb = np.clip(np.floor(o + 0.5), 0, 255)
        out[y0:y0 + len(yi)] = rgb[..., ::-1]
    return out
