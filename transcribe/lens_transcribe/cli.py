"""lens-transcribe: on-device speech-to-text for Lens.

  lens-transcribe input.wav -o transcript.json [--model base.en] [--offset-ms 0] [--no-fillers]

Writes the engine's transcript JSON (packages/engine/src/transcript.ts: Transcript): words with
startMs/endMs/confidence, filler flags, language, and measured pauses. Feed it to
`lens-plan --words transcript.json`. Audio never leaves the machine.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import TranscribeOptions, engine, transcribe_file


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="lens-transcribe", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="audio or video file (anything ffmpeg can decode)")
    ap.add_argument("-o", "--out", required=True, help="transcript JSON to write")
    ap.add_argument("--model", default=engine.DEFAULT_MODEL, help=f"faster-whisper model name or path (default {engine.DEFAULT_MODEL}; known: {', '.join(engine.MODELS)})")
    ap.add_argument("--language", default=None, help="language code; .en models are English only")
    ap.add_argument("--offset-ms", type=int, default=0, help="add this to every time (the track's offset on the recording clock)")
    ap.add_argument("--no-fillers", action="store_true", help="skip the filler pass (faster; fillers are then only found by VAD)")
    ap.add_argument("--no-infer", action="store_true", help="do not mark untranscribed voiced spans as fillers")
    a = ap.parse_args(argv)
    opts = TranscribeOptions(model=a.model, language=a.language, keep_fillers=not a.no_fillers, infer_untranscribed=not a.no_infer)
    t0 = time.time()
    try:
        t = transcribe_file(a.input, opts, a.offset_ms)
    except RuntimeError as e:
        print(f"lens-transcribe: {e}", file=sys.stderr)
        return 1
    with open(a.out, "w") as f:
        json.dump(t, f, indent=1)
    n_fill = sum(1 for w in t["words"] if w.get("filler"))
    print(f"lens-transcribe: {len(t['words'])} words ({n_fill} fillers), {len(t['pauses'])} pauses, "
          f"{t['durationMs'] / 1000:.1f}s audio in {time.time() - t0:.1f}s, model {opts.model} ({t['engine']['licence']}) -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
