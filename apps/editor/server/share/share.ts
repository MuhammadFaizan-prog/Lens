/**
 * Share link with bring-your-own storage (demand #13). The user points Lens at an S3-compatible bucket
 * (AWS S3, Cloudflare R2, Supabase Storage's S3 endpoint, MinIO, ...); Share uploads the export, a
 * poster frame and a static viewer page with SigV4-signed PUTs and hands back a link.
 *
 * Credentials: kept by this server only, never sent back to the page, never written into a project
 * and never logged (every error that leaves this module is passed through redact()). On the desktop
 * the access keys are encrypted with Electron safeStorage (the OS keychain / DPAPI) through
 * setShareSecretCodec(); elsewhere they sit in a local config file created 0600.
 */
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { EMPTY_SHA256, presignUrl, sha256Hex, signHeaders, uriEncode, type SigV4Creds } from "./sigv4";
import { viewerHtml, type ViewerChapter } from "./viewer";

export type ShareProvider = "s3" | "r2" | "supabase" | "custom";

/** Everything but the keys: safe to show in the UI. */
export interface ShareSettings {
  provider: ShareProvider;
  /** https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, https://<ref>.supabase.co/storage/v1/s3, http://127.0.0.1:9000 */
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix for every share ("lens" -> lens/<slug>/index.html). */
  prefix: string;
  /** Public URL the bucket is served from (r2.dev / custom domain / Supabase public URL). Empty = presigned links. */
  publicBaseUrl: string;
  /** Path-style addressing (endpoint/bucket/key) instead of bucket.endpoint/key. */
  pathStyle: boolean;
  /** Presigned link lifetime when there is no public URL, days (1..7). */
  linkDays: number;
}

export interface ShareKeys {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Encrypts the keys at rest (desktop: Electron safeStorage). */
export interface SecretCodec {
  kind: string;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

let codec: SecretCodec | null = null;
let configPathOverride: string | null = null;

/** Desktop: encrypt keys with the OS keychain and keep the config in userData. */
export function setShareSecretCodec(c: SecretCodec | null, configPath?: string): void {
  codec = c;
  if (configPath) configPathOverride = configPath;
}

export function shareConfigPath(): string {
  return configPathOverride ?? process.env.LENS_SHARE_CONFIG ?? path.join(os.homedir(), ".lens", "share.json");
}

interface StoredConfig {
  version: 1;
  settings: ShareSettings;
  keys: { kind: "plain"; accessKeyId: string; secretAccessKey: string } | { kind: string; data: string };
}

export const DEFAULT_SETTINGS: ShareSettings = { provider: "r2", endpoint: "", region: "auto", bucket: "", prefix: "lens", publicBaseUrl: "", pathStyle: true, linkDays: 7 };

export function validateSettings(s: Partial<ShareSettings>): string[] {
  const e: string[] = [];
  if (!["s3", "r2", "supabase", "custom"].includes(String(s.provider))) e.push("unknown provider");
  let u: URL | null = null;
  try {
    u = new URL(String(s.endpoint));
  } catch {
    e.push("endpoint must be a URL (https://...)");
  }
  if (u && !/^https?:$/.test(u.protocol)) e.push("endpoint must be http(s)");
  if (!s.region || !/^[a-z0-9-]+$/.test(s.region)) e.push("region is required (e.g. us-east-1, or auto for R2)");
  if (!s.bucket || !/^[a-z0-9][a-z0-9.\-_]{1,62}$/i.test(s.bucket)) e.push("bucket name is required");
  if (s.publicBaseUrl) {
    try {
      const p = new URL(s.publicBaseUrl);
      if (!/^https?:$/.test(p.protocol)) e.push("public URL must be http(s)");
    } catch {
      e.push("public URL must be a URL");
    }
  }
  if (s.prefix && !/^[A-Za-z0-9!\-_.*'()/ ]*$/.test(s.prefix)) e.push("folder may only use letters, digits, spaces and - _ . / ( ) ! * '");
  if (!(Number(s.linkDays) >= 1 && Number(s.linkDays) <= 7)) e.push("link lifetime must be 1-7 days");
  return e;
}

function readStored(): StoredConfig | null {
  try {
    const j = JSON.parse(fs.readFileSync(shareConfigPath(), "utf8")) as StoredConfig;
    return j && j.version === 1 && j.settings ? j : null;
  } catch {
    return null;
  }
}

function keysOf(s: StoredConfig): ShareKeys | null {
  const k = s.keys as Record<string, string>;
  if (k.kind === "plain") return k.accessKeyId && k.secretAccessKey ? { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey } : null;
  if (!codec || codec.kind !== k.kind) return null;
  try {
    return JSON.parse(codec.decrypt(Buffer.from(k.data!, "base64"))) as ShareKeys;
  } catch {
    return null;
  }
}

export function loadShare(): { settings: ShareSettings; keys: ShareKeys | null } | null {
  const s = readStored();
  return s ? { settings: { ...DEFAULT_SETTINGS, ...s.settings }, keys: keysOf(s) } : null;
}

/** Where the keys live, for the UI. */
export function keyStorage(): { kind: "os-keychain" | "local-file"; path: string } {
  return { kind: codec ? "os-keychain" : "local-file", path: shareConfigPath() };
}

/** Save settings; keys are kept when the new ones are blank. */
export function saveShare(settings: ShareSettings, keys: Partial<ShareKeys>): void {
  const errs = validateSettings(settings);
  const prev = loadShare();
  const k: ShareKeys = {
    accessKeyId: keys.accessKeyId?.trim() || prev?.keys?.accessKeyId || "",
    secretAccessKey: keys.secretAccessKey?.trim() || prev?.keys?.secretAccessKey || "",
  };
  if (!k.accessKeyId || !k.secretAccessKey) errs.push("access key ID and secret are required");
  if (errs.length) throw new ShareError(errs.join("; "), 400);
  const clean: ShareSettings = {
    provider: settings.provider,
    endpoint: settings.endpoint.trim().replace(/\/+$/, ""),
    region: settings.region.trim(),
    bucket: settings.bucket.trim(),
    prefix: settings.prefix.trim().replace(/^\/+|\/+$/g, ""),
    publicBaseUrl: settings.publicBaseUrl.trim().replace(/\/+$/, ""),
    pathStyle: !!settings.pathStyle,
    linkDays: Math.round(Number(settings.linkDays)),
  };
  const stored: StoredConfig = {
    version: 1,
    settings: clean,
    keys: codec ? { kind: codec.kind, data: codec.encrypt(JSON.stringify(k)).toString("base64") } : { kind: "plain", ...k },
  };
  const file = shareConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: ACLs of the user profile folder apply
  }
}

export function forgetShare(): void {
  fs.rmSync(shareConfigPath(), { force: true });
}

/** The config as the page may see it: no secret, the key ID shortened to its last 4 characters. */
export function publicConfig(): Record<string, unknown> {
  const c = loadShare();
  return {
    configured: !!(c && c.keys),
    settings: c?.settings ?? DEFAULT_SETTINGS,
    keyHint: c?.keys ? `…${c.keys.accessKeyId.slice(-4)}` : null,
    hasSecret: !!c?.keys?.secretAccessKey,
    keysUnreadable: !!(c && !c.keys),
    storage: keyStorage(),
  };
}

export class ShareError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

/** Remove any key material from a message (S3 errors echo the access key ID; never trust them). */
export function redact(msg: string, keys: ShareKeys | null | undefined): string {
  let out = msg;
  for (const s of [keys?.secretAccessKey, keys?.accessKeyId]) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out.replace(/(Signature=)[0-9a-f]{64}/gi, "$1[redacted]").replace(/(X-Amz-Credential=)[^&\s"]+/gi, "$1[redacted]").replace(/(Credential=)[^,\s/]+/g, "$1[redacted]");
}

// ---------------------------------------------------------------- S3 requests

interface Target {
  url: URL;
  host: string;
  /** Encoded path to sign. */
  path: string;
}

export function objectTarget(s: ShareSettings, key: string): Target {
  const ep = new URL(s.endpoint);
  const base = ep.pathname.replace(/\/+$/, "");
  const enc = uriEncode(key, true);
  if (s.pathStyle) {
    const p = `${base}/${uriEncode(s.bucket)}/${enc}`;
    return { url: new URL(`${ep.protocol}//${ep.host}${p}`), host: ep.host, path: p };
  }
  const host = `${s.bucket}.${ep.host}`;
  const p = `${base}/${enc}`;
  return { url: new URL(`${ep.protocol}//${host}${p}`), host, path: p };
}

function creds(s: ShareSettings, k: ShareKeys): SigV4Creds {
  return { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, region: s.region, service: "s3" };
}

/** One signed request. body: Buffer, or a file streamed with its sha256 already known. */
function s3Request(
  s: ShareSettings,
  k: ShareKeys,
  method: "PUT" | "DELETE" | "GET" | "HEAD",
  key: string,
  body: { buf?: Buffer; file?: string; size?: number; sha256?: string },
  extra: Record<string, string> = {},
  onBytes?: (n: number) => void,
): Promise<{ status: number; body: string }> {
  const t = objectTarget(s, key);
  const len = body.buf ? body.buf.length : body.file ? body.size! : 0;
  const payloadHash = body.buf ? sha256Hex(body.buf) : body.file ? body.sha256! : EMPTY_SHA256;
  const headers = signHeaders(creds(s, k), { method, path: t.path, headers: { host: t.host, ...extra, ...(method === "PUT" ? { "content-length": String(len) } : {}) }, payloadHash });
  const mod = t.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({ method, hostname: t.url.hostname, port: t.url.port || undefined, path: t.path, headers, timeout: 120_000 }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (b.length < 16384 ? (b += c) : undefined));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("timeout", () => req.destroy(new Error("storage request timed out")));
    req.on("error", (e) => reject(new ShareError(`storage unreachable: ${redact((e as Error).message, k)}`, 502)));
    if (body.buf) req.end(body.buf);
    else if (body.file) {
      const rs = fs.createReadStream(body.file);
      rs.on("data", (c) => onBytes?.((c as Buffer).length));
      rs.on("error", (e) => req.destroy(e));
      rs.pipe(req);
    } else req.end();
  });
}

function s3Fail(what: string, r: { status: number; body: string }, k: ShareKeys): ShareError {
  const code = /<Code>([^<]*)<\/Code>/.exec(r.body)?.[1];
  const msg = /<Message>([^<]*)<\/Message>/.exec(r.body)?.[1];
  const hint =
    r.status === 403 ? " (check the access key, its permissions on the bucket, and the region)" : r.status === 404 ? " (check the bucket name, endpoint and path-style setting)" : "";
  return new ShareError(redact(`${what}: storage answered ${r.status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}${hint}`, k), 502);
}

function needConfig(): { settings: ShareSettings; keys: ShareKeys } {
  const c = loadShare();
  if (!c) throw new ShareError("Share storage is not set up yet", 400);
  if (!c.keys) throw new ShareError("Saved storage keys could not be read on this machine: enter them again", 400);
  return { settings: c.settings, keys: c.keys };
}

/** Put and delete a small object: proves endpoint, bucket, keys and write permission. */
export async function testShare(): Promise<{ ok: true; key: string }> {
  const { settings, keys } = needConfig();
  const key = `${settings.prefix ? settings.prefix + "/" : ""}.lens-check-${crypto.randomBytes(4).toString("hex")}`;
  const put = await s3Request(settings, keys, "PUT", key, { buf: Buffer.from("lens share check\n") }, { "content-type": "text/plain" });
  if (put.status < 200 || put.status >= 300) throw s3Fail("Test upload failed", put, keys);
  const del = await s3Request(settings, keys, "DELETE", key, {});
  if (del.status >= 300 && del.status !== 404) throw s3Fail("Test delete failed", del, keys);
  return { ok: true, key };
}

// ---------------------------------------------------------------- upload jobs

export interface ShareJob {
  id: string;
  /** The export that was shared (.lens-export/<exportId>/export.mp4). */
  exportId: string;
  state: "running" | "done" | "error";
  stage: string;
  sent: number;
  total: number;
  url?: string;
  keys?: { video: string; poster: string; page: string };
  sha256?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ShareJob>();
export const shareJob = (id: string) => jobs.get(id);

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "recording";
}

function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function probeVideo(ffmpeg: string, file: string): { width: number; height: number; duration: number } {
  // ffmpeg -i prints the stream line and duration on stderr (no ffprobe shipped with the desktop app)
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const err = r.stderr ?? "";
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const v = /Video: .*?(\d{2,5})x(\d{2,5})/.exec(err);
  return { width: v ? Number(v[1]) : 1280, height: v ? Number(v[2]) : 720, duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0 };
}

function makePoster(ffmpeg: string, file: string, at: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-y", "-ss", at.toFixed(3), "-i", file, "-frames:v", "1", "-q:v", "3", out], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 && fs.existsSync(out) ? resolve() : reject(new ShareError(`poster frame failed: ${err.trim().slice(-300)}`))));
  });
}

export interface ShareRequest {
  /** The finished export (bundle/.lens-export/<exportId>/export.mp4). */
  exportFile: string;
  title: string;
  chapters: ViewerChapter[];
  ffmpeg: string;
}

export function startShare(r: ShareRequest): ShareJob {
  const { settings, keys } = needConfig();
  if (!fs.existsSync(r.exportFile)) throw new ShareError("Export the video first: no finished export to share", 400);
  const job: ShareJob = { id: crypto.randomBytes(6).toString("hex"), exportId: path.basename(path.dirname(r.exportFile)), state: "running", stage: "preparing", sent: 0, total: fs.statSync(r.exportFile).size, startedAt: Date.now() };
  jobs.set(job.id, job);
  void (async () => {
    try {
      const sha = await fileSha256(r.exportFile);
      job.sha256 = sha;
      const info = probeVideo(r.ffmpeg, r.exportFile);
      const posterFile = path.join(path.dirname(r.exportFile), "poster.jpg");
      await makePoster(r.ffmpeg, r.exportFile, Math.min(1, info.duration * 0.1), posterFile);
      const poster = fs.readFileSync(posterFile);
      const dir = `${settings.prefix ? settings.prefix + "/" : ""}${slugify(r.title)}-${crypto.randomBytes(5).toString("hex")}`;
      const k = { video: `${dir}/video.mp4`, poster: `${dir}/poster.jpg`, page: `${dir}/index.html` };
      job.keys = k;
      job.total += poster.length;
      const cache = { "cache-control": "public, max-age=31536000, immutable" };
      job.stage = "uploading video";
      const v = await s3Request(settings, keys, "PUT", k.video, { file: r.exportFile, size: fs.statSync(r.exportFile).size, sha256: sha }, { "content-type": "video/mp4", ...cache }, (n) => (job.sent += n));
      if (v.status < 200 || v.status >= 300) throw s3Fail("Video upload failed", v, keys);
      job.stage = "uploading poster";
      const p = await s3Request(settings, keys, "PUT", k.poster, { buf: poster }, { "content-type": "image/jpeg", ...cache });
      if (p.status < 200 || p.status >= 300) throw s3Fail("Poster upload failed", p, keys);
      job.sent += poster.length;
      // public bucket: the page links its neighbours; private bucket: presigned URLs, same lifetime as the link
      const pub = settings.publicBaseUrl;
      const expires = settings.linkDays * 86400;
      const signed = (key: string) => {
        const t = objectTarget(settings, key);
        return presignUrl(creds(settings, keys), `${t.url.protocol}//${t.host}`, t.host, t.path, expires);
      };
      const html = viewerHtml({
        title: r.title,
        videoUrl: pub ? "video.mp4" : signed(k.video),
        posterUrl: pub ? "poster.jpg" : signed(k.poster),
        width: info.width,
        height: info.height,
        durationSec: info.duration,
        chapters: r.chapters,
        createdAt: new Date().toISOString(),
      });
      job.stage = "uploading page";
      const h = await s3Request(settings, keys, "PUT", k.page, { buf: Buffer.from(html, "utf8") }, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
      if (h.status < 200 || h.status >= 300) throw s3Fail("Viewer page upload failed", h, keys);
      job.url = pub ? `${pub}/${uriEncode(k.page, true)}` : signed(k.page);
      job.stage = "done";
      job.state = "done";
    } catch (e) {
      job.state = "error";
      job.error = redact(e instanceof Error ? e.message : String(e), keys);
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}
