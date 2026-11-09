import { describe, expect, it } from "vitest";
import {
  buildRenderPlan,
  DEFAULT_TAKES,
  detectTakeGroups,
  prefixMatch,
  resolveProject,
  resolveTakes,
  ProjectValidationError,
  tokenSim,
  withTakeChoice,
  type TakeSettings,
  type Word,
} from "../src/index.js";
import { DEV, HELD_OUT, NORMAL_SPEECH, synthWords } from "./takes.corpus.js";
import { evalCase, evalSet } from "./takesEval.js";
import { META, demoSession } from "./fixtures.js";

// Bounds fixed before the first measurement (also stated in takes.corpus.ts and docs/Takes.md).
const WORD_PRECISION_MIN = 0.95;
const WORD_RECALL_MIN = 0.9;
const GROUP_PRECISION_MIN = 0.9;
const GROUP_RECALL_MIN = 0.9;

const ON: TakeSettings = { ...DEFAULT_TAKES, enabled: true };
const mid = (w: Word) => (w.startMs + w.endMs) / 2;
function kept(words: Word[], settings: TakeSettings = ON): string {
  const r = resolveTakes(words, settings);
  return words.filter((w) => !r.cuts.some((c) => mid(w) >= c.startMs && mid(w) < c.endMs)).map((w) => w.text).join(" ");
}

describe("take detector: token matching", () => {
  it("fuzzy token similarity and prefix alignment", () => {
    expect(tokenSim("export", "export")).toBe(1);
    expect(tokenSim("expert", "export")).toBeGreaterThan(0.6);
    expect(tokenSim("drag", "drop")).toBeLessThan(0.6);
    expect(tokenSim("lev", "level")).toBeGreaterThanOrEqual(0.8); // cut-off word
    const m = prefixMatch(["click", "the", "expert"], ["click", "the", "export", "button", "and"]);
    expect(m.matched).toBe(3);
    expect(m.bLen).toBe(3);
    expect(m.ratio).toBeGreaterThan(0.85);
    // an extra word in the restart costs, a different ending costs more
    const n = prefixMatch(["press", "play", "to", "preview"], ["press", "play", "again", "to", "stop"]);
    expect(n.ratio).toBeLessThan(0.75);
  });
});

describe("take detector: cases", () => {
  it("exact repeat of a whole sentence: the first is cut, the last kept", () => {
    const w = synthWords("[x Open the settings window.] | Open the settings window. Then pick a theme.");
    expect(kept(w)).toBe("Open the settings window. Then pick a theme.");
    const g = resolveTakes(w, ON).groups;
    expect(g).toHaveLength(1);
    expect(g[0]!.takes).toHaveLength(2);
    expect(g[0]!.kept).toBe(1);
  });

  it("partial repeat: an abandoned start is cut", () => {
    const w = synthWords("Welcome to Lens. [x Today we will] || Today we will record a short demo.");
    expect(kept(w)).toBe("Welcome to Lens. Today we will record a short demo.");
  });

  it("repeat with fillers: fillers inside and between takes go with the rejected take", () => {
    const w = synthWords("[x Click the expert um] | Click the export button and choose a format.");
    expect(kept(w)).toBe("Click the export button and choose a format.");
    const g = resolveTakes(w, ON).groups[0]!;
    expect(g.cues).toContain("filler");
  });

  it("restart phrase is cut with the take it abandons", () => {
    const w = synthWords("First, drag the clip onto the uh sorry let me redo that | drag the clip onto the timeline.");
    expect(kept(w)).toBe("First, drag the clip onto the timeline.");
  });

  it("three takes chain into one group", () => {
    const w = synthWords("[x Now we can see] | [x Now we can uh] || Now we can see the results in real time.");
    const g = resolveTakes(w, ON).groups;
    expect(g).toHaveLength(1);
    expect(g[0]!.takes).toHaveLength(3);
    expect(kept(w)).toBe("Now we can see the results in real time.");
  });

  it("a long pause before a short repeat counts as a restart cue", () => {
    expect(kept(synthWords("This is the part where we export || we export the final video."))).toBe("This is the part where we export the final video.");
    // the same words without the pause are ordinary speech
    expect(resolveTakes(synthWords("This is the part where we export we export the final video."), ON).groups).toHaveLength(0);
  });

  it("non-repeats with similar words are left alone", () => {
    for (const t of [
      "You can drag it. You can drop it anywhere.",
      "Click the button. Click it again to confirm.",
      "The red button saves. The blue button deletes.",
      "Press play to preview. Press play again to stop.",
      "This step is important. This step is optional for short videos.",
      "We tested it on Mac, we tested it on Windows.",
    ]) {
      const w = synthWords(t);
      expect(resolveTakes(w, ON).groups, t).toHaveLength(0);
      expect(kept(w)).toBe(w.map((x) => x.text).join(" "));
    }
  });

  it("no false positives on a minute of normal narration", () => {
    const w = synthWords(NORMAL_SPEECH);
    expect(w.length).toBeGreaterThan(150);
    expect(detectTakeGroups(w)).toHaveLength(0);
    expect(resolveTakes(w, ON).cuts).toHaveLength(0);
  });

  it("off by default and when disabled", () => {
    const w = synthWords("[x Open the settings window.] | Open the settings window.");
    expect(resolveTakes(w, DEFAULT_TAKES).groups).toHaveLength(0);
    expect(resolveProject({}).edits.takes.enabled).toBe(false);
  });
});

describe("take detector: precision and recall on the test set", () => {
  it("DEV and HELD_OUT", () => {
    const dev = evalSet(DEV);
    const held = evalSet(HELD_OUT);
    const fmt = (m: ReturnType<typeof evalSet>) =>
      `words P=${m.wordPrecision.toFixed(3)} R=${m.wordRecall.toFixed(3)} (tp ${m.tp} fp ${m.fp} fn ${m.fn}); ` +
      `groups P=${m.groupPrecision.toFixed(3)} R=${m.groupRecall.toFixed(3)} (${m.groupsFound}/${m.groupsTruth} found, ${m.groupsFalse} false)`;
    console.log(`takes DEV:      ${fmt(dev)}\n${dev.failures.join("\n")}`);
    console.log(`takes HELD_OUT: ${fmt(held)}\n${held.failures.join("\n")}`);
    expect(held.wordPrecision).toBeGreaterThanOrEqual(WORD_PRECISION_MIN);
    expect(held.wordRecall).toBeGreaterThanOrEqual(WORD_RECALL_MIN);
    expect(held.groupPrecision).toBeGreaterThanOrEqual(GROUP_PRECISION_MIN);
    expect(held.groupRecall).toBeGreaterThanOrEqual(GROUP_RECALL_MIN);
  });
});

describe("take choice, strategy, manual marks", () => {
  const w = synthWords("[x The webcam appears in the bottom left] | The webcam appears in the bottom right corner.");

  it("keeping the earlier take cuts the matching part of the final one and is reversible", () => {
    const g = resolveTakes(w, ON).groups[0]!;
    expect(kept(w, withTakeChoice(ON, g, 0))).toBe("The webcam appears in the bottom left corner.");
    expect(kept(w, withTakeChoice(withTakeChoice(ON, g, 0), g, 1))).toBe("The webcam appears in the bottom right corner.");
    expect(withTakeChoice(withTakeChoice(ON, g, 0), g, 1).choices).toHaveLength(0); // back to automatic
  });

  it("best strategy prefers a complete take without fillers over a later one with them", () => {
    const x = synthWords("[x Choose a background] | Choose a uh background color for the frame.");
    expect(resolveTakes(x, { ...ON, strategy: "best" }).groups[0]!.kept).toBe(0);
    expect(kept(x, { ...ON, strategy: "best" })).toBe("Choose a background color for the frame.");
    // and still picks the complete final take over a truncated, fumbling start
    const y = synthWords("[x Now we can uh] || Now we can see the results.");
    expect(resolveTakes(y, { ...ON, strategy: "best" }).groups[0]!.kept).toBe(1);
  });

  it("mark retake turns a span into a rejected take; ignore dismisses a group", () => {
    const x = synthWords("Open the panel. Pick a nice color. Pick the blue one.");
    expect(resolveTakes(x, ON).groups).toHaveLength(0);
    const nice = x.findIndex((v) => v.text === "nice");
    const marked = { startMs: x[nice - 2]!.startMs, endMs: x[nice + 1]!.endMs }; // "Pick a nice color."
    const r = resolveTakes(x, { ...ON, marked: [marked] });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.manual).toBe(true);
    expect(kept(x, { ...ON, marked: [marked] })).toBe("Open the panel. Pick the blue one.");
    const g = resolveTakes(w, ON).groups[0]!;
    expect(kept(w, { ...ON, ignored: [g.startMs] })).toBe(w.map((v) => v.text).join(" "));
  });

  it("project validation", () => {
    expect(() => resolveProject({ edits: { takes: { strategy: "longest" } } })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ edits: { takes: { choices: [{ atMs: 1, keep: -1 }] } } })).toThrow(ProjectValidationError);
    expect(resolveProject({ edits: { takes: { enabled: true, strategy: "best" } } }).edits.takes.padMs).toBe(120);
  });
});

describe("takes in the render plan", () => {
  const words = synthWords("Hello there. [x Open the settings window.] | Open the settings window. Then pick a theme.", 200);
  const events = demoSession();
  const m = { ...META, durationMs: Math.max(META.durationMs, words[words.length - 1]!.endMs + 500) };
  const audio = { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }] };

  it("rejected takes are cut: captions skip them, output gets shorter, takes listed", () => {
    const off = buildRenderPlan({ meta: m, events, project: resolveProject({ audio, captions: { enabled: true } }), words });
    const on = buildRenderPlan({ meta: m, events, project: resolveProject({ audio, captions: { enabled: true }, edits: { takes: { enabled: true } } }), words });
    expect(on.takes).toHaveLength(1);
    expect(on.takeCuts).toHaveLength(1);
    const cut = on.takeCuts[0]!;
    expect(on.cuts.some((c) => c.startMs <= cut.startMs && c.endMs >= cut.endMs)).toBe(true);
    expect(off.output.durationMs - on.output.durationMs).toBeCloseTo(cut.endMs - cut.startMs, 0);
    // caption text each time it changes (the same sentence twice in a row is two separate blocks)
    const capWords = (p: typeof on) => p.frames.map((f) => f.caption?.text ?? "").filter((t, i, a) => t && t !== a[i - 1]).join(" ");
    expect(capWords(off).match(/settings/g)?.length).toBe(2);
    expect(capWords(on).match(/settings/g)?.length).toBe(1);
    // audio pieces skip the cut too
    expect(on.audio).not.toBeNull();
    expect(on.audio!.pieces.every((p) => p.srcEnd <= cut.startMs + 1 || p.srcStart >= cut.endMs - 1)).toBe(true);
  });

  it("swapping the kept take moves the cut", () => {
    const p = resolveProject({ edits: { takes: { enabled: true } } });
    const a = buildRenderPlan({ meta: m, events, project: p, words });
    const g = a.takes[0]!;
    const q = resolveProject({ ...p, edits: { ...p.edits, takes: withTakeChoice(p.edits.takes, g, 0) } });
    const b = buildRenderPlan({ meta: m, events, project: q, words });
    expect(b.takes[0]!.kept).toBe(0);
    expect(b.takeCuts[0]!.startMs).toBeGreaterThan(a.takeCuts[0]!.startMs);
  });
});
