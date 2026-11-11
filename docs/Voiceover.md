# Voiceover (demand #17)

Narration after the fact: record a voiceover per transcript line or at the playhead, or import audio
files, and mix them into the video. Works the same in the editor preview, the browser export (the
desktop app's path, no Python) and the Python reference compositor.

## Using it

- **Voiceover lane** (timeline, under Audio). `+` imports audio files at the playhead (WAV, MP3, M4A,
  AAC, OGG, Opus, WebM, FLAC); double-click the lane to import at that point. Drag a clip to move it,
  drag its left edge to trim the head (the rest of the audio stays where it was), its right edge to
  trim the tail. Click a clip to select it: the Audio tab opens on its controls.
- **Audio tab > Voiceover.**
  - *Import audio…* and *Record at playhead*.
  - With a transcript, one row per line (a sentence, or a run of words ended by a 600 ms pause, at most
    20 words; fillers left out). The row's ● records that line: the video plays from the line's start
    with the recording's own sound muted (so it is not picked up by the mic), and ■ stops. A line
    already narrated shows ↻; a new take replaces the line's previous clip. Without a transcript, use
    *Record at playhead* or transcribe on the Transcript tab.
  - The selected clip: *Start* (anchor on the recording clock), *Trim start* / *Trim end*, *Gain*
    (-40 to +12 dB), *Mute clip*, *Mute original under it* (adds a volume-0 segment on the Audio lane
    over the clip, so the recorded speech does not play under the narration; undo removes it),
    *Remove*.
- Every change is one undo step; files are saved in `<project>/voiceover/`.

## How it works

- `project.voiceover = { clips: [...] }` (optional; a project without it plans and renders exactly as
  before). Each clip: `id, name, path, fileMs, srcMs, trimStartMs, trimEndMs, gainDb, muted?, line?`.
- A clip is anchored at a recording-clock time, so it moves with cuts like everything else; an anchor
  inside a cut moves to where the recording resumes. It always plays at normal speed (speed ranges do
  not stretch narration), from the output time of its anchor, for its trimmed length, cut at the end of
  the output. On the lane it is drawn from its anchor for its length in ms.
- Engine (`packages/engine/src/voiceover.ts`): the clips become `plan.audio.voice` pieces on the output
  clock (`outMs, fileOffsetMs, durMs, gain`).
- Preview (`apps/editor/src/media/audio.ts`): `AudioEngine` decodes each clip file once and schedules it
  with Web Audio next to the mic track's pieces (3 ms fade at each end). `renderOffline` renders the same
  schedule into an `OfflineAudioContext`, which is what the e2e test measures.
- Exports: both mix the clips **after** the recording's cleanup (noise reduction, loudness), so a clip
  plays at the level it was set to, with 3 ms fades at both ends: `server/exportAudio.ts`
  (`addVoice`, browser export / desktop) and `compositor/lens_compositor/audio.py` (Python reference).
  Clip files are decoded as Web Audio plays them: a mono file goes to both channels at full level
  (ffmpeg's own mono -> stereo upmix is 3 dB quieter per channel, which would make the export quieter
  than the preview).
- Recording: `getUserMedia` (echo cancellation, noise suppression and auto gain off) into a
  `MediaRecorder` (Opus WebM), uploaded with `POST /api/voiceover?name=` (the server checks the
  extension, decodes it to measure the length and refuses a file with no audio).

## Tests

- engine `test/voiceover.test.ts`: anchoring through cuts, trims, gain, validation, transcript lines.
- editor `test/voiceover.test.ts`: preview schedule (through a cut, from a playhead inside a clip, rate,
  reverse); export mixing on the desktop path: onset ±5 ms, silence outside the clip, +6 dB measured
  +6 dB ±0.5, voice level unchanged by denoise + loudness (±0.5 dB), mono file at full level, no-voice
  audio byte-identical.
- `tests/test_voiceover_audio.py`: the same on the Python compositor.
- `e2e/voiceover.spec.ts` (run with `LENS_EXPORT=browser`): import through the lane's `+`, gain through
  the Audio tab, a per-line take recorded from Chromium's fake microphone
  (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`), then the browser
  export: onsets within ±50 ms and export vs preview level within 2 dB.

## Not done

- Auto speed-fit of the video to the narration length (the demand report's option).
- A waveform drawn inside voiceover clips; clips on the lane do not snap.
- Recording with a real microphone and the timing study (task time to replace a fumbled sentence vs
  re-recording the take). Tested on Linux only; **unverified on Windows / macOS**.
