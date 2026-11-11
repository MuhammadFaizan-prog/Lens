"""Demand #12: the Python reference compositor draws every Lens cursor type and the light theme."""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "compositor"))
from lens_compositor.render import cursor_sprite  # noqa: E402

SHAPES = ["arrow", "pointer", "text", "grab", "grabbing", "crosshair", "resize-ew", "resize-ns", "resize-nwse", "resize-nesw", "move", "wait", "not-allowed"]


def _mask(shape, theme="classic"):
    spr, hot = cursor_sprite(shape, 64, theme)
    return spr[..., 3] > 0.5, spr, hot


def test_every_type_has_distinct_art():
    masks = {s: _mask(s)[0] for s in SHAPES}
    for s, m in masks.items():
        assert m.sum() > 60, s
    for i, a in enumerate(SHAPES):
        for b in SHAPES[i + 1:]:
            iou = (masks[a] & masks[b]).sum() / max(1, (masks[a] | masks[b]).sum())
            assert iou < 0.8, (a, b, iou)


def test_light_theme_swaps_fill():
    for s in SHAPES:
        m, spr, hot = _mask(s)
        _, spr_l, hot_l = _mask(s, "light")
        assert hot == hot_l
        # the deepest point inside the art is the fill: dark in classic, white in light
        core = (spr[..., 3] > 0.99).astype(np.uint8)
        dist = cv2.distanceTransform(core, cv2.DIST_L2, 3)
        y, x = np.unravel_index(int(np.argmax(dist)), dist.shape)
        dark = float(spr[y, x, :3].mean())
        light = float(spr_l[y, x, :3].mean())
        assert dark < 80 and light > 180, (s, dark, light)
