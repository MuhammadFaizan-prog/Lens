# Automatic privacy redaction (demand #3)

Clean-room, Lens's own design: the idea comes from the public demand evidence in
`research/demand/demand-report.md` #3; no product was decompiled or copied. Lens scans the
recording on the machine, finds sensitive text, follows it frame by frame and offers each find as a
review item. An accepted item becomes a tracked blur (or pixelate) mask that follows scrolling,
moving cards and zooms. Pending items are never hidden silently, and export asks first.

## What is found

| Type | Rule (`redact/lens_redact/classify.py`) |
|---|---|
| `email` | `local@domain.tld` |
| `phone` | 10–15 digits with separators or a leading `+` (`+1 (415) 555-0132`, `+44 20 7946 0958`, `(212) 555-0147`); 4-4-4 digit groups and dates are not phones |
| `card` | 13–19 digits, spaced or dashed, an issuer prefix (IIN) **and** a valid Luhn check digit |
| `api_key` | known prefixes: `sk-` (`sk-proj-`, `sk-ant-` …), `sk_/pk_/rk_live_/test_`, `ghp_ gho_ ghu_ ghs_ ghr_`, `github_pat_`, `AKIA/ASIA…` + 16, `xox?-`, `AIza…`, `glpat-`, `npm_ hf_ pypi_`, `SG.` |
| `jwt` | `eyJ….eyJ….sig`, and `eyJ` pieces of ≥ 16 characters (OCR often splits a JWT at its dots) |
| `token` | no known prefix: ≥ 20 characters of `[A-Za-z0-9+/_=-]`, letters and digits, ≥ 3.5 bits/char Shannon entropy (all three character classes below 32 characters); pure hex only from 40 characters |
| `ip` | dotted IPv4 with valid octets (not after a `v`) |
| `notification` | a banner in a screen corner (outer 40% of the width, top or bottom 35%): a block that appears at a scene change, is not explained by the scroll, stays still for ≥ 0.4 s, and has a border line or screen edge on three sides |

Decoys that must not match (unit tests and the synthetic sessions): normal words, short numbers,
hex colours, versions (`2.14.3`, `v1.2.3.4`), dates, times, prices, a non-Luhn 16-digit reference,
a Luhn-valid number without an issuer prefix, short git shas, paths, camelCase identifiers.

## Pipeline (`redact/lens_redact/scan.py`, `lens-redact` CLI)

1. **Analysis.** Every frame at 1/4 size: global motion from phase correlation (sub-pixel values
   zeroed: they are noise from local motion); motion-compensated residual (each pixel matched
   unshifted or shifted, whichever is closer) as a whole-frame mean and per 8×6 tile.
   **Samples for OCR**: the first frame, every 1 s while anything changed, 3 frames after each
   scene change (mean > 4 or a tile > 12 grey levels), after a third of the screen has scrolled,
   and while scroll events arrive (events.jsonl). Static stretches are not re-OCR'd.
2. **OCR**: Tesseract 5 (Apache-2.0) CLI, `--psm 11`, batched, two processes; our own line grouping
   (same row, gap < 2.5 heights) and glueing of words split at gaps < 0.5 height; findings are
   mapped back to word boxes; a key or JWT is extended over the following / preceding token-like
   fragments.
3. **Tracking** at full resolution, frame by frame: NCC template matching around predictions (own
   velocity, global shift, still), a wider search (±64 × ±96, ±160 while scroll events arrive),
   then up to 16 × 2 template pieces (partly covered, partly off-screen or clipped by a scroll
   view's edge), then up to 6 (12 at a frame edge) frames of coasting while moving, the box growing
   2 px per side per coasted frame. A new hit is tracked **backwards** through a 72-frame buffer to
   where it appeared, so frames before the first OCR sample are covered. Hits link to live tracks
   when they lie inside them; a larger box of the same token starts its own track.
   Banners keep their box (snapped to their border / the screen edge) from 18 frames before
   confirmation and for 0.5 s after their pixels stop matching (slide-in / slide-out).
4. **Merging.** Tracks that move together (offset spread ≤ 4 px over shared frames) and overlap or
   sit side by side on one row become one box; the same text lost for ≤ 3 s and found again where
   the motion puts it is bridged; tracks of the same type and similar text (≥ 0.8) are one review
   item. Each track becomes a time range with one key rect per frame where the box moved (runs of
   identical rects keep their first and last key), padded 6 px.

The scan file holds only a redacted preview of each find (`sk-proj-•••J0pD`, `j•••@a•••.com`,
`•••• 4242`); the secret text is never written (tested). Review thumbnails are crops of the frame
and do show the secret; they stay in the bundle's `.lens-cache/privacy/`.

## Project data

```json
"privacy": {"detections": [{"id": "pd3", "type": "email", "preview": "j•••@a•••.com", "confidence": 1,
  "state": "pending", "thumb": "pd3.jpg", "firstMs": 0,
  "tracks": [{"startMs": 0, "endMs": 6333.33, "keys": [{"tMs": 0, "rect": {"x": 417, "y": 168, "w": 259, "h": 30}}]}]}],
  "maskKind": "blur", "strength": null, "scannedAt": "2026-11-09T01:00:00Z"}
```

`state` is `pending`, `accepted` or `dismissed`. The engine (`packages/engine/src/privacy.ts`):
`reviewPrivacy` (accept → one tracked mask per track in `project.masks`, tagged `privacyId`, no
fade, feather 2; dismiss / pending → those masks removed), `applyPrivacyScan` (a re-scan keeps the
review state of items found again), `setPrivacyMaskKind`, `privacyCounts`. Masks gained `keys`
(`masksAt` uses the key at t, or the **union** of the two keys around t, so whichever source frame a
renderer shows is covered) and `privacyId`. `lens-plan --privacy-scan scan.json [--accept-privacy]
[--project-out p.json]` merges a scan from the command line; lens-plan and `compositor/pipeline.py`
print a warning while detections are pending.

## Editor

Left column **Transcript | Privacy** (a badge counts items to review). **Scan for sensitive info**
runs `redact/lens-redact` through the dev server (`POST /api/privacy/scan`, progress by stage,
result cached per screen.mp4) and adds the result as one undo step. Results are grouped by type,
each with a thumbnail, the redacted preview, first time and how often it was seen; click to show it
in the preview, ✓ hide, ✕ dismiss, ↺ back to review; **Hide all**, **Dismiss all**, **Blur /
Pixelate**. Hidden items are hatched blocks in the Masks lane (the inspector shows them as tracked;
moving one in time carries its keys). Every step is undoable. **Export** with items pending opens
a sheet: Review, or Export anyway. Sample bundle: `apps/editor/sample-privacy`
(`make_sample.py --privacy`, 15 s, generated on first open).

## Tests and measurements

Synthetic sessions: `research/harness/lensharness/privacy_synth.py`, 60 s, 1280×720 at 30 fps, a fake
console with fake secrets in a scrolling document (email ×2, card ×2, phone, an `sk-` key, a JWT, an
IP; the later variants also a prefix-less high-entropy token), an AWS key id in the static sidebar,
a token on a card that moves across the page (and under / over other text), two notification
banners that slide in, and decoys. Ground truth: every secret's visible box on every frame where at
least half of it is on screen (minus what a card or banner covers). Variants:

- **dev**: the scanner's constants were set while looking at it.
- **heldout**: dark theme, other secrets, decoys, sizes, scroll schedule, card path and banner
  positions; written with dev. Its first measurement **failed** (below) and was used to find two
  bugs, so its later numbers are optimistic.
- **fresh**: written after that (light theme, other secrets, sizes and motion; same wording as
  heldout); measured once, nothing changed after. This is the honest number.

Bounds were set before the first held-out measurement (`tests/test_privacy.py`):

| What | dev | heldout (1st run) | heldout (after fixes) | **fresh** | Bound |
|---|---|---|---|---|---|
| Instance recall (11–13 planted items) | 1.000 | 1.000 | 1.000 | **1.000** (13/13) | ≥ 0.95 |
| Frame recall (visible box ≥ 95% under a mask) | 1.000 | 0.942 ✗ | 1.000 | **0.991** | ≥ 0.95 |
| False positives per minute | 0 | 0 | 0 | **0** | ≤ 1 |
| Scan speed, s per minute of 720p30 video (2 cores) | 32–35 | 44 | 44–46 | **45** | — |

Export leak check (fresh, every detection accepted, rendered by the reference compositor with a
1.6× manual zoom over 24–33 s so masks must follow the camera): OCR of each secret's region on
every frame where it is visible: **6041 regions checked, 0 frames leak** (bound 0; a leak is a run
of min(6, len) of the secret's characters). Control: the same OCR read the secret in 431 of 447
sampled source regions (0.96; bound ≥ 0.70).

Held-out failure, 2026-11-09 (first run): frame recall 0.942. (1) The token on the moving card was
folded into a still text line it passed over (the merge joined boxes that overlapped once), which
also lost that token as its own item; merges now need the two tracks to move together. (2) Lines
entering from the top of the scroll view during a fast scroll were 1–2 px outside the mask while
coasting; coasted boxes now grow 2 px per side per frame. Thresholds were not changed.

Other tests: classifier unit tests (Luhn, entropy, prefixes, 20 true / 25 false cases, previews),
the scan file holds no secret text, the pipeline warning (`tests/test_privacy.py`); engine
`packages/engine/test/privacy.test.ts` (keyed rects, plan through crop, validation, accept /
dismiss / re-scan / mask kind); editor vitest (moving a tracked mask carries its keys); Playwright
`apps/editor/e2e/privacy.spec.ts` (real scan → items by type with thumbnails → export asks first →
accept one: mask in the Masks lane, plan frame gains a mask, text detail in the drawn preview drops
below 40% → undo: mask gone, pixels back within 5%, redo → dismiss one, hide all, pixelate).

## Known limits

- Synthetic screens only (DejaVu fonts, clean rendering, 1×). No real apps, no HiDPI, no
  anti-aliasing styles of other OSes, no video content under text.
- Text that changes while visible (a key being typed or revealed character by character) is
  re-found at the next OCR sample only; frames between can show part of it.
- English OCR model; small text (< ~13 px) and light-grey-on-white are where OCR fails first.
- User-supplied words (customer names) from the demand report are not built; no "add a box by hand
  and track it" tool (the manual mask is still there).
- Notification detection is a heuristic for corner banners with a border; toasts without an edge,
  or a menu opening in a corner, can be missed or (in principle) flagged.
- No funnel metric yet (share of exports that ran the review step); no GPU / Apple Vision OCR.
- Scan speed is ~45 s per minute of video on 2 cores, ~65% of it OCR; long recordings were not tried.
- Overlapping hidden items draw on top of each other in the single Masks lane.
