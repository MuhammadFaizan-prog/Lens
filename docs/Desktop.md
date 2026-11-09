# Lens desktop (Windows recorder)

`apps/desktop` is Lens's first real screen recorder: an Electron app that records a screen (or a
window), logs the cursor, clicks and shortcut combos on the video clock, shows a live auto-zoom preview
while recording, saves a Lens project and opens it in the bundled editor, which exports MP4 without
Python. It ships as an unsigned Windows NSIS installer that updates itself from GitHub Releases
(`docs/Releasing.md`).

**Why Electron and not Tauri.** The planned Tauri / Rust shell cannot be built or tested in the Linux
sandbox this project is developed in. Electron can, and it reuses the React editor (`apps/editor`) and
the TypeScript engine (`packages/engine`) as they are. Recorded in the Tracker. Tauri stays open for
later (smaller binary, native capture).

## What it does

| Part | How |
|---|---|
| Recorder window | Pick a screen or window (desktopCapturer thumbnails), Microphone toggle, Start / Stop. Global hotkey **Ctrl+Shift+R** starts and stops from anywhere; tray icon (red while recording) with Start / Stop, Show recorder, Check for updates, Quit. The recorder window is excluded from captures on Windows 10 2004+ (`setContentProtection`). |
| Capture | `getUserMedia` with the desktop source at the display's physical size, 30 fps, `MediaRecorder` **H.264 in WebM** (VP8 fallback), one chunk per second appended to `recording.webm` as it records, so a crash keeps everything up to the last second. Optional mic on its own recorder (`mic.webm`, Opus). |
| Video clock | t = 0 is the first frame the recorder took: the first frame reaching the stream after `start()` (`requestVideoFrameCallback` captureTime, else presentation time). The `MediaRecorder` "start" event is 50-245 ms late (measured), so it is not used. |
| Cursor | ~60 Hz samples of `screen.getCursorScreenPoint()` (Windows, macOS). On Linux / X11 that call goes stale while the pointer is over other apps' windows (measured), so Linux takes the cursor from uiohook's motion events. Samples are written only when the position changes; the still point is repeated before motion resumes so interpolation does not smear. |
| Clicks + keys | uiohook-napi (Windows prebuild included): mouse down / up / wheel and key presses. Privacy (Rules.md rule 5): a key is stored by name only as a shortcut (Ctrl / Alt / Win held); every other key press is stored as timing only (`"key":""`); bare modifiers are not stored. |
| Coordinates | `src/shared/coords.ts`: DIP → physical through the display containing the point (mixed-DPI Windows layouts, negative origins), physical → capture px of the recorded display (also when the stream is downscaled). Click points come from the hook (physical) cross-checked against the cursor poll; a hook that reports DIPs (DPI-unaware thread) is detected and corrected. |
| Live zoom preview | `src/shared/liveCamera.ts` runs the engine's camera step incrementally: zoom segments from the engine's `planAutoZoom` over the clicks / typing so far, springs advanced per preview frame (~30 fps). Fed the final segments it reproduces `buildCameraTrack` exactly (unit test). |
| Project | On Stop: `screen.mp4` (constant 30 fps H.264, last frame held to the Stop time because Chromium only sends frames on screen change), `mic.wav`, `events.jsonl` (engine `InputEvent` lines + a `#` header), `meta.json`, `project.json` (mic track), `recording.json` (diagnostics: clock candidates, displays, click sources, counts). Saved in `<Videos>\Lens\Lens-<date>_<time>\`. The editor opens on it. |
| Editor + export | The built `apps/editor` is served from a localhost server in the main process with the editor's own `/api` middleware (`apps/editor/server/api.ts`). Export uses the **in-browser render path** (`LENS_EXPORT=browser`): every plan frame is drawn by the preview renderer (the one measured against the compositor in `e2e/parity.spec.ts`), posted as JPEG and encoded by the bundled ffmpeg (H.264, BT.709 limited range, tagged), with the plan's audio pieces (cuts, speed, gain) mixed by an ffmpeg filter graph. |
| Auto-update | electron-updater, GitHub Releases provider; banner "Update available vX" → Update → "Restart to update". See `docs/Releasing.md`. |

## Run it (development, Linux / macOS / Windows)

```bash
npm install
npm run build -w @lens/editor          # the editor the app opens
npm run start -w @lens/desktop         # builds apps/desktop/dist and starts Electron
```

Unit tests: `npm test -w @lens/desktop` (coordinates / DPI, event-log format and privacy, live camera).
Env switches: `LENS_RECORDINGS_DIR`, `LENS_HOTKEY`, `LENS_OPEN_BUNDLE=<dir>` (open a project at launch),
`LENS_NO_EDITOR=1`, `LENS_LOWMEM=1` (small machines: no GPU, fewer processes), `LENS_NO_UPDATE=1`.

## Build the Windows installer (from Linux, no wine)

```bash
npm run build -w @lens/editor
npm run dist:win -w @lens/desktop
```

`scripts/dist-win.mjs` stages only what Windows needs (app JS, the editor build, ffmpeg.exe from the
ffmpeg-static b6.0 release (GPL, licence bundled), DejaVu Sans fonts, uiohook-napi with only its
`win32-x64` prebuild, electron-updater) and runs electron-builder: NSIS one-click per-user installer,
x64, unsigned (`signAndEditExecutable: false`, so no rcedit / wine; the exe keeps Electron's icon and
version resource). The installer / uninstaller icon (a red record dot) is generated at build time by
`scripts/make-icon.mjs`, so no binary icon is committed.

No wine needed, also on arm64 Linux: electron-builder's bundled `linux/makensis` is x86-64 only, so on
other hosts (or with `USE_SYSTEM_MAKENSIS=1`) `dist-win.mjs` points `ELECTRON_BUILDER_NSIS_DIR` at the
system NSIS (`apt install nsis`, 3.11 tested). electron-builder normally builds the uninstaller by
running a helper installer under wine; without wine, `scripts/eb-nowine.cjs` runs electron-builder
with its macOS code path that reads the uninstaller out of the helper's NSIS data instead, and checks
the extracted uninstaller's NSIS CRC (installer and uninstaller icons are identical so the CRC holds).
Checked for v0.1.0: installer CRC valid, `7z l -tNsis` shows `Uninstall Lens.exe` (154 947 bytes) and
`app-64.7z` inside. Output in `out/desktop/` (git-ignored): `Lens-Setup-<version>.exe`, its
`.blockmap`, `latest.yml`, `win-unpacked/`. Never commit the binary.

## Tests (Linux, Xvfb)

`scripts/setup-linux-test.sh` installs Xvfb, xdotool, Tk and Electron's libraries (and builds
uiohook-napi on arm64, whose "linux-arm64" prebuild is an x86-64 binary upstream). Then, one spec per
invocation (`e2e/run.sh` also cleans up Electron / Xvfb left behind by an OOM-killed run):

```bash
apps/desktop/e2e/run.sh record.spec.ts   # synthetic scene: file, clicks, zoom plan, live preview, editor
apps/desktop/e2e/run.sh export.spec.ts   # export the recorded project from the desktop app
LENS_E2E_SCALE=2 apps/desktop/e2e/run.sh record.spec.ts   # Electron at device scale 2 (DIP != px)
```

`record.spec.ts`: a full-screen Tk scene (moving bar; magenta flash under every press, press times
logged) driven by xdotool; the app records it with the global hotkey. Bounds, set before measuring:
duration within 0.5 s of wall time; clicks count exact, position within 2 px, time within 50 ms (the
click is logged between the last frame without its flash and the first with it, ±50 ms; and against
the scene's own press stamp on the video clock whose origin is bracketed by the flash frames); an auto
zoom covers every click, scale ≥ 1.2 with the click in view at the click and central 500 ms later; the
live preview zooms (> 1.2×) within 800 ms of a click; the editor opens the project (status ready,
frames = duration × fps ± 1, 6 clicks). `export.spec.ts`: MP4 frame count = plan frames, at the
requested size, BT.709 (default 720p30 full length; `LENS_E2E_EXPORT_RES=480 LENS_E2E_EXPORT_KEEP_S=8`
exports a smaller project on low-RAM machines). The export streams: the editor draws and posts one
frame at a time and the server holds at most one frame waiting on ffmpeg's stdin. Results and every test change after a failure: Tracker.

## Not verified on Windows

Everything above ran on Linux (arm64, Xvfb, X11). Built for Windows but not run there:

- **SmartScreen**: the installer is unsigned, so Windows shows "Windows protected your PC" → More info →
  Run anyway. Auto-updates are not signature-checked (no `publisherName`).
- **uiohook-napi win32-x64 prebuild**: shipped as is (a valid PE x86-64 DLL; never loaded here). If it
  fails to load, the app still records but logs no clicks or shortcuts; the recorder shows a warning.
- **DPI**: the mixed-DPI mapping (`screen.dipToScreenRect`, hook-vs-poll cross-check) is unit-tested
  with Windows-shaped numbers only; Linux was tested at device scale 1 (and 2 with `LENS_E2E_SCALE=2`).
  Whether uiohook reports physical pixels in Electron's per-monitor-aware process is unverified; the
  cross-check falls back if it does not (`recording.json` `clickSources` tells which path was used).
- **Capture**: Windows Graphics Capture / DXGI through Chromium, H.264 MediaRecorder (Media Foundation
  hardware or OpenH264), `setContentProtection` hiding the recorder, the tray, the global hotkey, the
  NSIS install and `quitAndInstall` (silent install + relaunch).
- **ffmpeg.exe** (ffmpeg-static b6.0) runs for the Stop transcode and export; not executed here.

## Known gaps

- **System audio** is not recorded (mic only). Chromium can loop back system audio on Windows through
  `getDisplayMedia` with audio; not wired yet.
- **Webcam** is not recorded by the desktop app (the editor supports a `cam.mp4` track).
- **System cursor is in the video**: Chromium's desktop capture draws the cursor, and the editor draws
  its own smoothed cursor on top, so both show. Cursorless capture needs native capture (WGC with cursor
  capture off). Workaround: turn the editor's cursor off, or accept the double cursor in zooms.
- **Window capture**: recording works, but cursor / clicks are mapped to the display under the cursor,
  not the window's rect (desktopCapturer gives no window bounds), so zooms are off for window captures.
- **Python features** (privacy scan, step labels, translation, interactive demo / guide export) need the
  Python tools and do not work in the Windows build; video export does (in-browser path). The in-browser
  export does one-pass loudness only, no denoise, no click sounds, no 3 ms fades at cuts.
- Capture is fixed at 30 fps; no pause / resume; no region capture.
