import { describe, expect, it } from "vitest";
import {
  buildRenderPlan,
  captionBlocks,
  editSegment,
  parseSrt,
  parseVtt,
  resolveProject,
  retimeWords,
  segmentTranscript,
  speechSpans,
  syllableWeight,
  toSrt,
  toVtt,
  trackWords,
  validateTranslations,
  visualOrderRtl,
  wrapLines,
  wrapWords,
  isFiller,
  ARABIC_FONT,
  type CaptionTrack,
  type Word,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

// Source transcript: two sentences with a pause inside the second and a long gap between them.
const SRC: Word[] = [
  { text: "Open", startMs: 1000, endMs: 1250 },
  { text: "the", startMs: 1300, endMs: 1400 },
  { text: "settings", startMs: 1450, endMs: 1900 },
  { text: "menu.", startMs: 1950, endMs: 2300 },
  { text: "Then", startMs: 3500, endMs: 3700 },
  { text: "um", startMs: 3750, endMs: 4100, filler: true },
  { text: "click", startMs: 4150, endMs: 4400 },
  // 600 ms pause inside the sentence
  { text: "save", startMs: 5000, endMs: 5300 },
  { text: "to", startMs: 5350, endMs: 5450 },
  { text: "finish.", startMs: 5500, endMs: 6000 },
];

const ES: CaptionTrack = {
  language: "es",
  name: "Español",
  rtl: false,
  sourceLanguage: "en",
  segments: [
    { id: "s1", startMs: 1000, endMs: 2300, source: "Open the settings menu.", text: "Abra el menú de configuración." },
    { id: "s2", startMs: 3500, endMs: 6000, source: "Then click save to finish.", text: "Luego haga clic en guardar para terminar." },
  ],
};

const UR: CaptionTrack = {
  language: "ur",
  name: "اردو",
  rtl: true,
  sourceLanguage: "en",
  segments: [
    { id: "s1", startMs: 1000, endMs: 2300, source: "Open the settings menu.", text: "سیٹنگز کا مینو کھولیں۔" },
    { id: "s2", startMs: 3500, endMs: 6000, source: "Then click save to finish.", text: "پھر Lens Studio میں محفوظ کریں پر کلک کریں۔" },
  ],
};

function insideSegment(words: Word[], track: CaptionTrack) {
  for (const w of words) {
    const seg = track.segments[w.segment!]!;
    expect(w.startMs).toBeGreaterThanOrEqual(seg.startMs);
    expect(w.endMs).toBeLessThanOrEqual(seg.endMs);
    expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
  }
}

describe("segmenting the source (demand #8)", () => {
  it("splits at sentence ends and long pauses, leaves fillers out of the text", () => {
    const segs = segmentTranscript(SRC, (w) => isFiller(w));
    expect(segs.map((s) => s.source)).toEqual(["Open the settings menu.", "Then click save to finish."]);
    expect(segs[1]).toMatchObject({ startMs: 3500, endMs: 6000 });
  });

  it("closes a long sentence at a comma in its last third", () => {
    const words: Word[] = Array.from({ length: 30 }, (_, i) => ({ text: i === 20 ? "word," : "word", startMs: i * 200, endMs: i * 200 + 150 }));
    const segs = segmentTranscript(words, () => false);
    expect(segs[0]!.source.split(" ").length).toBe(21);
  });
});

describe("re-timing translated words", () => {
  it("weights words by syllables (diacritics count as their vowel), Arabic script by letters", () => {
    expect(syllableWeight("configuración")).toBe(5); // con-fi-gu-ra-ción (io is one vowel group)
    expect(syllableWeight("menú")).toBe(2);
    expect(syllableWeight("Schaltfläche")).toBe(3);
    expect(syllableWeight("کھولیں")).toBe(3);
    expect(syllableWeight("—")).toBeLessThan(1);
  });

  it("keeps every word inside the speech spans, in order, contiguous within a span", () => {
    const spans = speechSpans({ startMs: 3500, endMs: 6000 }, SRC);
    // the 600 ms pause between "click" and "save" stays a gap; the 50 ms gaps are closed
    expect(spans).toEqual([{ startMs: 3500, endMs: 4400 }, { startMs: 5000, endMs: 6000 }]);
    const ws = retimeWords("Luego haga clic en guardar para terminar.", spans);
    expect(ws.map((w) => w.text)).toEqual(["Luego", "haga", "clic", "en", "guardar", "para", "terminar."]);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i]!;
      expect(spans.some((r) => w.startMs >= r.startMs && w.endMs <= r.endMs)).toBe(true);
      if (i) expect(w.startMs).toBeGreaterThanOrEqual(ws[i - 1]!.endMs);
    }
    expect(ws[0]!.startMs).toBe(3500);
    expect(ws[ws.length - 1]!.endMs).toBe(6000);
    // longer words get more time
    const dur = (t: string) => ws.find((w) => w.text === t)!.endMs - ws.find((w) => w.text === t)!.startMs;
    expect(dur("terminar.")).toBeGreaterThan(dur("en"));
  });

  it("every translated word stays inside its source segment, for every track", () => {
    for (const tr of [ES, UR]) insideSegment(trackWords(tr, SRC), tr);
  });

  it("cuts take their time with them: words squeeze into the speech that survives", () => {
    const cuts = [{ startMs: 4950, endMs: 6100 }]; // "save to finish." deleted
    const ws = trackWords(ES, SRC, cuts);
    const s2 = ws.filter((w) => w.segment === 1);
    expect(s2.length).toBe(7); // the whole translation is still shown
    for (const w of s2) {
      expect(w.startMs).toBeGreaterThanOrEqual(3500);
      expect(w.endMs).toBeLessThanOrEqual(4400);
    }
    // a segment cut completely disappears
    expect(trackWords(ES, SRC, [{ startMs: 900, endMs: 2400 }]).some((w) => w.segment === 0)).toBe(false);
  });

  it("without source words (imported subtitles) uses the whole segment", () => {
    const ws = trackWords(ES, null);
    expect(ws[0]!.startMs).toBe(1000);
    expect(ws.filter((w) => w.segment === 0).at(-1)!.endMs).toBe(2300);
  });
});

describe("caption layout for translations", () => {
  it("blocks never cross a segment", () => {
    const blocks = captionBlocks(trackWords(ES, SRC), 20, 10000, 42);
    for (const b of blocks) expect(new Set(b.words.map((w) => w.segment)).size).toBe(1);
  });

  it("wraps at max characters per line and keeps the old word-count wrap when it fits", () => {
    const en = ["This", "is", "Lens,", "a", "clean-room", "screen"];
    expect(wrapLines(en, 3, 42)).toEqual(wrapWords(6, 3));
    const de = ["Bildschirmaufnahmeprogramm", "Benachrichtigungseinstellungen", "werden", "geöffnet"];
    const lines = wrapLines(de, 5, 30);
    let i = 0;
    for (const n of lines) {
      const line = de.slice(i, i + n).join(" ");
      if (n > 1) expect([...line].length).toBeLessThanOrEqual(30);
      i += n;
    }
    expect(lines.reduce((a, b) => a + b, 0)).toBe(4);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("right-to-left lines draw right to left, keeping left-to-right runs in their own order", () => {
    const w = ["پھر", "Lens", "Studio", "میں", "کلک", "کریں۔"];
    expect(visualOrderRtl(w, [0, 1, 2, 3, 4, 5])).toEqual([5, 4, 3, 1, 2, 0]);
    expect(visualOrderRtl(["ایک", "دو", "تین"], [0, 1, 2])).toEqual([2, 1, 0]);
  });
});

describe("translated captions in the render plan", () => {
  const plan = (lang: string | null, extra: Record<string, unknown> = {}) =>
    buildRenderPlan({
      meta: META,
      events: demoSession(),
      words: SRC,
      project: resolveProject({ output: { fps: 30 }, captions: { enabled: true, maxWordsPerBlock: 5 }, translations: { language: lang, tracks: [ES, UR] }, ...extra }),
    });

  it("switches the burned-in language and leaves the source path unchanged", () => {
    const src = plan(null);
    const es = plan("es");
    const at = (p: ReturnType<typeof plan>, ms: number) => p.frames[Math.round((ms / 1000) * 30)]!;
    expect(at(src, 1500).caption!.words[0]).toBe("Open");
    expect(at(es, 1500).caption!.words[0]).toBe("Abra");
    expect(es.style.captions.language).toBe("es");
    expect(src.style.captions.language).toBeUndefined();
    expect(src.fonts).toBeUndefined();
  });

  it("highlight moves forward monotonically and only through translated words", () => {
    for (const lang of ["es", "ur"]) {
      const p = plan(lang);
      let lastText = "";
      let lastActive = -1;
      let seen = 0;
      for (const f of p.frames) {
        if (!f.caption) continue;
        if (f.caption.text !== lastText) {
          lastText = f.caption.text;
          lastActive = -1;
        }
        expect(f.caption.active).toBeGreaterThanOrEqual(lastActive);
        lastActive = f.caption.active;
        seen++;
      }
      expect(seen).toBeGreaterThan(60);
    }
  });

  it("Urdu carries the visual order and the Arabic-script font", () => {
    const p = plan("ur");
    const f = p.frames.find((x) => x.caption && x.caption.words.includes("Lens"))!;
    expect(f.caption!.visual).toBeDefined();
    const flat = f.caption!.visual!.flat();
    expect([...flat].sort((a, b) => a - b)).toEqual(f.caption!.words.map((_, i) => i));
    expect(flat.indexOf(f.caption!.words.indexOf("Lens"))).toBeLessThan(flat.indexOf(f.caption!.words.indexOf("Studio")));
    expect(p.style.captions.scriptFont).toBe(ARABIC_FONT.family);
    expect(p.fonts).toContainEqual(ARABIC_FONT);
  });

  it("subtitles follow cuts onto the output clock", () => {
    const p = plan("es", { edits: { cuts: [{ startMs: 2500, endMs: 3400 }] } });
    expect(p.subtitles.length).toBeGreaterThan(1);
    expect(p.subtitles[0]!.text.startsWith("Abra")).toBe(true);
    const s2 = p.subtitles.find((c) => c.text.startsWith("Luego"))!;
    expect(s2.startMs).toBe(3500 - 900);
    for (let i = 1; i < p.subtitles.length; i++) expect(p.subtitles[i]!.startMs).toBeGreaterThanOrEqual(p.subtitles[i - 1]!.endMs);
  });
});

describe("SRT / VTT round trip", () => {
  const cues = [
    { startMs: 0, endMs: 1234, text: "Abra el menú de configuración." },
    { startMs: 1500, endMs: 4321, text: "Wählen Sie die Datei aus,\ndie Sie hochladen möchten." },
    { startMs: 3_600_000 + 61_002, endMs: 3_600_000 + 62_500, text: "سیٹنگز کا مینو کھولیں۔" },
  ];
  it("SRT", () => expect(parseSrt(toSrt(cues))).toEqual(cues));
  it("VTT", () => {
    const v = toVtt(cues, "ur");
    expect(v.startsWith("WEBVTT\n\nNOTE language: ur\n")).toBe(true);
    expect(v).toContain("01:01:01.002 --> 01:01:02.500");
    expect(parseVtt(v)).toEqual(cues);
  });
});

describe("project data", () => {
  it("validates tracks and the selected language", () => {
    expect(validateTranslations({ language: "es", tracks: [ES] })).toEqual([]);
    expect(validateTranslations({ language: "fr", tracks: [ES] })[0]).toMatch(/no track/);
    expect(validateTranslations({ language: null, tracks: [ES, ES] })[0]).toMatch(/two es/);
    expect(() => resolveProject({ translations: { language: "fr", tracks: [ES] } })).toThrow();
  });

  it("side-by-side edit replaces the text and marks it edited", () => {
    const t = editSegment(ES, "s1", "  Abra   la configuración. ");
    expect(t.segments[0]).toMatchObject({ text: "Abra la configuración.", edited: true });
    expect(t.segments[1]).toEqual(ES.segments[1]);
  });
});
