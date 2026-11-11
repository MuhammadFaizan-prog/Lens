"""Cut transitions and slide enter / exit in the Python reference compositor (demand #14).

Same synthetic fixture as apps/editor/e2e/transitions.spec.ts: a 640x360 @30 screen that is dark
(luma 32) on even seconds and light (luma 224) on odd seconds, backdrop hidden (a frame's luma is the
screen's), kept source [0,900] dark, [1100,1900] light, [2100,2900] dark, [3100,3900] light,
[4100,4900] dark: four dark <-> light joins at output frames 27 / 51 / 75 / 99, plus a trailing cut.

Bounds, set before the first run:
 - 400 ms transitions: 12 `tr` frames per join, 48 in all, kinds crossfade / push / zoom / blur by join;
 - every frame without `tr` is byte-identical to the same plan with all `tr` removed (hard cuts);
 - crossfade: midpoint frame 27 mean luma within 10% of the average of the sides (the e2e bound), and
   every crossfade frame within 5% of the luma span of (1 - u) * A + u * B;
 - push (frame 51): left half minus right half >= 0.6 x span, and the frame equals the outgoing / incoming
   frames shifted by u * W within a mean of 2 levels;
 - zoom (75) and blur dip (99): mean luma at least 0.2 x span away from both sides;
 - slide enter (red slide at source 4500, 1000 ms, Slide up 0.4 s linear): frame 117 fx dy = 180 +- 1,
   top quarter luma within 25 of dark, band 52..60% height / left 10% red (R - G >= 100);
 - old projects: the reference compositor before this change (main 7d1a5db) and this one render a plan
   without transitions (cursor, clicks, motion blur on) byte-identically.
"""
from __future__ import annotations

import importlib
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

from lens_compositor import RenderOptions, render  # noqa: E402
from media import CLI, make_plan  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None or not CLI.exists(), reason="engine not built (npm run build)")

W, H, FPS, SECS = 640, 360, 30, 8
DARK, LIGHT = 32, 224
SPAN = LIGHT - DARK
JOINS = [27, 51, 75, 99]
KINDS = ["crossfade", "push", "zoom", "blur"]
CUTS = [[900, 1100], [1900, 2100], [2900, 3100], [3900, 4100], [4900, 8000]]


def bundle(d: Path) -> tuple[str, str, str]:
    screen = d / "screen.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={FPS}:d={SECS}",
                    "-vf", f"format=yuv420p,geq=lum='if(mod(floor(T),2),{LIGHT},{DARK})':cb=128:cr=128", "-c:v", "libx264",
                    "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", str(screen)], check=True)
    meta = d / "meta.json"
    meta.write_text(json.dumps({"width": W, "height": H, "fps": FPS, "durationMs": SECS * 1000, "pixelRatio": 1}))
    ev = ['# lens-events v1 {"capture":{"width":640,"height":360},"source":"screen","platform":"linux"}']
    ev += [json.dumps({"t": i * 100, "type": "move", "x": 100 + i * 5, "y": 100}) for i in range(SECS * 10)]
    events = d / "events.jsonl"
    events.write_text("\n".join(ev) + "\n")
    return str(screen), str(meta), str(events)


def project(transitions: bool, slide_enter: bool = False) -> dict:
    cuts = [{"startMs": a, "endMs": b} for a, b in CUTS]
    if transitions:
        for i, k in enumerate(KINDS[1:], start=1):
            cuts[i]["transition"] = {"kind": k}
    slide = {"id": "s1", "atMs": 4500, "durationMs": 1000, "title": "", "subtitle": "", "background": "#d02020", "textColor": "#ffffff",
             "accent": None, "fadeMs": 250, "titleSize": 84, "subtitleSize": 40}
    if slide_enter:
        slide["enter"] = {"kind": "slide-up", "ms": 400, "easing": "linear"}
    p = {"version": 1, "output": {"aspect": "16:9", "resolution": 360, "fps": FPS}, "zoom": {"auto": False},
         "cursor": {"visible": False, "clickEffect": "none"}, "motionBlur": {"enabled": False}, "shortcuts": {"enabled": False},
         "background": {"kind": "hidden", "colors": ["#000000"], "inherit": False}, "audio": {"tracks": []}, "edits": {"cuts": cuts},
         "slides": [slide]}
    if transitions:
        p["transitions"] = {"kind": "crossfade", "durationMs": 400, "easing": "ease-in-out", "scope": "manual"}
    return p


def frames_of(plan_path: Path, screen: str) -> list[np.ndarray]:
    got: dict[int, np.ndarray] = {}
    render(str(plan_path), screen, str(plan_path.with_suffix(".never.mp4")), opts=RenderOptions(frame_sink=lambda i, f: got.__setitem__(i, f.copy()), audio=False))
    return [got[i] for i in range(len(got))]


def luma(f: np.ndarray) -> float:
    b, g, r = (f[..., c].astype(np.float64) for c in range(3))
    return float((0.299 * r + 0.587 * g + 0.114 * b).mean())


@pytest.fixture(scope="module")
def renders(tmp_path_factory) -> dict:
    d = tmp_path_factory.mktemp("transitions")
    screen, meta, events = bundle(d)
    plan = make_plan(d, meta, events, project(True, slide_enter=True), name="tr")
    plain = json.loads(json.dumps(plan))
    for f in plain["frames"]:
        f.pop("tr", None)
    (d / "plain.json").write_text(json.dumps(plain))
    return {"plan": plan, "tr": frames_of(d / "tr.json", screen), "plain": frames_of(d / "plain.json", screen), "dir": d, "screen": screen,
            "meta": meta, "events": events}


def test_plan_carries_48_transition_frames(renders) -> None:
    fr = renders["plan"]["frames"]
    assert len(fr) == 153
    tr = [(i, f["tr"]) for i, f in enumerate(fr) if f.get("tr")]
    assert len(tr) == 48
    for j, k in zip(JOINS, KINDS):
        near = [t for i, t in tr if abs(i - j) <= 6]
        assert len(near) == 12 and {t["kind"] for t in near} == {k}


def test_frames_outside_transitions_identical(renders) -> None:
    fr = renders["plan"]["frames"]
    assert len(renders["tr"]) == len(renders["plain"]) == len(fr)
    for i, f in enumerate(fr):
        if not f.get("tr"):
            assert np.array_equal(renders["tr"][i], renders["plain"][i]), f"frame {i} changed"


def test_crossfade(renders) -> None:
    fr, out, plain = renders["plan"]["frames"], renders["tr"], renders["plain"]
    a, b = luma(plain[10]), luma(plain[40])
    assert abs(a - DARK) < 6 and abs(b - LIGHT) < 6
    mid = luma(out[27])
    avg = (a + b) / 2
    assert abs(mid - avg) <= 0.10 * avg, (mid, avg)
    for i, f in enumerate(fr):
        t = f.get("tr")
        if not t or t["kind"] != "crossfade":
            continue
        own, other = luma(plain[i]), luma(plain[t["other"]])
        la, lb = (other, own) if t["incoming"] else (own, other)
        want = (1 - t["u"]) * la + t["u"] * lb
        assert abs(luma(out[i]) - want) <= 0.05 * SPAN, (i, luma(out[i]), want)


def test_push(renders) -> None:
    fr, out, plain = renders["plan"]["frames"], renders["tr"], renders["plain"]
    f = out[51]
    left, right = luma(f[:, : W // 2]), luma(f[:, W // 2:])
    assert left - right >= 0.6 * SPAN, (left, right)
    t = fr[51]["tr"]
    a_img, b_img = (plain[t["other"]], plain[51]) if t["incoming"] else (plain[51], plain[t["other"]])
    s = int(round(t["u"] * W))
    want = np.concatenate([a_img[:, s:], b_img[:, : W - s]], axis=1).astype(np.float64)
    err = np.abs(f.astype(np.float64) - want)[:, 2:-2].mean()
    assert err <= 2, err


@pytest.mark.parametrize("j", [75, 99])
def test_zoom_and_blur_composite(renders, j: int) -> None:
    v = luma(renders["tr"][j])
    a, b = luma(renders["plain"][10]), luma(renders["plain"][40])
    assert abs(v - a) >= 0.2 * SPAN and abs(v - b) >= 0.2 * SPAN, (j, v, a, b)


def test_slide_enter(renders) -> None:
    fx = renders["plan"]["frames"][117]["slide"]["fx"]
    assert abs(fx[1] - 180) <= 1, fx
    f = renders["tr"][117].astype(np.float64)
    assert abs(luma(f[: H // 4]) - DARK) <= 25
    band = f[int(H * 0.52): int(H * 0.60), : W // 10]
    assert (band[..., 2] - band[..., 1]).mean() >= 100


def test_old_projects_render_identically(tmp_path: Path) -> None:
    """main's compositor and this one, same plan with no transitions: byte-identical frames."""
    from lensharness.synth import synthesize

    old = tmp_path / "old"
    shutil.copytree(ROOT / "compositor" / "lens_compositor", old / "lens_compositor_old")
    src = subprocess.run(["git", "-C", str(ROOT), "show", "7d1a5db:compositor/lens_compositor/render.py"], capture_output=True, text=True, check=True).stdout
    (old / "lens_compositor_old" / "render.py").write_text(src)
    sys.path.insert(0, str(old))
    try:
        mod = importlib.import_module("lens_compositor_old.render")
    finally:
        sys.path.remove(str(old))
    s = synthesize(tmp_path, 640, 360, 30, 2500)
    make_plan(tmp_path, s["meta"], s["events"], {"output": {"fps": 30, "resolution": 360}, "motionBlur": {"enabled": True},
                                                  "edits": {"cuts": [{"startMs": 900, "endMs": 1300}]}})
    plan = json.loads((tmp_path / "plan.json").read_text())
    assert not any(f.get("tr") for f in plan["frames"])
    a: list[np.ndarray] = []
    b: list[np.ndarray] = []
    render(str(tmp_path / "plan.json"), s["screen"], str(tmp_path / "x.mp4"), opts=RenderOptions(frame_sink=lambda i, f: b.append(f.copy()), audio=False))
    mod.render(str(tmp_path / "plan.json"), s["screen"], str(tmp_path / "y.mp4"), opts=mod.RenderOptions(frame_sink=lambda i, f: a.append(f.copy()), audio=False))
    assert len(a) == len(b) == len(plan["frames"])
    assert all(np.array_equal(x, y) for x, y in zip(a, b))
