import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRenderPlan, defaultProject, type InputEvent, type RecordingMeta } from "@lens/engine";
import { presignUrl, sha256Hex, signHeaders, uriEncode, verifyHeaderSignature } from "../server/share/sigv4";
import { forgetShare, loadShare, objectTarget, publicConfig, redact, saveShare, setShareSecretCodec, slugify, validateSettings, DEFAULT_SETTINGS, type ShareSettings } from "../server/share/share";
import { clock, escapeHtml, viewerHtml } from "../server/share/viewer";
import { viewerChapters } from "../src/state/share";

// demand #13: share link with bring-your-own S3-compatible storage.
const CREDS = { accessKeyId: "LENSTESTAKID0001", secretAccessKey: "lens/Test+Secret=Key0001", region: "us-east-1" };
const NOW = new Date(Date.UTC(2026, 10, 11, 5, 30, 0));

describe("SigV4 signer against botocore 1.44.0 (S3SigV4Auth / S3SigV4QueryAuth, same inputs, fixed clock)", () => {
  it("path-style PUT with a space in the key", () => {
    const body = Buffer.from("hello lens");
    const h = signHeaders(CREDS, { method: "PUT", path: "/lens-bucket/shares/My%20Demo/video.mp4", headers: { host: "127.0.0.1:9000", "content-type": "video/mp4" }, payloadHash: sha256Hex(body) }, NOW);
    expect(h["x-amz-content-sha256"]).toBe("71b720eeb44097abd86c21f20d13b446c36ed149508705c2134c9c005f246179");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=LENSTESTAKID0001/20261111/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=2c1d90983b17b29c0fb213f6d5d6b82c6f84ea93533d64065ef73472b07dcc8d",
    );
  });
  it("virtual-host PUT to an R2-style endpoint, region auto", () => {
    const h = signHeaders({ ...CREDS, region: "auto" }, { method: "PUT", path: "/a/b~c/index.html", headers: { host: "lens-bucket.0123abcd.r2.cloudflarestorage.com", "content-type": "text/html; charset=utf-8" }, payloadHash: sha256Hex("<html></html>") }, NOW);
    expect(h.authorization).toMatch(/Signature=99bb8cb502f554e8a662ea5b93aa4d9c6edb72424824eaee61631496ef97c9f0$/);
  });
  it("presigned GET, 1 hour", () => {
    expect(presignUrl(CREDS, "http://127.0.0.1:9000", "127.0.0.1:9000", "/lens-bucket/shares/My%20Demo/index.html", 3600, NOW)).toBe(
      "http://127.0.0.1:9000/lens-bucket/shares/My%20Demo/index.html?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=LENSTESTAKID0001%2F20261111%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261111T053000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=b2627ab478282224e71419f9dfdf5197bad98654ee36793ea7a0e9c5f79b3527",
    );
  });
  it("the mock server's verifier accepts our signature and rejects a tampered one", () => {
    const h = signHeaders(CREDS, { method: "PUT", path: "/b/k", headers: { host: "x:1" }, payloadHash: sha256Hex("a") }, NOW);
    const sec = (id: string) => (id === CREDS.accessKeyId ? CREDS.secretAccessKey : undefined);
    expect(verifyHeaderSignature(sec, { method: "PUT", path: "/b/k", query: [], headers: h }).ok).toBe(true);
    expect(verifyHeaderSignature(sec, { method: "PUT", path: "/b/k2", query: [], headers: h }).ok).toBe(false);
    expect(verifyHeaderSignature(() => "wrong", { method: "PUT", path: "/b/k", query: [], headers: h }).ok).toBe(false);
  });
  it("uriEncode keeps unreserved characters and slashes in keys only", () => {
    expect(uriEncode("a b/ü~-_.")).toBe("a%20b%2F%C3%BC~-_.");
    expect(uriEncode("a b/ü", true)).toBe("a%20b/%C3%BC");
  });
});

const S = (o: Partial<ShareSettings> = {}): ShareSettings => ({ ...DEFAULT_SETTINGS, provider: "custom", endpoint: "http://127.0.0.1:9000", region: "us-east-1", bucket: "lens-bucket", ...o });

describe("bucket addressing", () => {
  it("path-style, virtual-host and an endpoint with a path (Supabase)", () => {
    expect(objectTarget(S(), "lens/x y/video.mp4")).toMatchObject({ host: "127.0.0.1:9000", path: "/lens-bucket/lens/x%20y/video.mp4" });
    const v = objectTarget(S({ endpoint: "https://s3.eu-west-1.amazonaws.com", pathStyle: false }), "k/v.mp4");
    expect(v.host).toBe("lens-bucket.s3.eu-west-1.amazonaws.com");
    expect(v.url.toString()).toBe("https://lens-bucket.s3.eu-west-1.amazonaws.com/k/v.mp4");
    const sb = objectTarget(S({ endpoint: "https://abcd.supabase.co/storage/v1/s3", pathStyle: true }), "k/v.mp4");
    expect(sb.path).toBe("/storage/v1/s3/lens-bucket/k/v.mp4");
  });
  it("validates the settings", () => {
    expect(validateSettings(S())).toEqual([]);
    expect(validateSettings(S({ endpoint: "nope" })).join()).toMatch(/endpoint/);
    expect(validateSettings(S({ bucket: "" })).join()).toMatch(/bucket/);
    expect(validateSettings(S({ linkDays: 9 })).join()).toMatch(/1-7/);
  });
  it("slugs titles for object keys", () => {
    expect(slugify("Démo: Lens / v0.1.5!")).toBe("demo-lens-v0-1-5");
    expect(slugify("???")).toBe("recording");
  });
});

describe("credential storage", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-share-"));
    process.env.LENS_SHARE_CONFIG = path.join(dir, "share.json");
    setShareSecretCodec(null);
  });
  afterEach(() => {
    delete process.env.LENS_SHARE_CONFIG;
    setShareSecretCodec(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("local file is 0600, the page sees only the last 4 key characters, blank keys keep the saved ones", () => {
    saveShare(S(), { accessKeyId: "AKIDLOCAL1234", secretAccessKey: "SECRETLOCAL5678" });
    const file = process.env.LENS_SHARE_CONFIG!;
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const pub = JSON.stringify(publicConfig());
    expect(pub).not.toContain("SECRETLOCAL5678");
    expect(pub).not.toContain("AKIDLOCAL1234");
    expect(publicConfig()).toMatchObject({ configured: true, keyHint: "…1234", hasSecret: true, storage: { kind: "local-file" } });
    saveShare(S({ prefix: "other" }), { accessKeyId: "", secretAccessKey: "" });
    expect(loadShare()!.keys).toEqual({ accessKeyId: "AKIDLOCAL1234", secretAccessKey: "SECRETLOCAL5678" });
    expect(loadShare()!.settings.prefix).toBe("other");
    forgetShare();
    expect(fs.existsSync(file)).toBe(false);
    expect(publicConfig()).toMatchObject({ configured: false });
  });

  it("with a codec (desktop safeStorage) the keys are not in the file in clear", () => {
    const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
    setShareSecretCodec({ kind: "test-codec", encrypt: (s) => xor(Buffer.from(s)), decrypt: (b) => xor(b).toString() });
    saveShare(S(), { accessKeyId: "AKIDKEYCHAIN99", secretAccessKey: "SECRETKEYCHAIN77" });
    const raw = fs.readFileSync(process.env.LENS_SHARE_CONFIG!, "utf8");
    expect(raw).not.toContain("AKIDKEYCHAIN99");
    expect(raw).not.toContain("SECRETKEYCHAIN77");
    expect(loadShare()!.keys!.secretAccessKey).toBe("SECRETKEYCHAIN77");
    expect(publicConfig()).toMatchObject({ storage: { kind: "os-keychain" } });
    // the keychain is gone (another machine): the keys are reported unreadable, never guessed
    setShareSecretCodec(null);
    expect(publicConfig()).toMatchObject({ configured: false, keysUnreadable: true });
  });

  it("refuses to save without keys or with bad settings", () => {
    expect(() => saveShare(S(), { accessKeyId: "a" })).toThrow(/required/);
    expect(() => saveShare(S({ endpoint: "x" }), { accessKeyId: "a", secretAccessKey: "b" })).toThrow(/endpoint/);
  });

  it("redact strips keys, signatures and credentials from storage error text", () => {
    const k = { accessKeyId: "AKIDLEAK0001", secretAccessKey: "SECRETLEAK0002" };
    const m = redact("SignatureDoesNotMatch AWSAccessKeyId AKIDLEAK0001 key SECRETLEAK0002 Credential=AKIDLEAK0001/2026 Signature=" + "a".repeat(64), k);
    expect(m).not.toContain("AKIDLEAK0001");
    expect(m).not.toContain("SECRETLEAK0002");
    expect(m).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("viewer page", () => {
  const base = { title: "Demo <b>&</b>", videoUrl: "video.mp4", posterUrl: "poster.jpg", width: 1280, height: 720, durationSec: 75, createdAt: "2026-11-11T00:00:00Z" };
  it("escapes the title, has the video with poster and no external requests", () => {
    const h = viewerHtml({ ...base, chapters: [] });
    expect(h).toContain("<title>Demo &lt;b&gt;&amp;&lt;/b&gt;</title>");
    expect(h).toMatch(/<video id="v" controls playsinline preload="metadata" poster="poster.jpg" src="video.mp4">/);
    expect(h).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
    expect(h).not.toContain("Chapters</h2>");
  });
  it("lists chapters in order with clickable times, dropping ones past the end", () => {
    const h = viewerHtml({ ...base, chapters: [{ t: 30.5, title: "Second" }, { t: 0, title: "Intro" }, { t: 80, title: "Past end" }] });
    expect(h.indexOf("Intro")).toBeLessThan(h.indexOf("Second"));
    expect(h).toContain('data-t="30.500"');
    expect(h).toContain(">0:30<");
    expect(h).not.toContain("Past end");
    expect(clock(3725)).toBe("1:02:05");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });
});

describe("viewerChapters (project.chapters, recording clock -> output clock)", () => {
  const META: RecordingMeta = { width: 1280, height: 720, fps: 30, durationMs: 10000, pixelRatio: 1 };
  const EV: InputEvent[] = [{ t: 0, type: "move", x: 10, y: 10 }];
  it("maps through cuts and skips chapters without a title", () => {
    const p = defaultProject();
    const project = { ...p, output: { ...p.output, fps: 30 }, edits: { ...p.edits, cuts: [{ startMs: 2000, endMs: 4000 }] } };
    const plan = buildRenderPlan({ meta: META, events: EV, project });
    const ch = viewerChapters({ ...project, chapters: { items: [{ srcMs: 0, title: "Start" }, { srcMs: 5000, title: "After cut" }, { srcMs: 6000, title: " " }] } }, plan);
    expect(ch.map((c) => c.title)).toEqual(["Start", "After cut"]);
    expect(ch[0]!.t).toBe(0);
    expect(ch[1]!.t).toBeCloseTo(3, 1); // 5 s source - 2 s cut
    expect(viewerChapters(project, plan)).toEqual([]);
  });
});
