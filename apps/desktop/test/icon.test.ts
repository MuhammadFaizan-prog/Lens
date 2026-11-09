import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Lens icon (scripts/make-icon.mjs) feeds the installer, Lens.exe, the windows, the tray and (as
// SVG) the editor's favicon and header mark: all must be the same art.
const ROOT = path.resolve(__dirname, "..");
const modPath = path.join(ROOT, "scripts", "make-icon.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = async (): Promise<any> => import(/* @vite-ignore */ modPath);

describe("Lens icon", () => {
  it(".ico holds 16/24/32/48/64/256, 32-bit", async () => {
    const m = await load();
    const ico: Buffer = m.ico();
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, k) => ico.readUInt8(6 + 16 * k) || 256);
    expect(sizes).toEqual([16, 24, 32, 48, 64, 256]);
    for (let k = 0; k < count; k++) expect(ico.readUInt16LE(6 + 16 * k + 6)).toBe(32);
    // the 256 entry is a PNG
    const off = ico.readUInt32LE(6 + 16 * 5 + 12);
    expect(ico.subarray(off, off + 4).toString("latin1")).toBe("\x89PNG");
  });

  it("reads as the mark at 16 px: red centre, white ring, dark square, transparent corners", async () => {
    const m = await load();
    const n = 16;
    const px: Buffer = m.pixels(n);
    const at = (x: number, y: number) => Array.from(px.subarray((y * n + x) * 4, (y * n + x) * 4 + 4));
    expect(at(8, 8)).toEqual([0xe8, 0x3c, 0x3c, 0xff]);
    expect(at(8, 2)).toEqual([0xf0, 0xf0, 0xf0, 0xff]); // ring: 0.30-0.36 of the side from the centre
    expect(at(8, 0)).toEqual([0x1e, 0x22, 0x2a, 0xff]);
    expect(at(0, 0)[3]).toBe(0);
  });

  it("the editor's header mark and favicon use the same geometry and colours", async () => {
    const m = await load();
    const s = 32;
    const want = { rx: String(s * m.ART.cornerRadius), ring: String(s * m.ART.ringRadius), dot: String(s * m.ART.dotRadius) };
    const mark = fs.readFileSync(path.join(ROOT, "..", "editor", "src", "components", "Icon.tsx"), "utf8");
    const fav = decodeURIComponent(/rel="icon" href="data:image\/svg\+xml,([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "..", "editor", "index.html"), "utf8"))![1]!);
    for (const src of [mark, fav]) {
      expect(src).toMatch(new RegExp(`rx=["']${want.rx}["'] fill=["']${m.ART.bg}`));
      expect(src).toMatch(new RegExp(`r=["']${want.ring}["'] fill=["']${m.ART.ring}`));
      expect(src).toMatch(new RegExp(`r=["']${want.dot}["'] fill=["']${m.ART.dot}`));
    }
  });
});
