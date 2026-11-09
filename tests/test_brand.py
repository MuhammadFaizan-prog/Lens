"""Brand kit (demand #9), measured on rendered exports (MP4, decoded as a BT.709 player decodes it).

Bounds (written before the first measurement, docs/Tracker.md):
  watermark opacity   alpha recovered per pixel from the export with and without the watermark,
                      alpha = (with - without) / (logo - without) on luma, median over the logo's
                      interior: within ±0.03 of the brand's opacity (0.6 here)
  watermark position  the logo's edges in the export (where the luma change crosses half of its
                      full value) within ±2 px of the plan's rect, which the test also checks against
                      the corner + safe-margin geometry computed here independently
  colour propagation  the same project rendered with two brand primaries: a frame-anchored box that
                      only references @primary, the highlighted caption word, the derived backdrop,
                      measured by pixel colour: box stroke and caption highlight each channel within
                      ±10 levels of the brand primary, backdrop corners within ±4 levels of the
                      derived gradient's end colours (computed here, not read from the plan)
  intro card          exactly durationMs * fps / 1000 frames of the brand intro, painted with the
                      brand backdrop (corner patch within ±4 levels)
"""
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
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lens_compositor import RenderOptions, render  # noqa: E402
from media import CLI, make_plan, read_all_frames  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None or not CLI.exists(), reason="engine not built (npm run build)")

W, H, FPS = 1280, 720, 30
DUR = 2000
OPACITY = 0.6
OPACITY_TOL = 0.03
POS_TOL = 2.0
COLOUR_TOL = 10
BG_TOL = 4
PRIMARIES = ["#e8132a", "#1c7ed6"]
INTRO_MS = 1000
WORDS = [{"text": "Brand", "startMs": 100, "endMs": 900}, {"text": "colours", "startMs": 950, "endMs": 1500}, {"text": "follow", "startMs": 1550, "endMs": 1900}]


def hex_rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)


def mix(a: str, b: str, u: float) -> np.ndarray:
    """The derived backdrop's colours, written out here independently of the engine."""
    return np.round(hex_rgb(a) + (hex_rgb(b) - hex_rgb(a)) * u)


def _source(d: Path) -> dict:
    n = int(DUR * FPS / 1000)
    base = np.full((H, W, 3), 236, np.uint8)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", str(d / "screen.mp4")],
                   input=base.tobytes() * n, check=True)
    (d / "meta.json").write_text(json.dumps({"width": W, "height": H, "fps": FPS, "durationMs": DUR, "pixelRatio": 1}))
    ev = [{"t": 0, "type": "move", "x": 100, "y": 680}, {"t": DUR - 100, "type": "move", "x": 101, "y": 680}]
    (d / "events.jsonl").write_text("\n".join(json.dumps(e) for e in ev) + "\n")
    # logo: 200 x 100 white; left half opaque, right half alpha 128 (so the export must multiply the
    # logo's own alpha by the brand opacity: 0.6 and 0.6 * 128 / 255)
    logo = np.zeros((100, 200, 4), np.uint8)
    logo[..., :3] = 255
    logo[:, :100, 3] = 255
    logo[:, 100:, 3] = 128
    (d / "brand").mkdir(exist_ok=True)
    cv2.imwrite(str(d / "brand" / "logo.png"), logo)
    return {"screen": str(d / "screen.mp4"), "meta": str(d / "meta.json"), "events": str(d / "events.jsonl")}


def _project(primary: str, watermark: bool = True, intro: bool = False) -> dict:
    none = {"kind": "none", "ms": 0}
    return {
        "version": 1,
        "output": {"aspect": "16:9", "resolution": 720, "fps": FPS},
        "motionBlur": {"enabled": False},
        "cursor": {"visible": False},
        "zoom": {"auto": False},
        "audio": {"loudness": {"enabled": False}},
        "captions": {"enabled": True, "maxWordsPerBlock": 3, "style": {"fontSize": 96, "position": "custom", "y": 0.5, "maxWordsPerLine": 3}},
        "annotations": [
            {"id": "box", "kind": "rect", "anchor": "frame", "startMs": 0, "endMs": DUR, "rect": {"x": 0.3, "y": 0.2, "w": 0.4, "h": 0.12},
             "in": none, "out": none, "style": {"strokeWidth": 12, "fill": None, "radius": 0, "shadow": {"enabled": False}}},
        ],
        "brand": {
            "enabled": True,
            "colors": {"primary": primary, "accent": "#ffc94d", "background": {"mode": "derived", "colors": [], "angle": 135}},
            "captionHighlight": "primary",
            "font": "Inter",
            "logo": {"path": "brand/logo.png", "aspect": 2, "watermark": watermark, "corner": "bottom-right", "size": 0.1, "opacity": OPACITY, "margin": 0.035},
            "intro": {"enabled": intro, "title": "Acme", "subtitle": "", "durationMs": INTRO_MS, "logo": True},
        },
    }


def _export(d: Path, s: dict, name: str, project: dict) -> tuple[dict, np.ndarray]:
    plan = make_plan(d, s["meta"], s["events"], project, name=name, words=WORDS)
    out = d / f"{name}.mp4"
    render(str(d / f"{name}.json"), s["screen"], str(out), None, RenderOptions(preset="veryfast", audio=False, asset_dir=str(d)))
    return plan, read_all_frames(str(out))


@pytest.fixture(scope="module")
def runs(tmp_path_factory):
    d = tmp_path_factory.mktemp("brand")
    s = _source(d)
    res = {}
    for i, p in enumerate(PRIMARIES):
        res[p] = _export(d, s, f"brand{i}", _project(p))
    res["nowm"] = _export(d, s, "nowm", _project(PRIMARIES[0], watermark=False))
    res["intro"] = _export(d, s, "intro", _project(PRIMARIES[1], intro=True))
    return res


def luma(f: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float64)


def test_watermark_opacity_and_position(runs):
    plan, frames = runs[PRIMARIES[0]]
    _, bare = runs["nowm"]
    wm = plan["watermark"]
    # geometry, computed here: width 10% of 1280, aspect 2, margin 3.5% of the short side, bottom-right
    m = round(0.035 * 720)
    w = round(0.1 * W)
    h = round(w / 2)
    assert (wm["x"], wm["y"], wm["w"], wm["h"]) == (W - m - w, H - m - h, w, h)
    alphas, edges = [], []
    want_r = OPACITY * 128 / 255
    for i in (5, 30, 55):
        a, b = luma(frames[i]), luma(bare[i])
        full = 255.0 - b
        diff = a - b
        sel = full > 60
        # edges: where the change crosses half its full value
        half = (diff > 0.5 * want_r * full) & sel  # half of the smaller (right-half) step
        ys, xs = np.nonzero(half)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        edges.append((x0 - wm["x"], y0 - wm["y"], x1 - (wm["x"] + wm["w"]), y1 - (wm["y"] + wm["h"])))
        mid = wm["x"] + wm["w"] // 2
        left = np.zeros_like(sel)
        left[wm["y"] + 3:wm["y"] + wm["h"] - 3, wm["x"] + 3:mid - 3] = True
        right = np.zeros_like(sel)
        right[wm["y"] + 3:wm["y"] + wm["h"] - 3, mid + 3:wm["x"] + wm["w"] - 3] = True
        alphas.append((float(np.median(diff[left & sel] / full[left & sel])), float(np.median(diff[right & sel] / full[right & sel]))))
    worst_alpha = max(max(abs(a - OPACITY), abs(b - want_r)) for a, b in alphas)
    worst_edge = max(abs(e) for t in edges for e in t)
    print(f"watermark alpha (opaque half, alpha-128 half) {[('%.4f' % a, '%.4f' % b) for a, b in alphas]} (targets {OPACITY}, {want_r:.4f}), worst |error| {worst_alpha:.4f}; edge errors px {edges}, worst {worst_edge}")
    assert worst_alpha <= OPACITY_TOL
    assert worst_edge <= POS_TOL
    # no watermark when the logo's watermark switch is off
    assert runs["nowm"][0].get("watermark") is None


def _mode_colour(px: np.ndarray) -> np.ndarray:
    """The most common colour among px (BGR rows), averaged inside its 8-level bin."""
    q = (px // 8).astype(np.int32)
    keys = q[:, 0] * 1024 + q[:, 1] * 32 + q[:, 2]
    vals, counts = np.unique(keys, return_counts=True)
    k = vals[counts.argmax()]
    return px[keys == k].mean(0)


def test_brand_primary_propagates_to_annotation_caption_and_backdrop(runs):
    seen = {}
    for p in PRIMARIES:
        plan, frames = runs[p]
        want = hex_rgb(p)
        f = frames[12]  # t = 400 ms: "Brand" highlighted
        assert plan["frames"][12]["caption"]["active"] == 0
        # box stroke: frame rect x 0.3..0.7, y 0.2 -> top edge at y = 144, stroke 12 * 720/1080 = 8 px
        stroke = f[142:147, 420:860].reshape(-1, 3).astype(float)
        box_rgb = stroke.mean(0)[::-1]
        # highlighted caption word: the saturated pixels in the caption band (the pill is grey, the
        # other words white), then the most common colour among them
        band = f[300:430, 200:1080].reshape(-1, 3).astype(float)
        rgb = band[:, ::-1]
        sat = rgb.max(1) - rgb.min(1) > 60
        hi_rgb = _mode_colour(rgb[sat])
        # derived backdrop: deep shade (top-left) to mid shade (bottom-right), 135 degrees
        tl = f[2:14, 2:14].reshape(-1, 3).mean(0)[::-1]
        bg0, bg1 = mix(p, "#07080c", 0.8), mix(p, "#07080c", 0.42)
        seen[p] = (box_rgb, hi_rgb, tl, bg0, bg1)
        print(f"{p}: box {box_rgb.round(1)} caption highlight {hi_rgb.round(1)} backdrop tl {tl.round(1)} (want {bg0})")
        assert np.abs(box_rgb - want).max() <= COLOUR_TOL
        assert np.abs(hi_rgb - want).max() <= COLOUR_TOL
        assert np.abs(tl - bg0).max() <= BG_TOL
        assert plan["style"]["background"]["colors"] == [("#%02x%02x%02x" % tuple(int(v) for v in bg0)), ("#%02x%02x%02x" % tuple(int(v) for v in bg1))]
    # the change really moved every element: measured change >= 80% of the expected change (the deep
    # backdrop shades of two primaries differ far less than the primaries themselves)
    a, b = seen[PRIMARIES[0]], seen[PRIMARIES[1]]
    exp = [hex_rgb(PRIMARIES[0]) - hex_rgb(PRIMARIES[1])] * 2 + [a[3] - b[3]]
    for k in range(3):
        assert np.abs(a[k] - b[k]).max() >= 0.8 * np.abs(exp[k]).max()


def test_brand_intro_card(runs):
    plan, frames = runs["intro"]
    n = INTRO_MS * FPS // 1000
    on = [i for i, f in enumerate(plan["frames"]) if f["slide"] and f["slide"]["id"] == "brand-intro"]
    assert on == list(range(n))
    assert len(frames) == plan["output"]["frames"] == n + DUR * FPS // 1000
    mid = frames[n // 2]
    tl = mid[2:14, 2:14].reshape(-1, 3).mean(0)[::-1]
    bg0 = mix(PRIMARIES[1], "#07080c", 0.8)
    print(f"intro corner {tl.round(1)} want {bg0}")
    assert np.abs(tl - bg0).max() <= BG_TOL
    # the logo is on the card, centred above the title
    img = next(o for o in plan["frames"][n // 2]["slide"]["ops"] if o["op"] == "image")
    cy, cx = img["y"] + img["h"] // 2, img["x"] + img["w"] // 2
    qx = img["x"] + img["w"] // 4  # inside the logo's opaque left half
    assert luma(mid)[cy - 5:cy + 5, qx - 5:qx + 5].mean() > 240
    assert abs(cx - W / 2) <= 1
