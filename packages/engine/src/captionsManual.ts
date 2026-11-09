/**
 * Hand-written captions (Windows bug #15): cues the user adds at the playhead, edits, retimes,
 * splits and merges, or imports from SRT / VTT; and inline corrections of transcript words.
 * Cues are in source time like every other timed edit; the plan maps them to the output clock.
 */
import type { CaptionCue } from "./project.js";
import type { CaptionBlock } from "./transcript.js";
import type { Word } from "./types.js";

/** Transcript words with inline edits applied: new text, and "" drops the word from captions. */
export function applyWordEdits(words: Word[], edits: Record<string, string> | undefined): Word[] {
  if (!edits || !Object.keys(edits).length) return words;
  const out: Word[] = [];
  words.forEach((w, i) => {
    const e = edits[String(i)];
    if (e === undefined) out.push(w);
    else if (e.trim()) out.push({ ...w, text: e.trim() });
  });
  return out;
}

/** One caption block per cue, its words spread evenly over the cue (for wrapping and SRT lines). */
export function cueBlock(c: CaptionCue): CaptionBlock | null {
  const parts = c.text.split(/\s+/).filter(Boolean);
  if (!parts.length || !(c.endMs > c.startMs)) return null;
  const step = (c.endMs - c.startMs) / parts.length;
  const words: Word[] = parts.map((text, i) => ({ text, startMs: c.startMs + i * step, endMs: c.startMs + (i + 1) * step }));
  return { startMs: c.startMs, endMs: c.endMs, text: parts.join(" "), words, manual: true, cueId: c.id };
}

/** Transcript blocks plus cues; a transcript block overlapping any cue gives way to it. Sorted by start. */
export function mergeCaptionCues(blocks: CaptionBlock[], cues: CaptionCue[] | undefined): CaptionBlock[] {
  const manual = (cues ?? []).map(cueBlock).filter((b): b is CaptionBlock => !!b);
  if (!manual.length) return blocks;
  const kept = blocks.filter((b) => !manual.some((m) => b.startMs < m.endMs && m.startMs < b.endMs));
  return [...kept, ...manual].sort((a, b) => a.startMs - b.startMs);
}

/** Split a cue at time t (strictly inside): the text splits at the word nearest the same fraction. */
export function splitCue(c: CaptionCue, t: number, ids: [string, string]): [CaptionCue, CaptionCue] | null {
  if (!(t > c.startMs && t < c.endMs)) return null;
  const parts = c.text.split(/\s+/).filter(Boolean);
  const u = (t - c.startMs) / (c.endMs - c.startMs);
  const k = parts.length > 1 ? Math.min(parts.length - 1, Math.max(1, Math.round(parts.length * u))) : parts.length;
  const a = parts.slice(0, k).join(" ");
  const b = parts.slice(k).join(" ");
  return [
    { id: ids[0], startMs: c.startMs, endMs: Math.round(t), text: a || c.text },
    { id: ids[1], startMs: Math.round(t), endMs: c.endMs, text: b || c.text },
  ];
}

/** Merge two cues into one spanning both, text joined in time order. */
export function mergeCues(a: CaptionCue, b: CaptionCue, id = a.id): CaptionCue {
  const [x, y] = a.startMs <= b.startMs ? [a, b] : [b, a];
  return { id, startMs: Math.min(x.startMs, y.startMs), endMs: Math.max(x.endMs, y.endMs), text: `${x.text} ${y.text}`.replace(/\s+/g, " ").trim() };
}

function parseStamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const [, h, mi, se, ms] = m;
  return (Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(se)) * 1000 + Number(ms!.padEnd(3, "0"));
}

/** Parse SRT or WebVTT text into cues (times as written; tags and cue settings dropped). */
export function parseSubtitles(text: string, newId: () => string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const blocks = text.replace(/\r/g, "").replace(/^\uFEFF/, "").split(/\n\s*\n/);
  for (const raw of blocks) {
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [l, r] = lines[at]!.split("-->");
    const a = parseStamp(l!);
    const b = parseStamp((r ?? "").trim().split(/\s+/)[0] ?? "");
    const body = lines.slice(at + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (a === null || b === null || !(b > a) || !body) continue;
    cues.push({ id: newId(), startMs: a, endMs: b, text: body });
  }
  return cues.sort((x, y) => x.startMs - y.startMs);
}
