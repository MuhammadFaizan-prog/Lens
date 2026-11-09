# On-device caption translation (demand #8)

Lens translates captions on the user's machine. The transcript never leaves it: each language's
model is downloaded once, checked against a pinned SHA-256, and then runs offline on the CPU. No
cloud API is called, and nothing is metered. Nothing here comes from Screen Studio, FocuSee or any
other product (`docs/Rules.md`); neither of them translates captions (inventory AI-09).

## Models and licences

Every model is an [Argos Translate](https://github.com/argosopentech/argos-translate) package
(`.argosmodel`, a zip with a CTranslate2 model and a SentencePiece tokenizer). Lens loads the model
and tokenizer directly with CTranslate2 and SentencePiece; the Argos library and the Stanza sentence
splitter inside the package are not used (Lens already has caption segments).

| Pair | Package (SHA-256 pinned in `translate/lens_translate/models.py`) | Origin | Licence | Attribution needed |
|---|---|---|---|---|
| en → es | `translate-en_es-1_0` | Argos Translate, trained with OpenNMT on OPUS (OpenSubtitles, ParaCrawl, UNPC) | MIT / CC0-1.0 | no (credited anyway) |
| en → fr | `translate-en_fr-1_9` | OPUS-MT (Helsinki-NLP), converted to CTranslate2 by Argos Translate | **CC-BY-4.0** | **yes** |
| en → de | `translate-en_de-1_3` | Argos Translate (package README gives no training data) | MIT / CC0-1.0 | no (credited anyway) |
| en → ur | `translate-en_ur-1_9` | OPUS-MT (Helsinki-NLP), converted to CTranslate2 by Argos Translate | **CC-BY-4.0** | **yes** |
| en → ar | `translate-en_ar-1_0` | Argos Translate, trained with OpenNMT on OPUS (OpenSubtitles, UNPC) | MIT / CC0-1.0 | no (credited anyway) |

| Software / asset | Licence |
|---|---|
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) 4.x (inference) | MIT |
| [SentencePiece](https://github.com/google/sentencepiece) 0.2 (tokenizer) | Apache-2.0 |
| Noto Naskh Arabic (bundled in `assets/fonts/`, licence text next to it) | SIL OFL 1.1 |
| Pillow with libraqm (HarfBuzz MIT, FriBiDi LGPL-2.1, loaded at runtime) for shaping in the compositor | HPND / MIT / LGPL |
| sacrebleu (tests only, to cross-check chrF) | Apache-2.0 |
| `tesseract-ocr-spa` (tests only) | Apache-2.0 |

Sources for the licences, checked 2026-11-09:
- Argos package licence: the maintainer's answer in
  [argos-translate#533](https://github.com/argosopentech/argos-translate/issues/533) ("the .argosmodel
  model binaries are released under the same MIT/CC0 license"); packages whose README says they are
  derived from OPUS-MT state "The original OPUS model from which this packaged model is derived is
  licensed CC-BY 4.0" (en_fr 1.9 and en_ur 1.9 READMEs), and Lens treats those as CC-BY-4.0.
- Open question recorded, not resolved: the same issue thread asks whether weights trained on
  OpenSubtitles (which OPUS lists without a commercial-use grant) can carry MIT/CC0; there is no answer
  yet. Before shipping a paid build, re-check this or switch the es / ar pairs to OPUS-MT models (CC-BY-4.0).

### Attribution (CC-BY-4.0 models)

The French and Urdu models are OPUS-MT models by Jörg Tiedemann and Santhosh Thottingal,
"OPUS-MT — Building open translation services for the World", *Proceedings of the 22nd Annual
Conference of the European Association for Machine Translation (EAMT)*, Lisbon, 2020, licensed
CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/), converted to CTranslate2 by the Argos
Translate project. Lens runs them unmodified. The editor's **About** sheet (top bar) shows the same
credit (`apps/editor/src/about.ts`), and the Languages section names the model and licence under
each machine-translated track.

## Command line

```bash
translate/lens-translate transcript.json --to es,fr,de,ur -o out/
#   out/es.track.json  out/es.srt  out/es.vtt  ...  (recording clock, no edits)
translate/lens-translate transcript.json --to es,ur --project project.json --select es
#   adds the tracks to project.translations (replacing same-language tracks), selects Spanish
node packages/engine/dist/cli.js --meta meta.json --events events.jsonl --project project.json \
  --words transcript.json --captions-language es --srt es.srt --vtt es.vtt --out plan.json
#   burns Spanish in; the SRT / VTT are on the output clock (cuts, speed, slides applied)
```

`--progress` prints one JSON object per line (load / download / translate with done / total / done),
which the editor's dev server relays. `$LENS_MT_MODEL_DIR` (default `~/.cache/lens-mt`) holds the
models; `$LENS_MT_THREADS` sets CPU threads; `--no-download` fails instead of downloading.

## How it works

1. **Segments** (`segment.py`, mirrored by the engine's `segmentTranscript`; a test checks both agree):
   sentences, closed early at a pause > 700 ms or at 24 words / 9 s (at a comma in the last third).
   Fillers and VAD placeholders are left out of the text, but the segment's time span covers them.
2. **Translation**: one batch per language, beam 4, CTranslate2 `compute_type=auto` on the CPU, then
   detokenised. Translation is per segment, never per word.
3. **Track** (`project.translations.tracks[]`): language, name, `rtl`, the model and licence, and per
   segment `{id, startMs, endMs, source, text, edited?}`. `project.translations.language` picks the
   caption language (null = the source transcript). Presets never touch translations.
4. **Re-timing** (engine `trackWords`, at plan time): a segment's translated words are spread over the
   time the speaker actually spoke in it (the source words that survive every cut, gaps under 120 ms
   closed), weighted by spoken length (vowel groups for alphabetic scripts with diacritics folded;
   about one syllable per two letters for Arabic script). Every translated word lies inside its
   segment, highlight moves forward only, pauses stay silent, and when part of a sentence is cut the
   translation squeezes into what is left; a fully cut segment disappears.
5. **Layout**: caption blocks never cross a segment; lines hold at most `maxWordsPerLine` words and
   `maxCharsPerLine` characters (default 42, 0 = off; a longer single word gets its own line). The
   old word-count wrap is kept whenever it already fits, so existing English captions are unchanged.
6. **Right-to-left** (Urdu, Arabic): the engine gives each line's left-to-right drawing order
   (`CaptionFrame.visual`, word-level bidi: runs of Latin words or numbers keep their own order, the
   runs go right to left). Each Arabic-script word is drawn in Noto Naskh Arabic and shaped by
   HarfBuzz: PIL RAQM in the compositor, the browser in the preview (canvas `direction = rtl`), both
   with kerning off; the line's spaces come from the script font, as a full-line shaper would take
   them. All words share one baseline (the taller font's ascent).
7. **Subtitles**: `plan.subtitles` holds the cues in the caption language on the output clock, wrapped
   like the burned-in caption; `toSrt` / `toVtt` write them (text in logical order; players apply bidi).

## Editor

Captions tab → **Languages**: caption language switcher (one undo step), **Translate to…** a language
with progress (model download on first use, then segments done / total), the selected track's
segments **side by side** with their source (edit a translation, Enter or leaving the field commits
one undo step and the preview re-times it live; edited segments are tagged), **.srt / .vtt** download
for the selected language, and Remove. The preview always shows the selected language.

## Measured (2026-11-09, 2 ARM cores)

- Quality, chrF (sacrebleu chrF2, cross-checked to 1e-6) on 24 fixed English UI / tutorial
  sentences against references written and frozen before any model saw them
  (`tests/data/translation_refs.json`, bound ≥ 45 for es / fr / de, set before measuring):
  **es 81.2, fr 91.5, de 85.4, ur 50.5** (ur: reported, no bound). Caveat: the references were written
  by the same author as the test, in a plain software-manual register close to what MT produces;
  scores on real narration with idioms will be lower. Urdu output had visible errors (e.g. "Private
  bits stay blurred" → "نجی بٹے رہو"), so treat Urdu as a draft for a human to edit.
- Speed (beam 4, model load excluded): es 336, fr 225, de 163, ur 214 source words / s; model load
  0.35–0.86 s. A 10-minute talk (~1,500 words) translates in about 5–10 s per language here.
- Timing: every translated word inside its segment and highlight monotonic (vitest + plan check with a
  cut and a removed filler).
- Render: Tesseract (spa) read 20 / 20 words of the burned-in Spanish captions (bound ≥ 80% per block).
- Right-to-left: the compositor's Urdu and Arabic lines match a whole-line libraqm rendering pixel for
  pixel (ink IoU 1.000, bound 0.90; logical-order control 0.22 / 0.19); a Latin run inside Urdu and
  Arabic keeps its order and position. Preview ↔ export SSIM on 14 Urdu caption frames: mean 0.98955,
  min 0.98399 (existing bounds 0.97 / 0.95).

## Not done

- Only English as the source language; five target languages (more Argos / OPUS-MT pairs can be
  added to the catalogue, each needing its licence checked).
- No bilingual raters (the demand report's adequacy ≥ 4 / 5 test); chrF is on a small, self-written set.
- No TTS voiceover (phase 2) and no batch "burn in every language" export in one go (export one
  language at a time; SRT / VTT per language are available).
- Imported SRT / VTT do not become a translation track yet (`parseVtt` exists; no UI).
- The timeline's Captions lane still shows source-language blocks.
- Nastaliq (the usual Urdu book style) is not bundled; Urdu uses Naskh.
- Word timing inside a segment is an estimate from syllable weights, not an alignment to audio.
