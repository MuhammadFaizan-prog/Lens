/**
 * Title, description and chapters from the transcript (demand #27, docs/Chapters.md), through the UI,
 * on a held-out synthetic transcript (a screen-recording tutorial in four topics, written after the
 * engine was tuned on a different one in packages/engine/test/chapters.test.ts). Sentences are evenly
 * spaced (300 ms gaps everywhere), so topic changes can only be found from the words.
 *
 * Bounds (set before the first run, not to be loosened):
 *   1. Drafting runs on the page in < 1000 ms (no network, no model).
 *   2. Chapters: 4 or 5; the first at 0:00; each true topic change has a chapter start within 5 s.
 *   3. Title: 1..100 characters; every word except "and" is a word of the transcript.
 *      Description: >= 2 sentences, each one verbatim a sentence of the transcript.
 *      Each chapter title: non-empty; every word except "and" is spoken inside that chapter.
 *   4. Edits: a chapter renamed in the list shows in the YouTube list; the timeline ruler shows one
 *      marker per chapter.
 *   5. Files: the YouTube list has one "m:ss Title" line per chapter, ascending, first 0:00; the
 *      WebVTT download starts WEBVTT with one cue per chapter.
 *   6. MP4 markers (export on the run's path): ffprobe finds one chapter per plan chapter, each start
 *      within 1 ms of the plan's, the same titles, and the title tag = the drafted title.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { EXPORT_PATH } from "./uxHelpers";
import { EDITOR } from "./helpers";

test.afterAll(() => closeAll());

const TOPICS = [
  [
    "Before recording, plug in your microphone and pick it in the input menu.",
    "Speak a test sentence and watch the microphone level meter move.",
    "Choose the screen or window you want to capture from the source list.",
    "Close chat apps so notifications do not appear in the capture.",
    "Press the red record button and wait for the three second countdown.",
  ],
  [
    "After recording, the editor adds zoom blocks wherever you clicked.",
    "Drag the edge of a zoom block to make the zoom last longer.",
    "Raise the zoom scale when the button you clicked is very small.",
    "Delete a zoom block if the camera moves too much in that part.",
    "Smooth zoom transitions keep viewers from feeling dizzy.",
  ],
  [
    "Next, turn on captions so people can follow without sound.",
    "The transcript panel shows every caption word with its timing.",
    "Fix a misheard caption word by clicking it in the transcript.",
    "Pick a caption style with a bold font and a highlighted active word.",
    "Captions stay in sync even after you cut parts of the transcript.",
  ],
  [
    "Finally, open the export dialog and choose an export format.",
    "The export preset sets the resolution and frame rate for each platform.",
    "Pick a vertical export for short phone videos.",
    "Watch the export progress bar until the file is ready.",
    "Download the exported file and upload it wherever you share videos.",
  ],
];

const WORD_MS = 380;
const GAP_MS = 300;
const LEAD_MS = 500;

function makeBundle(): { dir: string; topicStarts: number[]; durationMs: number; ranges: Array<[number, number]> } {
  const words: Array<{ text: string; startMs: number; endMs: number }> = [];
  const topicStarts: number[] = [];
  const ranges: Array<[number, number]> = [];
  let t = LEAD_MS;
  for (const topic of TOPICS) {
    topicStarts.push(t);
    const a = t;
    for (const s of topic) {
      for (const w of s.split(/\s+/)) {
        words.push({ text: w, startMs: t, endMs: t + WORD_MS - 40 });
        t += WORD_MS;
      }
      t += GAP_MS;
    }
    ranges.push([a, t]);
  }
  const durationMs = Math.ceil((t + 1000) / 1000) * 1000;
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `chapters-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=10:d=${durationMs / 1000}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, "screen.mp4")]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: 640, height: 360, fps: 10, durationMs, pixelRatio: 1 }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), `# lens-events v1 {"capture":{"width":640,"height":360},"source":"screen","platform":"linux"}\n{"t": 0, "type": "move", "x": 100, "y": 100}\n`);
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({
    version: 1, output: { aspect: "16:9", resolution: 360, fps: 24 }, zoom: { auto: false }, cursor: { visible: false, clickEffect: "none" },
    motionBlur: { enabled: false }, frame: { shadow: { opacity: 0 } }, background: { kind: "solid", colors: ["#203040"], inherit: false }, audio: { tracks: [] }, captions: { enabled: false },
  }, null, 1));
  fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ version: 1, language: "en", durationMs, words }));
  return { dir, topicStarts, durationMs, ranges };
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

test("title, description and chapters drafted on the device, edited, exported as text and MP4 markers", async () => {
  const { dir, topicStarts, ranges } = makeBundle();
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  await page.waitForFunction(() => (window as any).__lens.store.get().bundle?.transcript?.words?.length > 0, null, { timeout: 60_000 });

  await page.getByTestId("export-dialog-open").click();
  await page.getByTestId("export-tab-chapters").click();
  await page.getByTestId("chapters-generate").click();
  await expect(page.getByTestId("chapter-row").first()).toBeVisible();
  const draftMs = await page.evaluate(() => (window as any).__lens.store.lastChapterDraftMs);
  const st = await page.evaluate(() => {
    const s = (window as any).__lens.store.get();
    return { ch: s.project.chapters, plan: s.plan.chapters, fps: s.plan.output.fps, dur: s.plan.output.durationMs };
  });
  const starts: number[] = st.plan.items.map((c: any) => c.outMs);
  console.log("draft", draftMs.toFixed(1), "ms; title:", JSON.stringify(st.ch.title));
  console.log("description:", JSON.stringify(st.ch.description));
  console.log("chapters:", JSON.stringify(st.plan.items), "truth:", JSON.stringify(topicStarts));
  // 1
  expect(draftMs).toBeLessThan(1000);
  // 2 (no cuts, so the output clock is the recording clock)
  expect(starts.length).toBeGreaterThanOrEqual(4);
  expect(starts.length).toBeLessThanOrEqual(5);
  expect(starts[0]).toBe(0);
  const errs = topicStarts.slice(1).map((t) => Math.min(...starts.map((s) => Math.abs(s - t))));
  console.log("boundary errors (ms):", errs.join(", "));
  for (const e of errs) expect(e).toBeLessThanOrEqual(5000);
  // 3
  const allWords = new Set(TOPICS.flat().join(" ").split(/\s+/).map(norm));
  const allSentences = TOPICS.flat();
  expect(st.ch.title.length).toBeGreaterThan(0);
  expect(st.ch.title.length).toBeLessThanOrEqual(100);
  for (const w of st.ch.title.split(/\s+/)) if (norm(w) !== "and") expect(allWords.has(norm(w))).toBe(true);
  const descSentences = st.ch.description.split(/(?<=[.!?])\s+/);
  expect(descSentences.length).toBeGreaterThanOrEqual(2);
  for (const s of descSentences) expect(allSentences).toContain(s);
  st.ch.items.forEach((it: any, i: number) => {
    const end = st.ch.items[i + 1]?.srcMs ?? Infinity;
    const spoken = new Set<string>();
    ranges.forEach(([a, b], ti) => {
      // words spoken inside [it.srcMs, end)
      let t = a;
      for (const s of TOPICS[ti]!) {
        for (const w of s.split(/\s+/)) {
          if (t >= it.srcMs - 1 && t < end) spoken.add(norm(w));
          t += WORD_MS;
        }
        t += GAP_MS;
      }
      void b;
    });
    expect(it.title.length).toBeGreaterThan(0);
    for (const w of it.title.split(/\s+/)) if (norm(w) !== "and") expect(spoken.has(norm(w))).toBe(true);
  });
  await shot(page, `chapters-drafted${PACKAGED ? "-app" : ""}`);

  // 4: rename the second chapter in the list; one marker per chapter on the timeline ruler
  const second = page.getByTestId("chapter-title").nth(1);
  await second.fill("Zoom editing basics");
  await expect(page.getByTestId("chapters-youtube")).toHaveValue(/\n\d+:\d\d Zoom editing basics(\n|$)/);
  // 5: the YouTube list
  const yt = await page.getByTestId("chapters-youtube").inputValue();
  const lines = yt.split("\n");
  console.log("youtube list:\n" + yt);
  expect(lines.length).toBe(starts.length);
  expect(lines[0]).toMatch(/^0:00 \S/);
  const secs = lines.map((l) => { const m = /^(\d+):(\d\d) /.exec(l)!; return Number(m[1]) * 60 + Number(m[2]); });
  for (let i = 1; i < secs.length; i++) expect(secs[i]!).toBeGreaterThan(secs[i - 1]!);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("chapters-download-vtt").click()]);
  const vtt = fs.readFileSync((await dl.path())!, "utf8");
  expect(vtt.startsWith("WEBVTT")).toBe(true);
  expect((vtt.match(/ --> /g) ?? []).length).toBe(starts.length);
  await page.getByTestId("export-dialog-close").click();
  await expect(page.getByTestId("tl-chapter")).toHaveCount(starts.length);
  await shot(page, `chapters-timeline${PACKAGED ? "-app" : ""}`);

  // 6: MP4 chapter markers
  const finalTitle = await page.evaluate(() => (window as any).__lens.store.get().project.chapters.title);
  const planCh = await page.evaluate(() => (window as any).__lens.store.get().plan.chapters.items);
  await page.getByTestId("export").click();
  await page.waitForFunction(() => { const e = (window as any).__lens.store.get().exporting; return e && (e.state === "done" || e.state === "error"); }, null, { timeout: 400_000, polling: 1000 });
  const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  expect(ex.state, ex.error).toBe("done");
  expect(ex.path === "browser" ? "browser" : "compositor").toBe(EXPORT_PATH);
  const mp4 = path.join(dir, ".lens-export", ex.id, "export.mp4");
  const pr = spawnSync("ffprobe", ["-v", "error", "-show_chapters", "-show_entries", "format_tags=title", "-of", "json", mp4], { encoding: "utf8" });
  const j = JSON.parse(pr.stdout);
  const got = j.chapters.map((c: any) => ({ startMs: Number(c.start_time) * 1000, title: c.tags?.title }));
  console.log("mp4 chapters:", JSON.stringify(got), "title tag:", j.format?.tags?.title);
  expect(got.length).toBe(planCh.length);
  got.forEach((c: any, i: number) => {
    expect(Math.abs(c.startMs - planCh[i].outMs)).toBeLessThanOrEqual(1);
    expect(c.title).toBe(planCh[i].title);
  });
  expect(j.format?.tags?.title).toBe(finalTitle);
  await lens.close();
});
