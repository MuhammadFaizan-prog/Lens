"""On-device caption translation (demand #8).

Bounds (written before the first measurement, docs/Tracker.md):
  quality       chrF (sacrebleu chrF2 definition, tests/chrf.py) of the local models on 24 fixed English
                UI / tutorial sentences against references written by hand and frozen before any
                model translated them (tests/data/translation_refs.json): es, fr, de >= 45. Urdu is
                reported with no threshold.
  segments      the Python segmenter (translate/lens_translate/segment.py) and the engine's
                segmentTranscript give identical segments
  CLI           lens-translate writes a track, an SRT and a VTT per language; every cue lies inside
                its segment's source span; SRT and VTT carry the same cues; --project adds the
                tracks and selects the language
  timing        in a render plan with the Spanish track burned in (with a cut and a removed filler):
                every caption frame shows words of one segment while the frame's source time is
                inside that segment's span, and the highlighted word index never moves backwards
                within a caption block
  render        Tesseract (spa) reads >= 80% of each Spanish caption block's words from the exported MP4
  right-to-left an Urdu and an Arabic caption drawn by the compositor (word-level bidi from the engine,
                each word shaped with RAQM) match a whole-line reference shaped by libraqm (HarfBuzz +
                FriBiDi, Unicode bidi): ink IoU >= 0.90; the same words drawn in logical (left-to-right)
                order score < 0.60 against the reference (the check can tell the difference)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compositor"))
sys.path.insert(0, str(ROOT / "translate"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from chrf import chrf  # noqa: E402
from media import CLI, make_plan, read_all_frames  # noqa: E402

ENGINE_INDEX = ROOT / "packages" / "engine" / "dist" / "index.js"
LT = ROOT / "translate" / "lens-translate"
REFS = json.loads((ROOT / "tests" / "data" / "translation_refs.json").read_text())

needs_engine = pytest.mark.skipif(shutil.which("node") is None or not CLI.exists(), reason="engine not built (npm run build)")


def _have_mt() -> bool:
    try:
        import ctranslate2  # noqa: F401
        import sentencepiece  # noqa: F401
    except ImportError:
        return False
    return True


needs_mt = pytest.mark.skipif(not _have_mt(), reason="pip install ctranslate2 sentencepiece")
OCR_RECALL_MIN = 0.80
CHRF_MIN = REFS["thresholds"]
IOU_MIN, IOU_WRONG_MAX = 0.90, 0.60


def node_eval(expr: str, data) -> object:
    """Evaluate `expr` (with `m` = the built engine, `d` = data) in node; returns its JSON."""
    js = f"import(process.argv[1]).then((m) => {{ const d = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(JSON.stringify({expr})); }})"
    r = subprocess.run(["node", "-e", js, ENGINE_INDEX.as_uri()], input=json.dumps(data), capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


# ---------------------------------------------------------------- quality

@needs_mt
def test_translation_quality_chrf():
    from lens_translate.mt import MTOptions, Translator

    en = REFS["en"]
    n_words = sum(len(s.split()) for s in en)
    scores, speed = {}, {}
    for lang in ["es", "fr", "de", "ur"]:
        tr = Translator(lang, MTOptions())
        t0 = time.time()
        hyps = tr.translate(en)
        dt = time.time() - t0
        scores[lang] = chrf(hyps, REFS[lang])
        speed[lang] = (n_words / dt, tr.load_s)
        try:
            import sacrebleu

            assert abs(sacrebleu.corpus_chrf(hyps, [REFS[lang]]).score - scores[lang]) < 1e-6
        except ImportError:
            pass
        print(f"\n{lang}: chrF {scores[lang]:.1f}  ({n_words} source words in {dt:.2f}s = {n_words / dt:.0f} words/s, "
              f"model load {tr.load_s:.2f}s, {tr.info.dirname}, {tr.info.licence})")
        for s, h, r in list(zip(en, hyps, REFS[lang]))[:4]:
            print(f"   {s}\n   -> {h}\n   ref {r}")
    out = ROOT / "out"
    out.mkdir(exist_ok=True)
    (out / "translation-quality.json").write_text(json.dumps({"chrf": scores, "wordsPerSecond": {k: v[0] for k, v in speed.items()},
                                                             "loadSeconds": {k: v[1] for k, v in speed.items()}}, indent=1))
    for lang, lo in CHRF_MIN.items():
        if lo is not None:
            assert scores[lang] >= lo, (lang, scores[lang])


# ---------------------------------------------------------------- segments and CLI

SRC_WORDS = [
    # "Open the project panel." / "Then um choose a new color for the background, and press Apply." / "Done."
    ("Open", 300, 550), ("the", 600, 700), ("project", 750, 1150), ("panel.", 1200, 1650),
    ("Then", 2400, 2650), ("um", 2700, 3050), ("choose", 3100, 3450), ("a", 3500, 3550), ("new", 3600, 3800),
    ("color", 3850, 4200), ("for", 4250, 4400), ("the", 4450, 4550), ("background,", 4600, 5200),
    ("and", 6000, 6150), ("press", 6200, 6500), ("Apply.", 6550, 6950),
    ("Your", 7500, 7700), ("changes", 7750, 8150), ("are", 8200, 8300), ("saved.", 8350, 8900),
]
DUR = 9500


def _transcript(words=SRC_WORDS) -> dict:
    ws = [{"text": t, "startMs": s, "endMs": e, "confidence": 0.9, **({"filler": True} if t == "um" else {})} for t, s, e in words]
    return {"version": 1, "language": "en", "durationMs": DUR, "words": ws}


@needs_engine
def test_segments_match_engine():
    from lens_translate.segment import segment_transcript

    long = [{"text": ("word," if i % 9 == 8 else "word"), "startMs": i * 210, "endMs": i * 210 + 160} for i in range(60)]
    long[30]["filler"] = True
    long[31]["inferred"] = True
    long.insert(40, {"text": "uh", "startMs": 40 * 210 - 40, "endMs": 40 * 210 - 10})
    for words in [_transcript()["words"], long, json.loads((ROOT / "apps" / "editor" / "sample" / "transcript.json").read_text())["words"]
                  if (ROOT / "apps" / "editor" / "sample" / "transcript.json").exists() else []]:
        py = segment_transcript(words)
        ts = node_eval("m.segmentTranscript(d, (w) => m.isFiller(w))", words)
        assert py == ts
        assert py


@needs_engine
@needs_mt
def test_cli_writes_tracks_srt_vtt_and_project(tmp_path):
    tp = tmp_path / "transcript.json"
    tp.write_text(json.dumps(_transcript()))
    proj = tmp_path / "project.json"
    proj.write_text(json.dumps({"version": 1, "captions": {"enabled": True}}))
    r = subprocess.run([sys.executable, str(LT), str(tp), "--to", "es,ur", "-o", str(tmp_path / "out"), "--project", str(proj), "--select", "es"],
                       capture_output=True, text=True)
    print(r.stderr)
    assert r.returncode == 0, r.stderr
    p = json.loads(proj.read_text())
    assert p["translations"]["language"] == "es"
    assert [t["language"] for t in p["translations"]["tracks"]] == ["es", "ur"]
    for lang in ["es", "ur"]:
        track = json.loads((tmp_path / "out" / f"{lang}.track.json").read_text())
        assert track["rtl"] == (lang == "ur")
        assert [s["source"] for s in track["segments"]] == ["Open the project panel.", "Then choose a new color for the background,",
                                                            "and press Apply.", "Your changes are saved."]
        assert all(s["text"] for s in track["segments"])
        srt = _parse_srt((tmp_path / "out" / f"{lang}.srt").read_text())
        vtt = _parse_vtt((tmp_path / "out" / f"{lang}.vtt").read_text())
        assert srt == vtt and len(srt) >= len(track["segments"])
        seg_words = [s["text"].split() for s in track["segments"]]
        assert sum(len(c[2].split()) for c in srt) == sum(len(w) for w in seg_words)  # every translated word, once
        for a, b, text in srt:
            assert any(s["startMs"] <= a and b <= s["endMs"] for s in track["segments"]), (a, b, text)
            for line in text.split("\n"):
                assert len(line) <= 42 or " " not in line  # wrapped like the burned-in caption
        if lang == "ur":
            assert any(re.search(r"[\u0600-\u06FF]", c[2]) for c in srt)


def _ms(s: str) -> int:
    h, m, rest = s.replace(",", ".").split(":")
    sec, ms = rest.split(".")
    return int(h) * 3600000 + int(m) * 60000 + int(sec) * 1000 + int(ms)


def _parse_srt(text: str) -> list[tuple[int, int, str]]:
    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.split("\n")
        a, b = lines[1].split(" --> ")
        out.append((_ms(a), _ms(b), "\n".join(lines[2:])))
    return out


def _parse_vtt(text: str) -> list[tuple[int, int, str]]:
    assert text.startswith("WEBVTT")
    out = []
    for block in re.split(r"\n\s*\n", text.strip())[1:]:
        lines = block.split("\n")
        if lines[0].startswith("NOTE"):
            continue
        i = next(k for k, l in enumerate(lines) if "-->" in l)
        a, b = lines[i].split(" --> ")
        out.append((_ms(a), _ms(b), "\n".join(lines[i + 1:])))
    return out


# ---------------------------------------------------------------- plan timing + render (Spanish)

W, H, FPS = 1280, 720, 30


def _source(d: Path) -> dict:
    n = int(DUR * FPS / 1000)
    base = np.full((H, W, 3), 228, np.uint8)
    cv2.rectangle(base, (80, 80), (1200, 600), (250, 250, 250), -1)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", str(d / "screen.mp4")],
                   input=base.tobytes() * n, check=True)
    (d / "meta.json").write_text(json.dumps({"width": W, "height": H, "fps": FPS, "durationMs": DUR, "pixelRatio": 1}))
    ev = [{"t": 0, "type": "move", "x": 100, "y": 100}, {"t": DUR - 100, "type": "move", "x": 101, "y": 100}]
    (d / "events.jsonl").write_text("\n".join(json.dumps(e) for e in ev) + "\n")
    return {"screen": str(d / "screen.mp4"), "meta": str(d / "meta.json"), "events": str(d / "events.jsonl")}


@pytest.fixture(scope="module")
def spanish(tmp_path_factory):
    if shutil.which("node") is None or not CLI.exists() or not _have_mt():
        pytest.skip("needs the built engine and ctranslate2")
    d = tmp_path_factory.mktemp("translate")
    s = _source(d)
    tp = d / "transcript.json"
    tp.write_text(json.dumps(_transcript()))
    subprocess.run([sys.executable, str(LT), str(tp), "--to", "es", "-o", str(d / "tr")], check=True, capture_output=True)
    track = json.loads((d / "tr" / "es.track.json").read_text())
    project = {
        "version": 1,
        "output": {"aspect": "16:9", "resolution": 720, "fps": FPS},
        "motionBlur": {"enabled": False},
        "cursor": {"visible": False},
        "zoom": {"auto": False},
        "audio": {"loudness": {"enabled": False}},
        # a cut inside the second sentence's pause and filler removal: timing must follow both
        "edits": {"cuts": [{"startMs": 5300, "endMs": 5800}], "cleanup": {"enabled": True, "removeFillers": True, "shortenPauses": False}},
        "captions": {"enabled": True, "maxWordsPerBlock": 6, "style": {"fontSize": 54, "maxWordsPerLine": 6}},
        "translations": {"language": "es", "tracks": [track]},
    }
    plan = make_plan(d, s["meta"], s["events"], project, name="es", words=_transcript()["words"])
    from lens_compositor import RenderOptions, render

    out = d / "es.mp4"
    t0 = time.time()
    render(str(d / "es.json"), s["screen"], str(out), None, RenderOptions(preset="veryfast", audio=False, asset_dir=str(d)))
    print(f"\nrendered {plan['output']['frames']} frames in {time.time() - t0:.1f}s")
    return d, track, plan, out


def test_translated_timing_stays_in_segments_and_highlight_is_monotonic(spanish):
    _, track, plan, _ = spanish
    segs = [s["text"].split() for s in track["segments"]]
    last_text, last_active, n = None, -1, 0
    for f in plan["frames"]:
        cap = f["caption"]
        if not cap:
            continue
        n += 1
        words = cap["words"]
        # the segment this block comes from: its words are a contiguous run of exactly one segment
        owners = [k for k, sw in enumerate(segs) if any(sw[i:i + len(words)] == words for i in range(len(sw) - len(words) + 1))]
        assert owners, words
        seg = track["segments"][owners[0]]
        assert seg["startMs"] <= f["src"] <= seg["endMs"], (f["src"], seg)
        if cap["text"] != last_text:
            last_text, last_active = cap["text"], -1
        assert cap["active"] >= last_active
        last_active = cap["active"]
        assert not any(c["startMs"] <= f["src"] < c["endMs"] for c in plan["cuts"])
    assert n > 100
    # the subtitles the plan carries are on the output clock (500 ms cut + filler removed before them)
    assert plan["subtitles"][0]["text"].split()[0] == segs[0][0]
    assert plan["subtitles"][-1]["endMs"] <= plan["output"]["durationMs"]


def _norm(w: str) -> str:
    w = unicodedata.normalize("NFC", w.lower())
    return "".join(ch for ch in w if unicodedata.category(ch)[0] in "LN")


def _ocr_spa(img: np.ndarray) -> list[str]:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    _, bw = cv2.threshold(g, 128, 255, cv2.THRESH_BINARY_INV)
    p = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "6", "-l", "spa"], input=cv2.imencode(".png", bw)[1].tobytes(), capture_output=True, check=True)
    return [t for t in (_norm(w) for w in p.stdout.decode(errors="replace").split()) if t]


def _has_spa() -> bool:
    if shutil.which("tesseract") is None:
        return False
    r = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True)
    return "spa" in (r.stdout + r.stderr).split()


@pytest.mark.skipif(not _has_spa(), reason="needs tesseract-ocr-spa")
def test_burned_in_spanish_captions_read_back(spanish):
    d, _, plan, out = spanish
    frames = read_all_frames(str(out))
    assert len(frames) == plan["output"]["frames"]
    blocks: dict[str, list[int]] = {}
    for i, f in enumerate(plan["frames"]):
        if f["caption"]:
            blocks.setdefault(f["caption"]["text"], []).append(i)
    total = found = 0
    for text, idx in blocks.items():
        words = [_norm(w) for w in text.split() if _norm(w)]
        i = idx[len(idx) // 2]
        got = _ocr_spa(frames[i, int(0.62 * H):])
        hit = sum(1 for w in words if w in got)
        print(f"frame {i}: {text!r} -> {got} ({hit}/{len(words)})")
        assert hit >= OCR_RECALL_MIN * len(words), (text, got)
        total += len(words)
        found += hit
    print(f"Spanish OCR word recall {found}/{total} = {found / total:.3f} over {len(blocks)} blocks")
    assert len(blocks) >= 3
    sample = frames[blocks[next(iter(blocks))][0]]
    cv2.imwrite(str(ROOT / "out" / "translate-es-frame.png"), sample) if (ROOT / "out").exists() else None


# ---------------------------------------------------------------- right-to-left


# Arabic-script only: the reference is one font (Noto Naskh Arabic has no Latin glyphs). The first
# version of this test used the mixed strings below here too and rendered Latin as missing-glyph boxes.
RTL_CASES = {
    "ur": "پھر سیٹنگز میں محفوظ کریں پر کلک کریں۔",
    "ar": "انقر على زر الحفظ في الشريط العلوي الآن.",
}
# Mixed scripts: a left-to-right run (a product name) inside right-to-left text, in the default caption font.
MIXED_CASES = {
    "ur": ("پھر Lens Studio میں محفوظ کریں پر کلک کریں۔", ["Lens", "Studio"]),
    "ar": ("انقر على زر الحفظ في Lens Studio الآن.", ["Lens", "Studio"]),
}
FAM = "Noto Naskh Arabic"


def _ink(img) -> np.ndarray:
    return np.asarray(img)[..., 3] > 128


def _set_arabic_font():
    from lens_compositor import annotations as ann

    ann.set_fonts([{"family": FAM, "regular": "builtin:NotoNaskhArabic-Regular.ttf", "bold": "builtin:NotoNaskhArabic-Bold.ttf"}], None)


def _draw(words, order, cs, active=-1, size=(1400, 240)):
    from PIL import Image, ImageDraw

    from lens_compositor.render import draw_caption

    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw_caption(ImageDraw.Draw(img), {"text": " ".join(words), "words": words, "lines": [len(words)], "active": active, "visual": [order]}, cs, *size)
    return img


@needs_engine
@pytest.mark.parametrize("lang", list(RTL_CASES))
def test_rtl_caption_matches_a_shaped_reference(lang):
    from PIL import Image, ImageDraw, ImageFont, features

    assert features.check("raqm"), "Pillow needs libraqm for right-to-left captions"
    text = RTL_CASES[lang]
    words = text.split()
    idx = list(range(len(words)))
    visual = node_eval("m.visualOrderRtl(d.words, d.idx)", {"words": words, "idx": idx})
    _set_arabic_font()
    cs = {"fontSize": 48, "font": FAM, "scriptFont": FAM, "background": {"enabled": False}, "wordHighlight": False,
          "textColor": "#ffffff", "position": "custom", "y": 0.5}
    Wd, Hd = 1400, 240
    ours = _draw(words, visual, cs)
    wrong = _draw(words, idx, cs)
    # reference: the whole line shaped and reordered by libraqm (HarfBuzz + FriBiDi), same font, size and baseline
    font = ImageFont.truetype(str(ROOT / "assets" / "fonts" / "NotoNaskhArabic-Bold.ttf"), 48, layout_engine=ImageFont.Layout.RAQM)
    ref = Image.new("RGBA", (Wd, Hd), (0, 0, 0, 0))
    d = ImageDraw.Draw(ref)
    tw = d.textlength(text, font=font, direction="rtl", features=["-kern"])
    asc, desc = font.getmetrics()
    lh = int((asc + desc) * 1.12)
    top = int(0.5 * Hd - lh / 2)
    d.text(((Wd - tw) / 2, top), text, font=font, fill=(255, 255, 255, 255), direction="rtl", features=["-kern"])
    a, b, c = _ink(ours), _ink(ref), _ink(wrong)
    iou = (a & b).sum() / max(1, (a | b).sum())
    iou_wrong = (c & b).sum() / max(1, (c | b).sum())
    print(f"\n{lang}: visual order {visual}; ink IoU vs libraqm reference {iou:.3f}, logical-order control {iou_wrong:.3f}")
    out = ROOT / "out"
    if out.exists():
        strip = np.vstack([np.asarray(im.convert("RGB")) for im in (ours, ref, wrong)])
        cv2.imwrite(str(out / f"translate-rtl-{lang}.png"), strip[..., ::-1])
    assert visual == idx[::-1]
    assert iou >= IOU_MIN
    assert iou_wrong < IOU_WRONG_MAX


@needs_engine
@pytest.mark.parametrize("lang", list(MIXED_CASES))
def test_rtl_glyph_order_with_a_latin_run(lang):
    """Each word lit in turn (highlight colour): word centres run right to left in logical order,
    except the Latin run, which keeps its own left-to-right order inside the line."""
    text, latin = MIXED_CASES[lang]
    words = text.split()
    visual = node_eval("m.visualOrderRtl(d.words, d.idx)", {"words": words, "idx": list(range(len(words)))})
    _set_arabic_font()
    cs = {"fontSize": 48, "scriptFont": FAM, "background": {"enabled": False}, "wordHighlight": True,
          "highlightColor": "#ff0000", "textColor": "#00ff00", "position": "custom", "y": 0.5}
    xs = []
    for j in range(len(words)):
        a = np.asarray(_draw(words, visual, cs, active=j))
        red = (a[..., 0] > 200) & (a[..., 1] < 60) & (a[..., 3] > 128)
        assert red.any(), words[j]
        xs.append(float(np.nonzero(red)[1].mean()))
    li = [words.index(w) for w in latin]
    print(f"\n{lang}: word centres (logical order) {[round(x) for x in xs]}")
    rtl = [x for k, x in enumerate(xs) if k not in li]
    assert all(p > q for p, q in zip(rtl, rtl[1:]))           # right to left
    assert xs[li[0]] < xs[li[1]]                              # the Latin run reads left to right
    before, after = xs[li[0] - 1], xs[li[-1] + 1]
    assert after < xs[li[0]] < xs[li[1]] < before              # and sits where the bidi algorithm puts it
