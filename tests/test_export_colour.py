"""Export colour: the compositor's x264 encode converts RGB with the BT.709 matrix and tags the stream
bt709 / limited range, so a player decoding it as BT.709 (what browsers do for HD) gets the compositor's
colours back. Before this, the encode used ffmpeg's untagged BT.601 default: up to 23 levels off."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compositor"))
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lens_compositor.render import encoder_args  # noqa: E402

W, H = 640, 360
COLOURS = [(30, 30, 30), (128, 128, 128), (230, 230, 230), (220, 40, 40), (40, 180, 60),
           (40, 80, 220), (250, 200, 40), (120, 60, 200), (20, 160, 170), (245, 245, 245)]
PLAYER = "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int"


def patches() -> np.ndarray:
    img = np.zeros((H, W, 3), np.uint8)
    pw, ph = W // 5, H // 2
    for k, (r, g, b) in enumerate(COLOURS):
        y, x = divmod(k, 5)
        img[y * ph:(y + 1) * ph, x * pw:(x + 1) * pw] = (b, g, r)
    return img


def encode(img: np.ndarray, args: list[str], out: Path) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", "30", "-i", "-", *args, str(out)],
                   input=img.tobytes() * 3, check=True)


def decode_as_player(path: Path) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-frames:v", "1", "-vf", PLAYER, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                       capture_output=True, check=True)
    return np.frombuffer(r.stdout, np.uint8)[: W * H * 3].reshape(H, W, 3)


def patch_shift(src: np.ndarray, out: np.ndarray) -> float:
    """Worst per-patch mean channel difference, patch interiors only (no chroma-edge bleed)."""
    pw, ph, m = W // 5, H // 2, 20
    d = np.abs(out.astype(int) - src.astype(int))
    worst = 0.0
    for k in range(len(COLOURS)):
        y, x = divmod(k, 5)
        worst = max(worst, float(d[y * ph + m:(y + 1) * ph - m, x * pw + m:(x + 1) * pw - m].reshape(-1, 3).mean(0).max()))
    return worst


pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg missing")


def test_export_encode_keeps_colours_within_2_levels(tmp_path: Path) -> None:
    img = patches()
    out = tmp_path / "new.mp4"
    encode(img, encoder_args("veryfast", 18), out)
    assert patch_shift(img, decode_as_player(out)) <= 2.0


def test_untagged_bt601_default_was_off_by_more_than_10_levels(tmp_path: Path) -> None:
    # the encode this replaced, kept as the measured "before"
    img = patches()
    out = tmp_path / "old.mp4"
    encode(img, ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"], out)
    assert patch_shift(img, decode_as_player(out)) > 10


def test_rendered_export_is_tagged_bt709(tmp_path: Path) -> None:
    from lens_compositor import RenderOptions, render
    from lensharness.synth import synthesize
    from media import CLI, make_plan

    if shutil.which("node") is None or not CLI.exists():
        pytest.fail("engine not built (npm run build)")
    s = synthesize(tmp_path, 640, 360, 30, 300)
    make_plan(tmp_path, s["meta"], s["events"], {"output": {"fps": 30, "resolution": 360}})
    out = tmp_path / "o.mp4"
    render(str(tmp_path / "plan.json"), s["screen"], str(out), opts=RenderOptions(preset="ultrafast"))
    p = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                   "stream=color_range,color_space,color_primaries,color_transfer", "-of", "json", str(out)],
                                  capture_output=True, text=True, check=True).stdout)["streams"][0]
    assert p == {"color_range": "tv", "color_space": "bt709", "color_primaries": "bt709", "color_transfer": "bt709"}
