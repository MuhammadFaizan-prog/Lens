/**
 * Built-in backdrops (v0.1.4): the original twelve keep their ids and definitions (Rules.md §4: old
 * projects render identically), the new field backdrops have unique ids, render deterministically,
 * match the golden hashes the Python twin is held to (tests/test_backdrop_field.py: same bytes in both
 * languages), are visibly distinct from each other, scale with the output size, and each sits in at
 * least one picker category.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKDROP_CATEGORIES, BUILTIN_BACKDROPS, backdropById, backdropCategories, buildRenderPlan, isFieldStyle, renderBackdropField, resolveProject } from "../src/index.js";

const meta = { width: 1280, height: 720, fps: 30, durationMs: 4000, pixelRatio: 1 };

const GOLDEN = new URL("./fixtures/backdrop-field-hashes.json", import.meta.url);
const GW = 160;
const GH = 90;
const fields = BUILTIN_BACKDROPS.filter((b) => isFieldStyle(b.style));

const rgbHash = (px: Uint8ClampedArray) => {
  const rgb = Buffer.alloc((px.length / 4) * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    rgb[j] = px[i]!;
    rgb[j + 1] = px[i + 1]!;
    rgb[j + 2] = px[i + 2]!;
  }
  return createHash("sha256").update(rgb).digest("hex").slice(0, 32);
};

describe("built-in backdrops", () => {
  it("keeps the original twelve exactly (ids, colours, styles, seeds)", () => {
    const classic = BUILTIN_BACKDROPS.slice(0, 12).map((b) => [b.id, b.style, b.seed, b.colors.join(" ")].join("|"));
    expect(classic).toEqual([
      "aurora|waves|11|#0b1026 #1f6f8b #99e1d9 #f0f3bd",
      "dusk|blobs|23|#1a1033 #6b2d5c #f0386b #ff9f1c",
      "lagoon|blobs|37|#022b3a #1f7a8c #bfdbf7 #e1e5f2",
      "ember|rays|41|#140d0b #7a1f0f #e2711d #ffc971",
      "orchard|waves|53|#0d2818 #04471c #058c42 #c9f2c7",
      "nebula|grain|67|#07031a #3c1a78 #b14aed #fbd1ff",
      "sandstone|waves|71|#3d2c1e #9c6644 #ddb892 #f4ede4",
      "glacier|rays|83|#e8f1f8 #b9d6ee #6aa6d6 #2b5f8e",
      "citrus|blobs|97|#fff3b0 #ffd166 #ef8354 #5e2bff",
      "slate|grain|101|#111418 #2a3039 #4b5563 #9aa5b1",
      "bloom|blobs|113|#2b0a3d #a4036f #ff7aa2 #ffe3ec",
      "tide|rays|127|#03045e #0077b6 #00b4d8 #caf0f8",
    ]);
    // the original twelve carry no new fields, so the plan's backdropArt for them is as before
    for (const b of BUILTIN_BACKDROPS.slice(0, 12)) expect(Object.keys(b).sort()).toEqual(["colors", "id", "name", "seed", "style"]);
  });

  it("has at least 36 new backdrops, every id unique, every palette valid", () => {
    expect(fields.length).toBeGreaterThanOrEqual(36);
    const ids = BUILTIN_BACKDROPS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of fields) {
      expect(b.id).toMatch(/^[a-z0-9-]+$/);
      expect(b.colors.length).toBeGreaterThanOrEqual(3);
      for (const c of b.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(backdropById(`builtin:${b.id}`)).toBe(b);
    }
  });

  it("puts every backdrop in at least one category, and every category has backdrops", () => {
    const ids = new Set(BACKDROP_CATEGORIES.map((c) => c.id));
    for (const b of BUILTIN_BACKDROPS) {
      const cs = backdropCategories(b);
      expect(cs.length).toBeGreaterThan(0);
      for (const c of cs) expect(ids.has(c)).toBe(true);
    }
    for (const c of BACKDROP_CATEGORIES) {
      if (c.id === "all") continue;
      const n = BUILTIN_BACKDROPS.filter((b) => backdropCategories(b).includes(c.id as never)).length;
      expect(n, c.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("renders every field backdrop deterministically and matches the golden hashes (shared with the Python twin)", () => {
    const got: Record<string, string> = {};
    for (const b of fields) {
      const a = renderBackdropField(b, GW, GH);
      const c = renderBackdropField(b, GW, GH);
      expect(Buffer.from(a).equals(Buffer.from(c)), b.id).toBe(true);
      for (let i = 3; i < a.length; i += 4) if (a[i] !== 255) throw new Error(`${b.id}: alpha ${a[i]}`);
      got[b.id] = rgbHash(a);
    }
    if (process.env.LENS_UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN, `${JSON.stringify({ width: GW, height: GH, hashes: got }, null, 1)}\n`);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
    expect(golden.width).toBe(GW);
    expect(got).toEqual(golden.hashes);
  });

  it("makes visibly distinct pictures (mean difference between any two >= 8 levels)", () => {
    const W = 64;
    const H = 36;
    const px = fields.map((b) => renderBackdropField(b, W, H));
    let worst = { d: Infinity, a: "", b: "" };
    for (let i = 0; i < px.length; i++) {
      for (let j = i + 1; j < px.length; j++) {
        let s = 0;
        for (let k = 0; k < px[i]!.length; k++) if ((k & 3) !== 3) s += Math.abs(px[i]![k]! - px[j]![k]!);
        const d = s / (W * H * 3);
        if (d < worst.d) worst = { d, a: fields[i]!.id, b: fields[j]!.id };
      }
    }
    console.log("closest pair", worst);
    expect(worst.d).toBeGreaterThanOrEqual(8);
  });

  // Shapes, colours and noise are sized in output fractions; only hairlines differ, by design (a line
  // is never thinner than one output pixel, so thumbnails keep visible lines): checked on area styles.
  it("is resolution independent: a 4x larger render, box-downsampled, matches the small one", () => {
    for (const id of ["mesh-lagoon", "aurora-borealis", "blur-candy", "bokeh-teal", "poly-glacier", "iso-blocks", "grain-twilight", "conic-prism", "burst-sun", "spot-beam", "dunes-sahara", "mountains-alpine", "sky-clear"]) {
      const b = backdropById(id)!;
      const W = 96;
      const H = 54;
      const small = renderBackdropField(b, W, H);
      const big = renderBackdropField(b, W * 4, H * 4);
      let s = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          for (let c = 0; c < 3; c++) {
            let acc = 0;
            for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) acc += big[((y * 4 + dy) * W * 4 + x * 4 + dx) * 4 + c]!;
            s += Math.abs(acc / 16 - small[(y * W + x) * 4 + c]!);
          }
        }
      }
      const mean = s / (W * H * 3);
      expect(mean, id).toBeLessThanOrEqual(10);
    }
  });

  it("carries a new backdrop into the render plan (style.backdropArt) for the Python compositor", () => {
    const q = resolveProject({ background: { kind: "image", imagePath: "builtin:synth-sunset", inherit: false }, output: { fps: 30, resolution: 360 } });
    const plan = buildRenderPlan({ meta, events: [{ t: 0, type: "move", x: 100, y: 100 }], project: q });
    expect(plan.style.backdropArt).toMatchObject({ id: "synth-sunset", style: "synth", seed: 1811, variant: 0 });
  });
});
