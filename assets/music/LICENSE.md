# Lens built-in music beds: licence

The built-in music beds offered in the editor's Audio tab (Music > Built-in: "Calm pad",
"Light pulse", "Focus keys") are not recordings. They are synthesised, sample by sample, by Lens's
own code in `packages/engine/src/musicBed.ts` from the chord charts in that file, and written into a
project's `music/` folder as `lens-<id>.wav` when chosen. No third-party audio, samples, loops or
presets are used.

The audio these beds produce is dedicated to the public domain under
**CC0 1.0 Universal** (https://creativecommons.org/publicdomain/zero/1.0/): you may copy, modify,
distribute and use it, including commercially, in any video, without asking permission and without
attribution.

The code that generates them is part of Lens and is covered by the repository's licence.

Imported music (Music > Import music…) is the user's own file; Lens copies it into the project
folder and claims no rights over it. Make sure you are allowed to use it.
