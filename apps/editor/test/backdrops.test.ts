/**
 * The original twelve built-in backdrops draw exactly as before (Rules.md §4: old projects render
 * identically): every Canvas2D call and style each one makes, hashed at 1920x1080 and at a 96x54
 * thumbnail, equals the hash taken from the v0.1.3 drawing code before the v0.1.4 backdrops landed.
 * (The new field backdrops' pixels are held by packages/engine/test/backdropField.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_BACKDROPS, backdropReady, drawBackdrop, prepareBackdrop } from "../src/render/backdrops";
import { recordingCtx } from "./recordingCtx";

// recorded from de0daa3 (v0.1.3) drawBackdrop(): [1920x1080, 96x54]
const V013: Record<string, [string, string]> = {
  aurora: ["1f4dcb2098b88a4dc9454c09dcf521f8", "fc94976efa6bc4baff3762f7b85463dd"],
  dusk: ["e62cf3426e04960201fa6b61079ffee2", "8b9754aef348ffd20c5289f265a3f253"],
  lagoon: ["0b870c4087bbcfaab031e48790278d37", "92d88209eaf9a8f6b6afbb92bb130d92"],
  ember: ["f1b1ab43483d51c6823cd180f1bf1d35", "775eaf1399087d221526c4f0a364c869"],
  orchard: ["50e68b8b8d52672d99678d77c9ffa6b0", "659f4f7d356a69014b66e484f1768334"],
  nebula: ["fdb6bed091fabc8cd64a216f762fc9f6", "1ad4c8212500021be076a3e52c7a8977"],
  sandstone: ["4dbc4ce8fb9a4b6fbb1008aa7d72d5c7", "8363b85e952adab60fdd46c913a9e399"],
  glacier: ["5ae377d3eee9521ec98c96c6ce4f13f6", "61c4fe7e2f3188813c2e304fcf12daac"],
  citrus: ["442d66f35a7a42b980bd0e56d55d4252", "f5453fe3e2033f17d46e6caa5493b98d"],
  slate: ["d2c3ece08f945b1374bef1d6ffa96a89", "dbc2c3d3d4564172e7d9787fbb99bbc7"],
  bloom: ["487048dfbee0ff60f1f4d6c7a1e6c6a1", "e3f017d31969d12a2a0004f78ecd3552"],
  tide: ["d6ecf2a7eb89a060f9814440d02fcf78", "4e80ef5a79d4a3bdf01a538180c83d34"],
};

describe("classic backdrops", () => {
  it("draw the same canvas calls as v0.1.3, at export and thumbnail size", () => {
    const got: Record<string, [string, string]> = {};
    for (const b of BUILTIN_BACKDROPS.slice(0, 12)) {
      got[b.id] = [[1920, 1080], [96, 54]].map(([w, h]) => {
        const r = recordingCtx();
        expect(drawBackdrop(r.ctx, b, w!, h!)).toBe(true);
        return r.hash().slice(0, 32);
      }) as [string, string];
    }
    expect(got).toEqual(V013);
  });

  it("are always ready (no off-thread render) and preparing them is a no-op", async () => {
    for (const b of BUILTIN_BACKDROPS.slice(0, 12)) {
      expect(backdropReady(b, 3840, 2160)).toBe(true);
      expect(await prepareBackdrop(b, 3840, 2160)).toBe(false);
    }
  });
});
