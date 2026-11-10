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
5. Privacy: keystrokes are stored only as shortcut combos with modifiers; plain typing is stored as
   timing, never characters.
6. Privacy scans store only redacted previews of what they find (`sk-proj-•••J0pD`), never the found
   text itself; review thumbnails stay in the bundle's local cache.
