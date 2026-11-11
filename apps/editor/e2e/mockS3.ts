/**
 * A small S3-compatible server for the share-link e2e (demand #13): path-style PUT / GET / HEAD /
 * DELETE on one bucket, objects in memory. Every write must carry a valid SigV4 header signature for
 * the test's key pair and an x-amz-content-sha256 that matches the body it actually received (checked
 * here with node:crypto, independently of the app). GET is anonymous while the bucket is "public";
 * otherwise it needs a valid presigned query. Range requests are served (video seeking).
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalRequest, sha256Hex, signingKey } from "../server/share/sigv4";
import { verifyHeaderSignature } from "../server/share/sigv4";

export interface MockObject {
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
}

export interface MockRequest {
  method: string;
  path: string;
  status: number;
  signed: "header" | "presigned" | "none";
  reason?: string;
}

export interface MockS3 {
  url: string;
  port: number;
  bucket: string;
  objects: Map<string, MockObject>;
  log: MockRequest[];
  setPublic(v: boolean): void;
  close(): Promise<void>;
}

function verifyPresigned(secretFor: (id: string) => string | undefined, path: string, q: URLSearchParams, host: string): { ok: boolean; reason?: string } {
  const sig = q.get("X-Amz-Signature");
  const cred = q.get("X-Amz-Credential");
  const t = q.get("X-Amz-Date");
  const exp = Number(q.get("X-Amz-Expires"));
  if (!sig || !cred || !t || !Number.isFinite(exp)) return { ok: false, reason: "not presigned" };
  const [akid, date, region, service] = cred.split("/");
  const secret = secretFor(akid!);
  if (!secret) return { ok: false, reason: "unknown access key" };
  const start = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15));
  if (Date.now() > start + exp * 1000) return { ok: false, reason: "expired" };
  const query: Array<[string, string]> = [];
  q.forEach((v, k) => k !== "X-Amz-Signature" && query.push([k, v]));
  const { text } = canonicalRequest({ method: "GET", path, query, headers: { host }, payloadHash: "UNSIGNED-PAYLOAD" });
  const sts = ["AWS4-HMAC-SHA256", t, `${date}/${region}/${service}/aws4_request`, sha256Hex(text)].join("\n");
  const want = crypto.createHmac("sha256", signingKey(secret, date!, region!, service!)).update(sts).digest("hex");
  return want === sig ? { ok: true } : { ok: false, reason: "presigned signature mismatch" };
}

export async function startMockS3(bucket: string, keys: { accessKeyId: string; secretAccessKey: string }): Promise<MockS3> {
  const objects = new Map<string, MockObject>();
  const log: MockRequest[] = [];
  let pub = true;
  const secretFor = (id: string) => (id === keys.accessKeyId ? keys.secretAccessKey : undefined);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const rawPath = (req.url ?? "/").split("?")[0]!;
    const m = new RegExp(`^/${bucket}/(.+)$`).exec(rawPath);
    const done = (status: number, signed: MockRequest["signed"], reason?: string, body?: Buffer | string, headers: Record<string, string> = {}) => {
      log.push({ method: req.method ?? "", path: rawPath, status, signed, reason });
      res.writeHead(status, { "access-control-allow-origin": "*", ...headers });
      res.end(body ?? (status >= 300 ? `<?xml version="1.0"?><Error><Code>${reason ?? "Error"}</Code><Message>${reason ?? ""}</Message></Error>` : ""));
    };
    if (!m) return done(404, "none", "NoSuchBucket");
    const key = decodeURIComponent(m[1]!);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method === "PUT" || req.method === "DELETE") {
        const query: Array<[string, string]> = [];
        u.searchParams.forEach((v, k) => query.push([k, v]));
        const v = verifyHeaderSignature(secretFor, { method: req.method, path: rawPath, query, headers: req.headers });
        if (!v.ok) return done(403, "header", v.reason ?? "SignatureDoesNotMatch");
        if (req.method === "DELETE") {
          objects.delete(key);
          return done(204, "header");
        }
        const claimed = String(req.headers["x-amz-content-sha256"] ?? "");
        if (claimed !== crypto.createHash("sha256").update(body).digest("hex")) return done(400, "header", "XAmzContentSHA256Mismatch");
        if (Number(req.headers["content-length"]) !== body.length) return done(400, "header", "IncompleteBody");
        const headers: Record<string, string> = {};
        for (const h of ["cache-control"]) if (req.headers[h]) headers[h] = String(req.headers[h]);
        objects.set(key, { body, contentType: String(req.headers["content-type"] ?? "application/octet-stream"), headers });
        return done(200, "header", undefined, "", { etag: `"${crypto.createHash("md5").update(body).digest("hex")}"` });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        let signed: MockRequest["signed"] = "none";
        if (u.searchParams.has("X-Amz-Signature")) {
          const v = verifyPresigned(secretFor, rawPath, u.searchParams, String(req.headers.host));
          if (!v.ok) return done(403, "presigned", v.reason);
          signed = "presigned";
        } else if (!pub) return done(403, "none", "AccessDenied");
        const o = objects.get(key);
        if (!o) return done(404, signed, "NoSuchKey");
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
        const base = { "content-type": o.contentType, "accept-ranges": "bytes", ...o.headers };
        if (range) {
          const size = o.body.length;
          let a = range[1] ? Number(range[1]) : size - Number(range[2]);
          let b = range[1] && range[2] ? Number(range[2]) : size - 1;
          a = Math.max(0, a);
          b = Math.min(size - 1, b);
          if (a > b) return done(416, signed, "InvalidRange");
          const part = o.body.subarray(a, b + 1);
          return done(206, signed, undefined, req.method === "HEAD" ? "" : part, { ...base, "content-length": String(part.length), "content-range": `bytes ${a}-${b}/${size}` });
        }
        return done(200, signed, undefined, req.method === "HEAD" ? "" : o.body, { ...base, "content-length": String(o.body.length) });
      }
      return done(405, "none", "MethodNotAllowed");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    bucket,
    objects,
    log,
    setPublic: (v) => (pub = v),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
