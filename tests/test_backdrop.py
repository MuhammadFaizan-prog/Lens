"""Backdrops in the Python compositor (Windows bug #20): Hidden, freely placed gradient stops, cover /
contain images and Lens's own procedural art (style.backdropArt), matching the editor's renderer."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compositor"))

from lens_compositor.backdrop_art import draw_backdrop_art, mulberry32  # noqa: E402
from lens_compositor.render import gradient_stops, hex_to_bgr, make_background  # noqa: E402

EMBER = {"id": "ember", "name": "Ember", "colors": ["#140d0b", "#7a1f0f", "#e2711d", "#ffc971"], "style": "rays", "seed": 41}


def style(**bg) -> dict:
    return {"background": {"kind": "solid", "colors": ["#202020"], "angle": 135, "blur": 0, **bg}}


def test_hidden_is_black():
    out = make_background(style(kind="hidden"), 64, 36)
    assert out.shape == (36, 64, 3) and float(np.abs(out).max()) < 1e-6


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_rng_matches_the_editor():
    js = """let a=41>>>0;const r=()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296};
    console.log(JSON.stringify(Array.from({length:50},r)))"""
    ref = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    r = mulberry32(41)
    assert [r() for _ in range(50)] == ref


def test_gradient_stops_free():
    assert gradient_stops(["a", "b"], None) == [(0.0, "a"), (1.0, "b")]
    assert gradient_stops(["a", "b"], [0.7, 0.2]) == [(0.2, "b"), (0.7, "a")]
    assert gradient_stops(["a", "b"], [0.5]) == [(0.0, "a"), (1.0, "b")]  # wrong length: even
    W, H = 200, 20
    # angle 90: left -> right; stops [0, 0.3]: everything past 30 % is the end colour
    out = make_background(style(kind="gradient", colors=["#000000", "#ffffff"], angle=90, stops=[0, 0.3]), W, H)
    assert abs(out[10, 100].mean() - 255) <= 1
    assert abs(out[10, int(W * 0.15)].mean() - 127) <= 6
    even = make_background(style(kind="gradient", colors=["#000000", "#ffffff"], angle=90), W, H)
    assert abs(even[10, 100].mean() - 128) <= 3


def test_image_cover_and_contain(tmp_path: Path):
    p = tmp_path / "m.png"
    cv2.imwrite(str(p), np.full((100, 100, 3), (255, 0, 255), np.uint8))
    cover = make_background(style(kind="image", imagePath=str(p), colors=["#00ff00"]), 160, 90)
    assert np.abs(cover[2, 2] - np.array([255, 0, 255])).max() <= 2
    contain = make_background(style(kind="image", imagePath=str(p), colors=["#00ff00"], fit="contain"), 160, 90)
    assert np.abs(contain[45, 2] - np.array(hex_to_bgr("#00ff00"))).max() <= 2  # side shows colors[0]
    assert np.abs(contain[45, 80] - np.array([255, 0, 255])).max() <= 2


def test_builtin_art_is_drawn_and_deterministic():
    a = make_background({**style(kind="image", imagePath="builtin:ember"), "backdropArt": EMBER}, 320, 180)
    b = draw_backdrop_art(EMBER, 320, 180)
    assert np.abs(a - b).max() <= 1.0  # only the debanding dither differs
    assert a.std() > 8  # not a flat fill
    # differs from the art's first colour alone (the old fallback)
    assert np.abs(a.mean(axis=(0, 1)) - np.array(hex_to_bgr("#140d0b"))).max() > 10
    blurred = make_background({**style(kind="image", imagePath="builtin:ember", blur=8), "backdropArt": EMBER}, 320, 180)
    assert blurred.shape == (180, 320, 3)


def _render(tmp_path: Path, project: dict, name: str):
    sys.path.insert(0, str(ROOT / "research" / "harness"))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from lens_compositor import RenderOptions, render
    from lensharness.synth import synthesize
    from media import CLI, make_plan

    if shutil.which("node") is None or not CLI.exists():
        pytest.fail("engine not built (npm run build)")
    if not (tmp_path / "screen.mp4").exists():
        synthesize(tmp_path, 640, 360, 30, 1000)
    plan = make_plan(tmp_path, str(tmp_path / "meta.json"), str(tmp_path / "events.jsonl"), project, name=name)
    frames: list[np.ndarray] = []
    render(str(tmp_path / f"{name}.json"), str(tmp_path / "screen.mp4"), str(tmp_path / f"{name}.mp4"),
           opts=RenderOptions(preset="ultrafast", max_frames=6, audio=False, frame_sink=lambda i, f: frames.append(np.array(f, np.float32))))
    return plan, frames


def test_compositor_fill_hidden_and_builtin(tmp_path: Path):
    """End to end through the engine plan: 9:16 Fill covers the frame (no backdrop rows), Hidden has no
    padding / corners / shadow, and built-in art reaches render.py as style.backdropArt."""
    plan, frames = _render(tmp_path, {"output": {"fps": 30, "resolution": 360, "aspect": "9:16", "fit": "fill"}, "background": {"kind": "solid", "colors": ["#ff00ff"], "inherit": False}}, "fill")
    W, H = plan["output"]["width"], plan["output"]["height"]
    assert H > W
    for f in plan["frames"][:6]:
        x, y, w, h = f["layout"]["screen"]
        assert y <= 0.5 and y + h >= H - 0.5 and x <= 0.5 and x + w >= W - 0.5
    magenta = np.array([255, 0, 255], np.float32)
    for fr in frames:
        for (yy, xx) in [(1, W // 2), (H - 2, W // 2), (H // 2, 1)]:
            assert np.abs(fr[yy, xx] - magenta).max() > 60  # recording, not the backdrop
    plan, frames = _render(tmp_path, {"output": {"fps": 30, "resolution": 360}, "background": {"kind": "hidden", "colors": ["#ff00ff"], "inherit": False}}, "hidden")
    assert plan["style"]["radius"] == 0 and plan["style"]["shadow"]["opacity"] == 0
    assert [round(v) for v in plan["frames"][0]["layout"]["screen"]] == [0, 0, plan["output"]["width"], plan["output"]["height"]]
    for fr in frames:
        assert np.abs(fr[1, 1] - magenta).max() > 60
    plan, frames = _render(tmp_path, {"output": {"fps": 30, "resolution": 360}, "background": {"kind": "image", "imagePath": "builtin:ember", "inherit": False}}, "art")
    assert plan["style"]["backdropArt"]["id"] == "ember"
    art = draw_backdrop_art(plan["style"]["backdropArt"], plan["output"]["width"], plan["output"]["height"])
    assert np.abs(frames[0][2, 2] - art[2, 2]).max() <= 2
