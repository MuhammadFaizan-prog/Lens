"""Sharper text in zooms (demand #22): the Python compositor's port of apps/editor/src/render/sharpen.ts."""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compositor"))
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lens_compositor.render import _viewport_warp  # noqa: E402
from lens_compositor.sharpen import lanczos3, lanczos_view, sharpen_amount_at, sharpened_view, unsharp  # noqa: E402


def text_like(h: int = 120, w: int = 200, seed: int = 1) -> np.ndarray:
    """Grey with 1-2 px dark strokes, like small UI text."""
    rng = np.random.default_rng(seed)
    img = np.full((h, w, 3), 200, np.uint8)
    for _ in range(140):
        x, y = int(rng.integers(2, w - 8)), int(rng.integers(2, h - 8))
        if rng.random() < 0.5:
            img[y:y + int(rng.integers(3, 8)), x:x + 1] = 40
        else:
            img[y:y + 1, x:x + int(rng.integers(3, 8))] = 40
    return img


def lap_var(img: np.ndarray) -> float:
    g = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    return float(cv2.Laplacian(g, cv2.CV_32F)[2:-2, 2:-2].var())


def test_amount_ramp_matches_the_editor() -> None:
    for s in (1.0, 1.5):
        assert sharpen_amount_at(0.6, s) == 0
    for s in (1.75, 2.5):
        assert sharpen_amount_at(0.6, s) == pytest.approx(0.6)
    assert sharpen_amount_at(0.6, 1.625) == pytest.approx(0.3)


def test_lanczos3_kernel() -> None:
    assert lanczos3(np.array([0.0]))[0] == 1
    assert np.all(np.abs(lanczos3(np.array([1.0, 2.0, -1.0, -2.0]))) < 1e-12)
    assert np.all(lanczos3(np.array([3.0, -3.5, 7.0])) == 0)


def test_identity_view_is_the_source() -> None:
    src = text_like()
    h, w = src.shape[:2]
    v = lanczos_view(src, [w / 2, h / 2, 1.0], w, h, w, h)
    assert np.array_equal(v, src.astype(np.float32))


def test_same_geometry_as_the_bicubic_warp() -> None:
    # Same pixel-centre mapping as _viewport_warp (output j <- source x0 + j / k). Checked against the
    # exact mapping on a linear ramp (OpenCV's warpAffine quantises positions to 1/32 px, so the warp
    # itself is only a coarse reference), and against the warp to 0.1 levels.
    yy, xx = np.mgrid[0:120, 0:200].astype(np.float32)
    src = np.dstack([xx, yy, xx * 0.5 + yy * 0.5]).astype(np.float32)
    cam = [100.0, 60.0, 2.5]
    a = lanczos_view(src, cam, 200, 120, 200, 120)
    x0, y0 = 100 - 40, 60 - 24
    jj, ii = np.mgrid[0:120, 0:200].astype(np.float64)
    ex, ey = x0 + ii / 2.5, y0 + jj / 2.5
    assert float(np.abs(a[8:-8, 8:-8, 0] - ex[8:-8, 8:-8]).max()) < 0.02
    assert float(np.abs(a[8:-8, 8:-8, 1] - ey[8:-8, 8:-8]).max()) < 0.02
    b = _viewport_warp(src, cam, 200, 120, 200, 120)
    assert float(np.abs(a[4:-4, 4:-4] - b[4:-4, 4:-4]).max()) < 0.1


def test_no_ringing_next_to_a_hard_edge() -> None:
    src = np.full((60, 120, 3), 128, np.uint8)
    src[:, 60:] = 20
    v = sharpened_view(src, [60.0, 30.0, 2.5], 120, 60, 120, 60, 1.5)
    assert v.min() >= 20 and v.max() <= 128
    # control: plain Lanczos-4 (OpenCV) does overshoot on the same edge
    M = np.float32([[2.5, 0, -(60 - 24) * 2.5], [0, 2.5, -(30 - 12) * 2.5]])
    l4 = cv2.warpAffine(src.astype(np.float32), M, (120, 60), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)
    assert l4.max() > 128.5 or l4.min() < 19.5


def test_unsharp_flat_is_unchanged_and_never_leaves_the_3x3_range() -> None:
    flat = np.full((20, 30, 3), 77, np.float32)
    assert np.array_equal(unsharp(flat, 1.0), flat)
    img = text_like().astype(np.float32)
    u = unsharp(img, 1.5)
    lo = cv2.erode(img, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_REPLICATE)
    hi = cv2.dilate(img, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_REPLICATE)
    assert np.all(u >= lo) and np.all(u <= hi)


def test_zoomed_text_is_sharper_than_the_bicubic_warp() -> None:
    src = text_like()
    cam = [100.0, 60.0, 2.5]
    off = _viewport_warp(src, cam, 200, 120, 200, 120).astype(np.float32)
    on = sharpened_view(src, cam, 200, 120, 200, 120, 0.6)
    assert lap_var(on) >= 1.25 * lap_var(off)


needs_engine = pytest.mark.skipif(shutil.which("node") is None or not (ROOT / "packages" / "engine" / "dist" / "cli.js").exists(), reason="engine not built (npm run build)")


@needs_engine
def test_render_only_zoomed_frames_change(tmp_path: Path) -> None:
    from lens_compositor import RenderOptions, render
    from lensharness.synth import synthesize
    from media import make_plan

    s = synthesize(tmp_path, 640, 360, 30, 2000)
    proj = {"output": {"fps": 30, "resolution": 360}, "motionBlur": {"enabled": False},
            "zoom": {"auto": False, "segments": [{"id": "z", "startMs": 600, "endMs": 2000, "scale": 2.5, "focus": {"x": 320, "y": 180}, "style": "classic", "auto": False}]}}
    make_plan(tmp_path, s["meta"], s["events"], proj)
    plan_off = json.loads((tmp_path / "plan.json").read_text())
    assert "zoomSharpen" not in plan_off["style"]
    plan_on = json.loads(json.dumps(plan_off))
    plan_on["style"]["zoomSharpen"] = {"amount": 0.6}
    (tmp_path / "plan_on.json").write_text(json.dumps(plan_on))

    def frames(p: str) -> list[np.ndarray]:
        got: list[np.ndarray] = []
        render(str(tmp_path / p), s["screen"], str(tmp_path / "x.mp4"), opts=RenderOptions(frame_sink=lambda i, f: got.append(f.copy())))
        return got

    off, on = frames("plan.json"), frames("plan_on.json")
    assert len(off) == len(on) == len(plan_off["frames"])
    for i, f in enumerate(plan_off["frames"]):
        d = float(np.abs(off[i].astype(np.int16) - on[i].astype(np.int16)).mean())
        if f["cam"][2] <= 1.5:
            assert d == 0, f"frame {i} (scale {f['cam'][2]:.2f}) changed"
    zoomed = [i for i, f in enumerate(plan_off["frames"]) if f["cam"][2] > 2.4]
    assert zoomed and any(float(np.abs(off[i].astype(np.int16) - on[i].astype(np.int16)).mean()) > 0 for i in zoomed)
