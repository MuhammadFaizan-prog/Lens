# Rules

1. Clean room. No decompiling, disassembling, unpacking, patching, or hooking third-party binaries
   (including installers and app bundles of Screen Studio or FocuSee), regardless of who supplies them.
   No copying their UI, icons, cursor sprites, fonts, sounds, sample media, or text.
2. Allowed sources: public docs, help centres, changelogs, marketing pages, public share pages, and
   videos we export ourselves from properly licensed or trial copies. Log every source in
   `research/evidence/` with URL/date or capture notes.
3. Every feature lands with a test. Look and motion features land with a harness measurement and,
   once bars exist, a blind A/B result.
4. Engine defaults change only with a recorded reason (measurement or explicit design choice).
   Recorded (v0.1.4 caption fonts): caption text metrics are measured the same way on both sides.
   Line ascent / descent: the editor measures `fontBoundingBoxAscent` / `Descent` of "Hg" at 64 × size
   and takes `ceil(v / 64)`, FreeType's 26.6 rounding (PIL `getmetrics`); Fira Sans 27 px is 26 / 8
   on both, where Chrome at 27 px gave 26 / 7. Word, space and pop / bounce widths: `render.py`
   measures the same font at 64 × size and divides by 64 (fractional, within 0.02 px of Chrome's
   `measureText`), not FreeType's per-glyph whole-pixel hinted advances. Reason: classic-subtitle
   preview vs export differed by mean 42.3 levels on the caption crop (lines shifted 1 px per line,
   words drifting up to several px along a line).
   Recorded (v0.1.4 caption fonts, caption glyph advances, 2026-11-10): `render.py` measures and draws
   caption words through RAQM (HarfBuzz) with `features=["-kern"]` (`caption_face`), as the preview
   does (fontKerning = none, default ligatures, fractional advances); BASIC layout (kept for text ops
   and as the fallback without libraqm) draws each glyph at its hinted whole-pixel advance, which drifts
   along a word (Caveat 40 px "Lens": 65 px drawn vs 62.77 measured) and skips ligatures (Lobster).
   Reason, compositor export vs preview: imported Lobster glyph IoU 0.544 -> 0.848 (mean |RGB| 18.42 ->
   6.18), classic-subtitle 0.726 -> 0.761, neon mean 14.36 -> 11.19, Caveat 0.706 -> 0.823.
   Recorded (v0.1.4 caption fonts, caption export paths, 2026-11-10): the preview-vs-export caption
   specs (`captionFonts2.spec.ts`, `ux-caption-fonts.spec.ts`) run on either export path, chosen by
   `LENS_EXPORT` (`uxHelpers.ts` `EXPORT_PATH`; `exportMp4` fails if the server took the other one).
   The browser path (`store.exportInBrowser` + `server/browserExport.ts`) is the one the shipped
   desktop app uses (`editorServer.ts` sets `LENS_EXPORT=browser`; no Python is packaged) and keeps
   the original bounds (mean |RGB| <= 12; glyph IoU >= 0.8 / >= 0.85). The dev server's Python
   reference (`/api/export`, `compositor/render.py`) keeps the mean bound and gets a separate glyph IoU
   tolerance: `captionFonts2` >= 0.70, `ux-caption-fonts` >= 0.80. Reason: with widths, line metrics
   and advances matched, the remaining gap is the rasterisers: Pillow / FreeType 2.14 hinted glyphs sit
   0.3-0.6 px higher than Chromium / Skia's and are thinner (1472 vs 1627 px over luma 128, Fira Sans
   27 px); x264 alone keeps IoU at 0.99, supersampled Pillow text moved it only 0.787 -> 0.790, and
   Pillow exposes no hinting switch. Measured on that path: classic-subtitle 0.761, Caveat 0.823,
   Lobster 0.848; browser path 0.978-0.997. Compositor numbers below these tolerances are failures.
5. Privacy: keystrokes are stored only as shortcut combos with modifiers; plain typing is stored as
   timing, never characters.
6. Privacy scans store only redacted previews of what they find (`sk-proj-•••J0pD`), never the found
   text itself; review thumbnails stay in the bundle's local cache.
