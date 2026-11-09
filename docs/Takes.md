# Multi-take with automatic best take (demand #1)

Clean-room, Lens's own design (no product was decompiled or copied; the idea comes from the public
demand evidence in `research/demand/demand-report.md` #1). The speaker records straight through,
restarting a sentence whenever they fumble; Lens finds the restarts in the transcript, keeps one
take per sentence and folds the rest into an **Alt takes** lane as reversible cuts.

## Project setting

```json
"edits": {"takes": {"enabled": true, "strategy": "last", "choices": [], "marked": [], "ignored": [], "padMs": 120}}
```

| Key | Meaning |
|---|---|
| `enabled` | find retakes and cut the rejected ones (off by default) |
| `strategy` | `last`: keep the last take of each group. `best`: keep the highest-scoring take |
| `choices` | `[{atMs, keep}]` per-group override: the group containing `atMs` keeps take `keep` (0 = first) |
| `marked` | `[{startMs, endMs}]` user-marked retakes ("Mark retake"): each becomes a rejected take, and the speech right after it is the kept take |
| `ignored` | times inside groups the user dismissed ("Not a retake") |
| `padMs` | silence kept at each side of a take cut, at most half of the gap there |

The engine (`packages/engine/src/takes.ts`, `resolveTakes`) adds the rejected takes to the plan's
`cuts`, so video, audio pieces and captions all follow them, and lists them in the plan as `takes`
(groups, takes, kept index, the strategy's own pick, scores, cues) and `takeCuts`. The render
pipeline transcribes the mic track when takes are on and no words were given.

## Detector

1. **Tokens.** Spoken words only: fillers and VAD placeholders are dropped, numbers become digits
   ("four" → "4") and runs of single letters / digits are joined ("M P four" → "mp4", "four K" → "4k").
2. **Restart search.** For each token j (a possible restart), look back up to 30 tokens for an
   earlier stretch A = tokens[i..j) that starts with the same word as j. Trailing junk is stripped
   from A first: restart phrases ("sorry", "oops", "let me redo that", "let me start over",
   "scratch that", "take two", ...) and stuttered repeats ("then we we").
3. **Fuzzy prefix alignment.** A is aligned against the start of what follows j (a DP where a
   similar word costs 1 − similarity, a different or dropped word 1, an extra word in the restart
   0.5; the restart may continue past A). Word similarity is 1 − edit distance / length, words of
   three letters or fewer must match exactly, and a cut-off word that is a prefix of the other
   counts 0.8. ratio = 1 − cost / |A|; matched = A words aligned with similarity ≥ 0.6.
4. **Cues** lower the bar: a restart phrase, a pause ≥ 800 ms before the restart, a filler between
   the take and the restart, a stutter, a last word with confidence < 0.5, or the take already being
   part of a group (a third take).
5. **Accept** when any of: ratio ≥ 0.95 and matched ≥ 3; ratio ≥ 0.95, matched ≥ 2 and a cue;
   A does not end in punctuation, ratio ≥ 0.75 and matched ≥ 3; a cue, ratio ≥ 0.6 and matched ≥ 3.
   A complete sentence that merely starts like the next one ("This step is important. This step is
   optional") needs a near-exact repeat or a cue.
6. **Groups.** A restart of the current group's final take extends the group (3+ takes). Fillers
   right before the first take belong to it. A new group starts only after the previous group's
   final-take extent.

## Keeping a take

- Keeping the **final** take cuts from the first take's start to the final take's start.
- Keeping an **earlier** take cuts the other earlier takes and the junk after the kept one, and cuts
  the part of the final take its words aligned to, so the sentence continues from where the kept
  take stopped ("…bottom **left**" + " corner.").
- `best` scores each take: 2 × completeness (share of the group's reference wording covered, times
  the alignment ratio; the final take is 1) + 0.5 × mean confidence − 0.25 × fillers − 0.2 × long
  internal pauses (> 700 ms), with a 0.01 per-position tie-break towards later takes.
- Cuts sit in the silence before each take (`padMs`), the "cut on the pause before each sentence"
  rule from the demand report.

## Editor

- **Alt takes lane** (timeline, source time): one block per take inside a dashed group outline; the
  kept take is solid, rejected takes are hatched and struck through. Click a rejected take to keep it
  (one undo step); ▶ on any take is an **A/B preview**: the plan is rebuilt as if that take were kept
  (no history entry), playback runs from just before the take to just after it, then the project's
  own plan comes back. "Keep it" / "Back" in the transcript panel during a preview.
- **Transcript**: words of rejected takes are struck through and ghosted; a chip before each take
  (`⇄ 1/2`, `✓ 2/2`) swaps or previews it; kept-take words are underlined. **Mark retake** on a
  selection; a **Takes** toggle and a **Keep last / Keep best** selector. Everything is an undoable edit.
- Multi-take sample: `python3 apps/editor/scripts/make_sample.py --takes` writes
  `apps/editor/sample-takes` (the default sample's media, a transcript with a fumbled first take);
  open it with `?dir=<abs path>/apps/editor/sample-takes`.

## Tests and measurements

| What | Result | Bound (set before measuring) |
|---|---|---|
| Detector, HELD_OUT set (14 retake cases, 9 non-repeat cases), word level | precision 0.957 (88/92), recall 1.000 (88/88) | ≥ 0.95, ≥ 0.90 |
| Detector, HELD_OUT, group level | precision 0.933 (14 found, 1 false), recall 1.000 (14/14) | ≥ 0.90, ≥ 0.90 |
| Detector, DEV set (14 + 6; constants set on it) | 1.000 / 1.000 words, 1.000 / 1.000 groups | n/a |
| Normal narration (~180 words, repeated phrasing) | 0 groups | 0 |
| Pipeline: espeak-ng intro + 2 fumbled takes + clean take + outro → lens-transcribe → plan → render → re-transcribe | WER 9.5% (2/21) vs the expected script; "sorry" (fumble-only) not heard; frames = plan; video 10466.7 ms, audio 10474.7 ms vs plan 10467.0 ms; sync median 20 ms, p90 41 ms, captions on 20/20 matched words | WER ≤ 10%; video and audio within one frame (33.3 ms); median ≤ 60 ms, p90 ≤ 150 ms, captions ≥ 90% |
| Editor (Playwright): swap changes kept take, transcript, plan and drawn pixels; A/B preview leaves history alone and ends by itself; undo restores take, frame count, source time and pixels; mark retake + toggle undo | pass | |

Engine unit tests: `packages/engine/test/takes.test.ts` (corpus `takes.corpus.ts`, scorer
`takesEval.ts`). Pipeline: `tests/test_takes.py`. Editor: `apps/editor/e2e/takes.spec.ts`.

The held-out numbers above are **after one fix found on the held-out set** (see docs/Tracker.md):
before it, held-out measured word precision 0.946 and group precision 0.867 (both under bound).

## Known limits

- Only text and timing: two sentences that genuinely start the same way, separated by a long pause
  ("This step is important. ‖ This step is optional") are taken as a retake (held-out case hn9).
  "Not a retake" dismisses such a group.
- Tested on hand-timed transcripts and on synthetic espeak speech only, never on real voices.
  Whisper also tends to "clean up" repeats; in the pipeline test it wrote the fumbled "expert" as
  "export", which happens to help detection but means the recogniser can hide fumbles.
- A restart that rephrases the sentence instead of repeating it is not found (use Mark retake).
- No "Record another take" button: there is no native recorder yet, so takes are found within one
  recording. Cursor / zoom continuity across a take cut uses the existing cut handling only.
- No hallway test of time-to-clean-cut versus manual transcript editing.
