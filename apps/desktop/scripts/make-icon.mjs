// Writes the Lens icon (a red record dot on a dark rounded square) as a multi-size .ico, generated at
// build time so no binary icon is committed. Used for the NSIS installer and uninstaller.
import fs from "node:fs";

function pixels(n) {
  const px = Buffer.alloc(n * n * 4); // BGRA, top-down
  const r = n * 0.22; // corner radius
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const dx = Math.max(r - cx, 0, cx - (n - r)), dy = Math.max(r - cy, 0, cy - (n - r));
      const inSquare = Math.hypot(dx, dy) <= r;
      const d = Math.hypot(cx - n / 2, cy - n / 2);
      const i = (y * n + x) * 4;
      if (!inSquare) continue;
      if (d <= n * 0.3) px.set([0x3c, 0x3c, 0xe8, 0xff], i); // red dot (B, G, R, A)
      else if (d <= n * 0.36) px.set([0xf0, 0xf0, 0xf0, 0xff], i); // white ring
      else px.set([0x2a, 0x22, 0x1e, 0xff], i); // dark background
    }
  return px;
}

function bmpEntry(n) {
  const px = pixels(n);
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(n, 4);
  hdr.writeInt32LE(n * 2, 8); // XOR + AND masks
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) px.copy(xor, (n - 1 - y) * n * 4, y * n * 4, (y + 1) * n * 4); // bottom-up
  const rowBytes = Math.ceil(n / 32) * 4;
  const and = Buffer.alloc(rowBytes * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (px[(y * n + x) * 4 + 3] === 0) and[(n - 1 - y) * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  return Buffer.concat([hdr, xor, and]);
}

export function writeIcon(file, sizes = [16, 24, 32, 48, 64, 128]) {
  const imgs = sizes.map(bmpEntry);
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
  fs.writeFileSync(file, Buffer.concat([dir, ...imgs]));
}
