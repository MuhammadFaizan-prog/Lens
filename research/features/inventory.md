# Feature inventory: Screen Studio vs FocuSee (public sources only)

Compiled 2026-11-09 from public pages only: official sites, user guides, FAQs, changelogs, pricing pages, release/news posts and a few third-party reviews. No app binary, installer or bundle was downloaded or inspected (clean-room rule, `docs/Rules.md`). Every source is listed with its access date in `research/evidence/sources.md`. Source keys in the tables (for example `[ss-g-cursor]`) resolve to full URLs in the link list at the bottom of this file.

**Versions covered:** Screen Studio 4.1 (changelog; 4.0 shipped 2 Oct 2026), macOS only. FocuSee 2.5.x (changelog: 2.5.0 Mac 27 Aug 2026, 2.5.2 Windows 15 Oct 2026), macOS and Windows.

## Legend

- `✓` documented by the vendor. `✓*` documented, with a condition in the Behaviour column (OS, beta, Mac-only and so on). `~` partly or indirectly documented. `—` not found in any public source checked (this is not proof the feature is absent). `?` claimed only by a third party or unclear.
- **★SS** = Screen Studio only, **★FS** = FocuSee only, among the sources checked.
- **Plan tiers.** *Screen Studio:* every feature is in every plan: $9/mo billed yearly or $29/mo monthly. Shareable links, cloud transcript and project sharing are listed as plan features [ss-home]. *FocuSee:* Free trial records, edits and exports **1** video with a watermark. **Standard** ($49.99/yr or $19.99/mo, 1 computer) adds unlimited watermark-free 4K60 exports, custom watermark and 5 GB cloud. **Advanced** ($79.99/yr or $24.99/mo, 3 computers) adds 300 AI credits a month. **Lifetime** costs $199.99 for 5 computers, 1,000 credits valid 1 year, and covers v2.x only. AI credit costs: AI Avatar 150/min, Vocal Enhancement 4/min, Smart Cut (fillers and silence) 1/min, Advanced-model subtitles 1/min. Noise reduction, background removal, the beauty filter and local captions cost no credits [fs-price] [fs-g-basic] [fs-faq-credit]. In the tables, "FS: paid" means any activated plan and "FS: credits" means AI credits are consumed.

---

## 1. Recording

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| REC-01 | Record full display | ✓ | ✓ | SS: "Display" mode, click the display to record; use it for full-screen apps. FS: "Full Screen" mode. | [ss-g-display] [fs-g-record] |
| REC-02 | Record single window | ✓ | ✓ | SS: click a window, or right-click "Window" for a list. FS: "Window" mode. | [ss-g-window] [fs-g-record] |
| REC-03 | Record custom area | ✓ | ✓ | SS: drag an area or type dimensions; guide lines; shows the maximum dimensions. FS: "Custom" drag. | [ss-g-area] [ss-cl] [fs-g-record] |
| REC-04 | Cursorless capture + separate mouse-data log | ✓ | ~ | SS FAQ: records the screen without the cursor plus precise mouse data, then re-adds the cursor, so cursor effects work after recording. FS: cursor size, style and smoothing are editable after recording, which implies the same approach, but no explicit statement was found. | [ss-home] [fs-g-cursor] |
| REC-05 | iPhone / iPad over USB | ✓ | ✓ | SS: USB-C to Lightning cable recommended; device must stay unlocked; auto device mockup; **no auto zoom and no cursor** (taps aren't captured). FS: iOS 10+; Windows needs Apple and mirroring drivers; no auto zoom, cursor effects or shortcut display. | [ss-g-iphone] [fs-g-ios] |
| REC-06 | Android over USB | — | ✓ ★FS | Android 11+, USB debugging plus MTP mode; device audio is recorded separately from computer audio; no auto zoom or cursor effects. | [fs-g-android] |
| REC-07 | iPhone Mirroring window | ✓* ★SS | — | macOS 15+: record the iPhone Mirroring app as a window, then pick an iPhone frame in the "Device frame" tab. | [ss-g-mirroring] |
| REC-08 | Microphone | ✓ | ✓ | Pick the device; SS shows a level bar. FS reviewers mention waveform monitoring. | [ss-g-webcam] [fs-g-record] [fs-home] |
| REC-09 | System audio (all apps or chosen apps) | ✓ | ✓ | SS: all apps, one app, or a group of apps (the rest are ignored). FS: pick the system audio device, or "audio from a selected application only". FS on macOS earlier than 13 needs an audio driver. | [ss-g-sysaudio] [fs-g-record] [fs-g-perm] |
| REC-10 | Webcam | ✓ | ✓ | SS: the live preview is not baked into the output; it can be hidden; layout is edited afterwards. FS: camera dropdown; for device recording only the computer's camera can be used. | [ss-g-webcam] [fs-g-record] |
| REC-11 | Pause / resume / restart / delete during recording | ✓ | ~ | SS: control widget can finish, pause, restart and delete; it is excluded from capture on macOS 12.3+. FS: pause/continue and finish hotkeys; no restart or delete documented. | [ss-g-inprogress] [fs-g-perm] |
| REC-12 | Countdown | ✓ | ✓ | SS: "a few seconds". FS: 3-second countdown, configurable in Record settings. | [ss-home] [fs-g-record] [fs-g-perm] |
| REC-13 | Global hotkeys | ✓ | ✓ | SS: global start/stop (set during onboarding), open recorder ⌥⌘↩, all customizable; ⌘/ lists editor shortcuts. FS: new recording, full screen, custom, window, pause/continue, finish; all customizable. | [ss-g-new] [ss-g-shortcuts] [fs-g-perm] |
| REC-14 | Recording flags / markers | ✓ ★SS | — | ⌘⌥⌃F drops a flag that shows on the timeline; shortcut is customizable. | [ss-g-flag] |
| REC-15 | Teleprompter / speaker notes | ✓ | ✓ | SS "Speaker notes": scroll speed, opacity, font size; ⌘⌥ starts the prompter; not captured. FS: scroll speed, font size, colour, background opacity (Mac only); excluded from capture on Win 10.0.19041+ and macOS 12.3+. | [ss-g-notes] [fs-g-teleprompter] |
| REC-16 | Hide desktop icons / taskbar | ✓ | ✓ | SS: "Hide desktop icons" utility. FS: hide desktop icons and hide taskbar in Record settings. | [ss-home] [fs-g-perm] |
| REC-17 | Resize recorded window to an exact size | ✓ ★SS | — | One click resizes the target window so recordings come out consistent. | [ss-home] |
| REC-18 | Crash-safe recording | ✓ ★SS | — | The take is saved to disk every 2 s and recovered after a crash or power loss. | [ss-home] |
| REC-19 | Capture engine choice | — | ✓ ★FS | macOS: "Modern" (ScreenCaptureKit, 12.3+) or "Traditional" engine; the traditional one also records the toolbar. SS is built on ScreenCaptureKit with no switch. | [fs-g-engine] [ss-home] |
| REC-20 | Recording quality setting | — | ✓ | FS Record settings include "recording quality" (values not documented). | [fs-g-perm] |
| REC-21 | Auto-effects toggles before recording | ✓ | ✓ | SS: "Create zooms automatically" (Settings → Recording). FS: auto-add zoom, 3D Motion pre-toggle, typing auto-zoom (off by default) in Settings or the recording bar. | [ss-g-disableauto] [fs-g-perm] [fs-g-3d] [fs-faq-edit] |
| REC-22 | Menu bar / tray quick start | ✓ | ✓ | SS: menu-bar icon and tray menu start recordings and open projects. FS: Mac menu bar or Windows tray with 3 modes. | [ss-g-new] [ss-cl] [fs-g-record] |
| REC-23 | Hide Dock icon | ✓ ★SS | — | Hidden when no project or recording is open. | [ss-g-dock] |
| REC-24 | Recent projects in the recording picker | ✓ | ~ | SS 4.0: a folder button shows recent projects next to the picker. FS: File → project history. | [ss-cl] [fs-g-export] |
| REC-25 | Platform / OS | macOS 13.1+ | Win 10+, macOS 10.15+ | SS: Apple silicon recommended; Intel MacBook Pro 2018+ and Air 2020+; 8 GB RAM. FS: i5 2.9 GHz or M1; 8 GB RAM. | [ss-g-sysreq] [fs-specs] |
| REC-26 | Recording length limit | — | ✓ | FS: unlimited ("as long as your computer supports"). SS: not stated for recording; share links are capped at 30 min. | [fs-g-record] [fs-price] [ss-g-links] |

## 2. Auto-zoom and camera motion

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| ZM-01 | Auto zoom on clicks | ✓ | ✓ | Zoom segments are generated from click positions; SS shows purple blocks on the zoom track, FS shows blue. An SS "Auto" zoom with no click in its span zooms nowhere. | [ss-g-addzoom] [ss-g-autozoom] [fs-g-zoom] |
| ZM-02 | Auto zoom on typing | ? | ✓* | FS 2.4: detects typing and zooms on the input area. **Off by default**; Mac first, Windows 2.4.1. SS: the official site only says "like where you clicked"; a competitor blog claims SS zooms on typing (unverified). | [fs-n-24] [fs-faq-edit] [fs-cl] [ss-home] [prequel] |
| ZM-03 | Manual zoom (focus point) | ✓ | ✓ | SS: switch the zoom to "Manual" and drag the purple dot; snaps to 50% (±1%); hold ⌘ to disable snapping (4.1). FS: set position manually; split a zoom into clips to move the focus. | [ss-g-manualzoom] [ss-cl] [fs-g-edit] [fs-g-zoom] |
| ZM-04 | Zoom level (depth) | ✓ | ✓ | SS: zoom-level setting per zoom; the picker shows % (range not published). FS: **1.0×–4.0×** per zoom. | [ss-g-manualzoom] [ss-cl] [fs-g-zoom] |
| ZM-05 | Add / resize / disable / remove zooms on the timeline | ✓ | ✓ | Click the track to add, drag edges for duration, right-click to disable or remove (SS); a "Disable Zoom" button (FS). | [ss-g-addzoom] [fs-g-edit] |
| ZM-06 | Apply settings to all zooms | ✓ | ✓ | SS: "apply to all" toast (changelog). FS: "Apply the current settings to all zoom parts". | [ss-cl] [fs-g-zoom] |
| ZM-07 | Instant zoom (no animation) | ✓ ★SS | — | "Instant Animation" toggle per zoom. | [ss-g-instant] |
| ZM-08 | Zoom/pan animation speed | ✓ | ✓ | SS: screen animation **Focused** (settles fast, readable) or **Smooth** (more fluid), under advanced settings. FS: zoom & pan **Slow (default) / Medium / Fast / Rapid**, or Custom **Tension / Friction / Mass** ("Newton's laws"); Reset button. | [ss-g-anim] [fs-g-motionblur] |
| ZM-09 | Follow / pan while zoomed | ✓ | ✓ | SS: auto zooms track the click area; v3 "Always keep zoomed in" (cursor-driven crop for other aspect ratios) was **removed in 4.0**. FS: "Auto Pan & Zoom"; a "Fixed Zoom Part" canvas option pins the zoomed area. | [ss-g-aspect] [ss-cl] [fs-home] [fs-g-edit] |
| ZM-10 | Glass Loupe zoom | ✓ ★SS | — | 4.0: magnifies a detail under a glass lens while the rest of the screen stays visible. A second zoom type next to "Classic". | [ss-cl] [ss-4] [ss-home] |
| ZM-11 | 3D Motion (tilt / perspective camera) | — | ✓ ★FS | Switch any 2D zoom clip to 3D Motion. **Auto:** follows the cursor; needs clicks; intensity **Subtle / Default / Strong** plus zoom level. **Manual:** tilt presets or custom X/Y/Z rotation and FOV, X/Y position (e.g. ±80% for an entrance slide-in), focus area. Can be enabled before recording. FS: paid. | [fs-g-3d] [fs-f-3d] |
| ZM-12 | AI upscaling of zoomed text | ✓ ★SS | — | Local model trained on macOS screenshots; "6.5× upscale" on the homepage; 4.1 notes say "upscales up to 4×", including small third-party cursors. | [ss-home] [ss-cl] |
| ZM-13 | Smart framing (camera never covers cursor) | ✓ ★SS | ~ | SS: zooms are balanced so the webcam never covers the cursor. FS: shrinks the camera during zoom instead (see CAM-05). | [ss-home] [fs-f-camlayout] |
| ZM-14 | Zooms re-aim on aspect-ratio change | ✓ ★SS | — | Changing between wide, square and vertical re-aims zooms and rearranges layouts and captions. | [ss-home] |
| ZM-15 | Turn auto zoom off globally | ✓ | ✓ | SS: Settings → Recording → "Create zooms automatically". FS: Record settings. | [ss-g-disableauto] [fs-g-perm] |
| ZM-16 | Spotlight synced with zoom | — | ✓ ★FS | Spotlight "intelligently syncs with the zoom effect" (July 2025 update). | [fs-n-jul25] |

## 3. Cursor

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| CUR-01 | Cursor smoothing | ✓ | ✓ | SS: on by default; "Cursor animation style" **Smooth / Medium / Rapid / None**; can be disabled per timeline fragment (useful for drop-downs). FS: cursor movement **Slow / Medium (default) / Fast / Rapid** or Custom **Tension / Friction / Mass**; can be turned off; 2.5 adds "Smooth Cursor Path" with a smoothing level. | [ss-g-anim] [ss-g-nosmooth] [fs-g-motionblur] [fs-g-cursor] [fs-cl] |
| CUR-02 | Cursor size | ✓ | ✓ | Slider in both, applied after recording. | [ss-g-cursor] [fs-g-cursor] |
| CUR-03 | Cursor styles / sets | ✓ | ✓ | SS: macOS or Touch cursor type; "custom cursor images from a large collection of cursor sets" (3.0); "Always use default system cursor"; system cursors swap to high-resolution versions as they grow. FS: **up to 40 styles**, colour; high-resolution rendering. | [ss-g-cursor] [ss-cl] [ss-home] [fs-f-autozoom] |
| CUR-04 | Hide cursor when idle | ✓ | ✓ | SS: "Hide cursor if it's not moving"; fades out and returns on movement. FS: toggle, **custom idle duration**, hide/show animation choice (2.5). | [ss-g-cursor] [ss-home] [fs-g-cursor] [fs-cl] |
| CUR-05 | Hide cursor entirely / per section | ✓ | ✓ | SS: global "Hide cursor", or right-click a fragment → "Hide mouse cursor". FS: "Show Cursor" toggle globally and per clip. | [ss-g-cursor] [ss-g-hidecursor] [fs-g-edit] |
| CUR-06 | Loop cursor to start position | ✓ | ✓ | SS: near the end the cursor glides back to its first position, for seamless loops. FS 2.5: "Cursor position at end of video": keep or return to start, plus an end-animation duration. | [ss-g-cursor] [fs-g-cursor] |
| CUR-07 | Click effects | ✓ | ✓ | SS: circle or ripple ("colourful ripple", redesigned in 4.0). FS: **8 click effects**. | [ss-home] [ss-cl] [fs-f-autozoom] |
| CUR-08 | Click sounds | ✓ | ✓ | SS: choose from several click sounds, plus volume. FS: toggle, choose sound, volume. | [ss-g-clicksound] [fs-g-cursor] |
| CUR-09 | Rotate cursor with motion | ✓ | ✓ | SS advanced: "Rotate cursor while moving". FS 2.5: "Cursor Angle" plus "Dynamic Cursor Direction" (rotates with movement). | [ss-g-cursor] [fs-g-cursor] |
| CUR-10 | Stop cursor movement before end | ✓ ★SS | — | Advanced: freezes the cursor before the end, so the move to the stop button isn't shown. | [ss-g-cursor] |
| CUR-11 | Remove cursor shakes | ✓ ★SS | — | Advanced: removes unintended jitter, e.g. from accessibility tools. | [ss-g-cursor] |
| CUR-12 | Optimize original cursor types | ✓ ★SS | — | Advanced: reduces rapid cursor-shape switching. | [ss-g-cursor] |
| CUR-13 | Cursor motion blur | ✓ | ✓ | See LOOK-11. | [ss-g-anim] [fs-g-motionblur] |
| CUR-14 | Touch cursor for device recordings | ✓ | — | SS: a "Touch" cursor type for iPad and iPhone; a Bluetooth mouse on the device shows a circular cursor, without smoothing. | [ss-g-cursor] [ss-g-iphone] |

## 4. Look (canvas, background, frame)

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| LOOK-01 | Wallpaper backgrounds | ✓ | ✓ | SS: macOS-native plus bundled wallpapers. FS: background templates, plus macOS 26 and 27 wallpapers (2025/2026 updates). | [ss-g-bg] [fs-g-edit] [fs-n-jul25] [fs-cl] |
| LOOK-02 | Gradient background | ✓ | ~ | SS: generated from a chosen colour; reduced banding in 4.0. FS: not explicit (templates). | [ss-g-bg] [ss-cl] |
| LOOK-03 | Solid colour background | ✓ | ✓ | SS: paste a hex or pick a colour. FS: "Video Background Color" (comparison page). | [ss-g-bg] [fs-cmp] |
| LOOK-04 | Custom image background | ✓ | ~ | SS: upload an image. FS: not explicit in the guide. | [ss-g-bg] |
| LOOK-05 | Unsplash photo search | ✓ ★SS | — | 4.0: search Unsplash in the app. | [ss-cl] [ss-home] |
| LOOK-06 | Background blur | — | ✓ ★FS | 2.5: blurs the canvas background. | [fs-g-edit] [fs-cl] |
| LOOK-07 | Padding | ✓ | ✓ | Space around the recording; SS padding 0 shows no background. | [ss-g-bg] [fs-g-edit] |
| LOOK-08 | Corner radius | ✓ | ✓ | "Rounded corners" (SS) and "Roundness" (FS) sliders. | [ss-g-bg] [fs-g-edit] |
| LOOK-09 | Inset | ✓ | ✓ | An inner frame/gap between the recording and its border. FS: not available once a custom camera layout is applied. | [ss-g-bg] [fs-g-edit] [fs-g-camlayout] |
| LOOK-10 | Drop shadow | ✓ | ✓ | SS: **angle, distance, softness**. FS: presence and intensity. | [ss-home] [ss-g-bg] [fs-g-edit] |
| LOOK-11 | Motion blur | ✓ | ✓ | SS: strength slider; per-type advanced settings (cursor, zoom-in, screen move) **removed in 4.0**. FS: three toggles (**Zoom-in, Screen, Cursor** motion blur), degree **default 50**, Reset; on by default. | [ss-g-anim] [ss-cl] [fs-g-motionblur] |
| LOOK-12 | Aspect ratios | ✓ | ✓ | SS: **Auto, 16:9, 9:16, 1:1, 4:3, 3:4**. FS: **Auto, 1:1, 4:3, 16:9, 9:16** plus presets for YouTube, TikTok, Twitter, LinkedIn, Facebook and Instagram. | [ss-g-aspect] [fs-g-edit] |
| LOOK-13 | Reel-mode safe-area preview | ✓ ★SS | — | Overlays the Instagram or TikTok UI on the preview (Off / Instagram / TikTok). | [ss-home] |
| LOOK-14 | Crop recording | ✓ | ✓ | SS: crop tool with drag or numeric input and an aspect lock; guide lines. FS: **16:9, 4:3, 1:1, 9:16** or custom. | [ss-g-crop] [fs-g-edit] |
| LOOK-15 | Device frames / mockups | ✓ | ✓ | SS: bezel and colour matched to the iPhone model; iPhone 18 Pro frames (4.1); mockup can be disabled. FS: iPhone, iPad, Samsung, Google Pixel and Android tablet frames. | [ss-home] [ss-cl] [ss-g-iphone] [fs-g-ios] [fs-g-edit] |
| LOOK-16 | Debanding and super resolution on export | ✓ ★SS | — | On-device enhancement listed under privacy. | [ss-home] |

## 5. Webcam layouts and transitions

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| CAM-01 | Layout kinds | ✓ | ✓ | SS: **Fullscreen camera, Split screen** (side by side or stacked for vertical), **Camera overlay, Screen only, Camera cutout**. FS: picture-in-picture, full screen, side by side, above/behind, hidden; **6 predefined layouts** depending on canvas orientation; custom drag-and-drop layout. | [ss-home] [ss-g-dynlayout] [fs-g-camlayout] [fs-f-camlayout] |
| CAM-02 | Dynamic layouts on a timeline, with animated transitions | ✓ | ✓ | SS 3.0+: Layouts track, transitions animated automatically. FS (July 2025): "Add Layout" segments with smooth transitions; a static layout is also possible. | [ss-g-dynlayout] [ss-cl] [fs-n-jul25] [fs-f-camlayout] |
| CAM-03 | Position, size, roundness | ✓ | ✓ | SS: position, size, roundness; "Camera aspect ratio" replaced Shape in 4.0. FS: size, roundness, border colour. | [ss-g-camera] [ss-cl] [fs-g-camlayout] [fs-f-camlayout] |
| CAM-04 | Mirror / flip | ✓ | ✓ | SS: mirror camera. FS: horizontal flip plus mirror camera. | [ss-g-camera] [fs-g-camlayout] |
| CAM-05 | Camera size during zoom | ✓ | ✓ | Shrinks the camera while zoomed; SS lets you set the size or turn it off. | [ss-g-camera] [fs-g-camlayout] |
| CAM-06 | Camera crop | ✓ | ✓ | SS 4.0 "Camera crop". FS: crop slider. | [ss-cl] [fs-g-camlayout] |
| CAM-07 | Background removal / cutout | ✓* | ✓ | SS: "Camera cutout", local; requires **Apple silicon and macOS 15+** (4.1); quality improved in 4.1. FS: **Original / Remove / Blur / Image** background; no credits. | [ss-cl] [ss-home] [fs-g-rmbg] [fs-faq-credit] |
| CAM-08 | Face tracking | ✓ ★SS | — | Keeps the face centred as you move. | [ss-home] [ss-cl] |
| CAM-09 | Hide camera during silence | ✓ ★SS | — | The camera steps aside when you stop talking. | [ss-home] [ss-cl] |
| CAM-10 | Colour grading / filters | ✓ | ✓ | SS: **12 looks** with strength, custom presets, custom **LUT** files. FS: colour/tone filters. | [ss-cl] [fs-g-camlayout] |
| CAM-11 | Webcam sharpen | ✓ ★SS | — | "Crisper detail without halos". | [ss-home] |
| CAM-12 | Beauty filter | — | ✓ ★FS | One intensity slider (skin smoothing plus whitening); non-destructive; free. Mac first. | [fs-g-beauty] [fs-faq-edit] |
| CAM-13 | Camera frames / borders | — | ✓ ★FS | A choice of camera borders and frames. | [fs-g-camlayout] [fs-g-edit] |
| CAM-14 | Camera delay / lip-sync correction | ✓ ★SS | — | 4.1 measures camera latency; a manual "Camera delay" setting is under Camera Style → Advanced. | [ss-cl] |
| CAM-15 | macOS camera effects (Background, Portrait, Studio Light, Reactions) | ~ | — | SS documents the macOS Control Center camera effects and how to turn off Reactions. These are OS features. | [ss-g-camsettings] [ss-g-reactions] |

## 6. Editing timeline

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| EDT-01 | Trim ends | ✓ | ✓ | Drag the clip edges; SS shows a yellow trim bubble that can be clicked to undo. | [ss-g-trim] [fs-g-edit] |
| EDT-02 | Split / cut / delete middle | ✓ | ✓ | SS: hold ⌥ for the split tool, C cuts at the playhead, X ripple-deletes back to the previous cut. FS: "Clip" splits, Delete removes. | [ss-g-trim] [ss-cl] [fs-g-edit] |
| EDT-03 | Speed per clip | ✓ | ✓ | SS: right-click → Set speed (preset list), whole recording or a fragment. FS: per-clip speed; can apply to all clips. | [ss-g-speed] [fs-g-edit] |
| EDT-04 | Typing detection + speed-up | ✓ | ✓* | SS 3.0+: typing parts are detected; a speed slider; "Apply to all typing parts". FS 2.4: typing marked on the timeline; "Apply to All Typing Segments" (Mac first). | [ss-g-typing] [ss-cl] [fs-faq-edit] [fs-n-24] |
| EDT-05 | Per-clip volume | ✓ | ✓ | SS: right-click → Set volume (list). FS 2.5: clip audio for system, mic and device separately. | [ss-g-volume] [fs-g-edit] [fs-cl] |
| EDT-06 | Per-clip cursor visibility / smoothing | ✓ | ✓ | See CUR-05 and CUR-01. | [ss-g-hidecursor] [fs-g-edit] |
| EDT-07 | Multi-track timeline | ✓ | ✓ | SS: clip, zoom, layouts, mask, shortcuts and caption tracks; a 4.0 toolbar adds zooms, layouts and masks. FS: clip, zoom, annotation/blur/spotlight tracks, typing markers. | [ss-cl] [ss-g-mask] [ss-g-shortcutsdisp] [fs-g-blur] [fs-g-spotlight] |
| EDT-08 | Audio scrubbing | ✓ | ~ | SS: a scrubber whose drag speed sets playback speed; 4.1 scrubs smoothly, plays in reverse at any speed, and plays volume changes while you drag. FS: timeline hover preview (2.5.1). | [ss-g-scrubber] [ss-cl] [fs-cl] |
| EDT-09 | J/K/L shuttle | ✓ ★SS | — | K plays/pauses; J and L shuttle at up to 16×; arrows step 0.5 s (1 s with Shift). | [ss-cl] |
| EDT-10 | Timeline zoom | ✓ | ✓ | SS: slider, pinch, ⌘-scroll. FS: zoom-in/out timeline hotkeys. | [ss-g-trim] [ss-cl] [fs-g-perm] |
| EDT-11 | Copy / paste properties | — | ✓ ★FS | Copies effect or clip settings to another clip; a Reset hotkey restores defaults. | [fs-g-perm] |
| EDT-12 | Command menu (⌘K) | ✓ ★SS | — | Keyboard access to any setting or action. | [ss-g-cmdk] |
| EDT-13 | Copy current frame as image | ✓ ★SS | — | ⌘C or the context menu. | [ss-g-copyframe] |
| EDT-14 | Import an existing video as a project | ✓ | ✓ | SS: MP4 only; no cursor or camera effects for imports. FS: **H.264 MP4 only**; zoom, annotations, layouts, backgrounds and watermark are available. | [ss-g-import] [fs-g-import] |
| EDT-15 | Preview performance modes | ✓ ★SS | — | **Quality** (matches export, motion blur on), **Performance** (motion blur off, higher fps), **Power saving**. | [ss-g-perf] |
| EDT-16 | Edit by transcript | ✓ ★SS | ~ | SS 4.0: delete a sentence from the transcript to cut it. FS: "Visual Text-Based Editing" only for highlighted fillers and silences inside Smart Cut (see AI-07). | [ss-cl] [ss-home] [fs-n-v2] |
| EDT-17 | Scenes / chapters | — | — | Not documented by either. Nearest equivalents are SS recording flags (REC-14) and layout segments. | — |
| EDT-18 | Undo / redo | ✓ | ✓ | SS: playhead re-sync on undo (changelog). FS: Undo hotkey. | [ss-cl] [fs-g-perm] |

## 7. Audio

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| AUD-01 | Noise reduction | ✓* | ✓ | SS 4.x "Microphone audio mode": **Standard / Noise reduction / Podcast (beta) / Loud / Off**, on-device. Intel Macs get Standard/Loud/Off only (4.1); not shown on macOS ≤13 (4.0). FS: one-click "Audio Noise Reduction", free. | [ss-home] [ss-cl] [fs-g-audio] [fs-faq-credit] |
| AUD-02 | Voice enhancement | ✓ | ✓ | SS: "Podcast" mode, for voice-led videos. FS: "Vocal Enhancement" (AI EQ/frequency shaping, removes harshness, evens near/far levels); **FS: credits 4/min**. | [ss-home] [fs-g-voice] |
| AUD-03 | Loudness levelling / volume boost | ✓ | ✓ | SS 4.1 "Loud" mode boosts the voice to a consistent level. FS: mic volume up to **300%**, system volume boost; 2.0 claims "dynamic balancing". | [ss-cl] [fs-g-audio] [fs-n-v2] |
| AUD-04 | Mute mic / system audio | ✓ | ✓ | SS 4.0: new recordings with no speech open with "Mute microphone" on. FS: separate mute toggles. | [ss-cl] [fs-g-audio] |
| AUD-05 | Background music | ✓ | ✓ | SS: built-in royalty-free library or your own MP3/MP4; loops to fit. FS 2.4: library (Focus, Business, Tech, Chill; sourced from Pixabay) or **MP3/M4A/AAC/WAV**; trim, **volume 0–100%**, fade in/out, loop (**on by default**), start/end range; **one track per project**. | [ss-g-music] [ss-home] [fs-g-music] [fs-n-24] |
| AUD-06 | Separate audio tracks (mic / system / device) | ✓ | ✓ | Edited independently; SS raw-file extraction exposes the tracks; FS per-clip control. | [ss-g-extract] [fs-g-edit] |
| AUD-07 | Mono mic export | ✓ | — | SS: exported mic stream is converted to mono. | [ss-cl] |
| AUD-08 | Preview audio identical to export | ✓ | — | SS 4.1: single audio engine, "same at binary level". | [ss-cl] |

## 8. AI features

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| AI-01 | Local captions / transcription | ✓ | ✓ | SS: Whisper **Base / Small / Medium** or Apple Speech (macOS 26+; Whisper removed on 26+); language auto or chosen; optional **prompt** for names; needs mic audio. FS "Local Model": **Nano / Basic / Pro**, 10 languages, free. | [ss-g-captions] [ss-cl] [fs-g-captions] |
| AI-02 | Cloud transcription | ✓ | ✓ | SS 4.0: uploads mic audio for higher quality and precise timings; audio deleted afterwards. FS "Advanced Model": **55+ languages**, accuracy claims of "98%" and "99%"; **credits 1/min**. | [ss-cl] [ss-home] [fs-g-aisubs] [fs-f-aisub] |
| AI-03 | Caption styling | ✓ | ✓ | SS 4.0: font style, colour, position, size; **line-by-line or word-by-word**; animation **appear / fade in / slide in**; repositions per aspect. FS 2.4: **5 styles** (3 standard, 2 "Highlight" word-emphasis); font, size, word colour, stroke colour/width, shadow colour/size/position/opacity, highlight colour/opacity, background transparency, position, spacing. | [ss-cl] [ss-home] [fs-g-editsubs] [fs-n-24] |
| AI-04 | Caption text and timing edit | ✓ | ✓ | SS: "Edit transcript" fixes typos. FS: edit text and timing; split (Enter), line break (Shift+Enter), merge, add or delete blocks; click a timestamp to seek. | [ss-g-captions] [fs-g-editsubs] [fs-f-aisub] |
| AI-05 | SRT import | — | ✓ ★FS | SRT only; Highlight styles don't apply to imported subtitles. | [fs-g-editsubs] [fs-faq-edit] |
| AI-06 | SRT / transcript export | ✓ ★SS | — | The .srt follows cuts and speed changes (fixed in 4.0). | [ss-home] [ss-cl] [ss-g-captions] |
| AI-07 | Filler-word removal | ✓ | ✓ | SS 4.0: finds um/uh and offers to cut them. FS "Smart Cut": language auto-detect, recognition, all detected segments pre-selected, Delete, Filter, Reset; free if subtitles already exist, otherwise **credits 1/min**; 55+ languages. | [ss-cl] [fs-g-smartcut] [fs-n-v2] |
| AI-08 | Pause / silence shortening | ✓ | ✓ | SS: "Tighten pause" offers to shorten long pauses. FS: silence removal inside Smart Cut. | [ss-cl] [fs-g-smartcut] |
| AI-09 | Subtitle translation | — | — | Neither documents translating captions into another language. FS "55+ languages" means recognising the spoken language. | [fs-f-aisub] [ss-g-captions] |
| AI-10 | AI voiceover (TTS from a script) | ✓ ★SS | — | Type a script to add a voice and change it later; the text is sent to the cloud. | [ss-home] |
| AI-11 | AI dubbing / voice cloning | — | — | Not documented by either. | — |
| AI-12 | AI avatars | — | ✓ ★FS | **100+ avatars**, lip-synced to **your recorded voice** (no TTS yet); generated in an AI Task Center, applied as the camera; **150 credits/min**. | [fs-g-avatar] [fs-n-v2] [fs-price] |
| AI-13 | Auto-hide sensitive data | ✓ ★SS | — | 4.1 "Hide sensitive data": covers emails, phone numbers, card numbers and keys, plus custom phrases; follows scrolling and typing; on-device. | [ss-cl] |
| AI-14 | Auto-hide faces | ✓ ★SS | — | 4.1 "Hide faces": blurs faces in avatars, photos and video calls; tracks while scrolling. | [ss-cl] |
| AI-15 | Live captions while recording | — | ? | The FocuSee news index blurb says "Add captions while recording"; no guide documents it. | [fs-n-idx] |

## 9. Text, annotations, keystrokes

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| TXT-01 | Keyboard shortcut display | ✓ | ✓ | SS: auto-detected; label size slider; "Show single key shortcuts" (ignores rapid typing); timeline to disable one shortcut or all of the same kind; 4.0 keycaps match Mac key names. FS: show shortcuts, single-key toggle, style, font colour, background colour and **opacity**, size, **position**, show/hide each; Mac needs accessibility permission. | [ss-g-shortcutsdisp] [ss-cl] [fs-g-keys] |
| TXT-02 | Text annotations | — | ✓ ★FS | Basic or artistic text; font, size, colour, style; position, duration, animation; timeline-placed. | [fs-g-annot] [fs-faq-edit] |
| TXT-03 | Shapes, arrows, lines | — | ✓ ★FS | Colour, opacity, stroke width, corner radius; drag, scale, rotate. | [fs-g-annot] |
| TXT-04 | Spotlight / highlight | ✓ | ✓ | SS: "Highlight" mask dims the rest of the frame; size and opacity. FS: Spotlight with rectangle↔ellipse shape, mask opacity, feathering; several at once; synced with zoom. | [ss-g-mask] [ss-home] [fs-g-spotlight] [fs-n-jul25] |
| TXT-05 | Manual privacy blur / mask | ✓ | ✓ | SS: mask that blends into the UI around it (takes the colour it covers); **does not follow scrolling**; mask and highlight can't share a frame; shortcut 4. FS: mosaic/blur with intensity and shape (rect↔ellipse); several per track. | [ss-g-mask] [ss-cl] [fs-g-blur] |
| TXT-06 | Magnifier / callout | ~ | ✓ | FS: Magnifier and Callout (popout, marquee, colour, roundness, mask opacity; 2.4 adds Callout styles). SS's closest equivalent is Glass Loupe (ZM-10), which is a zoom type. | [fs-g-annot] [fs-cl] [ss-cl] |
| TXT-07 | Watermark | — | ✓ ★FS | Image only (PNG, JPG, JPEG, SVG); position, size, opacity; free tier can preview but not export it (FS: paid). | [fs-g-watermark] [fs-price] |

## 10. Export

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| EXP-01 | MP4 resolution | ✓ | ✓ | SS: **720p, 1080p, 4K**. FS: **480p, 720p, 1080p, 2K, 4K, Original**. FS free: 1 export with a watermark. | [ss-home] [fs-g-export] [fs-g-record] |
| EXP-02 | Frame rate | ✓ | ✓ | SS: up to **60 fps** (24/30/60 discussed). FS: **10, 20, 24, 25, 30, 50, 60 fps**. | [ss-home] [ss-g-exportsettings] [fs-g-record] |
| EXP-03 | Quality / compression | ✓ | ✓ | SS: compression level doesn't change export time. FS: quality setting trades size against time. | [ss-g-exportsettings] [fs-g-export] |
| EXP-04 | GIF | ✓ | ✓ | SS: up to 1080p; own encoder in 4.1 (~3× smaller, up to 4× faster); **"balanced" by default**, "High quality" toggle; under 1 min recommended. FS: GIF format. | [ss-home] [ss-cl] [ss-g-exportsettings] [fs-g-export] |
| EXP-05 | ProRes | ✓ ★SS | — | 4.1: **422 LT / 422 / 422 HQ / 4444**, .mov with uncompressed audio. | [ss-cl] |
| EXP-06 | Encoder / acceleration | ✓ | ✓ | SS: own H.264 encoder plus hardware media engine (4.1, up to 3× faster). FS: GPU-accelerated export (2.4.x); NVIDIA-GPU guide. | [ss-cl] [ss-home] [fs-cl] [fs-g-nvidia] |
| EXP-07 | Copy to clipboard | ✓ | ✓ | SS: "Copy to Clipboard" and paste into Slack or Linear. FS: copy the exported file (2.5). | [ss-g-export] [ss-home] [fs-g-export] [fs-cl] |
| EXP-08 | Default / quick export settings | ✓ | ✓ | SS: balanced presets, quick-export action with last settings, quick share widget settings. FS: default export settings in Settings → Export. | [ss-home] [ss-cl] [ss-g-quickshare] [fs-g-perm] |
| EXP-09 | Batch export several projects | ✓ ★SS | — | 3.0: select several projects; asks for locations up front. | [ss-cl] |
| EXP-10 | Extract raw source files | ✓ | ✓ | Camera, mic and screen tracks (SS); camera, audio and video (FS). | [ss-g-extract] [fs-g-export] |
| EXP-11 | Size and time estimate, background-task progress | ✓ ★SS | — | 4.1: ranges when content-dependent; export starts before you choose the save path. | [ss-cl] |
| EXP-12 | Quick share widget after recording | ✓ ★SS | — | Share, Save, Copy or Edit straight after stopping; can be disabled. | [ss-g-quickshare] |

## 11. Collaboration and sharing

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| COL-01 | Shareable cloud links | ✓ | ✓ | SS: **1080p60, videos up to 30 min**, browser playback; managed in a dashboard. FS: upload with a chosen name, resolution, fps and quality; enable/disable sharing; **password**; manage, copy or delete in File History; storage is "5 GB" on the pricing page but "at least 1 GB" in the guide. **FS: paid.** | [ss-home] [ss-g-links] [fs-g-share] [fs-price] |
| COL-02 | Private links / access control | ✓ | ✓ | SS: private links and control over who can watch. FS: password plus sharing toggle. | [ss-home] [fs-g-share] |
| COL-03 | Timestamped viewer comments | ✓ ★SS | — | Viewers comment on an exact second (⌘↩), with a username. | [ss-g-comments] [ss-home] |
| COL-04 | View counts | ✓ ★SS | — | Show or hide view counts. | [ss-home] |
| COL-05 | Share an editable project | ✓ ★SS | — | SS: share a project link (beta), **up to 20 GB**, or zip the `.screenstudio` bundle. FS FAQ suggests exporting a video and sending the file. | [ss-home] [ss-cl] [ss-g-shareproj] [fs-faq-edit] |
| COL-06 | Share presets | ✓ | ? | SS: open the preset file in Finder and send it. FS: the comparison page lists "Shareable Presets" without detail. | [ss-g-sharepreset] [fs-cmp] |

## 12. Other (presets, projects, licensing, integrations)

| ID | Feature | Screen Studio | FocuSee | Behaviour / params | Source |
|---|---|---|---|---|---|
| OTH-01 | Style presets | ✓ | ✓ | SS: save the whole look (background, aspect, camera position and more), apply it, share it; "use last project settings as default". FS: name, rename, **set as default** (auto-applies to new recordings), apply, delete; only attributes that apply to the project are applied. | [ss-g-createpreset] [ss-g-applypreset] [ss-g-projsettings] [fs-g-preset] |
| OTH-02 | Templates / brand kit | ~ | ~ | Neither has a named "brand kit". SS pitches presets for teams; FS pricing lists "Custom Templates", which match its presets. | [ss-home] [fs-price] |
| OTH-03 | Project files | ✓ | ✓ | SS: `.screenstudio` bundle, Save / Save As, default folder, backup on every save, Finder/Quick Look previews, reopens at the last playhead. FS: project history with thumbnails, search, rename, batch delete, timestamps. | [ss-g-save] [ss-g-shareproj] [ss-cl] [fs-g-export] [fs-cl] |
| OTH-04 | Integrations / API | — | — | No public API or plugin system documented. SS relies on clipboard paste into Slack and Linear. | [ss-home] |
| OTH-05 | UI localization | — | ✓ | FS: 8–9 UI languages (EN, FR, DE, JA, ES, KO, zh-Hans, zh-Hant, PT). SS: not stated. | [fs-specs] [fs-g-basic] |
| OTH-06 | Offline / privacy model | ✓ | ✓ | SS: offline-first; cloud only for links, shared projects, cloud transcription and AI voiceover, with a prompt before upload. FS: local by default; cursor and keystroke data never uploaded; SSL cloud upload. | [ss-home] [fs-home] |
| OTH-07 | Web-based recorders | — | ✓ ★FS | Free online screen, camera and microphone recorders. | [fs-home] |
| OTH-08 | Startup and editor settings | ~ | ✓ | FS: launch at boot, autoplay in editor, save/export locations. SS: default project folder, hide Dock icon. | [fs-g-perm] [ss-g-save] |

---

## Gap vs Lens

Compared against `work/Lens/packages/engine/src/*.ts` (types, project, events, cursor, autozoom, camera, spring, oneEuro, layout, timeline, transcript, plan, cli, audio, crop, masks), for whether a plan field is actually drawn or heard, `work/Lens/compositor/lens_compositor/` (render.py, audio.py, pipeline.py), and `work/Lens/transcribe/lens_transcribe/` for speech-to-text. Updated after the P1 batch (commit 67df923) and local STT. Status meanings: **Implemented** means engine logic plus a rendered result exist; **Partial** means a config field or model exists but behaviour or rendering is incomplete; **Missing** means nothing in code. Priority: **P1** is core parity (both products have it, or it's central to the polished-demo output), **P2** is secondary parity or a high-value single-product feature, **P3** is niche.

Note: `docs/Tracker.md` says native capture, the Tauri editor UI and the GPU renderer are not started. Every recording-time feature is therefore Missing, and every editor interaction (drag handles, context menus) exists only as data in `project.json`.

### Implemented

| Feature IDs | What Lens has | Where |
|---|---|---|
| REC-04 (data model) | Cursorless-capture event log format: move, down/up, scroll, key with modifiers, cursor-shape | `types.ts` InputEvent, `events.ts` parseEventLog |
| ZM-01, ZM-02 | Auto zoom on clicks **and** typing stretches; clusters by time gap (`mergeGapMs` 2500) and fit; lead 350 ms, hold 1400 ms, min duration 1200 ms; adjacent zooms hand off by panning | `autozoom.ts` planAutoZoom |
| ZM-03, ZM-05 (data) | Manual zoom segments with a fixed focus point or "follow"; auto zooms that overlap manual ones are dropped | `types.ts` ZoomSegment, `autozoom.ts` effectiveZoomSegments |
| ZM-04 | Per-segment `scale`; defaultScale 2.0, minScale 1.25, maxScale 4 (validated) | `project.ts` |
| ZM-08 (single model) | Closed-form spring (stiffness/damping/mass, settle-time helper), log-space scale animation, default 900 ms critically damped | `spring.ts`, `camera.ts` |
| ZM-09 | Follow-cursor pan with deadzone (default 0.5) and edge clamping | `camera.ts` buildCameraTrack |
| ZM-13 | Smart framing that shifts the camera so the cursor clears the webcam overlay | `camera.ts` avoidOverlay, `layout.ts` overlayAvoidRect |
| ZM-15 | `zoom.auto` toggle | `project.ts` |
| CUR-01 (global) | One Euro prefilter, then spring follower (220 ms settle) with lookahead; toggle | `cursor.ts`, `oneEuro.ts` |
| CUR-02, CUR-05 (global) | Cursor size and visibility | `project.ts`, `render.py` |
| CUR-04 | Idle hide (idleMs 2500, fadeMs 250) | `cursor.ts` |
| CUR-06 | Loop to start (loopMs 800, smoothstep) | `cursor.ts` |
| CUR-07 | Click effects ripple / circle / highlight (450 ms) plus press-scale 0.85 | `cursor.ts`, `plan.ts`, `render.py` |
| CUR-13, LOOK-11 | Motion blur on screen (camera velocity) and cursor; one strength (0.35) and sample count | `plan.ts`, `render.py` |
| LOOK-02, LOOK-03, LOOK-04 | Background solid / gradient (angle) / image, plus blur; dithering against banding | `project.ts`, `render.py` make_background |
| LOOK-06 | Background blur (`background.blur`) | `render.py` |
| LOOK-07, LOOK-08, LOOK-10 | Padding, corner radius, shadow (opacity, blur, offset, angle) | `project.ts`, `render.py` |
| LOOK-12 | Any w:h aspect (validated); 720/1080/1440/2160 | `layout.ts` outputSize |
| CAM-01, CAM-02 | 5 layout kinds (screen-only, overlay, split landscape/vertical, fullscreen camera, cutout slot) on a timeline with eased transitions (500 ms) | `layout.ts` layoutFor, layoutAt |
| CAM-03 (partial set) | Corner position, size, circle / rounded / square | `project.ts`, `render.py` |
| EDT-01, EDT-02 | Cuts (merged ranges) mapped through the output timeline | `timeline.ts` |
| EDT-03 | Speed ranges (later range wins) | `timeline.ts` |
| EDT-04 | Typing detection (≥6 keys, ≥1.5 s, gaps ≤800 ms; shortcuts excluded) plus auto speed-up (default 3×) | `events.ts` detectTyping, `plan.ts` |
| EDT-16 | Edit by transcript: deleted words become cuts that join into neighbouring gaps | `transcript.ts` cutsForDeletedWords |
| AI-01 | Local speech-to-text: faster-whisper base.en (MIT) on the CPU, word timings + confidence + language, aligned to measured voiced runs; `lens-transcribe` CLI; the pipeline transcribes the mic track automatically when captions or cleanup need words | `transcribe/lens_transcribe`, `compositor/lens_compositor/pipeline.py`, `docs/STT.md` |
| AI-07, AI-08 | Filler removal (um/uh/…, 30 ms pad) and pause tightening (>900 ms down to 350 ms) from real audio: fillers found by a prompted second decode plus untranscribed voiced runs; pause cuts limited to measured silence; `edits.cleanup` in the project, cuts follow into audio and captions | `transcript.ts` cleanupCuts, `plan.ts`, `lens_transcribe` |
| AUD-04, AUD-06, EDT-05 | Mic + system tracks (path, offset, volume, mute) muxed as AAC, following cuts and speed ranges with 3 ms fades; per-segment volume overrides | `audio.ts`, `audio.py` |
| AUD-01, AUD-03 | FFT denoise (afftdn, floor measured from quiet windows); two-pass EBU R128 loudness normalisation (default -16 LUFS / -1.5 dBTP) | `audio.py` |
| CUR-08 | Procedural click sound (our own waveform) at each surviving click, with volume | `audio.ts`, `audio.py` |
| CUR-01 / EDT-06 (per segment) | Per-segment overrides: hide cursor, smoothing off, cursor size | `cursor.ts`, `project.ts` overrides |
| AI-03 (most) | Caption font size, text/highlight colours, background pill, top/bottom/custom position, max words per line, word-by-word highlight | `transcript.ts` captionFrame, `render.py` draw_caption |
| EXP-04 | GIF export (palettegen diff + paletteuse sierra2_4a), fps / width / loop | `audio.py` export_gif |
| LOOK-14 | Source crop; engine works in cropped space | `crop.ts`, `render.py` |
| TXT-04, TXT-05 | Timed spotlight / blur / pixelate masks with feather + fade, following zooms | `masks.ts`, `render.py` |
| CAM-04, CAM-05, CAM-06 | Webcam mirror, crop, size multiplier while zoomed | `layout.ts`, `camera.ts`, `render.py` |
| AI-05, AI-06 | SRT import and export | `transcript.ts` parseSrt / toSrt |
| TXT-01 (basic) | Shortcut overlays for modifier combos with Mac glyphs, repeat merging, 1200 ms display | `events.ts` shortcutOverlays, `render.py` |
| (demand #1) | Multi-take with automatic best take: retakes found in the transcript, keep last / best take, rejected takes as reversible cuts (video, audio, captions follow), per-group swap, mark retake; editor Alt takes lane with A/B preview and undo. Neither product has it (Screen Studio: planned) | `takes.ts` resolveTakes, `plan.ts`, editor Timeline / TranscriptPanel, `docs/Takes.md` |
| EXP-01, EXP-02, EXP-03 (basic) | H.264 MP4 via ffmpeg, CRF 18, fps 24/30/60 | `render.py`, `project.ts` |

### Partial

| ID | Feature | Gap in Lens | Priority |
|---|---|---|---|
| CUR-03 | Cursor styles | `shape` enum plus programmatic sprites only; no style sets, colour, high-res system cursor set, or touch cursor | P1 |
| AI-03 | Caption styling | No font family choice, stroke, shadow, or appear/fade/slide animation; no per-aspect repositioning | P2 |
| AI-01 | Local captions | English model tested only (multilingual models accepted, untested); no custom-vocabulary prompt for names; word starts in connected speech ~90 ms median / ~230 ms p95; tested on synthetic speech only | P1 |
| AUD-02 | Voice enhancement | Denoise and loudness exist; no EQ / "podcast" voice shaping | P2 |
| TXT-01 | Shortcut display options | No single-key option, size, position, colour or per-item disable | P2 |
| CAM-07 | Camera cutout | Layout slot and `cutout` flag exist; no person segmentation is applied | P1 |
| CAM-09 | Hide during silence | `camera.hideDuringSilence` config exists but nothing reads it | P2 |
| LOOK-09 | Inset | `frame.inset` config exists but isn't rendered | P2 |
| ZM-10 | Glass Loupe | `ZoomStyle "loupe"` exists, but the compositor ignores it (always a classic crop) | P2 |
| ZM-08 | Animation-speed presets | One spring for all zooms; no Focused/Smooth or Slow…Rapid presets, no per-zoom speed, no instant (ZM-07) | P2 |
| ZM-04 / ZM-06 | Zoom limits | `maxScale` isn't clamped for manual segments (only `scale<1` is rejected); no apply-to-all helper | P3 |
| EXP-03 / EXP-08 | Export presets | Only CRF and preset in `RenderOptions`; no quality presets, size estimate or saved defaults | P2 |
| LOOK-01 | Wallpapers | Image background works, but there's no bundled wallpaper library | P2 |
| OTH-03 | Project files | `project.json` document defined; no saving or versioning, bundle, backups or project history | P2 |
| REC-21 | Pre-record toggles | `zoom.auto` exists; no recorder to attach it to | P2 |

### Missing

| ID | Feature | Priority | Note |
|---|---|---|---|
| REC-01/02/03 | Display, window and area capture writing cursorless video plus event log | **P1** | Tracker: native capture not started |
| REC-08/09 | Mic and system-audio capture (per-app filter) | **P1** | The pipeline takes audio files; nothing records them yet |
| REC-10 | Webcam capture | **P1** | Compositor already accepts a webcam file |
| REC-11/12/13 | Pause/resume, countdown, global hotkeys | **P1** | |
| AUD-05 | Background music (library, fade, loop, range) | P2 | |
| COL-01/02 | Shareable links with access control | P2 | Needs a hosting backend |
| OTH-01 | Style presets (save/apply/default/share) | P2 | `resolveProject` merge makes this cheap |
| REC-05 / LOOK-15 | iPhone/iPad capture and device frames | P2 | |
| REC-15 | Teleprompter / speaker notes excluded from capture | P2 | |
| EDT-14 | Import an existing video as a project | P2 | |
| AI-02 | Cloud transcription | P2 | |
| CAM-08/10 | Face tracking, colour grading / LUT | P2 | |
| ZM-14 / LOOK-13 | Re-aim zooms on aspect change; reel safe-area overlay | P2 | |
| CUR-09/10/11/12 | Rotate with motion, stop before end, shake removal, cursor-type smoothing | P2 | |
| ZM-11 | 3D Motion | P2 | Unique to FocuSee |
| ZM-12 | AI upscaling of zoomed text | P3 | Unique to Screen Studio |
| AI-13/14 | Auto-hide sensitive data / faces | P2 | Unique to Screen Studio; strong privacy value |
| TXT-02/03/06/07 | Text, shapes, magnifier/callout, watermark | P2 | FocuSee only |
| EXP-05 | ProRes export | P3 | |
| EXP-09/11/12 | Batch export, estimates, quick-share widget | P3 | |
| REC-06 | Android capture | P3 | |
| REC-14/17/18 | Recording flags, window resize, crash-safe 2 s autosave | P2 (REC-18), P3 others | |
| CAM-11/12/13/14 | Sharpen, beauty, camera frames, lip-sync delay | P3 (CAM-14 P2) | |
| AI-10/12 | AI voiceover, AI avatars | P3 | |
| COL-03/04/05 | Comments, view counts, project sharing | P3 | |
| EDT-09/11/12/13/15 | Shuttle, copy props, ⌘K, copy frame, preview modes | P3 | Editor UI not started |

---

[ss-home]: https://screen.studio/
[ss-4]: https://screen.studio/4
[ss-cl]: https://screen.studio/changelog
[ss-g-display]: https://screen.studio/guide/recording-entire-display
[ss-g-window]: https://screen.studio/guide/recording-single-window
[ss-g-area]: https://screen.studio/guide/recording-area
[ss-g-iphone]: https://screen.studio/guide/recording-iphone-ipad
[ss-g-mirroring]: https://screen.studio/guide/iphone-mirroring
[ss-g-webcam]: https://screen.studio/guide/webcam-microphone
[ss-g-sysaudio]: https://screen.studio/guide/recording-system-audio
[ss-g-inprogress]: https://screen.studio/guide/managing-recording-in-progress
[ss-g-new]: https://screen.studio/guide/new-recording
[ss-g-shortcuts]: https://screen.studio/guide/screen-studio-shortcuts
[ss-g-flag]: https://screen.studio/guide/recording-flag
[ss-g-notes]: https://screen.studio/guide/speaker-notes-
[ss-g-disableauto]: https://screen.studio/guide/disable-automatic-zooms-
[ss-g-dock]: https://screen.studio/guide/hiding-dock-icon
[ss-g-sysreq]: https://screen.studio/guide/system-requirements
[ss-g-links]: https://screen.studio/guide/shareable-links
[ss-g-addzoom]: https://screen.studio/guide/adding-editing-zooms
[ss-g-autozoom]: https://screen.studio/guide/auto-zoom
[ss-g-manualzoom]: https://screen.studio/guide/manual-zoom
[ss-g-instant]: https://screen.studio/guide/instant-zoom
[ss-g-anim]: https://screen.studio/guide/animations
[ss-g-aspect]: https://screen.studio/guide/aspect-ratio
[ss-g-nosmooth]: https://screen.studio/guide/disable-smooth-mouse-movement
[ss-g-cursor]: https://screen.studio/guide/cursor
[ss-g-hidecursor]: https://screen.studio/guide/hiding-the-cursor-in-specific-sections
[ss-g-clicksound]: https://screen.studio/guide/mouse-click-sound
[ss-g-bg]: https://screen.studio/guide/background
[ss-g-crop]: https://screen.studio/guide/cropping-the-recording
[ss-g-dynlayout]: https://screen.studio/guide/dynamic-camera-layouts-
[ss-g-camera]: https://screen.studio/guide/camera
[ss-g-camsettings]: https://screen.studio/guide/camera-settings
[ss-g-reactions]: https://screen.studio/guide/reactions-
[ss-g-trim]: https://screen.studio/guide/trimming
[ss-g-speed]: https://screen.studio/guide/speeding-up-the-video
[ss-g-typing]: https://screen.studio/guide/speed-up-typing-segments
[ss-g-volume]: https://screen.studio/guide/set-volume
[ss-g-mask]: https://screen.studio/guide/adding-a-mask-and-highlight
[ss-g-shortcutsdisp]: https://screen.studio/guide/shortcuts
[ss-g-scrubber]: https://screen.studio/guide/scrubber
[ss-g-cmdk]: https://screen.studio/guide/command-menu
[ss-g-copyframe]: https://screen.studio/guide/copy-current-frame-as-an-image
[ss-g-import]: https://screen.studio/guide/creating-project-from-existing-video
[ss-g-perf]: https://screen.studio/guide/performance-settings
[ss-g-music]: https://screen.studio/guide/background-music
[ss-g-extract]: https://screen.studio/guide/extracting-raw-recording-files
[ss-g-captions]: https://screen.studio/guide/captions
[ss-g-export]: https://screen.studio/guide/exporting-the-video
[ss-g-exportsettings]: https://screen.studio/guide/explanation-of-export-settings
[ss-g-quickshare]: https://screen.studio/guide/quick-share-widget-
[ss-g-comments]: https://screen.studio/guide/shareable-links-comments
[ss-g-shareproj]: https://screen.studio/guide/sharing-your-project
[ss-g-sharepreset]: https://screen.studio/guide/sharing-preset
[ss-g-createpreset]: https://screen.studio/guide/creating-preset
[ss-g-applypreset]: https://screen.studio/guide/applying-preset
[ss-g-projsettings]: https://screen.studio/guide/managing-project-settings-for-new-recordings
[ss-g-save]: https://screen.studio/guide/saving-your-project
[fs-home]: https://focusee.ai/
[fs-price]: https://focusee.ai/go/store.php?product=fs&id=1
[fs-specs]: https://focusee.ai/specs.htm
[fs-cmp]: https://focusee.ai/compare/screen-studio-alternative.htm
[fs-cl]: https://focusee-voice.imobie.com/en/changelog
[fs-n-idx]: https://focusee.ai/news/
[fs-n-v2]: https://focusee.ai/news/focusee-v2-release.htm
[fs-n-jul25]: https://focusee.ai/news/focusee-2025-june-and-july-update.htm
[fs-n-24]: https://focusee.ai/news/focusee-2-4-update.htm
[fs-faq-edit]: https://focusee.ai/faq/editing-functions.htm
[fs-faq-credit]: https://focusee.ai/faq/ai-credit.htm
[fs-g-basic]: https://focusee.ai/guide/basic-information.htm
[fs-g-record]: https://focusee.ai/guide/record-video.htm
[fs-g-ios]: https://focusee.ai/guide/record-iphone-or-ipad.htm
[fs-g-android]: https://focusee.ai/guide/record-android-phone-or-tablet.htm
[fs-g-perm]: https://focusee.ai/guide/permissions-and-settings.htm
[fs-g-engine]: https://focusee.ai/guide/how-to-choose-a-recording-engine.htm
[fs-g-nvidia]: https://focusee.ai/guide/how-to-switch-to-nvidia-graphics-card.htm
[fs-g-teleprompter]: https://focusee.ai/guide/teleprompter.htm
[fs-g-zoom]: https://focusee.ai/guide/zoom-in-effect.htm
[fs-g-3d]: https://focusee.ai/guide/3d-motion-effect.htm
[fs-g-cursor]: https://focusee.ai/guide/cursor-effect.htm
[fs-g-motionblur]: https://focusee.ai/guide/motion-blur.htm
[fs-g-edit]: https://focusee.ai/guide/edit-the-recording.htm
[fs-g-camlayout]: https://focusee.ai/guide/camera-layout.htm
[fs-g-rmbg]: https://focusee.ai/guide/remove-camera-background.htm
[fs-g-beauty]: https://focusee.ai/guide/beauty-filter.htm
[fs-g-audio]: https://focusee.ai/guide/audio-control.htm
[fs-g-voice]: https://focusee.ai/guide/enhance-voice.htm
[fs-g-music]: https://focusee.ai/guide/add-background-music.htm
[fs-g-captions]: https://focusee.ai/guide/auto-captions.htm
[fs-g-aisubs]: https://focusee.ai/guide/ai-subtitles.htm
[fs-g-editsubs]: https://focusee.ai/guide/edit-subtitles.htm
[fs-g-smartcut]: https://focusee.ai/guide/remove-silence-and-fillers.htm
[fs-g-avatar]: https://focusee.ai/guide/ai-avatar.htm
[fs-g-keys]: https://focusee.ai/guide/keyboard-shortcuts.htm
[fs-g-annot]: https://focusee.ai/guide/annotations.htm
[fs-g-blur]: https://focusee.ai/guide/blur-effect.htm
[fs-g-spotlight]: https://focusee.ai/guide/spotlight-effect.htm
[fs-g-watermark]: https://focusee.ai/guide/add-watermark.htm
[fs-g-preset]: https://focusee.ai/guide/recording-preset.htm
[fs-g-export]: https://focusee.ai/guide/export-video.htm
[fs-g-share]: https://focusee.ai/guide/share-video.htm
[fs-g-import]: https://focusee.ai/guide/import-video-to-edit.htm
[fs-f-autozoom]: https://focusee.ai/features/auto-zoom-and-cursor-animation.htm
[fs-f-aisub]: https://focusee.ai/features/ai-subtitle.htm
[fs-f-camlayout]: https://focusee.ai/features/camera-layout.htm
[fs-f-3d]: https://focusee.ai/features/3d-motion.htm
[prequel]: https://prequel.sh/blog/screen-studio-4
