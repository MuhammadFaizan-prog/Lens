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
  ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm",
};

export interface EditorServer {
  port: number;
  urlFor(bundleDir: string): string;
  close(): void;
}

export async function startEditorServer(): Promise<EditorServer> {
  process.env.LENS_EXPORT = "browser";
  // caption translation needs Python + models the app does not ship (Windows #1b): shown as unavailable
  process.env.LENS_TRANSLATE = "off";
  process.env.LENS_ROOT = lensRoot();
  process.env.LENS_FFMPEG = ffmpegPath();
  const fd = fontDir();
  if (fd) process.env.LENS_FONT_DIR = fd;
  // imported caption fonts ("My fonts", Windows v0.1.3): a library in userData, shared by every project
  if (!process.env.LENS_FONT_LIBRARY) {
    try {
      const { app } = await import("electron");
      process.env.LENS_FONT_LIBRARY = path.join(app.getPath("userData"), "fonts");
    } catch {
      // not in Electron (tests): api.ts falls back to ~/.lens/fonts
    }
  }
  // share links (demand #13): storage keys encrypted with the OS keychain (safeStorage: Keychain on
  // macOS, DPAPI on Windows, libsecret / kwallet on Linux) in userData, never in a project
  try {
    const { app, safeStorage } = await import("electron");
    const { setShareSecretCodec } = await import("../../../editor/server/share/share");
    const file = path.join(app.getPath("userData"), "share-storage.json");
    if (safeStorage.isEncryptionAvailable())
      setShareSecretCodec({ kind: "electron-safeStorage", encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) }, file);
    else setShareSecretCodec(null, file);
  } catch {
    // not in Electron (tests): ~/.lens/share.json, 0600
  }
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
