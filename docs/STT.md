# Local speech-to-text (AI-01)

Lens transcribes the mic track on the user's machine. Audio never leaves it: the model is
downloaded once and then runs offline on the CPU.

## Engine and model

| Part | What | Licence |
|---|---|---|
| Recogniser library | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 1.2.x | MIT |
| Inference runtime | [CTranslate2](https://github.com/OpenNMT/CTranslate2) 4.x | MIT |
| Default model | `base.en` = [Systran/faster-whisper-base.en](https://huggingface.co/Systran/faster-whisper-base.en), a CTranslate2 conversion of OpenAI Whisper base.en, run as int8 on the CPU | MIT (OpenAI Whisper weights are MIT; the conversion is published under MIT) |
| Other models it accepts | `tiny.en`, `small.en`, `tiny`, `base`, `small` (same Systran conversions, MIT), or a local model path | MIT, or the custom model's own |
| Speech VAD (hallucination gate) | [Silero VAD](https://github.com/snakers4/silero-vad) v6 ONNX model, the copy bundled inside faster-whisper (`faster_whisper/assets/silero_vad_v6.onnx`), run with onnxruntime (MIT) | MIT |
| Audio decode | the `ffmpeg` binary (already a Lens dependency); PyAV is not used | LGPL/GPL binary, called as a process |
| Test speech only | `espeak-ng` (binary and `libespeak-ng` via ctypes, tests only, never shipped) | GPL-3.0 |
| Test OCR only | `tesseract` binary (tests only) | Apache-2.0 |

`base.en` is the default rather than `tiny.en`: on our synthetic test set, tiny.en's word timings
were too far off for the aligner (they shifted by a whole word around hesitations), and filler
detection gave false positives. Speed, measured on 2 ARM cores (this sandbox) for 42.8 s of speech,
model load included: 13.7 s with both passes (0.32x real time), 5.4 s with `--no-fillers`.

Model files are cached by Hugging Face Hub in `~/.cache/huggingface` by default, or in
`$LENS_STT_MODEL_DIR` when set. `$LENS_STT_THREADS` sets the CPU threads (default: all cores).

## Pipeline (`transcribe/lens_transcribe`)

1. Decode any audio/video to 16 kHz mono with ffmpeg.
2. Pass 1: plain decode with word timestamps. These are the words we keep.
3. Pass 2: decode again with a disfluent prompt (our own sentence) so the model writes
   hesitations out; Whisper is trained mostly on cleaned transcripts and drops "um"/"uh" without
   it. Only pass 2's fillers are used, and only where both passes agree on the surrounding words.
   Where pass 1 wrote a short unsure word exactly where pass 2 wrote a filler ("um" heard as
   "I'm"), the filler replaces it. Pass 2 also invents text in silences, which is why nothing
   else from it is taken.
4. Energy VAD (adaptive floor/speech percentiles, hysteresis) finds voiced runs and silences.
5. A monotonic dynamic programme aligns words to voiced runs (one word over 1+ runs, several words
   sharing a run, a run left untranscribed, a word dropped as hallucinated). Costs trust Whisper's
   word ends more than its starts (its DTW starts absorb the pause before a word), and a first pass
   measures and removes Whisper's systematic lag.
6. Voiced runs the recogniser wrote nothing for, 100-800 ms long, become `"[filler]"` words with
   `filler: true, inferred: true`. They are cut by cleanup but never shown in captions.
7. Measured silences of 150 ms or more that do not overlap a spoken word are written as `pauses`.

### Non-speech audio (hallucination suppression, `hallucination.py`)

Whisper writes text for audio with no speech in it. On the editor sample's synthetic tone track it
wrote 112 "oh," words, and squeezing 60 of them into one short voiced run made the aligner emit
words that ended before they started (both fixed 2026-11-09). Measured on our non-speech probes,
hallucinated segments had no_speech_prob 0.83-0.95 and gzip compression ratios 3.1-26; espeak speech
had <= 0.01 and 0.84-0.89. Four filters run on both decodes:

1. **Compression ratio** > 2.4 (Whisper's own decode-rejection value): the segment is a loop; its
   words are dropped and its span is marked unknown.
2. **No-speech probability** > 0.6 (Whisper's value) and either avg_logprob < -1 (Whisper's rule),
   a loop, or less than half of the segment heard as speech by the speech VAD: dropped. Whisper's
   rule alone keeps confident loops (avg_logprob -0.06 on the tone track).
3. **Speech-VAD gating**: Silero VAD finds speech regions (threshold 0.5, padded 100 ms). An aligned
   word less than 50% inside them is dropped. An untranscribed voiced run becomes an inferred
   `[filler]` only inside speech, outside every dropped segment, and within 1.5 s of a recognised
   word (a hesitation sits between words; a lone syllable-like burst is unknown sound).
4. **Low-confidence repetition**: 3+ identical consecutive words with mean confidence < 0.5 keep
   only the first.

The energy VAD still gives the word-boundary runs; Silero only decides speech vs not-speech.
`TranscribeOptions.hallucination` (`enabled` and every threshold) turns them off or tunes them.

The aligner: when one voiced run is shared by more words than fit at 30 ms each, the words get
equal widths inside the run, and every placed word has end >= start and never starts before the
previous one (unit test with 60 words in a 0.45 s run, and a 300-case random property test).

Output is the engine's `Transcript` JSON (`packages/engine/src/transcript.ts`):
`{version, language, languageProbability, durationMs, offsetMs, engine:{name, model, licence},
source, words:[{text, startMs, endMs, confidence, filler?, inferred?}], pauses:[{startMs, endMs}]}`.
A bare `Word[]` is still accepted everywhere.

## Using it

```bash
pip install -e transcribe            # or run transcribe/lens-transcribe from the checkout
lens-transcribe mic.wav -o transcript.json [--model base.en] [--offset-ms 400]
node packages/engine/dist/cli.js ... --words transcript.json --out plan.json

# or let the pipeline transcribe the project's mic track when captions/cleanup need words:
python3 compositor/pipeline.py --meta meta.json --events events.jsonl --project project.json \
  --screen screen.mp4 --out final.mp4
```

Project keys: `transcription: {mode: "auto"|"off", track: id|null, model, language}` and
`edits.cleanup: {enabled, removeFillers, shortenPauses, fillers, maxPauseMs, keepPauseMs, padMs}`.
With measured pauses, pause shortening only cuts measured silence and flagged fillers, never voiced
audio the recogniser could not place.

## Measured (tests/test_stt.py, espeak-ng speech, base.en, int8, CPU)

| What | Result | Bound |
|---|---|---|
| WER, 8 held-out connected sentences, clean | 7.0% (5/71) | <= 10% |
| WER, same, -50 dBFS room tone | 11.3% (8/71) | <= 15% |
| Word starts, pauses between words, room tone (truth: clean-signal energy) | 40/42 matched, max 10 ms | every matched word within ±150 ms, >= 90% matched |
| Word starts, connected speech (truth: espeak word events) | median 92 ms, p95 226 ms, 67% within 150 ms | median <= 120, p95 <= 300 ms |
| Inserted fillers (um/uh/er) flagged | 6/6, 0 false on content words | all, none false |
| Export after cleanup, re-transcribed | no fillers; content WER within 10% | no fillers; <= 10% |
| Captions in the rendered MP4 (tesseract OCR) | 4/4 blocks, every word read back | >= 80% of each block's words |
| Non-speech, 60 s each: tones (steady, beeps, sweep), clicks, noise (white, room tone), silence (zero, -70 dBFS dither), speech-shaped harmonic buzz | 0 words on every one; editor sample tone track 0 words (was 121, two ending before they start) | <= 1 word per minute (inferred fillers counted), every word end >= start |

Bound changes and their reasons are in docs/Tracker.md.

## Known limits

- English-only default model. Multilingual models work through `transcription.model` /
  `--language`, but only English is tested.
- No custom-vocabulary prompt yet (Screen Studio has one for names); product names like "Lens"
  are misheard.
- Word starts in connected speech (no pause between words) are interpolated from Whisper's own
  boundaries: median ~90 ms, p95 ~230 ms error on espeak speech, outside the ±150 ms that holds
  where speakers pause.
- Hesitations spoken short and schwa-like ("uh" read as the article "a") are not distinguishable
  by the recogniser; espeak at normal rate produces exactly that, so the tests draw fillers out to
  0.3-0.45 s as people do when hesitating. "hmm" was not detected in our trials.
- Tested only on synthetic (espeak) speech, never on real voices.
- The aligner is pure Python, O(words × runs); fine for minutes of audio, untested on an hour.
- Hallucination filters are measured on synthetic non-speech only (no music, no real room noise,
  no speech over music). A real segment that loops (compression ratio > 2.4) is dropped whole.
  Hesitations more than 1.5 s from any recognised word are no longer inferred.
