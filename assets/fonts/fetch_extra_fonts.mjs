#!/usr/bin/env node
// Fetches the second batch of caption fonts (packages/engine/src/fontCatalog.ts, EXTRA_FONTS) into
// assets/fonts, pinned by SHA-256 to a google/fonts commit. The .ttf files are git-ignored (binaries are
// never committed); the licence texts are written next to them. Static files are copied unchanged under
// Lens's file names (<stem>-Regular.ttf, <stem>-Bold.ttf, <stem>-OFL.txt / <stem>-Apache.txt).
//
//   node assets/fonts/fetch_extra_fonts.mjs [--check]
//
// --check only verifies that every file is present with the pinned hash (exit 1 otherwise).
// LENS_FONT_CACHE=<dir>: read <dir>/<google/fonts dir>/<file> first when it is there (still hash-checked).
// The desktop build (apps/desktop/scripts/dist-win.mjs) runs this; a file already present with the right
// hash is not downloaded again.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CATALOG = path.join(REPO, "packages", "engine", "src", "fontCatalog.ts");

/** EXTRA_FONTS and the commit, parsed from the engine source (the array between the markers is strict JSON). */
export function readCatalog(file = CATALOG) {
  const src = fs.readFileSync(file, "utf8");
  const m = /\/\* catalog:begin \*\/([\s\S]*?)\/\* catalog:end \*\//.exec(src);
  const c = /GOOGLE_FONTS_COMMIT = "([0-9a-f]{40})"/.exec(src);
  if (!m || !c) throw new Error(`${file}: catalog markers or commit not found`);
  return { commit: c[1], fonts: JSON.parse(m[1]) };
}

export function outNames(f) {
  const lic = f.licence === "Apache-2.0" ? "Apache" : "OFL";
  return { regular: `${f.stem}-Regular.ttf`, bold: f.bold ? `${f.stem}-Bold.ttf` : null, licence: `${f.stem}-${lic}.txt` };
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function get(commit, dir, file, want) {
  const cache = process.env.LENS_FONT_CACHE;
  if (cache) {
    const p = path.join(cache, dir, file);
    if (fs.existsSync(p)) {
      const b = fs.readFileSync(p);
      if (sha(b) === want) return b;
    }
  }
  const url = `https://raw.githubusercontent.com/google/fonts/${commit}/${dir}/${encodeURIComponent(file)}`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      if (sha(b) !== want) throw new Error(`SHA-256 mismatch (${sha(b)})`);
      return b;
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
  throw new Error(`${dir}/${file}: ${last?.message ?? last}`);
}

async function main() {
  const check = process.argv.includes("--check");
  const { commit, fonts } = readCatalog();
  const out = process.env.LENS_FONTS_DIR || HERE;
  fs.mkdirSync(out, { recursive: true });
  let fetched = 0;
  const bad = [];
  const jobs = [];
  for (const f of fonts) {
    const names = outNames(f);
    const items = [[f.regular, names.regular], [f.licenceFile, names.licence]];
    if (f.bold) items.push([f.bold, names.bold]);
    for (const [src, name] of items) {
      const dest = path.join(out, name);
      if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === src.sha256) continue;
      if (check) {
        bad.push(name);
        continue;
      }
      jobs.push(async () => {
        fs.writeFileSync(dest, await get(commit, f.dir, src.src, src.sha256));
        fetched++;
      });
    }
  }
  // a few downloads at a time
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) await queue.shift()();
  }));
  if (bad.length) {
    console.error(`fetch_extra_fonts: ${bad.length} file(s) missing or not matching the pinned hash: ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? ", ..." : ""}`);
    process.exit(1);
  }
  console.log(`fetch_extra_fonts: ${fonts.length} families ok (${fetched} file(s) fetched)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`fetch_extra_fonts: ${e.message ?? e}`);
    process.exit(1);
  });
}
