import { describe, expect, it } from "vitest";
import { buildTimeline, chaptersVtt, draftContent, draftContentForPlan, outputChapters, ffmetadata, resolveProject, segmentSentences, sentencesOf, stem, youtubeChapterIssues, youtubeChapterList, type Word } from "../src/index.js";

/** Words for sentences spoken at ~2.6 words/s with a 300 ms gap between sentences (no topic pauses). */
export function speak(topics: string[][], wordMs = 380, gapMs = 300): { words: Word[]; topicStarts: number[] } {
  const words: Word[] = [];
  const topicStarts: number[] = [];
  let t = 0;
  for (const topic of topics) {
    topicStarts.push(t);
    for (const s of topic) {
      for (const w of s.split(/\s+/)) {
        words.push({ text: w, startMs: t, endMs: t + wordMs - 40 });
        t += wordMs;
      }
      t += gapMs;
    }
  }
  return { words, topicStarts };
}

// dev set (tuning): a software-release tutorial, four topics, five or six sentences each
const DEV = [
  [
    "Today we are creating a new repository on GitHub for our project.",
    "Open GitHub and press the new repository button in the corner.",
    "Give the repository a short name and pick public or private.",
    "Tick the box that adds a license file and a gitignore template.",
    "Then clone the repository to your laptop with the clone command.",
  ],
  [
    "Now the readme file deserves real attention before anyone visits.",
    "A good readme starts with one sentence that says what the project does.",
    "Add an install section to the readme with the exact commands.",
    "Screenshots in the readme help people understand the interface quickly.",
    "Finish the readme with a usage example and a link to the documentation.",
  ],
  [
    "Next we set up continuous integration with a workflow file.",
    "The workflow runs the test suite on every push and pull request.",
    "Choose the runner operating system and the node version in the workflow.",
    "Cache the dependencies so each workflow run finishes in about a minute.",
    "A failing test turns the workflow check red on the pull request.",
  ],
  [
    "Finally we publish a release so users can download a build.",
    "Create a tag with the version number and push the tag to GitHub.",
    "The release page lists the changes since the previous version.",
    "Attach the installer files to the release as downloadable assets.",
    "Announce the release and the new version number to your users.",
  ],
];

describe("title, description and chapters from the transcript (demand #27)", () => {
  it("stems and sentences", () => {
    expect(new Set(["exports", "exporting", "exported", "export"].map(stem)).size).toBe(1);
    expect(new Set(["captions", "caption"].map(stem)).size).toBe(1);
    const { words } = speak(DEV);
    const s = sentencesOf(words);
    expect(s.length).toBe(20);
    expect(s[0]!.text).toBe(DEV[0]![0]);
    // fillers and VAD placeholders never reach a sentence
    const w2 = [...words.slice(0, 3), { text: "[filler]", startMs: 99999, endMs: 100000, inferred: true }, { text: "um", startMs: 100100, endMs: 100200, filler: true }];
    expect(sentencesOf(w2).flatMap((x) => x.words)).toEqual(words.slice(0, 3).map((w) => w.text));
  });

  it("dev transcript: chapter starts on the topic changes, one per topic", () => {
    const { words, topicStarts } = speak(DEV);
    const d = draftContent(words);
    expect(d.chapters.map((c) => c.srcMs)).toEqual(topicStarts);
    for (const c of d.chapters) expect(c.title.length).toBeGreaterThan(0);
    // titles name the topic's own words
    expect(d.chapters.map((c) => c.title.toLowerCase())).toEqual([expect.stringContaining("repositor"), expect.stringContaining("readme"), expect.stringContaining("workflow"), expect.stringContaining("release")]);
    expect(d.title.length).toBeGreaterThan(0);
    expect(d.title.length).toBeLessThanOrEqual(70);
    expect(d.description.split(/(?<=\.)\s/).length).toBe(3);
  });

  it("everything is drawn from the transcript", () => {
    const { words } = speak(DEV);
    const d = draftContent(words);
    const vocab = new Set(words.map((w) => w.text.toLowerCase().replace(/[^a-z0-9']/g, "")));
    for (const w of [...d.title.split(" "), ...d.chapters.flatMap((c) => c.title.split(" "))]) if (!/^(and)$/i.test(w)) expect(vocab.has(w.toLowerCase())).toBe(true);
    const all = DEV.flat();
    for (const s of d.description.split(/(?<=\.)\s/)) expect(all).toContain(s);
  });

  it("deterministic, and short or empty transcripts degrade gracefully", () => {
    const { words } = speak(DEV);
    expect(draftContent(words)).toEqual(draftContent([...words].reverse()));
    expect(draftContent([])).toEqual({ title: "", description: "", chapters: [], keywords: [] });
    const one = draftContent(speak([["Just one short sentence about exporting video."]]).words);
    expect(one.chapters).toHaveLength(1);
    expect(one.title.length).toBeGreaterThan(0);
  });

  it("chapters respect the minimum length on the output clock", () => {
    const { words } = speak(DEV);
    const s = sentencesOf(words);
    const { starts } = segmentSentences(s, { minChapterMs: 30_000 });
    for (let i = 1; i < starts.length; i++) expect(s[starts[i]!]!.startMs - s[starts[i - 1]!]!.startMs).toBeGreaterThanOrEqual(30_000);
  });

  it("chapters follow cuts onto the output clock", () => {
    const pieces = buildTimeline(100_000, [{ startMs: 20_000, endMs: 30_000 }], []);
    const items = [{ id: "a", srcMs: 500, title: "A" }, { id: "b", srcMs: 25_000, title: "B" }, { id: "c", srcMs: 50_000, title: "C" }, { id: "d", srcMs: 120_000, title: "D" }];
    expect(outputChapters(items, pieces, 90_000)).toEqual([{ outMs: 0, title: "A" }, { outMs: 20_000, title: "B" }, { outMs: 40_000, title: "C" }]);
    // a draft on a plan leaves cut words out and measures on the output clock
    const { words, topicStarts } = speak(DEV);
    const fps = 30;
    const cut = { startMs: topicStarts[1]!, endMs: topicStarts[2]! };
    const dur = words[words.length - 1]!.endMs;
    const frames: Array<{ src: number }> = [];
    for (let t = 0; t < dur; t += 1000 / fps) if (!(t >= cut.startMs && t < cut.endMs)) frames.push({ src: t });
    const d = draftContentForPlan(words, { frames, output: { fps, durationMs: (frames.length * 1000) / fps }, cuts: [cut] });
    expect(d.chapters.map((c) => c.title.toLowerCase()).join(" ")).not.toContain("readme");
    expect(d.chapters.length).toBe(3);
  });

  it("YouTube list, VTT and ffmetadata", () => {
    const ch = [{ outMs: 120, title: "Intro" }, { outMs: 65_400, title: "Readme" }, { outMs: 3_700_000, title: "Release" }];
    expect(youtubeChapterList(ch, 3_800_000)).toBe("0:00:00 Intro\n0:01:05 Readme\n1:01:40 Release");
    expect(youtubeChapterList(ch.slice(0, 2), 90_000)).toBe("0:00 Intro\n1:05 Readme");
    expect(youtubeChapterIssues(ch.slice(0, 2), 70_000)).toEqual(["YouTube needs at least 3 chapters (2 now).", "\"Readme\" is shorter than 10 s."]);
    expect(chaptersVtt(ch.slice(0, 2), 90_000)).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:01:05.400\nIntro\n\n2\n00:01:05.400 --> 00:01:30.000\nReadme\n");
    expect(ffmetadata({ title: "A=B; c" }, ch.slice(0, 2), 90_000)).toBe(";FFMETADATA1\ntitle=A\\=B\\; c\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=65400\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=65400\nEND=90000\ntitle=Readme\n");
  });

  it("project.chapters is optional and validated", () => {
    expect(resolveProject({}).chapters).toBeUndefined();
    expect(() => resolveProject({ chapters: { title: "t", description: "", embed: true, items: [{ id: "a", srcMs: -1, title: "x" }] } })).toThrow(/chapters.items/);
    expect(resolveProject({ chapters: { title: "t", description: "d", embed: false, items: [{ id: "a", srcMs: 0, title: "x" }] } }).chapters!.items).toHaveLength(1);
  });
});
