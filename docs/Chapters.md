# Title, description and chapters from the transcript (demand #27)

Clean-room, Lens's own design (no product was decompiled or copied; the idea comes from the public
demand evidence in `research/demand/demand-report.md` #27). Lens drafts a video title, a short
description and chapter markers from the transcript, on the device, and writes them into the export.

**What it is not:** there is no language model and no network call. The demand report proposed "a
local LLM"; Lens ships a deterministic, extractive pipeline in TypeScript instead
(`packages/engine/src/chapters.ts`), because the packaged desktop app has no Python and no model
runtime, and because an extractive draft can never claim something the speaker did not say.
**English only** (stop words and the stemmer are English); other languages still draft, but titles
will be worse.

## Where it is in the editor

**Export > Title & chapters** (tab of the Export dialog, `ChaptersTab.tsx`):

- **Draft from transcript** (`chapters-generate`; **Draft again from transcript** once there are chapters): drafts title, description and chapters from the
  transcript as the export will play it (words inside cuts left out, chapter lengths on the output
  clock). Without a transcript the tab says so and offers **Open Transcript**.
- Title and description are editable text boxes (one undo step per pause in typing); **Copy** (title) and **Copy with chapters** (description followed by the YouTube list).
- Chapter list: rename, **Set start** (moves the chapter to the playhead), click the time to seek, remove, **+ At playhead** adds one.
  Chapters are also drawn as markers on the timeline ruler.
- **YouTube list** (read-only, **Copy**),
  with YouTube's rules checked (first at 0:00, at least 3 chapters, each at least 10 s) and any issue
  shown under it (`chapters-issues`).
- Downloads: **.txt** (YouTube list) and **WebVTT** chapters file.
- **Chapter markers in the MP4** (`chapters-embed`, on by default).

## Project data

```json
"chapters": {"title": "...", "description": "...", "embed": true,
             "items": [{"id": "c1", "srcMs": 0, "title": "Setting up the microphone"}]}
```

`project.chapters` is optional; older projects have none and render exactly as before (it never
changes the picture). `srcMs` is on the recording clock, so a chapter follows cuts and speed changes:
the plan (`plan.chapters.items`, `outputChapters`) maps each start onto the output clock; a start
inside a cut moves to where the recording resumes, starts past the end are dropped, the first chapter
is forced to 0 and equal starts merge. Validation: title <= 200 characters, description <= 5000,
chapter title <= 100, `srcMs >= 0`.

## Pipeline (`chapters.ts`)

1. **Sentences**: words split at `. ? !`, at pauses over 900 ms, or every 30 words; fillers and VAD
   placeholder words dropped.
2. **Tokens**: lower-cased, English stop words dropped, a light suffix stemmer (plural, -ing, -ed, -ly).
3. **How many chapters (TextTiling)**: for each gap between sentences, TF-IDF cosine similarity of the
   3 sentences before and after it, 1-2-1 smoothed; a gap's depth is how far it dips below the nearest
   peaks on both sides. Gaps deeper than mean + 0.25 sd (and > 0.05) are candidates, deepest first,
   kept when every chapter stays at least `minChapterMs` long on the output clock
   (default max(10 s, duration / 15), YouTube's minimum is 10 s), at most 12 chapters.
4. **Where exactly (cohesion DP)**: with the chapter count fixed, a dynamic programme splits the
   sentences into that many contiguous chapters maximising the sum of |sum of unit sentence vectors|
   per chapter, under the same length rule. This is sharper at the boundary than the smoothed valley.
5. **Chapter titles**: the best key phrase(s) of the chapter: runs of content words, scored by the
   words' frequency in the chapter times their rarity in the other chapters, at most 48 characters
   (`Part N` if nothing qualifies).
6. **Video title**: TextRank over the word co-occurrence graph (window 3, damping 0.85), the top two
   key phrases, at most 70 characters.
7. **Description**: TextRank over sentences (word-overlap similarity), three sentences of at least 6
   words, one per chapter first, in spoken order, verbatim.

Same input, same output (no randomness); drafting a 20-sentence transcript takes ~40 ms in the page.

## Output formats

| Format | Where | Notes |
|---|---|---|
| YouTube list | `youtubeChapterList` | `m:ss Title` per line (`h:mm:ss` past an hour), first `0:00` |
| WebVTT chapters | `chaptersVtt` | `WEBVTT`, one cue per chapter, cue ends at the next start / the video end |
| MP4 chapters + title / description | `ffmetadata` + `apps/editor/server/chapterMeta.ts` | FFMETADATA1 file copied in with `ffmpeg -map_metadata 1 -map_chapters 1 -c copy` (no re-encode), after the encode, in **both** export paths: the in-app browser export (`server/browserExport.ts`, the packaged desktop app's path) and the Python reference export (`server/api.ts`). Cancel kills that ffmpeg; a failed run leaves the MP4 as it was and reports `chapters: ...` |

## Tests

- Engine vitest `packages/engine/test/chapters.test.ts`: stemmer and sentences, a dev transcript with
  one chapter start per topic change, everything drawn from the transcript, determinism and
  short / empty transcripts, minimum length on the output clock, chapters through cuts, YouTube /
  VTT / ffmetadata formats, optional and validated `project.chapters`.
- Editor vitest `apps/editor/test/chapterMeta.test.ts`: chapters go into the file only when asked.
- Playwright `apps/editor/e2e/chapters.spec.ts`, on a **held-out** transcript (a four-topic recording
  tutorial written after tuning on the dev one; sentences evenly spaced so topic changes can only be
  found from the words). Bounds set before the first run: drafting < 1000 ms in the page; 4-5
  chapters, first at 0:00, each true topic change within ±5 s of a chapter start; title and chapter
  titles made of transcript words (chapter titles of words spoken in that chapter), description
  sentences verbatim; a rename shows in the YouTube list; one ruler marker per chapter; YouTube list
  and WebVTT shapes; ffprobe finds one MP4 chapter per plan chapter within 1 ms, same titles, and the
  title tag.
- Measured (2026-11-11, branch `feat/ai-chapters-015` at bde55d9, Linux web build, both export
  paths): **4 chapters**, boundary error **0 / 0 / 0 ms** for the three topic changes (bound ±5 s),
  draft **38-43 ms** (bound < 1000 ms), MP4 has **4 chapter atoms** and the **title tag**, on the
  browser path and on the Python path.

## Not done

- Abstractive titles (a model could write "How to record a tutorial"; Lens picks phrases the speaker
  said). The demand report's metric (edit distance between the drafted and the final title) has not
  been measured with users.
- Languages other than English (stop words, stemmer).
- Chapters in GIF / WebM exports; YouTube upload.
