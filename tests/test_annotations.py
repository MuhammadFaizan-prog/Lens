"""Annotations, text slides and auto step labels (demand #4), measured on rendered exports.

Bounds (written before the first measurement, docs/Tracker.md):
  arrow draw-on     the visible tip in each export frame lies within the tips the plan gives for
                    frames i-1..i+1 (i.e. ±1 frame), with 2 px for anti-aliasing and the encode
  text              OCR (tesseract) of each text item's region in an export frame (laid out as the
                    compositor lays it out, polarity-normalised, 2x) reads >= 95% of all annotation
                    words and >= 80% of each item's words
  screen anchor     a box drawn around a target in the recording stays on it while the camera zooms
                    and pans: every edge within ±2 px of target edge + padding (both measured in pixels)
  text slides       exactly durationMs * fps / 1000 slide frames, output length grows by exactly the
                    slide; audio beeps after the slide land at their shifted times ±1 frame, and the
                    slide is silent
  step labels       >= 90% of drafted labels exactly equal the ground truth (dev and held-out
                    sessions), and 100% of badges numbered in click order
"""
from __future__ import annotations

import json
import re
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
sys.path.insert(0, str(ROOT / "redact"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lensharness.audio import decode_mono, onsets  # noqa: E402
from lens_compositor import RenderOptions, render  # noqa: E402
from media import CLI, SR, beeps, ffprobe, make_plan, read_all_frames, screen_point, write_wav  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None or not CLI.exists(), reason="engine not built (npm run build)")

W, H, FPS = 1280, 720, 30
FRAME_MS = 1000 / FPS
TARGET = (700, 380, 48, 48)  # x, y, w, h of the black target square in the recording
PAD = 12
ARROW = ((200, 600), (900, 600))
ARROW_IN = (300, 1300)  # draw-on window, source ms
SLIDE = {"id": "s1", "atMs": 2000, "durationMs": 1500, "title": "Part two", "subtitle": "Slides between segments", "fadeMs": 0,
         "background": "#0b2a6f", "textColor": "#ffffff", "accent": None}
TEXTS = {
    "title": "Annotations stay editable",
    "lower": "Lens screen recorder",
    "label": "Click the target",
    "callout": "Callouts point here",
    "badge": "Open Settings",
}
MIN_WORDS_ALL, MIN_WORDS_ITEM = 0.95, 0.80
MIN_STEP_ACC = 0.90


def _source(d: Path, dur_ms: int = 7000) -> dict:
    """Plain light screen, a black target square and a moving grey bar (so frozen frames show)."""
    n = int(dur_ms * FPS / 1000)
    base = np.full((H, W, 3), 236, np.uint8)
    x, y, w, h = TARGET
    base[y:y + h, x:x + w] = 10
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", str(d / "screen.mp4")], stdin=subprocess.PIPE)
    for i in range(n):
        f = base.copy()
        bx = 40 + (i * 7) % 300
        f[40:56, bx:bx + 60] = 150
        enc.stdin.write(f.tobytes())
    enc.stdin.close()
    enc.wait()
    (d / "meta.json").write_text(json.dumps({"width": W, "height": H, "fps": FPS, "durationMs": dur_ms, "pixelRatio": 1}))
    ev = [{"t": 0, "type": "move", "x": 100, "y": 680}, {"t": 6900, "type": "move", "x": 101, "y": 680}]
    (d / "events.jsonl").write_text("\n".join(json.dumps(e) for e in ev) + "\n")
    return {"screen": str(d / "screen.mp4"), "meta": str(d / "meta.json"), "events": str(d / "events.jsonl")}


def _project(mic: str) -> dict:
    tx, ty, tw, th = TARGET
    none = {"kind": "none", "ms": 0}
    return {
        "version": 1,
        "output": {"aspect": "16:9", "resolution": 720, "fps": FPS},
        "background": {"kind": "solid", "colors": ["#3a3f4b"]},
        "motionBlur": {"enabled": False},
        "cursor": {"visible": False},
        "zoom": {"auto": False, "segments": [{"id": "z", "startMs": 2600, "endMs": 6600, "scale": 2.0, "focus": {"x": 760, "y": 420},
                                               "style": "classic", "auto": False}]},
        "audio": {"tracks": [{"id": "mic", "kind": "mic", "path": mic, "offsetMs": 0, "volume": 1, "muted": False}], "loudness": {"enabled": False}},
        "slides": [SLIDE],
        "annotations": [
            {"id": "arrow", "kind": "arrow", "startMs": ARROW_IN[0], "endMs": 1900, "from": {"x": ARROW[0][0], "y": ARROW[0][1]},
             "to": {"x": ARROW[1][0], "y": ARROW[1][1]}, "in": {"kind": "draw", "ms": ARROW_IN[1] - ARROW_IN[0]}, "out": none,
             "style": {"color": "#00a8ff", "strokeWidth": 6, "shadow": {"enabled": False}}},
            {"id": "box", "kind": "rect", "startMs": 2400, "endMs": 6900, "rect": {"x": tx - PAD, "y": ty - PAD, "w": tw + 2 * PAD, "h": th + 2 * PAD},
             "in": none, "out": none, "style": {"color": "#e8132a", "strokeWidth": 4, "fill": None, "radius": 0, "shadow": {"enabled": False}}},
            {"id": "title", "kind": "text", "role": "title", "anchor": "frame", "startMs": 4000, "endMs": 6900, "rect": {"x": 0.1, "y": 0.05, "w": 0.8, "h": 0},
             "align": "center", "text": TEXTS["title"], "style": {"fontSize": 60, "fill": "#11131a", "fillOpacity": 0.75}},
            {"id": "lower", "kind": "text", "role": "lower-third", "anchor": "frame", "startMs": 4000, "endMs": 6900, "rect": {"x": 0.08, "y": 0.8, "w": 0.6, "h": 0},
             "text": TEXTS["lower"], "in": {"kind": "typewriter", "ms": 600}, "style": {"fontSize": 44, "strokeWidth": 8, "fill": "#11131a", "fillOpacity": 0.8}},
            {"id": "label", "kind": "text", "anchor": "screen", "startMs": 4000, "endMs": 6900, "rect": {"x": 640, "y": 470, "w": 0, "h": 0},
             "text": TEXTS["label"], "style": {"fontSize": 22, "fill": "#11131a", "fillOpacity": 0.8}},
            {"id": "callout", "kind": "callout", "anchor": "frame", "startMs": 4000, "endMs": 6900, "rect": {"x": 0.62, "y": 0.62, "w": 0.3, "h": 0.1},
             "to": {"x": 0.55, "y": 0.5}, "text": TEXTS["callout"]},
            {"id": "badge", "kind": "badge", "anchor": "frame", "startMs": 4000, "endMs": 6900, "at": {"x": 0.08, "y": 0.62}, "size": 26, "text": TEXTS["badge"],
             "style": {"fontSize": 34}},
        ],
    }


@pytest.fixture(scope="module")
def export(tmp_path_factory):
    d = tmp_path_factory.mktemp("ann")
    s = _source(d)
    mic = write_wav(d / "mic.wav", beeps([1000, 3000, 5000], 7000))
    plan = make_plan(d, s["meta"], s["events"], _project(mic))
    out = d / "out.mp4"
    info = render(str(d / "plan.json"), s["screen"], str(out), opts=RenderOptions(preset="veryfast", crf=14))
    frames = read_all_frames(str(out))
    return {"dir": d, "plan": plan, "out": str(out), "info": info, "frames": frames}


def _ann(f: dict, id_: str) -> dict | None:
    return next((a for a in f["annotations"] if a["id"] == id_), None)


def test_arrow_draw_on_matches_plan_within_one_frame(export):
    plan, frames = export["plan"], export["frames"]
    idx = [i for i, f in enumerate(plan["frames"]) if _ann(f, "arrow")]
    assert idx, "arrow never on screen"
    (x0, y0), (x1, y1) = (screen_point(plan["frames"][idx[0]], plan, *ARROW[0]), screen_point(plan["frames"][idx[0]], plan, *ARROW[1]))

    def plan_tip(i: int) -> float:
        a = _ann(plan["frames"][i], "arrow") if 0 <= i < len(plan["frames"]) else None
        if a is None:
            return x0 if i < idx[0] else x1
        return x0 + (x1 - x0) * a["anim"]["draw"]

    checked = 0
    worst = 0.0
    for i in idx:
        # coverage of the arrow colour per pixel: projection of (pixel - background) onto
        # (arrow colour - background), so the thin anti-aliased point of the head still counts
        cx0 = int(x0) - 10  # only the arrow's own stretch of the screen (the backdrop outside is darker)
        band = frames[i][int(y0) - 30:int(y0) + 30, cx0:int(x1) + 20].astype(np.float32)
        bg_c = np.array([236, 236, 236], np.float32)
        ac = np.array([255, 168, 0], np.float32) - bg_c  # #00a8ff in BGR
        cov = ((band - bg_c) @ ac) / float(ac @ ac)
        resid = np.abs(band - (bg_c + cov[..., None] * ac)).max(axis=2)
        cols = np.where(((cov > 0.25) & (resid < 40)).any(axis=0))[0] + cx0
        if len(cols) == 0:
            assert plan_tip(i) - x0 < 8, f"frame {i}: nothing drawn, plan tip {plan_tip(i) - x0:.1f} px in"
            continue
        tip = cols.max() + 1  # right edge of the drawn head
        lo = min(plan_tip(i - 1), plan_tip(i), plan_tip(i + 1)) - 2
        hi = max(plan_tip(i - 1), plan_tip(i), plan_tip(i + 1)) + 2
        assert lo <= tip <= hi, f"frame {i}: tip at {tip:.1f}, plan {plan_tip(i):.1f} (±1 frame: {lo:.1f}..{hi:.1f})"
        checked += 1
        worst = max(worst, abs(tip - plan_tip(i)))
    print(f"arrow draw-on: {checked} frames inside ±1 frame, largest |tip - plan tip| {worst:.2f} px")
    assert checked >= 20


def test_screen_anchored_box_stays_on_target_while_zoomed(export):
    plan, frames = export["plan"], export["frames"]
    tx, ty, tw, th = TARGET
    idx = [i for i, f in enumerate(plan["frames"]) if _ann(f, "box") and not f["slide"]]
    scales = [plan["frames"][i]["cam"][2] for i in idx]
    assert max(scales) >= 1.9 and min(scales) <= 1.2, "the box must be checked through the zoom in, hold and out"
    worst = 0.0
    for i in idx:
        # search window: the plan's mapping of the padded target, grown by 30 px (the orange badge and
        # lower-third bar elsewhere on the frame have red-ish anti-aliased edges)
        fp = plan["frames"][i]
        (wx0, wy0), (wx1, wy1) = screen_point(fp, plan, tx - PAD, ty - PAD), screen_point(fp, plan, tx + tw + PAD, ty + th + PAD)
        win = np.zeros(frames[i].shape[:2], bool)
        win[max(0, int(wy0) - 30):int(wy1) + 30, max(0, int(wx0) - 30):int(wx1) + 30] = True
        fr = frames[i].astype(np.int16)
        b, g, r = fr[..., 0], fr[..., 1], fr[..., 2]
        red = (r > 160) & (g < 90) & (b < 110) & win
        ry, rx = np.where(red)
        assert len(rx) > 50, f"frame {i}: box not drawn"
        # target box from its dark pixels inside the drawn box (text backings elsewhere are dark too)
        inner = np.zeros_like(red)
        inner[ry.min():ry.max() + 1, rx.min():rx.max() + 1] = True
        ys, xs = np.where((r < 70) & (g < 70) & (b < 70) & inner)
        assert len(xs) > 100, f"frame {i}: target not found"
        t0x, t1x, t0y, t1y = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        k = plan["frames"][i]["layout"]["screen"][2] / (plan["source"]["crop"][2] / plan["frames"][i]["cam"][2])
        sw = 4 * k
        o0x, o1x, o0y, o1y = rx.min(), rx.max() + 1, ry.min(), ry.max() + 1
        box = (o0x + sw / 2, o1x - sw / 2, o0y + sw / 2, o1y - sw / 2)
        want = (t0x - PAD * k, t1x + PAD * k, t0y - PAD * k, t1y + PAD * k)
        err = max(abs(a - b) for a, b in zip(box, want))
        worst = max(worst, err)
        assert err <= 2.0, f"frame {i} (zoom {plan['frames'][i]['cam'][2]:.2f}): box {box} vs target+pad {want}"
    print(f"screen-anchored box: {len(idx)} frames, worst edge error {worst:.2f} px")


def _ocr_words(img: np.ndarray, psm: int = 7) -> list[str]:
    """OCR one text region: grey, dark text on light (inverted when the region is mostly dark), 2x."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if g.mean() < 128:
        g = 255 - g
    g = cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    p = subprocess.run(["tesseract", "stdin", "stdout", "--psm", str(psm), "-l", "eng"], input=cv2.imencode(".png", g)[1].tobytes(), capture_output=True)
    return [w.lower() for w in re.findall(r"[A-Za-z0-9]+", p.stdout.decode(errors="replace"))]


def _text_regions(plan: dict, f: dict, id_: str) -> list[tuple[int, int, int, int]]:
    """Output-px boxes of an item's text ops (laid out exactly as the compositor does), + backing + 6 px."""
    from lens_compositor.annotations import text_geometry

    a = _ann(f, id_)
    out = []
    for o in a["ops"]:
        if o["op"] != "text" or o["text"].isdigit():
            continue
        if a["space"] == "screen":
            k = f["layout"]["screen"][2] / (plan["source"]["crop"][2] / f["cam"][2])
            x, y = screen_point(f, plan, o["x"], o["y"])
        else:
            k, (x, y) = 1.0, (o["x"], o["y"])
        g = text_geometry(o, x, y, k)
        bx, by, bw, bh = g["box"]
        px, py = ((o["bg"]["padX"] * k, o["bg"]["padY"] * k) if o.get("bg") else (0, 0))
        out.append((int(bx - px - 6), int(by - py - 6), int(bx + bw + px + 6), int(by + bh + py + 6)))
    return out


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract not installed")
def test_annotation_text_is_readable_in_export(export):
    plan, frames = export["plan"], export["frames"]
    # a frame where every text item is fully in (typewriter done, fades done)
    i = next(i for i, f in enumerate(plan["frames"]) if all((a := _ann(f, k)) and a["opacity"] >= 0.999 and a["anim"]["chars"] == -1 for k in TEXTS))
    f = plan["frames"][i]
    total = found = 0
    for k, text in TEXTS.items():
        read: list[str] = []
        for x0, y0, x1, y1 in _text_regions(plan, f, k):
            read += _ocr_words(frames[i][max(0, y0):y1, max(0, x0):x1], psm=6)
        ws = [w.lower() for w in re.findall(r"[A-Za-z0-9]+", text)]
        hit = sum(w in read for w in ws)
        total += len(ws)
        found += hit
        print(f"  {k}: {hit}/{len(ws)} read {read}")
        assert hit / len(ws) >= MIN_WORDS_ITEM, f"{k}: read {hit}/{len(ws)} words of {text!r} ({read})"
    print(f"annotation text OCR: {found}/{total} words")
    assert found / total >= MIN_WORDS_ALL


def test_text_slide_exact_duration_and_audio_sync(export, tmp_path):
    plan, frames = export["plan"], export["frames"]
    n_slide = int(round(SLIDE["durationMs"] * FPS / 1000))
    assert plan["output"]["frames"] == int(round(7000 * FPS / 1000)) + n_slide
    v = ffprobe(export["out"], "stream=nb_frames,duration", count=False)["streams"][0]
    assert int(v["nb_frames"]) == plan["output"]["frames"]
    # slide frames: the slide's background colour covers the frame (BGR of #0b2a6f)
    bgc = np.array([0x6f, 0x2a, 0x0b], np.int16)
    is_slide = [float((np.abs(f[::8, ::8].astype(np.int16) - bgc).max(axis=2) < 14).mean()) > 0.8 for f in frames]
    runs = [i for i, s in enumerate(is_slide) if s]
    assert len(runs) == n_slide, f"{len(runs)} slide frames, want {n_slide}"
    assert runs == list(range(runs[0], runs[0] + n_slide))
    assert runs[0] == int(round(SLIDE["atMs"] * FPS / 1000))
    # audio: source beeps at 1000, 3000, 5000 ms -> output 1000, 4500, 6500; nothing during the slide
    x = decode_mono(export["out"])
    got = onsets(x, SR, rel_threshold=0.3)
    want = [1000, 3000 + SLIDE["durationMs"], 5000 + SLIDE["durationMs"]]
    assert len(got) == len(want), got
    for g_, w_ in zip(got, want):
        assert abs(g_ - w_) <= FRAME_MS, (got, want)
    a = ffprobe(export["out"], "stream=duration", stream="a:0")["streams"][0]
    assert abs(float(a["duration"]) - plan["output"]["durationMs"] / 1000) < 0.05
    s0 = int(SLIDE["atMs"] / 1000 * SR)
    s1 = int((SLIDE["atMs"] + SLIDE["durationMs"]) / 1000 * SR)
    assert np.abs(x[s0 + 200:s1 - 200]).max() < 1e-3, "slide must be silent"


# ------------------------------------------------------------------ auto step labels

def _steps_session(d: Path, variant: str) -> tuple[dict, dict]:
    from lensharness.steps_synth import generate
    from lens_redact.steps import step_labels

    gt = generate(d, variant)
    res = step_labels(str(d / "screen.mp4"), str(d / "events.jsonl"))
    (d / "steps.json").write_text(json.dumps(res))
    return gt, res


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract not installed")
@pytest.mark.parametrize("variant", ["dev", "heldout"])
def test_step_label_accuracy(tmp_path, variant):
    gt, res = _steps_session(tmp_path, variant)
    drafts = res["drafts"]
    assert len(drafts) == len(gt["steps"])
    exact = 0
    rows = []
    for g, dr in zip(gt["steps"], drafts):
        assert abs(g["clickMs"] - dr["clickMs"]) < 1
        ok = dr["label"] == g["label"]
        exact += ok
        rows.append(f"{'ok ' if ok else 'BAD'} {g['label']!r:28} -> {dr['label']!r}")
    acc = exact / len(drafts)
    print(f"step labels ({variant}): {exact}/{len(drafts)} exact = {acc:.3f}\n" + "\n".join(rows))
    (tmp_path / "accuracy.txt").write_text(f"{acc}\n" + "\n".join(rows))
    assert acc >= MIN_STEP_ACC, "\n".join(rows)

    # numbering: accept every draft, build the plan, read the badge numbers the plan draws
    plan_path = tmp_path / "plan.json"
    proj = tmp_path / "p.json"
    proj.write_text(json.dumps({"version": 1, "output": {"fps": 30, "resolution": 720}}))
    subprocess.run(["node", str(CLI), "--meta", str(tmp_path / "meta.json"), "--events", str(tmp_path / "events.jsonl"), "--project", str(proj),
                    "--step-labels", str(tmp_path / "steps.json"), "--accept-steps", "--out", str(plan_path)], check=True, capture_output=True)
    plan = json.loads(plan_path.read_text())
    shown: dict[str, int] = {}
    for f in plan["frames"]:
        for a in f["annotations"]:
            if a["kind"] == "badge":
                num = next(o["text"] for o in a["ops"] if o["op"] == "text" and o["text"].isdigit())
                shown.setdefault(a["id"], int(num))
    order = sorted(drafts, key=lambda d: d["clickMs"])
    want = {f"step-{d['id']}": i + 1 for i, d in enumerate(order)}
    assert shown == want, (shown, want)
