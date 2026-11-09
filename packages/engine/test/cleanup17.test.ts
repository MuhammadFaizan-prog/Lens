/**
 * Windows bug #17: Cleanup ("Remove fillers" / "Shorten pauses" / "Longest pause") did nothing:
 * cleanup.enabled defaulted to false and cuts were only made when transcript words existed.
 * Now pauses come from the mic's measured silences, so they are cut with no transcript at all,
 * and fillers are cut from the transcript's words.
 */
import { describe, expect, it } from "vitest";
import { cleanupCuts, DEFAULT_CLEANUP } from "../src/transcript";

describe("cleanup without a transcript (#17)", () => {
  const silences = [
    { startMs: 2000, endMs: 6000 }, // 4 s pause
    { startMs: 8000, endMs: 8600 }, // short: kept as is
    { startMs: 11000, endMs: 15000 }, // 4 s pause
  ];
  it("shortens measured silences longer than maxPauseMs to keepPauseMs", () => {
    const cuts = cleanupCuts([], 16000, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: true, pauses: silences });
    const keep = DEFAULT_CLEANUP.keepPauseMs / 2;
    expect(cuts).toEqual([
      { startMs: 2000 + keep, endMs: 6000 - keep },
      { startMs: 11000 + keep, endMs: 15000 - keep },
    ]);
    // what remains of each long pause is keepPauseMs <= maxPauseMs
    for (const s of [silences[0]!, silences[2]!]) {
      const removed = cuts.filter((c) => c.startMs >= s.startMs && c.endMs <= s.endMs).reduce((a, c) => a + c.endMs - c.startMs, 0);
      expect(s.endMs - s.startMs - removed).toBe(DEFAULT_CLEANUP.keepPauseMs);
    }
  });
  it("makes no pause cuts when shortenPauses is off, and none without silences", () => {
    expect(cleanupCuts([], 16000, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: false, pauses: silences })).toEqual([]);
    expect(cleanupCuts([], 16000, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: true })).toEqual([]);
  });
  it("cuts fillers from words and pauses from silences together", () => {
    const words = [
      { text: "Hello", startMs: 500, endMs: 1900 },
      { text: "um", startMs: 6100, endMs: 6500, filler: true },
      { text: "next", startMs: 6600, endMs: 7900 },
    ];
    const cuts = cleanupCuts(words, 9000, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: true, pauses: [{ startMs: 1900, endMs: 6100 }] });
    // the filler is cut (inside padMs) and the pause around it shortened
    expect(cuts.some((c) => c.startMs <= 6100 + DEFAULT_CLEANUP.padMs && c.endMs >= 6500 - DEFAULT_CLEANUP.padMs)).toBe(true);
    expect(cuts.some((c) => c.startMs <= 2100 && c.endMs >= 5900)).toBe(true);
  });
});
