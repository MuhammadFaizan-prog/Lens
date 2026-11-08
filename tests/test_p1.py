"""P1 feature tests: each renders through engine -> plan -> reference compositor and measures the
output (audio decoded and measured, frames sampled), not just the plan.

Items: audio mux with cuts/speed, audio cleanup (denoise + loudnorm), click sounds, GIF export,
source crop, spotlight/blur/pixelate masks, webcam mirror/crop/zoomed size, caption styling with
word highlight, per-segment cursor and volume overrides.
"""
from __future__ import annotations

import copy
import json
import math
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(ROOT / "compositor"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lensharness.audio import decode_mono, loudness, noise_floor, onsets, rms_db  # noqa: E402
from lensharness.synth import synthesize  # noqa: E402
from lens_compositor import RenderOptions, render  # noqa: E402
from lens_compositor.audio import synth_click  # noqa: E402
from media import CLI, SR, beeps, ffprobe, make_plan, read_all_frames, screen_point, speechy, webcam_bars, write_wav  # noqa: E402

FPS = 30
FRAME_MS = 1000 / FPS
BASE = {"output": {"fps": FPS, "resolution": 360}, "motionBlur": {"enabled": False}, "background": {"kind": "solid", "colors": ["#202020"]}}
FAST = RenderOptions(preset="veryfast", crf=16)

pytestmark = pytest.mark.skipif(shutil.which("node") is None or not CLI.exists(), reason="engine not built (npm run build)")


def proj(**over) -> dict:
    p = copy.deepcopy(BASE)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(p.get(k), dict):
            p[k] = {**p[k], **v}
        else:
            p[k] = v
    return p


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    d = tmp_path_factory.mktemp("p1synth")
    s = synthesize(d, 640, 360, FPS, 8000)
    return d, s


def write_events(d: Path, events: list[dict], name: str = "events") -> str:
    p = d / f"{name}.jsonl"
    p.write_text("\n".join(json.dumps(e) for e in events) + "\n")
    return str(p)


def sweep(a, b, t0, dur, step=8):
    out = []
    n = max(1, round(dur / step))
    for i in range(n + 1):
        u = i / n
        out.append({"t": t0 + u * dur, "type": "move", "x": a[0] + (b[0] - a[0]) * u, "y": a[1] + (b[1] - a[1]) * u})
    return out


# ------------------------------------------------------------------ 1. audio in export

def test_audio_mux_follows_cuts_and_speed(synth, tmp_path):
    d, s = synth
    # file-time beeps; offsetMs=200 puts them at recording times 500, 1500, 2500 (cut), 3500, 5000, 6500
    file_beeps = [300, 1300, 2300, 3300, 4800, 6300]
    mic = write_wav(tmp_path / "mic.wav", beeps(file_beeps, 8000))
    sysa = write_wav(tmp_path / "sys.wav", beeps([100, 200, 300], 8000, freq=3000))
    project = proj(
        edits={"cuts": [{"startMs": 2000, "endMs": 3000}], "speed": [{"startMs": 4000, "endMs": 6000, "rate": 2}]},
        audio={"tracks": [{"id": "mic", "kind": "mic", "path": mic, "offsetMs": 200, "volume": 1, "muted": False},
                          {"id": "sys", "kind": "system", "path": sysa, "offsetMs": 0, "volume": 1, "muted": True}],
               "loudness": {"enabled": False}},
    )
    plan = make_plan(tmp_path, s["meta"], s["events"], project)
    assert plan["output"]["durationMs"] == pytest.approx(6000)
    out = tmp_path / "out.mp4"
    info = render(str(tmp_path / "plan.json"), s["screen"], str(out), opts=FAST)
    assert info["audio"] is True
    v = ffprobe(str(out), "stream=duration,nb_frames")["streams"][0]
    a = ffprobe(str(out), "stream=duration,codec_name", stream="a:0")["streams"][0]
    assert a["codec_name"] == "aac"
    assert abs(float(v["duration"]) - 6.0) <= FRAME_MS / 1000 + 1e-6
    assert abs(float(a["duration"]) - 6.0) < 0.05
    x = decode_mono(str(out))
    got = onsets(x, SR, rel_threshold=0.3)
    expected = [500, 1500, 2500, 3500, 4500]  # 3500 src -> 2500 out; 5000 -> 3500; 6500 -> 4500
    assert len(got) == len(expected), got
    for g, e in zip(got, expected):
        assert abs(g - e) <= FRAME_MS, (got, expected)
    # the muted 3 kHz track is absent: spectrum near 3 kHz is negligible vs 1 kHz
    spec = np.abs(np.fft.rfft(x))
    f = np.fft.rfftfreq(len(x), 1 / SR)
    assert spec[(f > 2950) & (f < 3050)].max() < 0.05 * spec[(f > 950) & (f < 1050)].max()


# ------------------------------------------------------------------ 2. audio cleanup

@pytest.mark.parametrize("target", [-16, -23])
def test_loudness_normalised_to_target(synth, tmp_path, target):
    d, s = synth
    mic = write_wav(tmp_path / "mic.wav", speechy(8000, level=0.03))
    lou = {"enabled": True, "targetLufs": target} if target != -16 else {"enabled": True}  # -16 is the default
    project = proj(audio={"tracks": [{"id": "mic", "kind": "mic", "path": mic, "offsetMs": 0, "volume": 1, "muted": False}], "loudness": lou})
    plan = make_plan(tmp_path, s["meta"], s["events"], project)
    assert plan["audio"]["loudness"]["targetLufs"] == target
    before = loudness(mic)["integratedLufs"]
    out = tmp_path / "out.mp4"
    render(str(tmp_path / "plan.json"), s["screen"], str(out), opts=FAST)
    m = loudness(str(out))
    assert abs(before - target) > 3  # the input really was off target
    assert abs(m["integratedLufs"] - target) <= 1.0, m
    assert m["truePeakDbtp"] <= -1.0


def test_noise_reduction_lowers_noise_floor(synth, tmp_path):
    d, s = synth
    rng = np.random.default_rng(5)
    sig = speechy(8000, level=0.2) + rng.normal(0, 0.006, int(8 * SR)).astype(np.float32)  # hiss at about -44 dBFS
    mic = write_wav(tmp_path / "noisy.wav", sig)
    floors = {}
    for on in (False, True):
        project = proj(audio={"tracks": [{"id": "mic", "kind": "mic", "path": mic, "offsetMs": 0, "volume": 1, "muted": False}],
                              "loudness": {"enabled": False}, "noiseReduction": {"enabled": on, "amountDb": 20}})
        make_plan(tmp_path, s["meta"], s["events"], project, name=f"nr{on}")
        out = tmp_path / f"nr{on}.mp4"
        render(str(tmp_path / f"nr{on}.json"), s["screen"], str(out), opts=FAST)
        floors[on] = noise_floor(str(out))
    assert floors[True]["noiseFloorDb"] < floors[False]["noiseFloorDb"] - 8, floors
    # speech is kept: the loud windows lose less than 3 dB
    assert floors[True]["speechLevelDb"] > floors[False]["speechLevelDb"] - 3, floors


# ------------------------------------------------------------------ 3. click sounds

def test_click_sound_is_procedural_and_deterministic():
    a, b = synth_click(48000), synth_click(48000)
    assert np.array_equal(a, b)
    assert 0.02 < len(a) / 48000 < 0.05
    assert abs(np.abs(a).max() - 0.9) < 1e-6
    assert abs(float(a[0])) < 1e-3  # no DC step at the start


def test_click_sounds_land_at_plan_times(synth, tmp_path):
    d, s = synth
    project = proj(cursor={"clickSound": True, "clickSoundVolume": 0.8}, edits={"cuts": [{"startMs": 1000, "endMs": 1300}]})
    plan = make_plan(tmp_path, s["meta"], s["events"], project)
    times = plan["audio"]["clickSound"]["times"]
    assert times == [900, 1300, 5700]  # source clicks 900, 1600, 6000 through the 300 ms cut
    out = tmp_path / "out.mp4"
    render(str(tmp_path / "plan.json"), s["screen"], str(out), opts=FAST)
    x = decode_mono(str(out))
    got = onsets(x, SR, rel_threshold=0.25)
    assert len(got) == len(times), got
    for g, e in zip(got, times):
        assert abs(g - e) <= FRAME_MS, (got, times)
    click_rms = lambda y: np.mean([rms_db(y, SR, t, t + 30) for t in times])  # noqa: E731
    assert -24 < click_rms(x) < -8  # audible but not clipping-loud

    # volume scales the click
    make_plan(tmp_path, s["meta"], s["events"], proj(cursor={"clickSound": True, "clickSoundVolume": 0.4}), name="quiet")
    render(str(tmp_path / "quiet.json"), s["screen"], str(tmp_path / "quiet.mp4"), opts=FAST)
    xq = decode_mono(str(tmp_path / "quiet.mp4"))
    times_q = [900, 1600, 6000]
    q = np.mean([rms_db(xq, SR, t, t + 30) for t in times_q])
    assert abs((q - click_rms(x)) - 20 * math.log10(0.5)) < 1.0


# ------------------------------------------------------------------ 4. GIF export

@pytest.mark.parametrize("loop", [True, False])
def test_gif_export(tmp_path, loop):
    s = synthesize(tmp_path, 640, 360, FPS, 3000)
    make_plan(tmp_path, s["meta"], s["events"], proj(export={"gif": {"fps": 10, "width": 320, "loop": loop}}))
    out = tmp_path / "out.gif"
    info = render(str(tmp_path / "plan.json"), s["screen"], str(out), opts=FAST)
    assert info["gif"] == {"fps": 10, "width": 320, "loop": loop}
    st = ffprobe(str(out), "stream=width,height,nb_read_frames,codec_name", count=True)["streams"][0]
    assert st["codec_name"] == "gif"
    assert (st["width"], st["height"]) == (320, 180)
    assert abs(int(st["nb_read_frames"]) - 30) <= 1
    dur = float(ffprobe(str(out), "format=duration")["format"]["duration"])
    assert abs(dur - 3.0) < 0.15
    assert (b"NETSCAPE2.0" in out.read_bytes()) == loop
    frames = read_all_frames(str(out))
    assert frames.std() > 5  # not blank


# ------------------------------------------------------------------ 5. crop

def test_crop_renders_only_the_cropped_region(synth, tmp_path):
    d, s = synth
    crop = {"x": 96, "y": 120, "w": 384, "h": 216}  # 16:9, part of the sidebar plus cards
    project = proj(crop=crop, zoom={"auto": False}, cursor={"visible": False}, frame={"radius": 0, "shadow": {"opacity": 0}})
    plan = make_plan(tmp_path, s["meta"], s["events"], project)
    assert plan["source"]["crop"] == [96, 120, 384, 216]
    out = tmp_path / "out.mp4"
    render(str(tmp_path / "plan.json"), s["screen"], str(out), opts=RenderOptions(preset="veryfast", crf=12, max_frames=3))
    frame = read_all_frames(str(out))[0].astype(np.float32)
    sx, sy, sw, sh = (int(round(v)) for v in plan["frames"][0]["layout"]["screen"])
    got = frame[sy + 2:sy + sh - 2, sx + 2:sx + sw - 2]
    ref = cv2.imread(s["reference"]).astype(np.float32)

    def score(region):
        r = cv2.resize(region, (sw, sh), interpolation=cv2.INTER_AREA)[2:-2, 2:-2]
        return float(np.corrcoef(r.ravel(), got.ravel())[0, 1])

    cropped = score(ref[120:336, 96:480])
    full = score(ref)
    assert cropped > 0.97, cropped
    assert full < cropped - 0.2, (full, cropped)


def test_crop_cursor_outside_is_not_drawn(synth, tmp_path):
    d, s = synth
    events = sweep((100, 100), (600, 330), 0, 2000)
    ev = write_events(tmp_path, events)
    crop = {"x": 0, "y": 0, "w": 320, "h": 180}
    common = dict(crop=crop, zoom={"auto": False}, cursor={"smoothing": {"enabled": False}, "hideWhenIdle": False})
    plan = make_plan(tmp_path, s["meta"], ev, proj(**common))
    make_plan(tmp_path, s["meta"], ev, proj(**{**common, "cursor": {**common["cursor"], "visible": False}}), name="nocur")
    render(str(tmp_path / "plan.json"), s["screen"], str(tmp_path / "a.mp4"), opts=RenderOptions(preset="veryfast", crf=12, max_frames=60))
    render(str(tmp_path / "nocur.json"), s["screen"], str(tmp_path / "b.mp4"), opts=RenderOptions(preset="veryfast", crf=12, max_frames=60))
    a, b = read_all_frames(str(tmp_path / "a.mp4")).astype(np.int16), read_all_frames(str(tmp_path / "b.mp4")).astype(np.int16)
    diff = (np.abs(a - b).max(axis=3) > 40).sum(axis=(1, 2))
    inside = [i for i, f in enumerate(plan["frames"][:60]) if f["cur"] is not None]
    outside = [i for i, f in enumerate(plan["frames"][:60]) if f["cur"] is None]
    assert inside and outside
    assert np.median(diff[inside[: len(inside) // 2]]) > 30  # cursor drawn while inside the crop
    assert diff[outside[3:]].max() < 5  # and gone once it leaves


# ------------------------------------------------------------------ 6. masks

def test_masks_blur_pixelate_spotlight_follow_camera(synth, tmp_path):
    d, s = synth
    ev = write_events(tmp_path, [{"t": 0, "type": "move", "x": 20, "y": 20}])
    rect = {"x": 300, "y": 190, "w": 200, "h": 100}  # over the card grid (lots of detail)
    masks = [
        {"id": "b1", "kind": "blur", "rect": rect, "startMs": 0, "endMs": 1000, "feather": 0, "fadeMs": 0, "strength": 6},
        {"id": "p1", "kind": "pixelate", "rect": rect, "startMs": 1000, "endMs": 2000, "feather": 0, "fadeMs": 0, "strength": 10},
        {"id": "s1", "kind": "spotlight", "rect": rect, "startMs": 2000, "endMs": 3000, "feather": 0, "fadeMs": 0, "strength": 0.6},
        {"id": "b2", "kind": "blur", "rect": rect, "startMs": 3000, "endMs": 5000, "feather": 6, "fadeMs": 0, "strength": 6},
    ]
    zoom = {"auto": False, "segments": [{"id": "z", "startMs": 3000, "endMs": 5000, "scale": 2, "focus": {"x": 420, "y": 240}, "style": "classic", "auto": False}]}
    common = dict(zoom=zoom, cursor={"visible": False}, frame={"radius": 0, "shadow": {"opacity": 0}}, shortcuts={"enabled": False})
    plan = make_plan(tmp_path, s["meta"], ev, proj(masks=masks, **common))
    make_plan(tmp_path, s["meta"], ev, proj(**common), name="base")
    n = 150
    render(str(tmp_path / "plan.json"), s["screen"], str(tmp_path / "m.mp4"), opts=RenderOptions(preset="veryfast", crf=10, max_frames=n))
    render(str(tmp_path / "base.json"), s["screen"], str(tmp_path / "b.mp4"), opts=RenderOptions(preset="veryfast", crf=10, max_frames=n))
    M = read_all_frames(str(tmp_path / "m.mp4")).astype(np.float32)
    B = read_all_frames(str(tmp_path / "b.mp4")).astype(np.float32)

    def box(i, inset=4):
        f = plan["frames"][i]
        x0, y0 = screen_point(f, plan, rect["x"], rect["y"])
        x1, y1 = screen_point(f, plan, rect["x"] + rect["w"], rect["y"] + rect["h"])
        return int(x0) + inset, int(y0) + inset, int(x1) - inset, int(y1) - inset

    def lapvar(img):
        return float(cv2.Laplacian(cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())

    def outside_diff(i, x0, y0, x1, y1, pad=10):
        m = np.ones(M.shape[1:3], bool)
        m[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad] = False
        return float(np.abs(M[i] - B[i])[m].mean())

    # blur, unzoomed (t=0.5 s)
    i = 15
    x0, y0, x1, y1 = box(i)
    assert lapvar(M[i, y0:y1, x0:x1]) < 0.25 * lapvar(B[i, y0:y1, x0:x1])
    assert outside_diff(i, x0, y0, x1, y1) < 1.5
    # pixelate (t=1.5 s): block structure -> most horizontal neighbours equal
    i = 45
    x0, y0, x1, y1 = box(i)
    reg = M[i, y0:y1, x0:x1].mean(axis=2)
    flat_m = float((np.abs(np.diff(reg, axis=1)) < 4).mean())
    flat_b = float((np.abs(np.diff(B[i, y0:y1, x0:x1].mean(axis=2), axis=1)) < 4).mean())
    assert flat_m > 0.8 and flat_m > flat_b + 0.05, (flat_m, flat_b)
    assert outside_diff(i, x0, y0, x1, y1) < 1.5
    # spotlight (t=2.5 s): inside untouched, outside dimmed by 60 %
    i = 75
    x0, y0, x1, y1 = box(i)
    inside_ratio = M[i, y0:y1, x0:x1].mean() / B[i, y0:y1, x0:x1].mean()
    sx, sy, sw, sh = (int(round(v)) for v in plan["frames"][i]["layout"]["screen"])
    corner = (slice(sy + 4, sy + 40), slice(sx + sw - 80, sx + sw - 4))
    outside_ratio = M[i][corner].mean() / B[i][corner].mean()
    assert abs(inside_ratio - 1) < 0.03, inside_ratio
    assert abs(outside_ratio - 0.4) < 0.05, outside_ratio
    # blur while zoomed 2x (t=4.5 s): the mask moved and grew with the camera
    i = 135
    assert plan["frames"][i]["cam"][2] > 1.95
    zx0, zy0, zx1, zy1 = box(i)
    assert (zx1 - zx0) > 1.8 * (x1 - x0)
    assert lapvar(M[i, zy0:zy1, zx0:zx1]) < 0.25 * lapvar(B[i, zy0:zy1, zx0:zx1])
    assert outside_diff(i, zx0, zy0, zx1, zy1, pad=20) < 1.5


# ------------------------------------------------------------------ 7. webcam

def test_webcam_mirror_crop_and_zoomed_size(synth, tmp_path):
    d, s = synth
    cam = webcam_bars(tmp_path / "cam.mp4", dur_ms=8000)
    project = proj(camera={"enabled": True, "shape": "square", "size": 0.3, "mirror": True, "crop": {"x": 80, "y": 0, "w": 160, "h": 240}, "zoomedSize": 0.6},
                   cursor={"visible": False})
    plan = make_plan(tmp_path, s["meta"], s["events"], project)
    n = 120
    render(str(tmp_path / "plan.json"), s["screen"], str(tmp_path / "out.mp4"), camera_path=cam, opts=RenderOptions(preset="veryfast", crf=10, max_frames=n))
    F = read_all_frames(str(tmp_path / "out.mp4")).astype(np.int16)

    def masks(img):
        b, g, r = img[..., 0], img[..., 1], img[..., 2]
        return {"green": (g > 180) & (r < 90) & (b < 90), "blue": (b > 180) & (r < 90) & (g < 90),
                "red": (r > 180) & (g < 90) & (b < 90), "yellow": (r > 180) & (g > 180) & (b < 90)}

    i0 = 0
    cx, cy, cw, ch = (int(round(v)) for v in plan["frames"][i0]["layout"]["camera"])
    reg = F[i0, cy + 3:cy + ch - 3, cx + 3:cx + cw - 3]
    m = masks(reg)
    half = reg.shape[1] // 2
    # crop keeps only the green and blue bands; mirror puts blue on the left
    assert m["red"].sum() == 0 and m["yellow"].sum() == 0
    assert m["blue"][:, :half].mean() > 0.8 and m["green"][:, half:].mean() > 0.8
    # zoomed: the webcam shrinks to ~60 % per side (36 % area), anchored bottom-right
    zi = max(range(n), key=lambda k: plan["frames"][k]["cam"][2])
    assert plan["frames"][zi]["cam"][2] > 1.9
    area0 = sum(v.sum() for v in masks(F[i0]).values())
    areaz = sum(v.sum() for v in masks(F[zi]).values())
    assert abs(areaz / area0 - 0.36) < 0.06, areaz / area0
    ys, xs = np.nonzero(masks(F[zi])["green"] | masks(F[zi])["blue"])
    assert abs(xs.max() - (cx + cw - 1)) <= 2 and abs(ys.max() - (cy + ch - 1)) <= 2


# ------------------------------------------------------------------ 8. caption styling

WORDS = [
    {"text": "Lens", "startMs": 300, "endMs": 600},
    {"text": "polishes", "startMs": 650, "endMs": 1000},
    {"text": "every", "startMs": 1050, "endMs": 1300},
    {"text": "screen", "startMs": 1350, "endMs": 1700},
    {"text": "recording", "startMs": 1750, "endMs": 2200},
    {"text": "automatically.", "startMs": 2250, "endMs": 2900},
]


def test_caption_style_and_word_highlight(synth, tmp_path):
    d, s = synth
    cap = {"enabled": True, "wordHighlight": True, "style": {"fontSize": 60, "textColor": "#ffffff", "highlightColor": "#ff00ff",
                                                            "background": {"enabled": True, "color": "#000000", "opacity": 0.9},
                                                            "position": "top", "maxWordsPerLine": 3}}
    plan = make_plan(tmp_path, s["meta"], s["events"], proj(captions=cap, cursor={"visible": False}, shortcuts={"enabled": False}), words=WORDS)
    picks = {0: 450, 1: 800, 2: 1200, 4: 2000}
    idx = {w: round(t / FRAME_MS) for w, t in picks.items()}
    for w, i in idx.items():
        assert plan["frames"][i]["caption"]["active"] == w
    assert plan["frames"][idx[4]]["caption"]["lines"] == [3, 3]
    render(str(tmp_path / "plan.json"), s["screen"], str(tmp_path / "out.mp4"), opts=RenderOptions(preset="veryfast", crf=10, max_frames=max(idx.values()) + 1))
    F = read_all_frames(str(tmp_path / "out.mp4")).astype(np.int16)
    H = F.shape[1]

    band = int(0.35 * H)  # caption sits in the top band; the synthetic UI below has random card colours

    def magenta(i):
        img = F[i, :band]
        m = (img[..., 2] > 170) & (img[..., 0] > 170) & (img[..., 1] < 100)
        ys, xs = np.nonzero(m)
        return m.sum(), (xs.mean() if len(xs) else -1), (ys.mean() if len(ys) else -1)

    c = {w: magenta(i) for w, i in idx.items()}
    assert all(v[0] > 40 for v in c.values()), c
    assert all(v[2] < 0.3 * H for v in c.values()), c  # position: top
    assert c[0][1] < c[1][1] < c[2][1]  # highlight walks along line 1
    assert c[4][2] > c[0][2] + 20  # word 4 sits on line 2
    # background pill: dark pixels in the top band, none in the bottom band
    dark = (F[idx[0]].max(axis=2) < 12)
    assert dark[: int(0.3 * H)].sum() > 2000 and dark[int(0.7 * H):].sum() < 50
    # highlight off: same caption, no highlight colour
    make_plan(tmp_path, s["meta"], s["events"], proj(captions={**cap, "wordHighlight": False}, cursor={"visible": False}, shortcuts={"enabled": False}), name="nohl", words=WORDS)
    render(str(tmp_path / "nohl.json"), s["screen"], str(tmp_path / "nohl.mp4"), opts=RenderOptions(preset="veryfast", crf=10, max_frames=idx[1] + 1))
    G = read_all_frames(str(tmp_path / "nohl.mp4")).astype(np.int16)
    g = G[idx[1], :band]
    assert ((g[..., 2] > 170) & (g[..., 0] > 170) & (g[..., 1] < 100)).sum() == 0
    ys, xs = np.nonzero(g.max(axis=2) < 12)  # the pill
    pill = g[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    assert (pill.min(axis=2) > 230).sum() > 100  # white text still drawn inside the pill


# ------------------------------------------------------------------ 9. per-segment overrides

def test_overrides_cursor_hide_size_smoothing_and_volume(synth, tmp_path):
    d, s = synth
    events = sweep((120, 120), (520, 260), 0, 1500) + sweep((520, 260), (120, 120), 1500, 1500) + sweep((120, 120), (520, 260), 3000, 1500)
    ev = write_events(tmp_path, events)
    tone = write_wav(tmp_path / "tone.wav", (0.3 * np.sin(2 * np.pi * 440 * np.arange(8 * SR) / SR)).astype(np.float32))
    overrides = [{"startMs": 1000, "endMs": 2000, "cursor": {"hidden": True}, "volume": 0.25},
                 {"startMs": 2700, "endMs": 3300, "cursor": {"smoothing": False}},
                 {"startMs": 3600, "endMs": 4400, "cursor": {"size": 3}}]
    common = dict(zoom={"auto": False}, cursor={"hideWhenIdle": False}, shortcuts={"enabled": False},
                  audio={"tracks": [{"id": "mic", "kind": "mic", "path": tone, "offsetMs": 0, "volume": 1, "muted": False}], "loudness": {"enabled": False}})
    plan = make_plan(tmp_path, s["meta"], ev, proj(overrides=overrides, **common), name="ov")
    make_plan(tmp_path, s["meta"], ev, proj(**common), name="base")
    make_plan(tmp_path, s["meta"], ev, proj(**{**common, "cursor": {"visible": False}}), name="nocur")
    n = 135
    for name in ("ov", "base", "nocur"):
        render(str(tmp_path / f"{name}.json"), s["screen"], str(tmp_path / f"{name}.mp4"), opts=RenderOptions(preset="veryfast", crf=10, max_frames=n))
    OV, BA, NC = (read_all_frames(str(tmp_path / f"{k}.mp4")).astype(np.int16) for k in ("ov", "base", "nocur"))

    def cursor_mask(F, i):
        return np.abs(F[i] - NC[i]).max(axis=2) > 40

    at = lambda ms: round(ms / FRAME_MS)  # noqa: E731
    # hidden: no cursor pixels in the range, normal cursor before it
    assert cursor_mask(BA, at(1500)).sum() > 30
    assert cursor_mask(OV, at(1500)).sum() < 5
    assert abs(int(cursor_mask(OV, at(800)).sum()) - int(cursor_mask(BA, at(800)).sum())) < 15
    # size 3 vs default 1.5: area about 4x
    ratio = cursor_mask(OV, at(4000)).sum() / cursor_mask(BA, at(4000)).sum()
    assert 3.0 < ratio < 5.0, ratio
    # smoothing off: the cursor sits on the raw path, ahead of the smoothed (lagging) one
    def centroid(F, i):
        ys, xs = np.nonzero(cursor_mask(F, i))
        return np.array([xs.mean(), ys.mean()])
    # around the direction reversal at 3.0 s the raw path turns sharply while the smoothed one rounds it
    i = at(3170)
    base_plan = json.loads((tmp_path / "base.json").read_text())
    k = plan["frames"][i]["layout"]["screen"][2] / 640  # output px per source px at scale 1
    want = (np.array(plan["frames"][i]["cur"][:2]) - np.array(base_plan["frames"][i]["cur"][:2])) * k
    got = centroid(OV, i) - centroid(BA, i)
    assert np.linalg.norm(want) > 5.0
    assert np.linalg.norm(got - want) < 2.0, (got, want)
    j = at(2500)  # before the override both renders agree
    assert np.linalg.norm(centroid(OV, j) - centroid(BA, j)) < 0.5
    # volume override: -12 dB inside [1000, 2000) relative to outside
    x = decode_mono(str(tmp_path / "ov.mp4"))
    inside, outside = rms_db(x, SR, 1100, 1900), rms_db(x, SR, 300, 900)
    assert abs((inside - outside) - 20 * math.log10(0.25)) < 1.0, (inside, outside)
    assert abs(rms_db(x, SR, 2100, 2900) - outside) < 0.5
