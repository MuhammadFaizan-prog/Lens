/**
 * AWS Signature Version 4 for S3-compatible storage (demand #13 share links): AWS S3, Cloudflare R2,
 * Supabase Storage's S3 endpoint, MinIO, ... Written from the published SigV4 algorithm (canonical
 * request -> string to sign -> HMAC-SHA256 key chain); no SDK. Header auth for uploads, query-string
 * presigning for private-bucket links.
 */
import crypto from "node:crypto";

export interface SigV4Creds {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const hmac = (k: crypto.BinaryLike, s: string) => crypto.createHmac("sha256", k).update(s, "utf8").digest();
export const sha256Hex = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

/** RFC 3986 encoding as SigV4 wants it (keep A-Z a-z 0-9 - _ . ~; "/" kept in object key paths). */
export function uriEncode(s: string, keepSlash = false): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** 20130524T000000Z */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request");
}

function canonicalQuery(q: Array<[string, string]>): string {
  return q
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export interface CanonicalParts {
  method: string;
  /** Already-encoded absolute path ("/bucket/key" or "/key"). */
  path: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  payloadHash: string;
}

export function canonicalRequest(p: CanonicalParts): { text: string; signedHeaders: string } {
  const h = Object.entries(p.headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const signedHeaders = h.map(([k]) => k).join(";");
  const text = [p.method, p.path, canonicalQuery(p.query), h.map(([k, v]) => `${k}:${v}\n`).join(""), signedHeaders, p.payloadHash].join("\n");
  return { text, signedHeaders };
}

/**
 * Header-signed request. Returns the headers to send (the given ones plus x-amz-date,
 * x-amz-content-sha256 and Authorization). `headers` must include host.
 */
export function signHeaders(
  c: SigV4Creds,
  req: { method: string; path: string; query?: Array<[string, string]>; headers: Record<string, string>; payloadHash: string },
  now = new Date(),
): Record<string, string> {
  const service = c.service ?? "s3";
  const t = amzDate(now);
  const date = t.slice(0, 8);
  const headers: Record<string, string> = { ...req.headers, "x-amz-date": t };
  if (service === "s3") headers["x-amz-content-sha256"] = req.payloadHash;
  const { text, signedHeaders } = canonicalRequest({ method: req.method, path: req.path, query: req.query ?? [], headers, payloadHash: req.payloadHash });
  const scope = `${date}/${c.region}/${service}/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", t, scope, sha256Hex(text)].join("\n");
  const sig = crypto.createHmac("sha256", signingKey(c.secretAccessKey, date, c.region, service)).update(sts, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return headers;
}

/** Query-string presigned GET URL (max 7 days on AWS). `base` = scheme://host, `path` already encoded. */
export function presignUrl(c: SigV4Creds, base: string, host: string, path: string, expiresSec: number, now = new Date()): string {
  const service = c.service ?? "s3";
  const t = amzDate(now);
  const date = t.slice(0, 8);
  const scope = `${date}/${c.region}/${service}/aws4_request`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${c.accessKeyId}/${scope}`],
    ["X-Amz-Date", t],
    ["X-Amz-Expires", String(Math.max(1, Math.min(604800, Math.round(expiresSec))))],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const { text } = canonicalRequest({ method: "GET", path, query, headers: { host }, payloadHash: "UNSIGNED-PAYLOAD" });
  const sts = ["AWS4-HMAC-SHA256", t, scope, sha256Hex(text)].join("\n");
  const sig = crypto.createHmac("sha256", signingKey(c.secretAccessKey, date, c.region, service)).update(sts, "utf8").digest("hex");
  return `${base}${path}?${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}

/**
 * Verify a header-signed request (used by the test mock S3 server, never by the app). Recomputes the
 * signature from the request's own signed headers.
 */
export function verifyHeaderSignature(
  secretFor: (accessKeyId: string) => string | undefined,
  req: { method: string; path: string; query: Array<[string, string]>; headers: Record<string, string | string[] | undefined> },
): { ok: boolean; accessKeyId?: string; reason?: string } {
  const auth = String(req.headers.authorization ?? "");
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return { ok: false, reason: "no SigV4 Authorization header" };
  const [, akid, date, region, service, signed, sig] = m as unknown as string[];
  const secret = secretFor(akid!);
  if (!secret) return { ok: false, reason: "unknown access key" };
  const t = String(req.headers["x-amz-date"] ?? "");
  const headers: Record<string, string> = {};
  for (const k of signed!.split(";")) headers[k] = String(req.headers[k] ?? "");
  const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "UNSIGNED-PAYLOAD");
  const { text } = canonicalRequest({ method: req.method, path: req.path, query: req.query, headers, payloadHash });
  const sts = ["AWS4-HMAC-SHA256", t, `${date}/${region}/${service}/aws4_request`, sha256Hex(text)].join("\n");
  const want = crypto.createHmac("sha256", signingKey(secret, date!, region!, service!)).update(sts, "utf8").digest("hex");
  const ok = want.length === sig!.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig!));
  return ok ? { ok, accessKeyId: akid } : { ok, reason: "signature mismatch" };
}
