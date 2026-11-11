# Platform export presets (demand #24)

Lens's own design. No preset list, label or layout is taken from Screen Studio, FocuSee or any other
product (see `docs/Rules.md`); the numbers are the platforms' published upload specifications, cited
below.

## Using it

- **Export… > Video** (or the preset chip next to **Export** in the top bar, which reads *Preset: none*
  until one is chosen) opens the preset picker.
- Picking a preset is **one undo step**: its canvas size and frame rate go into the project's output
  (so the preview shows the exported framing at once; choose Fit / Fill / Follow / Custom framing as
  usual) and the preset is stored in `project.export.video`.
- Under the picker: one line on what the preset does, the output (size, fps, duration, frames), then
  **Bitrate (Mbps)** and **Size cap (MB)** (empty = the preset's value, shown as the placeholder) and the
  estimated size. For **GIF**: frame rate, width and *Loop forever* instead.
- **Warnings** list what the platform will reject or what the export will change: too long / too short
  for the platform, frame rate over its maximum, canvas outside its range, canvas or fps changed since
  the preset was applied, bitrate over its maximum, estimated size over the cap.
- The **Export** button in the top bar reads *Export GIF* when the GIF preset is on. During the export
  the sheet says when it is making the GIF or re-encoding to fit the cap; when it is done it shows the
  file's size (and, after a cap re-encode, the size before and the bitrate used) and offers
  **Download MP4** / **Download GIF**. **Cancel export** stops every step, including the mux, GIF and
  size-cap ffmpeg runs.

## Presets

| Preset | Canvas | fps | Video bitrate (avg / peak) | Cap | Duration | Source |
|---|---|---|---|---|---|---|
| Custom | the project's | the project's | auto (crf 18) or yours (peak 1.5x) | yours | – | – |
| YouTube 1080p 30 fps | 1920×1080 | 30 | 8 / 12 Mbps | – | – | [YouTube upload settings](https://support.google.com/youtube/answer/1722171) |
| YouTube 1080p 60 fps | 1920×1080 | 60 | 12 / 18 Mbps | – | – | same |
| YouTube Shorts | 1080×1920 | 30 | 10 / 15 Mbps | – | ≤ 3 min | [three-minute Shorts](https://support.google.com/youtube/answer/15424877) |
| TikTok / Reels | 1080×1920 | 30 | 10 / 15 Mbps | – | ≤ 3 min (Reels) | [Instagram Reels](https://about.instagram.com/features/reels) |
| X (Twitter) | 1920×1080 | 30 | 8 / 12 Mbps | 512 MB | ≤ 140 s | [X videos](https://help.x.com/en/using-x/x-videos) (without Premium) |
| LinkedIn | 1920×1080 | 30 | 8 / 12 Mbps, never over 30 | 5,000 MB | 3 s – 15 min | [LinkedIn video](https://www.linkedin.com/help/linkedin/answer/a548372): 256×144 – 4096×2304, 192 kbps – 30 Mbps |
| App Store · iPhone 886×1920 | 886×1920 | 30 (max 30) | 11 / 12 Mbps | 500 MB | 15 – 30 s | [App preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications): H.264 10–12 Mbps, ≤ 30 fps |
| App Store · iPhone 1920×886 | 1920×886 | 30 | 11 / 12 Mbps | 500 MB | 15 – 30 s | same |
| App Store · iPhone 1080×1920 | 1080×1920 | 30 | 11 / 12 Mbps | 500 MB | 15 – 30 s | same (5.5" iPhones) |
| App Store · iPad 1200×1600 | 1200×1600 | 30 | 11 / 12 Mbps | 500 MB | 15 – 30 s | same (13" / 11" iPads) |
| GIF | the project's, scaled to the GIF width | GIF fps (default 15) | – | – | – | palette GIF |

Sizes are 1 MB = 1,000,000 bytes, so a cap holds under either reading of "MB". Numbers read 2026-11-11;
platforms change them, so check before a big upload.

## Project data

```json
"export": {
  "gif": { "fps": 15, "width": 640, "loop": true },
  "video": { "preset": "appstore-iphone-portrait", "bitrateMbps": null, "maxSizeMB": null }
}
```

- `export.video` is optional. **Absent (every older project) = the old export, byte for byte**: crf 18,
  or the desktop Settings bitrate (`LENS_EXPORT_BITRATE_MBPS`, peak 1.5x), no cap, MP4. The vitest
  `exportFinish.test.ts` pins the old encoder arguments.
- `bitrateMbps` (0.1–200) and `maxSizeMB` (0.1–100,000) override the preset's; `null` = the preset's.
  A preset's own bitrate wins over the Settings bitrate. LinkedIn and App Store clamp to their maximum.
- Engine: `packages/engine/src/exportPresets.ts` (`EXPORT_PRESETS`, `applyExportPreset`,
  `encodeSettings`, `estimateBytes`, `bitrateForCap`, `exportChecks`, validation in `resolveProject`).

## How the export does it

- **Rate control**: average bitrate with the preset's peak (`-b:v` / `-maxrate`, buffer 2x the
  average) in both export paths: the in-app path (`server/browserExport.ts`, the shipped desktop app's,
  no Python) and the Python reference (`compositor/render.py --bitrate --maxrate`). x264 averages that
  bitrate on content that needs it (measured 8.64 Mbps for an 8 Mbps preset on noisy 720p); flat screen
  recordings come out well under it, so the estimate is an upper bound.
- **GIF** and the **size cap** run after the encode in `server/exportFinish.ts`, with ffmpeg only (no
  Python), for both paths:
  - GIF: `fps, scale=W:-1 (lanczos), palettegen stats_mode=diff, paletteuse sierra2_4a`, the same filter
    as the reference compositor's GIF, `-loop 0` or `-1`.
  - Size cap: if the MP4 is over the cap it is re-encoded at the average bitrate that fits (cap x 8 x
    0.97, minus 160 kbps audio, over the duration), peak = average, audio copied; retried at 0.85x and
    0.7x; still over after three passes = an error naming the size reached.
- Every step after the frames (audio, mux, GIF, cap) checks for Cancel, and the running ffmpeg child is
  killed by it, so a cancelled export never turns "done".
- The editor's Cancel now shows "Export cancelled" at once and tells the server afterwards (before, the
  sheet waited on that request and `ux-export.spec.ts` read "running" right after the click; that spec
  failed the same way on main 7d1a5db).

## Tests

- vitest engine `exportPresets.test.ts` (7): old projects unchanged, every preset applies and resolves,
  YouTube / App Store / X numbers, overrides and clamps, checks, estimate and cap bitrate, validation.
- vitest editor `exportFinish.test.ts` (7): old encoder arguments unchanged, preset peak, bitrate hit on
  busy content (0.80–1.10x), size cap with duration and audio kept, GIF header / width / loop block,
  Cancel stops a running step.
- Playwright `e2e/exportPresets.spec.ts` (2 tests, web build), bounds in the spec header, set before the
  first run. Measured numbers are in `docs/Tracker.md`.

## Not done

- No platform has been fed an actual upload (App Store Connect acceptance is the demand's test; it needs
  an Apple developer account).
- Slack / Discord size-limit presets (the demand mentions Slack) are covered by Custom + size cap only.
- No two-pass encode: the cap uses single-pass average bitrate with retries.
- Bitrate presets are H.264 only; no HEVC / AV1 / ProRes.
- Not measured on Windows / macOS.
