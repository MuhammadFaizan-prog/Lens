/**
 * Imported caption fonts (Windows v0.1.3 request "import custom fonts ... from their pc or from internet
 * or google fonts"): checking that a file really is a font, reading its family name, and the Google
 * Fonts / CSS @font-face plumbing. Pure (no Node, no DOM): the WOFF decompressors are passed in
 * (zlib inflate for WOFF 1, Brotli for WOFF2) so the editor server and tests can both use it.
 *
 * A font passes when its container parses (TrueType / OpenType sfnt, WOFF or WOFF2; collections are
 * refused), its table directory stays inside the file, and it has the tables a renderer needs: head
 * (with the 0x5F0F3CF5 magic), cmap, name, hhea, maxp and outlines (glyf + loca, CFF or CFF2). The
 * family name comes from the name table (typographic family, else family).
 */

export const MAX_FONT_BYTES = 10 * 1024 * 1024;

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

export interface FontInfo {
  format: FontFormat;
  /** Typographic family (name ID 16), else family (name ID 1); "" when it could not be read. */
  family: string;
  /** Subfamily (name ID 17, else 2), e.g. "Bold Italic". */
  subfamily: string;
  /** OS/2 usWeightClass (400 when the table is missing or compressed without a decompressor). */
  weight: number;
  italic: boolean;
  /** Outline flavour: TrueType glyf or CFF. */
  outlines: "truetype" | "cff";
}

export class FontFileError extends Error {}

export interface Decompressors {
  /** zlib (RFC 1950) inflate, for WOFF 1 tables. */
  inflate?: (data: Uint8Array) => Uint8Array;
  /** Brotli decompress, for the WOFF2 table stream. */
  brotli?: (data: Uint8Array) => Uint8Array;
}

const tagAt = (d: DataView, o: number) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));

/** Container format from the first four bytes, or null when it is not a font this importer takes. */
export function sniffFontFormat(bytes: Uint8Array): FontFormat | "ttc" | null {
  if (bytes.length < 12) return null;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const v = d.getUint32(0);
  const t = tagAt(d, 0);
  if (v === 0x00010000 || t === "true") return "ttf";
  if (t === "OTTO") return "otf";
  if (t === "wOFF") return "woff";
  if (t === "wOF2") return "woff2";
  if (t === "ttcf") return "ttc";
  return null;
}

/** Table tag -> bytes (empty when a table is compressed and its contents are not needed or cannot be read). */
type Tables = Map<string, Uint8Array>;

function sfntTables(bytes: Uint8Array): Tables {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = d.getUint16(4);
  if (n < 1 || n > 512 || 12 + n * 16 > bytes.length) throw new FontFileError("the table directory is damaged");
  const out: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = tagAt(d, o);
    const off = d.getUint32(o + 8);
    const len = d.getUint32(o + 12);
    if (off + len > bytes.length) throw new FontFileError(`table ${tag.trim()} runs past the end of the file`);
    out.set(tag, bytes.subarray(off, off + len));
  }
  return out;
}

const NEEDED = ["name", "head", "OS/2"];

function woffTables(bytes: Uint8Array, dz: Decompressors): Tables {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44) throw new FontFileError("the WOFF header is cut short");
  const n = d.getUint16(12);
  if (n < 1 || n > 512 || 44 + n * 20 > bytes.length) throw new FontFileError("the WOFF table directory is damaged");
  const out: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    const tag = tagAt(d, o);
    const off = d.getUint32(o + 4);
    const comp = d.getUint32(o + 8);
    const orig = d.getUint32(o + 12);
    if (off + comp > bytes.length || comp > orig) throw new FontFileError(`WOFF table ${tag.trim()} is damaged`);
    const raw = bytes.subarray(off, off + comp);
    if (comp === orig) out.set(tag, raw);
    else if (dz.inflate && NEEDED.includes(tag)) {
      let t: Uint8Array;
      try {
        t = dz.inflate(raw);
      } catch {
        throw new FontFileError(`WOFF table ${tag.trim()} does not decompress`);
      }
      if (t.length !== orig) throw new FontFileError(`WOFF table ${tag.trim()} has the wrong size`);
      out.set(tag, t);
    } else out.set(tag, new Uint8Array(0));
  }
  return out;
}

const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp",
  "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt",
  "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill"];

function base128(d: DataView, o: { p: number }): number {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    if (o.p >= d.byteLength) throw new FontFileError("the WOFF2 table directory is cut short");
    const b = d.getUint8(o.p++);
    if ((i === 0 && b === 0x80) || v & 0xfe000000) throw new FontFileError("the WOFF2 table directory is damaged");
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return v >>> 0;
  }
  throw new FontFileError("the WOFF2 table directory is damaged");
}

function woff2Tables(bytes: Uint8Array, dz: Decompressors): Tables {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 48) throw new FontFileError("the WOFF2 header is cut short");
  if (tagAt(d, 4) === "ttcf") throw new FontFileError("font collections are not supported");
  const n = d.getUint16(12);
  const compressed = d.getUint32(20);
  if (n < 1 || n > 512) throw new FontFileError("the WOFF2 table directory is damaged");
  const o = { p: 48 };
  const dir: Array<{ tag: string; len: number }> = [];
  for (let i = 0; i < n; i++) {
    if (o.p >= bytes.length) throw new FontFileError("the WOFF2 table directory is cut short");
    const flags = d.getUint8(o.p++);
    let tag: string;
    if ((flags & 0x3f) === 63) {
      if (o.p + 4 > bytes.length) throw new FontFileError("the WOFF2 table directory is cut short");
      tag = tagAt(d, o.p);
      o.p += 4;
    } else tag = WOFF2_TAGS[flags & 0x3f]!;
    const orig = base128(d, o);
    const tv = (flags >> 6) & 3;
    const transformed = tag === "glyf" || tag === "loca" ? tv === 0 : tv !== 0;
    const len = transformed ? base128(d, o) : orig;
    dir.push({ tag, len });
  }
  if (o.p + compressed > bytes.length) throw new FontFileError("the WOFF2 data is cut short");
  const out: Tables = new Map();
  if (!dz.brotli) {
    for (const t of dir) out.set(t.tag, new Uint8Array(0));
    return out;
  }
  let stream: Uint8Array;
  try {
    stream = dz.brotli(bytes.subarray(o.p, o.p + compressed));
  } catch {
    throw new FontFileError("the WOFF2 data does not decompress");
  }
  let at = 0;
  for (const t of dir) {
    if (at + t.len > stream.length) throw new FontFileError(`WOFF2 table ${t.tag.trim()} is cut short`);
    out.set(t.tag, stream.subarray(at, at + t.len));
    at += t.len;
  }
  return out;
}

function nameString(name: Uint8Array, ids: number[]): string {
  if (name.length < 6) return "";
  const d = new DataView(name.buffer, name.byteOffset, name.byteLength);
  const count = d.getUint16(2);
  const strings = d.getUint16(4);
  const found = new Map<number, { score: number; s: string }>();
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    if (o + 12 > name.length) break;
    const plat = d.getUint16(o);
    const enc = d.getUint16(o + 2);
    const lang = d.getUint16(o + 4);
    const id = d.getUint16(o + 6);
    const len = d.getUint16(o + 8);
    const off = strings + d.getUint16(o + 10);
    if (!ids.includes(id) || off + len > name.length) continue;
    let s = "";
    let score: number;
    if (plat === 3 || plat === 0) {
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(d.getUint16(off + k));
      score = plat === 3 && (enc === 1 || enc === 10) ? (lang === 0x409 ? 3 : 2) : 1;
    } else if (plat === 1 && enc === 0) {
      for (let k = 0; k < len; k++) s += String.fromCharCode(d.getUint8(off + k));
      score = lang === 0 ? 1.5 : 0.5;
    } else continue;
    s = s.replace(/\0/g, "").trim();
    if (!s) continue;
    const prev = found.get(id);
    if (!prev || score > prev.score) found.set(id, { score, s });
  }
  for (const id of ids) if (found.has(id)) return found.get(id)!.s;
  return "";
}

/** Parse a font file; throws FontFileError with a reason a person can read when it is not a usable font. */
export function parseFontInfo(bytes: Uint8Array, dz: Decompressors = {}): FontInfo {
  if (!bytes || !bytes.length) throw new FontFileError("the file is empty");
  if (bytes.length > MAX_FONT_BYTES) throw new FontFileError(`the file is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB`);
  const kind = sniffFontFormat(bytes);
  if (kind === "ttc") throw new FontFileError("font collections (.ttc) are not supported; use a single .ttf / .otf");
  if (!kind) throw new FontFileError("not a font file (expected TrueType, OpenType, WOFF or WOFF2)");
  const tables = kind === "woff" ? woffTables(bytes, dz) : kind === "woff2" ? woff2Tables(bytes, dz) : sfntTables(bytes);
  for (const t of ["head", "cmap", "name", "hhea", "maxp"]) if (!tables.has(t)) throw new FontFileError(`the font has no ${t} table`);
  const truetype = tables.has("glyf") && tables.has("loca");
  const cff = tables.has("CFF ") || tables.has("CFF2");
  if (!truetype && !cff) throw new FontFileError("the font has no glyph outlines (glyf or CFF)");
  const head = tables.get("head")!;
  if (head.length >= 16 && new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(12) !== 0x5f0f3cf5) throw new FontFileError("the font's head table is damaged");
  const name = tables.get("name")!;
  const family = nameString(name, [16, 1]);
  const subfamily = nameString(name, [17, 2]);
  if (name.length && !family) throw new FontFileError("the font has no family name");
  const os2 = tables.get("OS/2");
  let weight = 400;
  let italic = /italic|oblique/i.test(subfamily);
  if (os2 && os2.length >= 64) {
    const d = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
    weight = d.getUint16(4) || 400;
    italic = italic || (d.getUint16(62) & 1) === 1;
  }
  const format: FontFormat = kind === "woff" || kind === "woff2" ? kind : cff ? "otf" : "ttf";
  return { format, family, subfamily, weight, italic, outlines: truetype ? "truetype" : "cff" };
}

/** A family name safe to store and to register as a CSS font family (no quotes, controls or slashes). */
export function cleanFamilyName(s: string): string {
  return s.replace(/[\u0000-\u001f"'\\/<>{};]/g, "").replace(/\s+/g, " ").trim().slice(0, 64);
}

/** File name for an imported font in the bundle's fonts/ folder. */
export function importedFontFileName(family: string, weight: number, format: FontFormat): string {
  const stem = cleanFamilyName(family).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "font";
  return `${stem}-${weight}.${format}`;
}

/** Family name from a file name ("Lobster-Regular.ttf" -> "Lobster"), for fonts whose name table could not be read. */
export function familyFromFileName(name: string): string {
  return cleanFamilyName(name.replace(/\.(ttf|otf|woff2?)$/i, "").replace(/[-_ ](regular|bold|medium|book|normal|\d{3})$/i, "").replace(/[-_]+/g, " "));
}

// ------------------------------------------------------------------------------ CSS @font-face / Google Fonts

export interface CssFontFace {
  family: string;
  weight: number;
  style: "normal" | "italic";
  url: string;
  unicodeRange?: string;
}

/** The @font-face rules of a stylesheet (Google Fonts css2, Bunny Fonts, a self-hosted .css), urls made absolute. */
export function parseFontFaceCss(css: string, baseUrl: string): CssFontFace[] {
  const out: CssFontFace[] = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const block = m[1]!;
    const prop = (k: string) => new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([^;]+)`, "i").exec(block)?.[1]?.trim();
    const family = cleanFamilyName((prop("font-family") ?? "").replace(/^["']|["']$/g, ""));
    const src = prop("src") ?? "";
    const urls = [...src.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)].map((u) => u[2]!);
    if (!family || !urls.length) continue;
    let url: string;
    try {
      url = new URL(urls[0]!, baseUrl).toString();
    } catch {
      continue;
    }
    const w = prop("font-weight") ?? "400";
    const weight = w === "bold" ? 700 : w === "normal" ? 400 : Number.parseInt(w, 10) || 400;
    const style = /italic|oblique/i.test(prop("font-style") ?? "") ? "italic" : "normal";
    const ur = prop("unicode-range");
    out.push({ family, weight, style, url, ...(ur ? { unicodeRange: ur } : {}) });
  }
  return out;
}

/** Whether a unicode-range covers basic Latin "A" (U+0041); no range covers everything. */
function coversLatin(range?: string): boolean {
  if (!range) return true;
  return range.split(",").some((r) => {
    const m = /U\+([0-9A-F?]+)(?:-([0-9A-F]+))?/i.exec(r.trim());
    if (!m) return false;
    const lo = Number.parseInt(m[1]!.replace(/\?/g, "0"), 16);
    const hi = m[2] ? Number.parseInt(m[2], 16) : Number.parseInt(m[1]!.replace(/\?/g, "F"), 16);
    return lo <= 0x41 && 0x41 <= hi;
  });
}

/**
 * The upright faces to download for a regular and a bold: the nearest weight to 400 and to 700 among the
 * faces that cover Latin. Bold is null when the stylesheet has a single weight.
 */
export function pickFontFaces(faces: CssFontFace[]): { regular: CssFontFace; bold: CssFontFace | null } | null {
  const up = faces.filter((f) => f.style === "normal" && coversLatin(f.unicodeRange));
  const pool = up.length ? up : faces.filter((f) => coversLatin(f.unicodeRange));
  if (!pool.length) return null;
  const near = (w: number) => [...pool].sort((a, b) => Math.abs(a.weight - w) - Math.abs(b.weight - w) || a.weight - b.weight)[0]!;
  const regular = near(400);
  const b = near(700);
  return { regular, bold: b.weight > regular.weight ? b : null };
}

/** Google Fonts css2 request for a family at the given weights (the API answers 400 when a weight does not exist). */
export function googleFontsCssUrl(family: string, weights: number[] = [400, 700]): string {
  const fam = encodeURIComponent(cleanFamilyName(family)).replace(/%20/g, "+");
  const ws = [...new Set(weights.filter((w) => w >= 100 && w <= 900).map((w) => Math.round(w / 100) * 100))].sort((a, b) => a - b);
  return `https://fonts.googleapis.com/css2?family=${fam}${ws.length ? `:wght@${ws.join(";")}` : ""}&display=swap`;
}

/** What a pasted URL points at: a font file, or a stylesheet with @font-face rules. */
export function fontUrlKind(url: string, contentType = ""): "font" | "css" {
  const ct = contentType.toLowerCase();
  if (/text\/css/.test(ct)) return "css";
  if (/font\/|application\/(font|x-font)/.test(ct)) return "font";
  let p = "";
  try {
    const u = new URL(url);
    if (/(^|\.)fonts\.googleapis\.com$|(^|\.)fonts\.bunny\.net$/.test(u.hostname)) return "css";
    p = u.pathname.toLowerCase();
  } catch {
    p = url.toLowerCase();
  }
  return /\.(ttf|otf|woff2?)$/.test(p) ? "font" : "css";
}
