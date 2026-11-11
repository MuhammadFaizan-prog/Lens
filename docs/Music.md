# Music bed with automatic ducking (demand #23)

Lens's own design (clean room, Rules.md §1). A music track under the whole video that gets quieter
by itself while you talk and comes back in the pauses, with the same result in the preview, the
desktop app's export and the Python reference export.

## In the editor

**Audio tab → Music.**

- **Add built-in music**: pick one of three beds made by Lens (*Calm pad*, *Light pulse*, *Focus
  keys*). They are synthesised by Lens's own code, not recordings, and are free to use anywhere
  (CC0 1.0, `assets/music/LICENSE.md`). The bed is written into the project folder as
  `music/lens-<id>.wav` the first time it is chosen, so it travels with the project.
- **Import music…**: MP3, WAV, OGG / Opus, M4A / AAC, FLAC or WebM audio (up to 200 MB). The file is
  checked by decoding it with ffmpeg and copied into the project's `music/` folder.

Once a track is in:

| Control | What it does | Default |
| --- | --- | --- |
| Music on | Mute the music without removing it | on |
| Volume (vs speech) | How far under your voice the music sits when it is not ducked | -14 dB |
| Duck under speech | Turn the automatic ducking on / off | on |
| Duck depth | How much quieter the music gets while you talk | 12 dB |
| Attack | How long the music takes to go down; it finishes as you start talking (the whole recording is known, so it looks ahead) | 150 ms |
| Release | How long it takes to come back after you stop | 600 ms |
| Hold | How long it stays down after the last word before the release starts | 150 ms |
| Fade in / Fade out | At the start and end of the video | 1 s / 2 s |
| Loop | Repeat a short file under a longer video | on |

The small graph under the controls is the music's level over the whole video, drawn from the same
numbers the export uses, with the stretches of speech shaded. The line under it says how many
stretches of speech the music ducks under (or why there are none: no mic track, speech still being
measured, ducking off). *Replace with* / *Replace with file…* swap the music and keep your settings;
*Remove music* takes it out (Ctrl+Z brings it back). Every change is one undo step and is heard
right away while playing.

## How it works

- **Where the speech is**: the mic track's measured silences (the same ffmpeg silencedetect pass
  that *Shorten pauses* uses; speech is what lies between them), or the transcript's words when
  there are no measured pauses. Only audible speech counts: a muted mic leaves the music alone.
  The speech is mapped through cuts, speed ranges and inserted slides onto the output clock
  (`packages/engine/src/music.ts` `speechToOutput`).
- **Envelope**: piecewise-linear gain keys in the render plan (`plan.audio.music.duck`): down to
  `-depthDb` from `attack` before each stretch of speech to its start, held through the speech and
  `hold`, back up over `release`. A gap too short to recover fully stays ducked, so the music does
  not pump between words. Fades are a second key list (`fade`), shortened proportionally if the video
  is shorter than both fades.
- **Level**: the music is put `volumeDb` under the speech by integrated loudness (ITU-R BS.1770-4,
  `packages/engine/src/loudness.ts`, checked against EBU Tech 3341 case 1: -23.0 LUFS). The preview
  measures the mic file and the music file it has decoded; the export measures the speech after its
  noise reduction and loudness normalisation, and the music file. Same function, same formula
  (`musicLevelGain`).
- **Preview** (`apps/editor/src/media/audio.ts`): the music plays on the output clock through three
  Web Audio gains (level, duck, fade); the envelopes are scheduled as `linearRampToValueAtTime`
  between the plan's keys, which is exactly the piecewise-linear curve the export evaluates.
- **Export, desktop app** (`apps/editor/server/exportAudio.ts` `mixMusic`): decoded once at 48 kHz
  stereo, looped from `startMs` on the output clock, multiplied by the envelopes per sample, added
  after denoise / loudnorm (RNNoise never sees the music), clamped. `music-mix.json` next to the
  export records the measured speech and music loudness and the gain.
- **Export, Python reference** (`compositor/lens_compositor/audio.py` `mix_music`): the same steps
  in numpy / scipy.

Project data (absent in older projects, whose plans stay byte-identical):

```jsonc
"audio": {
  "music": {
    "path": "music/lens-calm-pad.wav", "name": "Calm pad", "source": "builtin:calm-pad",
    "enabled": true, "volumeDb": -14,
    "duck": { "enabled": true, "depthDb": 12, "attackMs": 150, "holdMs": 150, "releaseMs": 600 },
    "fadeInMs": 1000, "fadeOutMs": 2000, "loop": true, "startMs": 0
  }
}
```

## Tests

- `packages/engine/test/music.test.ts` (22): BS.1770 against EBU Tech 3341 case 1, gating, mono,
  streaming; level gain; speech from pauses / words; mapping through cuts and speed; duck keys
  (depth under speech, look-ahead attack, recovery in a long gap, no pumping in a short one); fades;
  loop position; plans without music byte-identical (absent / null / muted); music-only projects;
  validation; the three built-in beds (deterministic, whole bars, -6 dBFS peak, seamless loop,
  audible); WAV encoding; `applyEnvelope` equals `keyAt` sample by sample.
- `apps/editor/test/musicExport.test.ts` (5): built-in bed WAV, import checks (safe name, refuses
  text and fake audio), export mix: duck depth, level from the two loudness measurements, loop,
  fades after loudnorm, unlooped file ends, music-only export.
- `tests/test_music.py`: the Python reference mix, same checks.
- `apps/editor/e2e/musicDucking.spec.ts` (run with `LENS_EXPORT=browser`, the desktop path):
  imports a file with the picker, sets volume and depth with the controls, renders the preview's
  audio graph offline and exports the MP4, then measures both with ffmpeg's ebur128 on band-split
  audio (speech 1 kHz, music 220 / 330 Hz). See docs/Tracker.md for the numbers.

## Not done

- Several music clips at different times, or music that follows cuts (a bed is one track on the
  output clock).
- A cross-fade at the loop point of an imported file (the built-in beds loop seamlessly; an
  imported file loops as cut).
- Beat-synced cuts, music search / library, stems.
