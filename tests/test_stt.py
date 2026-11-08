"""Local speech-to-text (AI-01) and transcript cleanup from real audio (E03).

Speech is synthesized here with espeak-ng (no downloaded clips) and recognised on-device with
faster-whisper base.en (MIT). Bounds are stated once below; docs/Tracker.md records them and any
change to them with its reason.

- WER on known connected sentences: <= 10% clean, <= 15% with -50 dBFS room tone.
- Word starts, speech with pauses between words: every matched word within +-150 ms of the
  boundary measured from the clean signal's energy envelope; >= 90% of words matched.
- Word starts, connected speech (no pauses), against the synthesizer's own word events:
  median <= 120 ms, p95 <= 300 ms.
- Every inserted hesitation (um / uh / er, drawn out as people say them) is flagged as a filler,
  no content word is, and cleanup removes them from the rendered video: re-transcribing the export
  finds no fillers.
- Captions in the rendered video carry the transcribed words (OCR of sampled frames).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "transcribe"))
sys.path.insert(0, str(ROOT / "compositor"))
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lens_transcribe import TranscribeOptions, align, fillers as F, merge_fillers, transcribe_array, vad  # noqa: E402
from lens_transcribe.audio import decode_audio  # noqa: E402
from media import CLI, read_all_frames, write_wav  # noqa: E402
from speech import ESPEAK, SR, add_noise, hesitant_ssml, norm, pad, tts, tts_with_word_starts, wer_counts, word_runs  # noqa: E402

try:
    import faster_whisper  # noqa: F401

    HAVE_FW = True
except ImportError:
    HAVE_FW = False

needs_model = pytest.mark.skipif(not (HAVE_FW and ESPEAK), reason="needs faster-whisper and espeak-ng")
needs_engine = pytest.mark.skipif(shutil.which("node") is None or not CLI.exists(), reason="engine not built (npm run build)")

WER_CLEAN_MAX = 0.10
WER_NOISY_MAX = 0.15
START_TOL_MS = 150
MATCHED_MIN = 0.90
CONNECTED_MEDIAN_MAX_MS = 120
CONNECTED_P95_MAX_MS = 300

# Held-out sentences (not the ones the alignment costs were set on).
CONNECTED = [
    "Lens records your screen and adds smooth zoom effects",
    "Open the settings window and change the output resolution",
    "The webcam appears in the bottom right corner",
    "Drag the slider to make the background darker",
    "Export the final video when you are happy with it",
    "Captions are generated from your voice on this computer",
    "Every click creates a soft ripple under the cursor",
    "Turn on noise reduction before you share the recording",
]
HESITANT = [
    "Um the timeline shows every cut you make",
    "Next uh drag the corner to resize the frame",
    "We er added a shadow behind the window",
    "Then um press play to watch the result",
    "So uh the cursor grows when you click",
    "Okay er now choose a brighter gradient",
]


# ------------------------------------------------------------------ unit: no model needed

def test_vad_finds_pauses_under_noise():
    sr = SR
    x = np.zeros(int(3 * sr), np.float32)
    t = np.arange(int(0.4 * sr)) / sr
    burst = 0.3 * np.sin(2 * np.pi * 220 * t) * np.sin(np.pi * t / 0.4) ** 0.3
    for s in (0.5, 1.3, 2.2):
        i = int(s * sr)
        x[i:i + len(burst)] += burst
    v = vad.detect(add_noise(x, -55), sr)
    sil = v.silences(0.15)
    # silences: [0,0.5], [0.9,1.3], [1.7,2.2], [2.6,3.0] within 30 ms (the burst envelope ramps)
    want = [(0.0, 0.5), (0.9, 1.3), (1.7, 2.2), (2.6, 3.0)]
    assert len(sil) == 4, sil
    for (a, b), (p, q) in zip(sil, want):
        assert abs(a - p) <= 0.03 and abs(b - q) <= 0.03, (sil, want)


def test_align_snaps_to_runs_flags_untranscribed_and_drops_hallucination():
    W = align.TimedWord
    runs = [(0.30, 0.60), (0.80, 1.05), (1.25, 1.70), (1.90, 2.40)]
    # Whisper-like: starts absorb the pause before; "um" at 0.80-1.05 was not written;
    # "thanks" is invented text in the trailing silence.
    words = [W("Open", 0.0, 0.55, 0.9), W("the", 0.55, 1.6, 0.8), W("menu", 1.6, 2.3, 0.95), W("thanks", 2.6, 2.9, 0.05)]
    out, untr = align.align(words, runs)
    kept = [w for w in out if not w.dropped]
    assert [w.text for w in kept] == ["Open", "the", "menu"]
    assert [(w.start, w.end) for w in kept] == [(0.30, 0.60), (1.25, 1.70), (1.90, 2.40)]
    assert untr == [(0.80, 1.05)]


def test_shared_run_shifts_boundaries_onto_the_run():
    W = align.TimedWord
    words = [W("open", 0.0, 0.5, 0.9), W("the", 0.5, 0.7, 0.9), W("menu", 0.7, 1.2, 0.9)]
    out, untr = align.align(words, [(0.3, 1.45)], refine=False)
    assert untr == []
    assert out[0].start == pytest.approx(0.3) and out[-1].end == pytest.approx(1.45)
    # boundaries move by run end - recogniser end = 0.25 s
    assert out[1].start == pytest.approx(0.75) and out[2].start == pytest.approx(0.95)


def test_merge_fillers_inserts_replaces_and_refuses():
    W = align.TimedWord
    base = [W("We", 0.0, 0.4, 0.8), W("or", 0.45, 0.7, 0.2), W("open", 0.7, 1.2, 0.9), W("the", 1.2, 1.5, 0.9), W("menu", 1.5, 2.0, 0.9)]
    prompted = [W("We,", 0.0, 0.4, 0.8), W("er,", 0.42, 0.72, 0.5), W("open", 0.9, 1.2, 0.9), W("uh,", 1.25, 1.32, 0.1),
                W("menu", 1.5, 2.0, 0.9)]
    m = merge_fillers(base, prompted, F.DEFAULT_FILLERS)
    # "or" was the hesitation misheard; "the" stays (the prompted pass's "uh" sits on it); anchor
    # "open" takes the prompted pass's start.
    assert [w.text for w in m] == ["We", "er,", "open", "the", "menu"]
    assert m[2].start == pytest.approx(0.9)


def test_pauses_between_excludes_speech():
    words = [{"text": "a", "startMs": 100, "endMs": 400}, {"text": "um", "startMs": 600, "endMs": 900, "filler": True},
             {"text": "b", "startMs": 1500, "endMs": 1800}]
    p = F.pauses_between(words, [(0, 100), (380, 600), (900, 1500), (1800, 2500)], 150)
    assert p == [{"startMs": 400, "endMs": 600}, {"startMs": 900, "endMs": 1500}, {"startMs": 1800, "endMs": 2500}]


# ------------------------------------------------------------------ recognition on real audio

def _words(t: dict, fillers: bool = False) -> list[str]:
    return [w["text"] for w in t["words"] if not w.get("inferred") and (fillers or not w.get("filler"))]


@needs_model
@pytest.mark.parametrize("noise,bound", [(None, WER_CLEAN_MAX), (-50.0, WER_NOISY_MAX)], ids=["clean", "room-tone"])
def test_wer_on_known_sentences(noise, bound):
    E = N = 0
    lines = []
    for s in CONNECTED:
        a = pad(tts(s))
        if noise is not None:
            a = add_noise(a, noise)
        t = transcribe_array(a)
        e, n = wer_counts(s.split(), _words(t))
        E, N = E + e, N + n
        lines.append(f"{e}/{n}  {' '.join(_words(t, True))}")
    wer = E / N
    print(f"\nWER ({'clean' if noise is None else f'{noise} dBFS room tone'}): {wer:.3f} ({E}/{N})\n  " + "\n  ".join(lines))
    assert wer <= bound, lines


@pytest.fixture(scope="module")
def hesitant_results():
    if not (HAVE_FW and ESPEAK):
        pytest.skip("needs faster-whisper and espeak-ng")
    out = []
    for s in HESITANT:
        clean = pad(tts(hesitant_ssml(s), word_gap=15, ssml=True))
        runs = word_runs(clean)
        assert len(runs) == len(s.split()), f"test signal: expected one energy run per word in {s!r}, got {len(runs)}"
        out.append((s, runs, transcribe_array(add_noise(clean, -50.0))))
    return out


@needs_model
def test_word_starts_within_150ms(hesitant_results):
    errs, total, report = [], 0, []
    for s, runs, t in hesitant_results:
        hyp = [w for w in t["words"] if not w.get("filler")]
        j = 0
        for word, (a, _b) in zip(s.split(), runs):
            if F.is_filler(word):
                continue
            total += 1
            for k in range(j, len(hyp)):
                if norm(hyp[k]["text"]) == norm(word):
                    errs.append(hyp[k]["startMs"] - a * 1000)
                    report.append((word, round(a * 1000), hyp[k]["startMs"]))
                    j = k + 1
                    break
    e = np.abs(np.array(errs))
    print(f"\nword starts: {len(e)}/{total} matched, max {e.max():.0f} ms, mean {e.mean():.1f} ms")
    assert len(e) >= MATCHED_MIN * total
    assert e.max() <= START_TOL_MS, [r for r in report if abs(r[2] - r[1]) > START_TOL_MS]


@needs_model
def test_inserted_fillers_are_flagged_and_content_words_are_not(hesitant_results):
    missed, false = [], []
    for s, runs, t in hesitant_results:
        flagged = [w for w in t["words"] if w.get("filler")]
        for word, (a, b) in zip(s.split(), runs):
            a, b = a * 1000, b * 1000
            if F.is_filler(word):
                if not any(w["startMs"] < b and w["endMs"] > a for w in flagged):
                    missed.append((s, word))
            elif any(min(w["endMs"], b) - max(w["startMs"], a) > 0.5 * (b - a) for w in flagged):
                false.append((s, word))
    print(f"\nfillers: {sum(F.is_filler(w) for s in HESITANT for w in s.split()) - len(missed)} detected, missed {missed}, false {false}")
    assert not missed and not false


@needs_model
def test_connected_speech_word_starts_vs_tts_events():
    errs = []
    for s in CONNECTED:
        x, starts = tts_with_word_starts(s)
        a = add_noise(pad(x, 0.3), -50.0)
        t = transcribe_array(a)
        hyp = [w for w in t["words"] if not w.get("filler")]
        j = 0
        for word, st in zip(s.split(), starts):
            for k in range(j, len(hyp)):
                if norm(hyp[k]["text"]) == norm(word):
                    errs.append(hyp[k]["startMs"] - (st + 0.3) * 1000)
                    j = k + 1
                    break
    e = np.abs(np.array(errs))
    print(f"\nconnected speech word starts: n={len(e)} median {np.median(e):.0f} ms, p95 {np.percentile(e, 95):.0f} ms, "
          f"within 150 ms {np.mean(e <= 150):.0%}, mean signed {np.mean(errs):+.0f} ms")
    assert len(e) >= 0.8 * sum(len(s.split()) for s in CONNECTED)
    assert np.median(e) <= CONNECTED_MEDIAN_MAX_MS and np.percentile(e, 95) <= CONNECTED_P95_MAX_MS


# ------------------------------------------------------------------ CLI + engine schema

@needs_model
@needs_engine
def test_cli_output_is_accepted_by_lens_plan(tmp_path):
    x = pad(tts(hesitant_ssml("So um open the share menu"), sr=48000, word_gap=15, ssml=True), sr=48000)
    wav = write_wav(tmp_path / "voice.wav", x, 48000)
    out = tmp_path / "t.json"
    p = subprocess.run([sys.executable, str(ROOT / "transcribe" / "lens-transcribe"), wav, "-o", str(out), "--offset-ms", "1000"],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    t = json.loads(out.read_text())
    assert t["version"] == 1 and t["language"] == "en" and t["engine"] == {"name": "faster-whisper", "model": "base.en", "licence": "MIT"}
    assert [norm(w) for w in _words(t)] == ["so", "open", "the", "share", "menu"]
    assert any(w.get("filler") for w in t["words"])
    assert all(w["startMs"] >= 1000 and 0 <= w["confidence"] <= 1 for w in t["words"])  # offset applied
    assert t["pauses"] and all(p["endMs"] > p["startMs"] for p in t["pauses"])
    meta = tmp_path / "meta.json"
    meta.write_text(json.dumps({"width": 640, "height": 360, "fps": 30, "durationMs": t["durationMs"] + 1000, "pixelRatio": 1}))
    ev = tmp_path / "e.jsonl"
    ev.write_text(json.dumps({"t": 0, "type": "move", "x": 10, "y": 10}) + "\n")
    proj = tmp_path / "p.json"
    proj.write_text(json.dumps({"output": {"fps": 30, "resolution": 360}, "edits": {"cleanup": {"enabled": True}}}))
    q = subprocess.run(["node", str(CLI), "--meta", str(meta), "--events", str(ev), "--project", str(proj), "--words", str(out),
                        "--out", str(tmp_path / "plan.json")], capture_output=True, text=True)
    assert q.returncode == 0, q.stderr
    plan = json.loads((tmp_path / "plan.json").read_text())
    um = next(w for w in t["words"] if w.get("filler"))
    assert any(c["startMs"] <= um["startMs"] + 31 and c["endMs"] >= um["endMs"] - 31 for c in plan["cleanupCuts"])


# ------------------------------------------------------------------ render pipeline from audio

PIPE_SENTENCE = "Um first we open the editor. Then uh drag the clip onto the timeline. Er finally export the video."


@pytest.fixture(scope="module")
def piped(tmp_path_factory):
    if not (HAVE_FW and ESPEAK) or shutil.which("node") is None or not CLI.exists():
        pytest.skip("needs faster-whisper, espeak-ng and the built engine")
    from lens_compositor import RenderOptions
    from lens_compositor.pipeline import run
    from lensharness.synth import synthesize

    d = tmp_path_factory.mktemp("stt-pipe")
    voice = pad(tts(hesitant_ssml(PIPE_SENTENCE), sr=48000, word_gap=12, ssml=True), 0.6, 1.2, sr=48000)
    write_wav(d / "mic.wav", voice, 48000)
    dur_ms = int(len(voice) / 48000 * 1000) + 400  # mic starts 400 ms into the recording
    s = synthesize(d, 640, 360, 30, dur_ms)
    project = {
        "output": {"fps": 30, "resolution": 360},
        "motionBlur": {"enabled": False},
        "background": {"kind": "solid", "colors": ["#202020"]},
        "cursor": {"visible": False},
        "shortcuts": {"enabled": False},
        "zoom": {"auto": False},
        "audio": {"tracks": [{"id": "mic", "kind": "mic", "path": "mic.wav", "offsetMs": 400, "volume": 1, "muted": False}],
                  "loudness": {"enabled": False}},
        "captions": {"enabled": True, "wordHighlight": False, "maxWordsPerBlock": 4,
                     "style": {"fontSize": 64, "textColor": "#ffffff", "position": "bottom", "maxWordsPerLine": 4,
                               "background": {"enabled": True, "color": "#000000", "opacity": 1.0}}},
        "edits": {"cleanup": {"enabled": True}},
    }
    (d / "project.json").write_text(json.dumps(project))
    r = run(s["meta"], s["events"], str(d / "project.json"), s["screen"], str(d / "out.mp4"), opts=RenderOptions(preset="veryfast", crf=12))
    return d, r, voice


@needs_model
@needs_engine
def test_pipeline_transcribes_mic_and_cuts_fillers(piped):
    d, r, voice = piped
    assert r.transcript is not None and r.transcript.exists()
    t = json.loads(r.transcript.read_text())
    plan = json.loads(r.plan.read_text())
    assert t["source"]["trackId"] == "mic" and t["offsetMs"] == 400
    fill = [w for w in t["words"] if w.get("filler")]
    assert len([w for w in fill if not w.get("inferred")]) >= 3
    # every filler is inside a cleanup cut (minus padding)
    for w in fill:
        assert any(c["startMs"] <= w["startMs"] + 31 and c["endMs"] >= w["endMs"] - 31 for c in plan["cleanupCuts"]), w
    removed = sum(c["endMs"] - c["startMs"] for c in plan["cuts"])
    out_audio = decode_audio(str(d / "out.mp4"))
    assert abs(len(out_audio) / SR * 1000 - (plan["source"]["durationMs"] - removed)) < 100
    # the export, re-transcribed: no hesitations left, content intact
    t2 = transcribe_array(out_audio)
    heard = [w["text"] for w in t2["words"] if not w.get("inferred")]
    print(f"\nexport re-transcribed: {' '.join(heard)}  (removed {removed:.0f} ms)")
    assert not any(F.is_filler(w) for w in heard), heard
    content = [w for w in PIPE_SENTENCE.split() if not F.is_filler(w)]
    e, n = wer_counts(content, heard)
    assert e / n <= WER_CLEAN_MAX, heard


def _ocr(img: np.ndarray) -> list[str]:
    import cv2

    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    _, bw = cv2.threshold(g, 128, 255, cv2.THRESH_BINARY_INV)  # dark text on white for tesseract
    p = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "6", "-l", "eng"], input=cv2.imencode(".png", bw)[1].tobytes(),
                       capture_output=True, check=True)
    return [t for t in (norm(w) for w in p.stdout.decode(errors="replace").split()) if t]


@needs_model
@needs_engine
@pytest.mark.skipif(shutil.which("tesseract") is None, reason="needs tesseract-ocr")
def test_rendered_captions_carry_transcribed_words(piped):
    d, r, _ = piped
    plan = json.loads(r.plan.read_text())
    t = json.loads(r.transcript.read_text())
    spoken = {norm(w["text"]) for w in t["words"] if not w.get("filler") and not w.get("inferred")}
    F_ = read_all_frames(str(d / "out.mp4"))
    H = F_.shape[1]
    # one frame from the middle of each caption block on screen
    blocks: dict[str, list[int]] = {}
    for i, f in enumerate(plan["frames"]):
        if f["caption"]:
            blocks.setdefault(" ".join(f["caption"]["words"]), []).append(i)
    assert len(blocks) >= 3
    checked = 0
    for text, idx in blocks.items():
        words = [norm(w) for w in text.split()]
        assert set(words) <= spoken  # the plan's captions are the transcribed words
        i = idx[len(idx) // 2]
        got = _ocr(F_[i, int(0.6 * H):])
        found = sum(1 for w in words if w in got)
        print(f"frame {i}: caption {text!r} -> OCR {got}")
        assert found >= 0.8 * len(words), (text, got)
        checked += 1
    assert checked == len(blocks)
