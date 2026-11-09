// The Lens icon: a red record dot with a white ring on a dark rounded square (first drawn for the
// 0.1.0 installer; the art is fixed, do not redesign). Generated at build time so no binary icon is
// committed. One drawing, many outputs:
//   - lens.ico (16/24/32/48/64/256): installer, uninstaller, Lens.exe resource, window and tray on Windows
//   - lens-<n>.png: window and tray icon on Linux / macOS
//   - svg(): the same geometry as vector, for the editor favicon and header mark (apps/editor)
// Usage: node scripts/make-icon.mjs <out-dir>   (writes lens.ico + lens-16/32/64/256.png)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// geometry as fractions of the side, colours as RGB hex: the single definition of the mark
export const ART = { cornerRadius: 0.22, dotRadius: 0.3, ringRadius: 0.36, dot: "#e83c3c", ring: "#f0f0f0", bg: "#1e222a" };
export const ICO_SIZES = [16, 24, 32, 48, 64, 256];
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** RGBA pixels, top-down. */
export function pixels(n) {
  const px = Buffer.alloc(n * n * 4);
  const r = n * ART.cornerRadius;
  const [dot, ring, bg] = [ART.dot, ART.ring, ART.bg].map(rgb);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const dx = Math.max(r - cx, 0, cx - (n - r)), dy = Math.max(r - cy, 0, cy - (n - r));
      if (Math.hypot(dx, dy) > r) continue; // outside the rounded square: transparent
      const d = Math.hypot(cx - n / 2, cy - n / 2);
      const c = d <= n * ART.dotRadius ? dot : d <= n * ART.ringRadius ? ring : bg;
      px.set([...c, 0xff], (y * n + x) * 4);
    }
  return px;
}

/** 32-bit BMP icon entry (BGRA, bottom-up, with the AND mask). */
function bmpEntry(n) {
  const px = pixels(n);
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(n, 4);
  hdr.writeInt32LE(n * 2, 8); // XOR + AND masks
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const s = (y * n + x) * 4, d = ((n - 1 - y) * n + x) * 4;
      xor[d] = px[s + 2]; xor[d + 1] = px[s + 1]; xor[d + 2] = px[s]; xor[d + 3] = px[s + 3];
    }
  const rowBytes = Math.ceil(n / 32) * 4;
  const and = Buffer.alloc(rowBytes * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (px[(y * n + x) * 4 + 3] === 0) and[(n - 1 - y) * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  return Buffer.concat([hdr, xor, and]);
}

/** PNG (RGBA, 8-bit). */
export function png(n) {
  const px = pixels(n);
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) px.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Multi-size .ico buffer: BMP entries up to 64 px, PNG for 256 (the Vista+ format for the large size). */
export function ico(sizes = ICO_SIZES) {
  const imgs = sizes.map((n) => (n >= 256 ? png(n) : bmpEntry(n)));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let off = dir.length;
  sizes.forEach((n, k) => {
    const e = 6 + 16 * k;
    dir.writeUInt8(n >= 256 ? 0 : n, e);
    dir.writeUInt8(n >= 256 ? 0 : n, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(imgs[k].length, e + 8);
    dir.writeUInt32LE(off, e + 12);
    off += imgs[k].length;
  });
  return Buffer.concat([dir, ...imgs]);
}

export function writeIcon(file, sizes = ICO_SIZES) {
  fs.writeFileSync(file, ico(sizes));
}

/** The same mark as SVG (viewBox 0 0 32 32). */
export function svg() {
  const s = 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" rx="${s * ART.cornerRadius}" fill="${ART.bg}"/><circle cx="${s / 2}" cy="${s / 2}" r="${s * ART.ringRadius}" fill="${ART.ring}"/><circle cx="${s / 2}" cy="${s / 2}" r="${s * ART.dotRadius}" fill="${ART.dot}"/></svg>`;
}

/** Writes lens.ico and lens-<n>.png into dir. */
export function writeIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  writeIcon(path.join(dir, "lens.ico"));
  for (const n of [16, 32, 64, 256]) fs.writeFileSync(path.join(dir, `lens-${n}.png`), png(n));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? ".";
  writeIcons(dir);
  console.log(`wrote lens.ico (${ICO_SIZES.join("/")}) and pngs to ${dir}`);
}
