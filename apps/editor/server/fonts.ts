/**
 * Caption font import (Windows v0.1.3 request: "add option they can import custom fonts too either from
 * their pc or from internet or google fonts"). Runs in the editor server (vite middleware on the web, the
 * in-app server in the desktop app), so files can be written next to the project:
 *
 *  - file:    bytes the page read from a file picker (input[type=file]); one file, or a regular + a bold
 *  - path:    files the desktop app's native dialog picked (absolute paths on this machine)
 *  - url:     a direct .ttf / .otf / .woff / .woff2 URL, or a stylesheet with @font-face rules
 *             (Google Fonts css2, Bunny Fonts, a self-hosted .css): the regular and bold faces are fetched
 *  - google:  a Google Fonts family name: the css2 API is asked for weights 400 and 700 (falling back to
 *             what the family has) and those files are fetched
 *  - library: a font imported earlier, from the user's font library
 *
 * Every file must parse as a font (engine fontFile.ts: sfnt / WOFF / WOFF2, required tables, a family
 * name) and stay under 10 MB. Accepted files are copied into <bundle>/fonts/ (the project renders offline
 * and opens on another machine) and into the user font library (LENS_FONT_LIBRARY, default ~/.lens/fonts;
 * the desktop app points it at userData/fonts), which lists them under "My fonts" in every project.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  BUILTIN_FONTS, cleanFamilyName, familyFromFileName, fontUrlKind, FontFileError, googleFontsCssUrl, importedFontFileName, MAX_FONT_BYTES, parseFontFaceCss,
  parseFontInfo, pickFontFaces, type FontInfo, type ProjectFont,
} from "../../../packages/engine/src/index";

export type ImportRequest =
  | { kind: "file"; files: Array<{ name: string; data: string }> }
  | { kind: "path"; paths: string[] }
  | { kind: "url"; url: string }
  | { kind: "google"; family: string }
  | { kind: "library"; family: string };

export interface LibraryFont {
  family: string;
  /** File names inside the library folder. */
  regular: string;
  bold: string;
  source?: ProjectFont["source"];
  addedAt: string;
}

export interface ImportResult {
  font: ProjectFont;
  format: string;
  weights: number[];
}

export interface FontDeps {
  fetch: typeof fetch;
  libraryDir: string;
}

export class FontImportError extends Error {}

export function defaultLibraryDir(): string {
  return process.env.LENS_FONT_LIBRARY ? path.resolve(process.env.LENS_FONT_LIBRARY) : path.join(os.homedir(), ".lens", "fonts");
}

/** Node's zlib for the WOFF decompressors. */
export const NODE_DECOMPRESSORS = {
  inflate: (b: Uint8Array) => new Uint8Array(zlib.inflateSync(b)),
  brotli: (b: Uint8Array) => new Uint8Array(zlib.brotliDecompressSync(b)),
};

/** Check one font file; throws FontImportError with the reason. */
export function validateFont(bytes: Uint8Array, label: string): FontInfo {
  try {
    return parseFontInfo(bytes, NODE_DECOMPRESSORS);
  } catch (e) {
    if (e instanceof FontFileError) throw new FontImportError(`${label}: ${e.message}`);
    throw new FontImportError(`${label}: not a readable font`);
  }
}

const UA = "Lens/0.1 (caption font import)";

async function download(deps: FontDeps, url: string, what: "font" | "css"): Promise<{ bytes: Uint8Array; type: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FontImportError(`not a URL: ${url}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FontImportError("only http(s) URLs can be imported");
  let r: Response;
  try {
    r = await deps.fetch(u.toString(), { headers: { "user-agent": UA, accept: what === "css" ? "text/css,*/*;q=0.1" : "*/*" }, redirect: "follow" });
  } catch (e) {
    throw new FontImportError(`could not reach ${u.hostname}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!r.ok) throw new FontImportError(`${u.hostname} answered ${r.status}`);
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > MAX_FONT_BYTES) throw new FontImportError(`the file is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > MAX_FONT_BYTES) throw new FontImportError(`the file is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB`);
  return { bytes, type: r.headers.get("content-type") ?? "" };
}

interface Face {
  bytes: Uint8Array;
  info: FontInfo;
}

/** Faces from a stylesheet: the regular and (when there is one) the bold upright face that cover Latin. */
async function facesFromCss(deps: FontDeps, css: string, base: string): Promise<{ family: string; faces: Face[] }> {
  const picked = pickFontFaces(parseFontFaceCss(css, base));
  if (!picked) throw new FontImportError("the stylesheet has no @font-face for Latin text");
  const out: Face[] = [];
  for (const f of [picked.regular, picked.bold]) {
    if (!f) continue;
    const { bytes } = await download(deps, f.url, "font");
    out.push({ bytes, info: validateFont(bytes, path.basename(new URL(f.url).pathname) || "font") });
  }
  return { family: picked.regular.family, faces: out };
}

/** Google Fonts: css2 with 400 + 700; a family without one of them is asked again for what it has. */
async function googleFaces(deps: FontDeps, family: string): Promise<{ family: string; faces: Face[] }> {
  const name = cleanFamilyName(family);
  if (!name) throw new FontImportError("type a Google Fonts family name");
  let lastErr: unknown = null;
  for (const weights of [[400, 700], [400], []]) {
    const url = googleFontsCssUrl(name, weights);
    try {
      const { bytes } = await download(deps, url, "css");
      const css = new TextDecoder().decode(bytes);
      if (!/@font-face/i.test(css)) throw new FontImportError(`Google Fonts has no family named "${name}"`);
      return await facesFromCss(deps, css, url);
    } catch (e) {
      lastErr = e;
      // 400: the family does not have that weight (or does not exist); try the next request
      if (!(e instanceof FontImportError && / answered 400$/.test(e.message))) throw e;
    }
  }
  if (lastErr instanceof FontImportError && / answered 400$/.test(lastErr.message)) throw new FontImportError(`Google Fonts has no family named "${name}"`);
  throw lastErr;
}

function libraryIndex(dir: string): LibraryFont[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "library.json"), "utf8"));
    return Array.isArray(j?.fonts) ? (j.fonts as LibraryFont[]).filter((f) => f && typeof f.family === "string" && typeof f.regular === "string") : [];
  } catch {
    return [];
  }
}

function writeLibraryIndex(dir: string, fonts: LibraryFont[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify({ version: 1, fonts }, null, 1));
}

/** Fonts in the user's library whose files are still there. */
export function listLibrary(dir: string): LibraryFont[] {
  return libraryIndex(dir).filter((f) => fs.existsSync(path.join(dir, f.regular)) && fs.existsSync(path.join(dir, f.bold)));
}

/** Remove a family from the library (its files too). */
export function removeFromLibrary(dir: string, family: string): boolean {
  const all = libraryIndex(dir);
  const gone = all.filter((f) => f.family === family);
  if (!gone.length) return false;
  const keep = all.filter((f) => f.family !== family);
  for (const f of gone)
    for (const file of new Set([f.regular, f.bold])) if (!keep.some((k) => k.regular === file || k.bold === file)) fs.rmSync(path.join(dir, path.basename(file)), { force: true });
  writeLibraryIndex(dir, keep);
  return true;
}

/** A family name that does not shadow one of Lens's built-in fonts (those keep their own files). */
function ownName(family: string): string {
  const f = cleanFamilyName(family) || "My font";
  return BUILTIN_FONTS.some((b) => b.family.toLowerCase() === f.toLowerCase()) ? `${f} (imported)` : f;
}

/** Import a font into `bundle` (and the library); the project then lists it in customFonts. */
export async function importFont(bundle: string, req: ImportRequest, deps: FontDeps): Promise<ImportResult> {
  let family = "";
  let faces: Face[] = [];
  let source: ProjectFont["source"];
  if (req.kind === "file" || req.kind === "path") {
    const items: Array<{ name: string; bytes: Uint8Array }> = [];
    if (req.kind === "file") {
      if (!Array.isArray(req.files) || !req.files.length) throw new FontImportError("no file");
      for (const f of req.files.slice(0, 2)) {
        const b64 = String(f.data ?? "");
        if (b64.length > (MAX_FONT_BYTES * 4) / 3 + 8) throw new FontImportError(`${f.name}: the file is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB`);
        items.push({ name: path.basename(String(f.name ?? "font")), bytes: new Uint8Array(Buffer.from(b64, "base64")) });
      }
    } else {
      if (!Array.isArray(req.paths) || !req.paths.length) throw new FontImportError("no file");
      for (const p of req.paths.slice(0, 2)) {
        const st = fs.statSync(p, { throwIfNoEntry: false });
        if (!st?.isFile()) throw new FontImportError(`${path.basename(p)}: not found`);
        if (st.size > MAX_FONT_BYTES) throw new FontImportError(`${path.basename(p)}: the file is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB`);
        items.push({ name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) });
      }
    }
    faces = items.map((it) => ({ bytes: it.bytes, info: validateFont(it.bytes, it.name) }));
    family = faces[0]!.info.family || familyFromFileName(items[0]!.name);
    source = { kind: "file", name: items.map((i) => i.name).join(", ") };
  } else if (req.kind === "url") {
    const url = String(req.url ?? "").trim();
    const first = await download(deps, url, fontUrlKind(url));
    if (fontUrlKind(url, first.type) === "css" && !/^(wOFF|wOF2|OTTO|true|\0\x01\0\0)/.test(new TextDecoder("latin1").decode(first.bytes.subarray(0, 4)))) {
      const r = await facesFromCss(deps, new TextDecoder().decode(first.bytes), url);
      family = r.family;
      faces = r.faces;
    } else {
      faces = [{ bytes: first.bytes, info: validateFont(first.bytes, path.basename(new URL(url).pathname) || "font") }];
      family = faces[0]!.info.family || familyFromFileName(path.basename(new URL(url).pathname));
    }
    source = { kind: "url", url };
  } else if (req.kind === "google") {
    const r = await googleFaces(deps, req.family);
    family = cleanFamilyName(req.family) || r.family;
    faces = r.faces;
    source = { kind: "google", url: `https://fonts.google.com/specimen/${encodeURIComponent(family).replace(/%20/g, "+")}` };
  } else if (req.kind === "library") {
    const lib = listLibrary(deps.libraryDir).find((f) => f.family === req.family);
    if (!lib) throw new FontImportError(`${req.family} is not in your font library`);
    const out = path.join(bundle, "fonts");
    fs.mkdirSync(out, { recursive: true });
    for (const f of new Set([lib.regular, lib.bold])) fs.copyFileSync(path.join(deps.libraryDir, f), path.join(out, f));
    const info = validateFont(new Uint8Array(fs.readFileSync(path.join(out, lib.regular))), lib.regular);
    return { font: { family: lib.family, regular: `fonts/${lib.regular}`, bold: `fonts/${lib.bold}`, source: { kind: "library", ...(lib.source?.url ? { url: lib.source.url } : {}) } }, format: info.format, weights: [] };
  } else throw new FontImportError("unknown import kind");

  if (!faces.length) throw new FontImportError("no font in that source");
  family = ownName(family);
  // regular = the lighter face, bold = the heavier one (or the same file for a single weight)
  faces.sort((a, b) => a.info.weight - b.info.weight);
  const reg = faces[0]!;
  const bold = faces.length > 1 && faces[faces.length - 1]!.info.weight > reg.info.weight ? faces[faces.length - 1]! : null;
  const names = [importedFontFileName(family, reg.info.weight, reg.info.format), bold ? importedFontFileName(family, bold.info.weight, bold.info.format) : null];
  const dirs = [path.join(bundle, "fonts"), deps.libraryDir];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, names[0]!), reg.bytes);
    if (bold) fs.writeFileSync(path.join(d, names[1]!), bold.bytes);
  }
  const lib = libraryIndex(deps.libraryDir).filter((f) => f.family !== family);
  lib.push({ family, regular: names[0]!, bold: names[1] ?? names[0]!, source, addedAt: new Date().toISOString() });
  writeLibraryIndex(deps.libraryDir, lib);
  return {
    font: { family, regular: `fonts/${names[0]}`, bold: `fonts/${names[1] ?? names[0]}`, ...(source ? { source } : {}) },
    format: reg.info.format,
    weights: faces.map((f) => f.info.weight),
  };
}

/** Files a font ref names that are not there (bundle-relative or builtin:), for the export's fallback. */
export function missingFamilies(fonts: Array<{ family: string; regular: string; bold: string }> | undefined, resolve: (ref: string) => string | null): string[] {
  return (fonts ?? []).filter((f) => !resolve(f.regular) || !resolve(f.bold)).map((f) => f.family);
}
