// Runs the packaged app's on-device job worker (resources/app.asar.unpacked/dist/jobWorker.cjs) with
// plain Node and the packaged models (resources/lens/assets/models), the way the app starts it, on a
// bundle: a privacy scan and step labels. Checks the staged layout (worker + tesseract.js unpacked,
// models found) without launching Electron. Usage: node check-staged-jobs.cjs <unpacked-app-dir> <bundle>
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const [appDir, bundle] = process.argv.slice(2).map((p) => path.resolve(p));
const res = path.join(appDir, "resources");
const worker = path.join(res, "app.asar.unpacked", "dist", "jobWorker.cjs");
const ffmpeg = path.join(res, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const env = { LENS_ROOT: path.join(res, "lens"), LENS_OCR_WORKERS: "1" };
const run = (req) => new Promise((resolve, reject) => {
  const w = new Worker(worker, { workerData: { ...req, ffmpeg, env } });
  w.on("message", (m) => (m.type === "done" ? resolve(m.result) : m.type === "error" ? reject(new Error(m.message)) : undefined));
  w.on("error", reject);
});
(async () => {
  const t0 = Date.now();
  const thumbs = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "lens-thumbs-"));
  const scan = await run({ kind: "scan", video: path.join(bundle, "screen.mp4"), events: path.join(bundle, "events.jsonl"), thumbs });
  const t1 = Date.now();
  const steps = await run({ kind: "steps", video: path.join(bundle, "screen.mp4"), events: path.join(bundle, "events.jsonl") });
  console.log(JSON.stringify({ scan: { detections: scan.detections.length, seconds: (t1 - t0) / 1000 }, steps: { drafts: steps.drafts.length, labels: steps.drafts.map((d) => d.label), seconds: (Date.now() - t1) / 1000 } }));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
