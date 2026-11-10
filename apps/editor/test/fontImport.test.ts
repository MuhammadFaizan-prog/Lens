/**
 * Caption font import on the editor server (server/fonts.ts, Windows v0.1.3): from a file, a direct URL,
 * a CSS @font-face URL and Google Fonts (fetch mocked: no network), into <bundle>/fonts and the user
 * font library; non-fonts and oversize files refused; library listing and removal; built-in names not
 * shadowed; missing files detected for the export's fallback.
 *
 * Fixture fonts are the committed first-batch TTFs in assets/fonts (no binary added to the repo).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FontImportError, importFont, listLibrary, missingFamilies, removeFromLibrary, type FontDeps } from "../server/fonts";

const FONTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "fonts");
const REG = fs.readFileSync(path.join(FONTS, "Caveat-Regular.ttf"));
const BOLD = fs.readFileSync(path.join(FONTS, "Caveat-Bold.ttf"));
const POPPINS = fs.readFileSync(path.join(FONTS, "Poppins-Regular.ttf"));

let tmp = "";
let bundle = "";
let lib = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lens-fontimport-"));
  bundle = path.join(tmp, "bundle");
  lib = path.join(tmp, "library");
  fs.mkdirSync(bundle);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fetch that serves a fixed map of URLs (anything else: 404) and records what was asked. */
function mockFetch(routes: Record<string, { body: Uint8Array | string; type?: string; status?: number }>): { fetch: typeof fetch; calls: Array<{ url: string; ua: string | null }> } {
  const calls: Array<{ url: string; ua: string | null }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: new Headers(init?.headers).get("user-agent") });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(typeof r.body === "string" ? r.body : new Uint8Array(r.body), { status: r.status ?? 200, headers: { "content-type": r.type ?? "application/octet-stream" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const deps = (f: typeof fetch): FontDeps => ({ fetch: f, libraryDir: lib });
const b64 = (b: Buffer) => b.toString("base64");

describe("import from a file", () => {
  it("one file: validated, copied into fonts/ and the library, family from the name table", async () => {
    const r = await importFont(bundle, { kind: "file", files: [{ name: "whatever.ttf", data: b64(REG) }] }, deps(mockFetch({}).fetch));
    expect(r.font).toMatchObject({ family: "Caveat (imported)", regular: "fonts/Caveat-imported-400.ttf", bold: "fonts/Caveat-imported-400.ttf", source: { kind: "file" } });
    expect(fs.readFileSync(path.join(bundle, r.font.regular)).equals(REG)).toBe(true);
    expect(listLibrary(lib).map((f) => f.family)).toEqual(["Caveat (imported)"]);
  });

  it("a regular and a bold file become one family with two weights (lighter = regular)", async () => {
    const r = await importFont(bundle, { kind: "file", files: [{ name: "b.ttf", data: b64(BOLD) }, { name: "a.ttf", data: b64(REG) }] }, deps(mockFetch({}).fetch));
    expect(r.weights.sort()).toEqual([400, 700]);
    expect(fs.readFileSync(path.join(bundle, r.font.regular)).equals(REG)).toBe(true);
    expect(fs.readFileSync(path.join(bundle, r.font.bold)).equals(BOLD)).toBe(true);
  });

  it("refuses a file that is not a font, and anything over 10 MB, without writing", async () => {
    const d = deps(mockFetch({}).fetch);
    await expect(importFont(bundle, { kind: "file", files: [{ name: "photo.ttf", data: b64(Buffer.from("\x89PNG\r\n\x1a\n not really")) }] }, d)).rejects.toThrow(/photo\.ttf: not a font file/);
    await expect(importFont(bundle, { kind: "file", files: [{ name: "big.ttf", data: b64(Buffer.alloc(10 * 1024 * 1024 + 10)) }] }, d)).rejects.toThrow(/larger than 10 MB/);
    await expect(importFont(bundle, { kind: "file", files: [{ name: "cut.ttf", data: b64(REG.subarray(0, 3000)) }] }, d)).rejects.toBeInstanceOf(FontImportError);
    expect(fs.existsSync(path.join(bundle, "fonts"))).toBe(false);
  });

  it("desktop paths (the native dialog) import the same way", async () => {
    const p = path.join(tmp, "MyFont.ttf");
    fs.writeFileSync(p, POPPINS);
    const r = await importFont(bundle, { kind: "path", paths: [p] }, deps(mockFetch({}).fetch));
    // a built-in family keeps its own files: the import gets its own name
    expect(r.font.family).toBe("Poppins (imported)");
  });
});

describe("import from the internet", () => {
  it("a direct font URL", async () => {
    const m = mockFetch({ "https://cdn.example.com/f/Caveat.ttf": { body: REG, type: "font/ttf" } });
    const r = await importFont(bundle, { kind: "url", url: "https://cdn.example.com/f/Caveat.ttf" }, deps(m.fetch));
    expect(r.font.family).toBe("Caveat (imported)");
    expect(r.font.source).toEqual({ kind: "url", url: "https://cdn.example.com/f/Caveat.ttf" });
  });

  it("a CSS @font-face URL: the regular and bold faces it names are fetched", async () => {
    const css = `@font-face{font-family:"Shop Hand";font-weight:400;src:url(hand-400.ttf) format("truetype")}
@font-face{font-family:"Shop Hand";font-weight:700;src:url(/fonts/hand-700.ttf) format("truetype")}`;
    const m = mockFetch({
      "https://shop.example.com/css/fonts.css": { body: css, type: "text/css" },
      "https://shop.example.com/css/hand-400.ttf": { body: REG },
      "https://shop.example.com/fonts/hand-700.ttf": { body: BOLD },
    });
    const r = await importFont(bundle, { kind: "url", url: "https://shop.example.com/css/fonts.css" }, deps(m.fetch));
    expect(r.font.family).toBe("Shop Hand");
    expect(r.weights.sort()).toEqual([400, 700]);
    expect(m.calls.map((c) => c.url)).toEqual(["https://shop.example.com/css/fonts.css", "https://shop.example.com/css/hand-400.ttf", "https://shop.example.com/fonts/hand-700.ttf"]);
  });

  it("a URL that serves a web page is refused", async () => {
    const m = mockFetch({ "https://example.com/font.ttf": { body: "<!doctype html><title>Login</title>", type: "text/html" } });
    await expect(importFont(bundle, { kind: "url", url: "https://example.com/font.ttf" }, deps(m.fetch))).rejects.toThrow(/not a font file/);
    await expect(importFont(bundle, { kind: "url", url: "file:///etc/passwd" }, deps(m.fetch))).rejects.toThrow(/http/);
    await expect(importFont(bundle, { kind: "url", url: "https://example.com/missing.woff2" }, deps(m.fetch))).rejects.toThrow(/answered 404/);
  });

  it("Google Fonts: css2 for 400 + 700, then the files; the family keeps the name typed", async () => {
    const api = "https://fonts.googleapis.com/css2?family=Grand+Hand:wght@400;700&display=swap";
    const css = `@font-face { font-family: 'Grand Hand'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/grandhand/v1/r.ttf) format('truetype'); }
@font-face { font-family: 'Grand Hand'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/grandhand/v1/b.ttf) format('truetype'); }`;
    const m = mockFetch({ [api]: { body: css, type: "text/css" }, "https://fonts.gstatic.com/s/grandhand/v1/r.ttf": { body: REG }, "https://fonts.gstatic.com/s/grandhand/v1/b.ttf": { body: BOLD } });
    const r = await importFont(bundle, { kind: "google", family: "Grand Hand" }, deps(m.fetch));
    expect(r.font).toMatchObject({ family: "Grand Hand", source: { kind: "google", url: "https://fonts.google.com/specimen/Grand+Hand" } });
    expect(r.weights.sort()).toEqual([400, 700]);
    // asked with a non-browser user agent (Google then serves whole TrueType files, not unicode-range subsets)
    expect(m.calls[0]!.ua).toMatch(/^Lens\//);
  });

  it("Google Fonts: a single-weight family is asked again without 700; an unknown family says so", async () => {
    const one = "https://fonts.googleapis.com/css2?family=Solo:wght@400&display=swap";
    const m = mockFetch({
      "https://fonts.googleapis.com/css2?family=Solo:wght@400;700&display=swap": { body: "bad weight", status: 400 },
      [one]: { body: "@font-face { font-family: 'Solo'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/solo/r.ttf); }", type: "text/css" },
      "https://fonts.gstatic.com/s/solo/r.ttf": { body: REG },
    });
    const r = await importFont(bundle, { kind: "google", family: "Solo" }, deps(m.fetch));
    expect(r.font.regular).toBe(r.font.bold);
    const none = mockFetch({});
    await expect(importFont(bundle, { kind: "google", family: "Nope Sans" }, deps(none.fetch))).rejects.toThrow(/answered 404|no family/);
    const four = mockFetch(Object.fromEntries([[400, 700], [400], []].map((w) => [`https://fonts.googleapis.com/css2?family=Nope${w.length ? `:wght@${w.join(";")}` : ""}&display=swap`, { body: "x", status: 400 }])));
    await expect(importFont(bundle, { kind: "google", family: "Nope" }, deps(four.fetch))).rejects.toThrow(/Google Fonts has no family named "Nope"/);
  });
});

describe("library and missing files", () => {
  it("a library font is copied into another project; removing it deletes its files", async () => {
    await importFont(bundle, { kind: "file", files: [{ name: "a.ttf", data: b64(REG) }, { name: "b.ttf", data: b64(BOLD) }] }, deps(mockFetch({}).fetch));
    const other = path.join(tmp, "other");
    fs.mkdirSync(other);
    const r = await importFont(other, { kind: "library", family: "Caveat (imported)" }, deps(mockFetch({}).fetch));
    expect(fs.existsSync(path.join(other, r.font.regular))).toBe(true);
    expect(fs.existsSync(path.join(other, r.font.bold))).toBe(true);
    expect(removeFromLibrary(lib, "Caveat (imported)")).toBe(true);
    expect(listLibrary(lib)).toEqual([]);
    expect(fs.readdirSync(lib)).toEqual(["library.json"]);
    await expect(importFont(other, { kind: "library", family: "Caveat (imported)" }, deps(mockFetch({}).fetch))).rejects.toThrow(/not in your font library/);
  });

  it("missingFamilies names the fonts whose files do not resolve", () => {
    fs.mkdirSync(path.join(bundle, "fonts"));
    fs.writeFileSync(path.join(bundle, "fonts", "a.ttf"), REG);
    const resolve = (ref: string) => (fs.existsSync(path.join(bundle, ref)) ? path.join(bundle, ref) : null);
    expect(missingFamilies([{ family: "A", regular: "fonts/a.ttf", bold: "fonts/a.ttf" }, { family: "B", regular: "fonts/b.ttf", bold: "fonts/b.ttf" }], resolve)).toEqual(["B"]);
  });
});
