// Builds the desktop app into apps/desktop/dist: main.cjs, preload.cjs, renderer/ (esbuild).
// The editor it opens is apps/editor/dist (npm run build -w @lens/editor).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeIcons } from "./make-icon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "renderer"), { recursive: true });

const common = { bundle: true, sourcemap: "linked", logLevel: "warning", target: "es2022" };
await build({
  ...common,
  entryPoints: [path.join(ROOT, "src/main/main.ts")],
  outfile: path.join(DIST, "main.cjs"),
  platform: "node",
  format: "cjs",
  external: ["electron", "uiohook-napi", "electron-updater", "vite", "tesseract.js"],
  // the editor middleware (apps/editor/server/api.ts) is ESM and reads import.meta.url
  define: { "import.meta.url": "__lensMetaUrl" },
  banner: { js: 'const __lensMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
});
// on-device jobs (privacy scan, step labels; Windows #1) run on a worker thread: dist/jobWorker.cjs
await build({
  ...common,
  entryPoints: [path.join(ROOT, "..", "editor", "server", "jobWorker.ts")],
  outfile: path.join(DIST, "jobWorker.cjs"),
  platform: "node",
  format: "cjs",
  external: ["tesseract.js"],
  define: { "import.meta.url": "__lensMetaUrl" },
  banner: { js: 'const __lensMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
});
await build({ ...common, entryPoints: [path.join(ROOT, "src/preload.ts")], outfile: path.join(DIST, "preload.cjs"), platform: "node", format: "cjs", external: ["electron"] });
await build({ ...common, entryPoints: [path.join(ROOT, "src/renderer/recorder.ts")], outfile: path.join(DIST, "renderer/recorder.js"), platform: "browser", format: "iife" });
// app icon (window, tray; the .ico also goes into Lens.exe): dist/icons/lens.ico + lens-<n>.png
writeIcons(path.join(DIST, "icons"));
for (const f of ["recorder.html", "recorder.css", "region.html", "teleprompter.html", "settings.html"]) fs.copyFileSync(path.join(ROOT, "src/renderer", f), path.join(DIST, "renderer", f));
console.log("built", path.relative(process.cwd(), DIST));
