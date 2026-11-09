// Runs electron-builder without wine (used by dist-win.mjs on hosts where wine cannot run the x86
// NSIS stub, e.g. arm64 Linux). electron-builder builds the NSIS uninstaller by compiling a helper
// installer and *running* it under wine; on macOS Catalina+ it instead reads the uninstaller straight
// out of that helper's NSIS data block (UninstallerReader). This takes the reader path on Linux too,
// with an overlay offset computed from every PE section (the system NSIS 3.x stub has an .idata
// section the stock reader rejects). Same output as the wine path: the uninstaller exe NSIS embeds.
"use strict";
const fs = require("node:fs");
const zlib = require("node:zlib");
const macos = require("app-builder-lib/out/util/macosVersion");
const nsisUtil = require("app-builder-lib/out/targets/nsis/nsisUtil");

const SIG = Buffer.from([0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74]); // 0xDEADBEEF "NullsoftInst"

function extractUninstaller(installerPath, uninstallerPath) {
  const b = fs.readFileSync(installerPath);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error("not an MZ executable");
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) throw new Error("no PE header");
  const nSections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  let off = pe + 24 + optSize;
  let overlay = 0;
  for (let i = 0; i < nSections; i++, off += 40) {
    const rawSize = b.readUInt32LE(off + 16);
    const rawPtr = b.readUInt32LE(off + 20);
    if (rawPtr && rawSize) overlay = Math.max(overlay, rawPtr + rawSize);
  }
  const exe = b.subarray(0, overlay);
  const data = b.subarray(overlay);
  // firstheader: flags(4) siginfo(4) "NullsoftInst"(12) length_of_header(4) length_of_all_following_data(4)
  if (!data.subarray(4, 20).equals(SIG)) throw new Error("NSIS signature not found after the PE image");
  if (data.readUInt32LE(24) !== data.length) throw new Error("NSIS data size mismatch");
  let pos = 28;
  let inner = null;
  while (pos + 4 <= data.length) {
    let size = data.readUInt32LE(pos);
    pos += 4;
    const compressed = (size & 0x80000000) !== 0;
    size &= 0x7fffffff;
    if (size === 0 || pos + size > data.length) break;
    let blk = data.subarray(pos, pos + size);
    pos += size;
    if (compressed) blk = zlib.inflateRawSync(blk);
    if (blk.length >= 20 && blk.subarray(4, 20).equals(SIG)) {
      if (inner) throw new Error("multiple inner NSIS blocks");
      inner = blk;
    }
  }
  if (!inner) throw new Error("uninstaller block not found");
  const out = Buffer.concat([exe, inner]);
  // NSIS's integrity check: CRC32 of everything after the first 512 bytes, stored in the last 4.
  // It fails when the uninstaller's header should differ from the helper's (a different uninstaller
  // icon), so check it here rather than ship an uninstaller that refuses to run.
  const crc = zlib.crc32(out.subarray(512, out.length - 4)) >>> 0;
  if (crc !== out.readUInt32LE(out.length - 4)) throw new Error("extracted uninstaller fails the NSIS CRC check (installer and uninstaller icons must be identical)");
  fs.writeFileSync(uninstallerPath, out);
}

macos.isMacOsCatalina = () => true;
nsisUtil.UninstallerReader.exec = async (installerPath, uninstallerPath) => {
  extractUninstaller(installerPath, uninstallerPath);
  console.log(`  • uninstaller extracted without wine  size=${fs.statSync(uninstallerPath).size}`);
};
require("electron-builder/out/cli/cli");
