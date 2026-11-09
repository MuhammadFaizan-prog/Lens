"""Multi-take with automatic best take (demand #1), end to end from real (synthetic) audio.

espeak-ng says an intro, two fumbled takes of one sentence, the clean take, and an outro, with known
segment times. lens-transcribe turns the mic track into words, the engine (edits.takes on) cuts the
fumbled takes, the compositor renders. The export is then re-transcribed.

Bounds, fixed before the first run (docs/Takes.md, docs/Tracker.md):
- every fumbled take's audio lies inside the plan's take cuts (50 ms tolerance at each edge) and no
  kept segment's voiced audio is cut (30 ms tolerance);
- WER of the re-transcribed export against the expected script (intro + clean take + outro) <= 10%,
  and no word that only the fumbles contain ("expert", "sorry") is heard;
- video frame count == plan frames; video and decoded audio durations within one frame of the plan;
- audio <-> captions sync: words in the export's re-transcription, matched to the source transcript,
  start where the plan maps them: median |error| <= 60 ms, 90th percentile <= 150 ms; and at >= 90%
  of matched words the plan's caption on that output frame contains the word.
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

from media import CLI, ffprobe, write_wav  # noqa: E402
from speech import ESPEAK, SR, norm, tts, wer_counts, word_runs  # noqa: E402

try:
    import faster_whisper  # noqa: F401

    HAVE_FW = True
except ImportError:
    HAVE_FW = False

WER_MAX = 0.10
FUMBLE_TOL_MS = 50
KEPT_TOL_MS = 30
SYNC_MEDIAN_MAX_MS = 60
SYNC_P90_MAX_MS = 150
CAPTION_HIT_MIN = 0.90
FPS = 30
FRAME_MS = 1000 / FPS

# (text, kept?, silence after in s)
SCRIPT = [
    ("Here is how to export a video.", True, 0.6),
    ("Click the export", False, 1.0),
    ("Click the expert button, sorry.", False, 1.0),
    ("Click the export button and choose a file format.", True, 0.6),
    ("Then press save to finish.", True, 1.2),
]
LEAD_S = 0.6
FUMBLE_ONLY = {"expert", "sorry"}


@pytest.fixture(scope="module")
def takes_run(tmp_path_factory):
    if not (HAVE_FW and ESPEAK) or shutil.which("node") is None or not CLI.exists():
        pytest.skip("needs faster-whisper, espeak-ng and the built engine")
    from lens_compositor import RenderOptions
    from lens_compositor.pipeline import run
    from lensharness.synth import synthesize

    d = tmp_path_factory.mktemp("takes")
    sr = 48000
    parts = [np.zeros(int(LEAD_S * sr), np.float32)]
    segs = []  # (start_ms, end_ms, kept, text) of each spoken segment's voiced audio
    t = LEAD_S
    for text, keep, after in SCRIPT:
        x = tts(text, sr=sr)
        runs = word_runs(x, sr=sr)
        segs.append((1000 * (t + runs[0][0]), 1000 * (t + runs[-1][1]), keep, text, [(1000 * (t + a), 1000 * (t + b)) for a, b in runs]))
        parts += [x, np.zeros(int(after * sr), np.float32)]
        t += len(x) / sr + after
    voice = np.concatenate(parts)
    write_wav(d / "mic.wav", voice, sr)
    dur_ms = int(len(voice) / sr * 1000)
    # lens-transcribe CLI on the mic track
    p = subprocess.run([str(ROOT / "transcribe" / "lens-transcribe"), str(d / "mic.wav"), "-o", str(d / "transcript.json")], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    s = synthesize(d, 640, 360, FPS, dur_ms)
    project = {
        "output": {"fps": FPS, "resolution": 360},
        "motionBlur": {"enabled": False},
        "background": {"kind": "solid", "colors": ["#202020"]},
        "cursor": {"visible": False},
        "shortcuts": {"enabled": False},
        "zoom": {"auto": False},
        "audio": {"tracks": [{"id": "mic", "kind": "mic", "path": "mic.wav", "offsetMs": 0, "volume": 1, "muted": False}],
                  "loudness": {"enabled": False}},
        "captions": {"enabled": True, "wordHighlight": False, "maxWordsPerBlock": 4},
        "edits": {"takes": {"enabled": True, "strategy": "last"}},
    }
    (d / "project.json").write_text(json.dumps(project))
    r = run(s["meta"], s["events"], str(d / "project.json"), s["screen"], str(d / "out.mp4"), words=str(d / "transcript.json"),
            opts=RenderOptions(preset="veryfast", crf=18))
    return d, r, segs


def _out_time(plan: dict, src_ms: float) -> float | None:
    for pc in plan["audio"]["pieces"]:
        if pc["srcStart"] <= src_ms < pc["srcEnd"]:
            return pc["outStart"] + (src_ms - pc["srcStart"]) / pc["rate"]
    return None


def _align(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    """Index pairs of equal tokens on a minimum-edit alignment."""
    n, m = len(a), len(b)
    D = np.zeros((n + 1, m + 1), int)
    D[:, 0] = range(n + 1)
    D[0, :] = range(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = min(D[i - 1, j] + 1, D[i, j - 1] + 1, D[i - 1, j - 1] + (a[i - 1] != b[j - 1]))
    i, j, out = n, m, []
    while i > 0 and j > 0:
        if a[i - 1] == b[j - 1] and D[i, j] == D[i - 1, j - 1]:
            out.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif D[i, j] == D[i - 1, j - 1] + 1:
            i, j = i - 1, j - 1
        elif D[i, j] == D[i - 1, j] + 1:
            i -= 1
        else:
            j -= 1
    return out[::-1]


@pytest.mark.skipif(not (HAVE_FW and ESPEAK), reason="needs faster-whisper and espeak-ng")
def test_fumbled_takes_are_cut_and_export_matches_plan(takes_run):
    from lens_transcribe import transcribe_array
    from lens_transcribe.audio import decode_audio

    d, r, segs = takes_run
    plan = json.loads(r.plan.read_text())
    src_t = json.loads((d / "transcript.json").read_text())
    print("\nsource transcript:", " ".join(w["text"] for w in src_t["words"]))
    print("takes:", json.dumps([{k: g[k] for k in ("kept", "cues", "similarity")} | {"takes": [(t["startMs"], t["endMs"]) for t in g["takes"]]} for g in plan["takes"]]))
    print("takeCuts:", plan["takeCuts"])
    assert plan["takes"], "no retake group detected"
    cuts = plan["takeCuts"]

    # 1. the plan: fumbles inside take cuts, kept speech untouched
    for s0, s1, keep, text, runs in segs:
        if keep:
            for a, b in runs:
                for c in cuts:
                    ov = min(b, c["endMs"]) - max(a, c["startMs"])
                    assert ov <= KEPT_TOL_MS, (text, (a, b), c)
        else:
            assert any(c["startMs"] <= s0 + FUMBLE_TOL_MS and c["endMs"] >= s1 - FUMBLE_TOL_MS for c in cuts), (text, s0, s1, cuts)

    # 2. durations
    n_frames = int(ffprobe(str(d / "out.mp4"), "stream=nb_read_frames", count=True)["streams"][0]["nb_read_frames"])
    assert n_frames == plan["output"]["frames"]
    assert abs(n_frames * FRAME_MS - plan["output"]["durationMs"]) <= FRAME_MS
    out_audio = decode_audio(str(d / "out.mp4"))
    audio_ms = len(out_audio) / SR * 1000
    print(f"plan {plan['output']['durationMs']:.1f} ms, video {n_frames * FRAME_MS:.1f} ms, audio {audio_ms:.1f} ms")
    assert abs(audio_ms - plan["output"]["durationMs"]) <= FRAME_MS

    # 3. the export, re-transcribed
    t2 = transcribe_array(out_audio)
    heard_words = [w for w in t2["words"] if not w.get("inferred") and not w.get("filler")]
    heard = [w["text"] for w in heard_words]
    expected = " ".join(text for text, keep, _ in SCRIPT if keep).split()
    e, n = wer_counts(expected, heard)
    print(f"export re-transcribed: {' '.join(heard)}\nWER {e}/{n} = {e / n:.3f}")
    assert e / n <= WER_MAX
    assert not FUMBLE_ONLY & {norm(w) for w in heard}

    # 4. audio <-> captions sync
    src_words = [w for w in src_t["words"] if not w.get("inferred") and not w.get("filler")
                 and not any(c["startMs"] <= (w["startMs"] + w["endMs"]) / 2 < c["endMs"] for c in plan["cuts"])]
    pairs = _align([norm(w["text"]) for w in src_words], [norm(w["text"]) for w in heard_words])
    errs, cap_hits = [], 0
    for i, j in pairs:
        want = _out_time(plan, src_words[i]["startMs"])
        assert want is not None
        got = heard_words[j]["startMs"]
        errs.append(abs(got - want))
        f = min(len(plan["frames"]) - 1, int(((heard_words[j]["startMs"] + heard_words[j]["endMs"]) / 2) * FPS / 1000))
        cap = plan["frames"][f]["caption"]
        if cap and norm(heard_words[j]["text"]) in {norm(x) for x in cap["words"]}:
            cap_hits += 1
    errs = np.array(errs)
    print(f"sync: {len(pairs)} matched words, median {np.median(errs):.0f} ms, p90 {np.percentile(errs, 90):.0f} ms, max {errs.max():.0f} ms; "
          f"caption hits {cap_hits}/{len(pairs)}")
    assert len(pairs) >= 0.8 * len(expected)
    assert np.median(errs) <= SYNC_MEDIAN_MAX_MS
    assert np.percentile(errs, 90) <= SYNC_P90_MAX_MS
    assert cap_hits >= CAPTION_HIT_MIN * len(pairs)
