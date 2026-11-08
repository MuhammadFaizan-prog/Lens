"""Self-tests for the measurement harness and the reference compositor.

The e2e test is the important one: render a synthetic session with known engine settings, then
measure the export with the same harness we point at Screen Studio / FocuSee exports, and check
that it recovers the settings. If the harness cannot recover our own known numbers, its readings
of anyone else's video are worthless.
"""
import json
import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(ROOT / "compositor"))

from lensharness.springfit import fit_transition, fit_zoom_curve, step_response, settle_time_ms  # noqa: E402
from lensharness.track import corner_radius  # noqa: E402
from lensharness.synth import synthesize  # noqa: E402
from lensharness.abcompare import make_blind_pair  # noqa: E402
from lens_compositor import render, RenderOptions, rounded_mask, make_background  # noqa: E402

CLI = ROOT / "packages" / "engine" / "dist" / "cli.js"


@pytest.mark.parametrize("omega,zeta", [(7.0, 1.0), (10.0, 0.7), (5.0, 1.3)])
def test_spring_fit_recovers_known_params(omega, zeta):
    t = np.arange(0, 2500, 1000 / 60)
    t0 = 400.0
    y = 0.1 + (0.8 - 0.1) * step_response((t - t0) / 1000, omega, zeta)
    y += np.random.default_rng(0).normal(0, 0.002, len(t))
    f = fit_transition(t, y)
    assert abs(f.omega - omega) / omega < 0.05
    assert abs(f.zeta - zeta) < 0.06
    assert abs(f.t0_ms - t0) < 20


def test_zoom_curve_finds_in_and_out():
    t = np.arange(0, 6000, 1000 / 30)
    ls = np.log(2) * (step_response((t - 500) / 1000, 7, 1) - step_response((t - 3500) / 1000, 7, 1))
    fits = fit_zoom_curve(t, np.exp(ls))
    assert [f["direction"] for f in fits] == ["in", "out"]
    assert all(abs(f["settle_ms"] - settle_time_ms(7, 1)) < 60 for f in fits)


def test_corner_radius_estimate():
    ref = np.full((400, 600, 3), 200, np.uint8)
    cv2.putText(ref, "Lens", (50, 200), cv2.FONT_HERSHEY_SIMPLEX, 3, (20, 20, 20), 4)
    frame = np.zeros((500, 700, 3), np.uint8)
    m = rounded_mask(600, 400, 24.0)[..., None]
    frame[50:450, 50:650] = (ref * m).astype(np.uint8)
    r = corner_radius(frame, ref, {"x": 50, "y": 50, "w": 600, "h": 400})
    assert abs(r - 24) < 4


def test_background_gradient_runs_between_colors():
    bg = make_background({"background": {"kind": "gradient", "colors": ["#000000", "#ffffff"], "angle": 90, "blur": 0}}, 200, 100)
    assert bg[50, 2].mean() < 15 and bg[50, -3].mean() > 240


@pytest.fixture(scope="module")
def e2e(tmp_path_factory):
    if shutil.which("node") is None or not CLI.exists():
        pytest.skip("engine not built (npm run build)")
    d = tmp_path_factory.mktemp("e2e")
    s = synthesize(d, 960, 540, 30, 8000)
    (d / "project.json").write_text(json.dumps({"output": {"fps": 30, "resolution": 720}}))
    subprocess.run(["node", str(CLI), "--meta", s["meta"], "--events", s["events"], "--project", str(d / "project.json"), "--out", str(d / "plan.json")], check=True)
    render(str(d / "plan.json"), s["screen"], str(d / "lens.mp4"), opts=RenderOptions(preset="veryfast"))
    from measure import measure  # noqa: E402
    m = measure(str(d / "lens.mp4"), s["reference"], s["events"], sync="0")
    return d, json.loads((d / "plan.json").read_text()), m


def test_e2e_tracks_almost_every_frame(e2e):
    _, plan, m = e2e
    assert m["trackedFrames"] / m["totalFrames"] > 0.9


def test_e2e_recovers_zoom_curve(e2e):
    _, plan, m = e2e
    t = np.array(m["zoom"]["curve"]["t"])
    s = np.array(m["zoom"]["curve"]["scale"])
    pt = np.array([f["t"] for f in plan["frames"]])
    ps = np.array([f["cam"][2] for f in plan["frames"]])
    assert np.abs(np.interp(t, pt, ps) - s).max() < 0.03
    cx = np.array(m["zoom"]["curve"]["cx"])
    pcx = np.interp(t, pt, [f["cam"][0] for f in plan["frames"]])
    assert np.abs(cx - pcx).mean() < 2.0


def test_e2e_recovers_engine_settings(e2e):
    _, plan, m = e2e
    zin = [z for z in m["zoom"]["transitions"] if z["direction"] == "in"][0]
    zout = [z for z in m["zoom"]["transitions"] if z["direction"] == "out"][-1]
    assert abs(zin["settle_ms"] - 900) < 90          # project default springFromSettle(900, 1)
    assert abs(zin["zeta"] - 1) < 0.1
    assert abs(zin["toScale"] - 2.0) < 0.05
    assert abs(zin["leadMs"] - 350) < 60            # zoom.leadMs
    assert abs(zout["holdMs"] - 1400) < 80           # zoom.holdMs
    assert abs(m["look"]["padding"]["paddingFractionOfShortSide"] - 0.08) < 0.005
    assert abs(m["look"]["cornerRadiusAt1080"] - 14) < 3


def test_e2e_cursor_found_and_smoothed(e2e):
    _, plan, m = e2e
    assert m["cursor"]["foundFrames"] > 0.8 * m["trackedFrames"]
    # Tracker accuracy: measured cursor (anchor bias removed) vs the plan's ground-truth cursor.
    from lensharness.cursortrack import track_cursor  # noqa: E402
    d = e2e[0]
    from lensharness.track import track_video  # noqa: E402
    events = [json.loads(l) for l in (d / "events.jsonl").read_text().splitlines() if l.strip()]
    tr = track_video(str(d / "lens.mp4"), str(d / "reference.png"))
    ct = [c for c in track_cursor(str(d / "lens.mp4"), str(d / "reference.png"), tr, events) if c["found"]]
    meas = np.array([[c["x"], c["y"]] for c in ct])
    truth, moving, scale = [], [], []
    fr = plan["frames"]
    for c in ct:
        i = int(round(c["t"] * plan["output"]["fps"] / 1000))
        f = fr[i]
        truth.append(f["cur"][:2] if f["cur"] else [math.nan, math.nan])
        a, b = fr[max(i - 1, 0)], fr[min(i + 1, len(fr) - 1)]
        cam_moving = abs(b["cam"][2] - a["cam"][2]) > 0.002 or math.hypot(b["cam"][0] - a["cam"][0], b["cam"][1] - a["cam"][1]) > 1.0
        cur_fast = bool(a["cur"] and b["cur"]) and math.hypot(b["cur"][0] - a["cur"][0], b["cur"][1] - a["cur"][1]) > 10.0
        # motion blur smears the sprite during camera or fast cursor motion, biasing the blob anchor
        moving.append(cam_moving or cur_fast)
        scale.append(round(f["cam"][2], 1))
    truth = np.array(truth, float)
    moving, scale = np.array(moving), np.array(scale)
    ok = np.all(np.isfinite(truth), axis=1)
    err = meas[ok] - truth[ok]
    still, sc = ~moving[ok], scale[ok]
    # the sprite's hotspot offset is fixed in export pixels, so the anchor bias differs per zoom level
    for z in np.unique(sc[still]):
        sel = sc == z
        err[sel] -= np.median(err[sel & still], axis=0)
    mag = np.hypot(err[:, 0], err[:, 1])
    assert still.sum() > 50
    # settled frames: median error sub-pixel. Known tracker limit: for ~0.7 s after a click the
    # ripple ring touches the sprite blob and shifts its anchor ~3 px, so RMS is not asserted here.
    assert np.median(mag[still]) < 1.0
    assert np.percentile(mag, 95) < 8.0                  # including blurred motion frames
    assert m["cursor"]["smoothing"]["settleMs"] is not None


def test_blind_pair_hides_identity(tmp_path, e2e):
    d, _, _ = e2e
    res = make_blind_pair(str(d / "lens.mp4"), str(d / "screen.mp4"), str(tmp_path / "ab"), samples=3, seed=1)
    key = json.loads(Path(res["key"]).read_text())
    assert {key["X"], key["Y"]} == {"ours", "bar"}
    assert set(key["files"]) == {"X", "Y"}
    assert Path(res["sideBySide"]).stat().st_size > 1000
    assert Path(res["contactSheet"]).exists()
