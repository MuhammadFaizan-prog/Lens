"""Synthetic cursorless screen recording + input-event log, for self-tests of the whole pipeline.

Draws a deterministic, feature-rich fake app UI (sidebar, cards, a text field and buttons) whose
state follows the event log: buttons flash on click, typed characters appear in the field. No
cursor is drawn, exactly like a real Lens capture (A13). Optional white sync flash at t=0.
"""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

import cv2
import numpy as np


def ease_in_out(u: float) -> float:
    return 2 * u * u if u < 0.5 else 1 - (-2 * u + 2) ** 2 / 2


def demo_events(w: int, h: int) -> list[dict]:
    """Mirror of packages/engine/test/fixtures.ts demoSession, scaled to w x h."""
    sx, sy = w / 1920, h / 1080
    ev: list[dict] = []

    def move(a, b, t0, dur, jitter=0.0):
        n = max(1, round(dur / 8))
        rng = np.random.default_rng(int(t0) + 7)
        for i in range(n + 1):
            u = i / n
            e = ease_in_out(u)
            ev.append({"t": t0 + u * dur, "type": "move",
                       "x": (a[0] + (b[0] - a[0]) * e) * sx + rng.uniform(-jitter, jitter),
                       "y": (a[1] + (b[1] - a[1]) * e) * sy + rng.uniform(-jitter, jitter)})

    def click(x, y, t):
        ev.append({"t": t, "type": "down", "x": x * sx, "y": y * sy, "button": "left"})
        ev.append({"t": t + 90, "type": "up", "x": x * sx, "y": y * sy, "button": "left"})

    move((960, 540), (400, 300), 0, 600, 1.5)
    click(400, 300, 900)
    move((400, 300), (420, 360), 1200, 300)
    click(420, 360, 1600)
    for i, ch in enumerate("hello lens world"):
        ev.append({"t": 1800 + i * 120, "type": "key", "key": ch, "modifiers": []})
    ev.append({"t": 4200, "type": "key", "key": "s", "modifiers": ["cmd"]})
    move((420, 360), (1600, 900), 5000, 700, 1.5)
    click(1600, 900, 6000)
    ev.sort(key=lambda e: e["t"])
    return ev


def _base_ui(w: int, h: int) -> np.ndarray:
    rng = np.random.default_rng(42)
    img = np.full((h, w, 3), 246, np.uint8)
    # Sidebar with icon rows.
    sbw = int(w * 0.16)
    img[:, :sbw] = (40, 34, 30)
    for i in range(14):
        y = int(h * 0.08 + i * h * 0.06)
        cv2.circle(img, (int(sbw * 0.18), y), max(3, int(h * 0.012)), tuple(int(c) for c in rng.integers(80, 255, 3)), -1, cv2.LINE_AA)
        cv2.rectangle(img, (int(sbw * 0.3), y - 4), (int(sbw * (0.5 + rng.uniform(0, 0.4))), y + 4), (150, 140, 130), -1)
    # Top bar.
    img[: int(h * 0.07), sbw:] = (255, 255, 255)
    cv2.line(img, (sbw, int(h * 0.07)), (w, int(h * 0.07)), (220, 220, 220), 1)
    # Grid of textured cards: lots of corners for feature matching.
    font = cv2.FONT_HERSHEY_SIMPLEX
    cols, rows = 4, 3
    gx0, gy0 = sbw + int(w * 0.03), int(h * 0.42)
    cw = (w - gx0 - int(w * 0.03)) // cols
    ch = (h - gy0 - int(h * 0.04)) // rows
    for r in range(rows):
        for c in range(cols):
            x, y = gx0 + c * cw, gy0 + r * ch
            cv2.rectangle(img, (x + 6, y + 6), (x + cw - 6, y + ch - 6), (255, 255, 255), -1)
            cv2.rectangle(img, (x + 6, y + 6), (x + cw - 6, y + ch - 6), (225, 225, 225), 1)
            color = tuple(int(v) for v in rng.integers(40, 230, 3))
            cv2.rectangle(img, (x + 16, y + 16), (x + 16 + cw // 3, y + 16 + ch // 3), color, -1)
            for k in range(4):
                ox = int(rng.uniform(20, cw - 40))
                oy = int(rng.uniform(ch * 0.5, ch - 20))
                cv2.circle(img, (x + ox, y + oy), int(rng.uniform(3, 9)), tuple(int(v) for v in rng.integers(30, 220, 3)), -1, cv2.LINE_AA)
            cv2.putText(img, f"Card {r * cols + c + 1}", (x + cw // 3 + 30, y + 40), font, max(0.4, h / 1800), (60, 60, 60), 1, cv2.LINE_AA)
    return img


def render_ui_frame(base: np.ndarray, t: float, events: list[dict], w: int, h: int) -> np.ndarray:
    img = base.copy()
    font = cv2.FONT_HERSHEY_SIMPLEX
    sx, sy = w / 1920, h / 1080
    # Buttons at the click targets; they flash for 250 ms after a click.
    buttons = [((400, 300), "Open"), ((1600, 900), "Save")]
    for (bx, by), label in buttons:
        x, y = int(bx * sx), int(by * sy)
        flashed = any(e["type"] == "down" and abs(e["x"] - x) < 30 and abs(e["y"] - y) < 30 and 0 <= t - e["t"] < 250 for e in events)
        col = (240, 160, 60) if flashed else (220, 110, 40)
        cv2.rectangle(img, (x - int(70 * sx), y - int(24 * sy)), (x + int(70 * sx), y + int(24 * sy)), col, -1)
        cv2.putText(img, label, (x - int(30 * sx), y + int(8 * sy)), font, max(0.4, h / 1500), (255, 255, 255), 1, cv2.LINE_AA)
    # Text field with typed characters.
    fx, fy = int(330 * sx), int(340 * sy)
    cv2.rectangle(img, (fx, fy), (fx + int(600 * sx), fy + int(44 * sy)), (255, 255, 255), -1)
    cv2.rectangle(img, (fx, fy), (fx + int(600 * sx), fy + int(44 * sy)), (180, 180, 180), 1)
    typed = "".join(e["key"] for e in events if e["type"] == "key" and not e["modifiers"] and e["t"] <= t)
    cv2.putText(img, typed, (fx + 10, fy + int(30 * sy)), font, max(0.45, h / 1400), (30, 30, 30), 1, cv2.LINE_AA)
    return img


def synthesize(out_dir: str | Path, w: int = 1280, h: int = 720, fps: int = 30, duration_ms: int = 8000, sync_flash: bool = False) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    events = demo_events(w, h)
    base = _base_ui(w, h)
    screen = out / "screen.mp4"
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", str(screen)],
        stdin=subprocess.PIPE,
    )
    assert enc.stdin
    n = math.ceil(duration_ms / 1000 * fps)
    for i in range(n):
        t = i * 1000 / fps
        frame = np.full((h, w, 3), 255, np.uint8) if sync_flash and i < 2 else render_ui_frame(base, t, events, w, h)
        enc.stdin.write(frame.tobytes())
    enc.stdin.close()
    enc.wait()
    meta = {"width": w, "height": h, "fps": fps, "durationMs": duration_ms, "pixelRatio": 1}
    (out / "meta.json").write_text(json.dumps(meta))
    (out / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    cv2.imwrite(str(out / "reference.png"), render_ui_frame(base, 0, [], w, h))
    return {"screen": str(screen), "meta": str(out / "meta.json"), "events": str(out / "events.jsonl"), "reference": str(out / "reference.png")}
