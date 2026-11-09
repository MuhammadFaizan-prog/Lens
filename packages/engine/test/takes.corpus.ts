/**
 * Retake test set for the take detector (packages/engine/src/takes.ts). Written before the detector,
 * in two parts: DEV (the detector's rules and constants were set while looking at these) and HELD_OUT
 * (written at the same time, run only to measure). Nothing in HELD_OUT was edited after the detector
 * was first run on it.
 *
 * Markup: words separated by spaces. "[x ... ]" wraps words that are a rejected take and should be
 * cut (including fillers or restart cues that belong to it). "|" is a 500 ms pause, "||" a 1200 ms
 * pause. A word ending in . ! or ? is followed by a 400 ms sentence gap, any other word by 60 ms.
 * um / uh / er are flagged as fillers (as lens-transcribe does). A trailing "~" gives the word a
 * low recogniser confidence (0.4); every other word has 0.9.
 *
 * Bounds, fixed before the first measurement (test/takes.test.ts):
 *   HELD_OUT word level (words cut as retakes vs words marked [x]): precision >= 0.95, recall >= 0.90
 *   HELD_OUT group level (a truth retake group counts as found when a detected group covers it and
 *     keeps the truth's final take): precision >= 0.90, recall >= 0.90
 *   NORMAL_SPEECH (narration with no retakes): zero groups detected.
 */
export interface Case {
  id: string;
  kind: "exact" | "partial" | "filler" | "cue" | "chain" | "pause" | "fuzzy" | "negative";
  text: string;
}

export const DEV: Case[] = [
  { id: "d1", kind: "partial", text: "Welcome to Lens. [x Today we will] || Today we will record a short demo." },
  { id: "d2", kind: "exact", text: "[x Open the settings window.] | Open the settings window. Then pick a theme." },
  { id: "d3", kind: "fuzzy", text: "[x Click the expert um] | Click the export button and choose a format." },
  { id: "d4", kind: "cue", text: "First, [x drag the clip onto the uh sorry let me redo that] | drag the clip onto the timeline." },
  { id: "d5", kind: "chain", text: "[x Now we can see] | [x Now we can uh] || Now we can see the results in real time." },
  { id: "d6", kind: "pause", text: "This is the part where [x we export] || we export the final video." },
  { id: "d7", kind: "chain", text: "[x Select the text and um] [x select the] | Select the text and press delete." },
  { id: "d8", kind: "chain", text: "Lens records your screen. [x It adds smooth zooms on every click and] | [x It adds smooth] || It adds smooth zooms on every click and keystroke." },
  { id: "d9", kind: "partial", text: "[x The webcam appears in the bottom left] | The webcam appears in the bottom right corner." },
  { id: "d10", kind: "cue", text: "To start, [x press record and wait for the countdown let me try that again] | press record and wait for the countdown." },
  { id: "d11", kind: "pause", text: "[x Captions are generated on your] || Captions are generated on your machine, so nothing leaves it." },
  { id: "d12", kind: "filler", text: "[x Choose a background] | Choose a uh background color for the frame." },
  { id: "d13", kind: "partial", text: "We can trim the clip. [x Then we we] | Then we share the link." },
  { id: "d14", kind: "fuzzy", text: "[x Export it as an M P four] || Export it as an MP4 file." },
  { id: "dn1", kind: "negative", text: "Open the file menu. Then open the recent files list. Open the one you need." },
  { id: "dn2", kind: "negative", text: "Click the button. Click it again to confirm." },
  { id: "dn3", kind: "negative", text: "You can drag it. You can drop it anywhere." },
  { id: "dn4", kind: "negative", text: "The red button saves. The blue button deletes." },
  { id: "dn5", kind: "negative", text: "We record, we edit, we export." },
  { id: "dn6", kind: "negative", text: "Speed up the typing. Speed matters for long demos." },
];

export const HELD_OUT: Case[] = [
  { id: "h1", kind: "pause", text: "[x Let's open the] || Let's open the project from last week." },
  { id: "h2", kind: "filler", text: "Next, [x set the zoom level to two um] | set the zoom level to two times." },
  { id: "h3", kind: "chain", text: "[x Hit save and the] | [x Hit save and] || Hit save and the video renders in the background." },
  { id: "h4", kind: "cue", text: "[x Turn on the motion blur oops] | Turn on the motion blur for smoother pans." },
  { id: "h5", kind: "pause", text: "Our cursor [x is smoothed with a] || is smoothed with a spring." },
  { id: "h6", kind: "partial", text: "[x The audio is normalized to minus] | The audio is normalized to minus sixteen LUFS." },
  { id: "h7", kind: "cue", text: "[x Pick a layout for the camera scratch that] | Pick a layout for the webcam." },
  { id: "h8", kind: "exact", text: "[x Drag the corner to resize the window] | Drag the corner to resize the window." },
  { id: "h9", kind: "filler", text: "Then [x uh we add a mask over the] | we add a mask over the password field." },
  { id: "h10", kind: "chain", text: "[x Share the link with] [x share the link with your um] || Share the link with your team." },
  { id: "h11", kind: "fuzzy", text: "[x Record your screen in four K] | Record your screen in 4K." },
  { id: "h12", kind: "pause", text: "[x Select export and wait] || Select export and wait a few seconds." },
  { id: "h13", kind: "partial", text: "[x The timeline shows every cut] | The timeline shows every cut and zoom." },
  { id: "h14", kind: "cue", text: "So [x this is how you let me start over] | this is how you build a demo." },
  { id: "hn1", kind: "negative", text: "Open the editor. Open the inspector on the right." },
  { id: "hn2", kind: "negative", text: "Press play to preview. Press play again to stop." },
  { id: "hn3", kind: "negative", text: "Lens has a timeline. Lens has captions too." },
  { id: "hn4", kind: "negative", text: "Make it bigger, then make it smaller." },
  { id: "hn5", kind: "negative", text: "This step is important. This step is optional for short videos." },
  { id: "hn6", kind: "negative", text: "Choose a color for the background and a color for the border." },
  { id: "hn7", kind: "negative", text: "We tested it on Mac, we tested it on Windows." },
  { id: "hn8", kind: "negative", text: "Zoom in on the button, zoom out after the click." },
  { id: "hn9", kind: "negative", text: "This step is important. || This step is optional for short videos." },
];

/** A minute of ordinary demo narration with no retakes (similar words recur on purpose). */
export const NORMAL_SPEECH =
  "Hi, I'm going to show you how Lens turns a raw recording into a polished demo. | " +
  "First, open the project you recorded yesterday. The editor shows the preview on the left and the timeline at the bottom. | " +
  "Click the play button to watch the recording. You can click anywhere on the timeline to jump there. " +
  "The zoom lane shows every automatic zoom, and the cut lane shows every cut. || " +
  "Now open the inspector on the right. The inspector has settings for the background, the frame and the cursor. " +
  "Pick a gradient for the background, then pick a radius for the frame. | " +
  "If you want a calmer video, choose the calm preset. If you want a faster video, choose the punchy preset. || " +
  "Next, look at the transcript. Every word you said is here, and every filler is marked. " +
  "Click remove fillers to cut them all at once. | You can undo that with one click. " +
  "When you are happy with the edit, export the video. The export uses the same plan as the preview, so what you see is what you get. || " +
  "That is the whole workflow. Record, edit, export.";

export interface SynthWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  filler?: boolean;
  /** Truth: this word belongs to a rejected take. */
  retake: boolean;
  /** Truth: index of the [x] span the word is in (-1 outside). */
  span: number;
}

const FILLER_WORDS = new Set(["um", "uh", "er"]);

/** Turn the markup into timed words (deterministic durations from word length). */
export function synthWords(text: string, t0 = 300): SynthWord[] {
  const out: SynthWord[] = [];
  let t = t0;
  let inX = false;
  let span = -1;
  let spans = 0;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if (raw === "|" || raw === "||") {
      t += raw === "|" ? 500 : 1200;
      continue;
    }
    let tok = raw;
    if (tok.startsWith("[x")) {
      inX = true;
      span = spans++;
      tok = tok.slice(2);
      if (!tok) continue;
    }
    let closes = false;
    if (tok.endsWith("]")) {
      closes = true;
      tok = tok.slice(0, -1);
    }
    if (tok) {
      const low = tok.endsWith("~");
      const word = low ? tok.slice(0, -1) : tok;
      const bare = word.toLowerCase().replace(/[^a-z0-9']/g, "");
      const dur = 90 + 55 * bare.length;
      const w: SynthWord = { text: word, startMs: t, endMs: t + dur, confidence: low ? 0.4 : 0.9, retake: inX, span: inX ? span : -1 };
      if (FILLER_WORDS.has(bare)) w.filler = true;
      out.push(w);
      t += dur + (/[.!?]$/.test(word) ? 400 : 60);
    }
    if (closes) {
      inX = false;
      span = -1;
    }
  }
  return out;
}
