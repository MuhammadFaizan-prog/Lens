/**
 * The bundled editor: a localhost HTTP server that serves the built apps/editor and runs the same
 * /api middleware as the editor's dev server (apps/editor/server/api.ts), with export switched to the
 * in-browser path (no Python in the desktop build).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { editorDist, ffmpegPath, fontDir, lensRoot } from "./paths";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".wasm": "application/wasm",
};

export interface EditorServer {
  port: number;
  urlFor(bundleDir: string): string;
  close(): void;
}

export async function startEditorServer(): Promise<EditorServer> {
  process.env.LENS_EXPORT = "browser";
  process.env.LENS_ROOT = lensRoot();
  process.env.LENS_FFMPEG = ffmpegPath();
  const fd = fontDir();
  if (fd) process.env.LENS_FONT_DIR = fd;
  // privacy scan / step labels off the main thread (Windows #1). The worker and tesseract.js are
  // unpacked from app.asar (worker_threads cannot start a script inside an asar archive).
  const worker = path.join(__dirname, "jobWorker.cjs").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (fs.existsSync(worker)) process.env.LENS_JOB_WORKER = worker;
  // after the environment is set: api.ts reads it at module load
  const { apiMiddleware } = await import("../../../editor/server/api");
  const api = apiMiddleware();
  const dist = editorDist();
  const server = http.createServer((req, res) => {
    void api(req, res, () => {
      const url = new URL(req.url ?? "/", "http://x");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/" || rel === "") rel = "/index.html";
      const file = path.resolve(dist, "." + rel);
      if (!file.startsWith(path.resolve(dist)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.statusCode = 404;
        return res.end("not found");
      }
      res.setHeader("content-type", MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
      fs.createReadStream(file).pipe(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    urlFor: (dir) => `http://127.0.0.1:${port}/?dir=${encodeURIComponent(dir)}`,
    close: () => server.close(),
  };
}
