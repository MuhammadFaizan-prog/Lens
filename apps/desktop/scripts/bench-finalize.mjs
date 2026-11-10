// Perf bench for the Stop-to-editor path (v0.1.3): times, on synthetic captures,
//   finalize  Recording.finalize (recording.webm [+ mic.webm] [+ cam.webm] -> screen.mp4, mic.wav, cam.mp4, project.json)
//   import    importVideo on a 60 s H.264 mp4 (remux path) and a 60 s VP9 webm (re-encode path)
//   editor    GET /api/bundle and the first frame (/api/frames/screen/0.jpg) on the 60 s camera bundle, cold cache
// It bundles the sources of any Lens checkout (--tree), so the same inputs can be timed on main and on a branch.
//
//   node apps/desktop/scripts/bench-finalize.mjs --inputs <dir> --out <file.json> [--tree <repo>] [--label x] [--runs 2] [--only finalize,import,editor] [--secs 10,60] [--work <scratch dir>] [--editor-work <dir>] [--cases f10,f10c,f60,f60c,imp-h264,imp-vp9,editor] [--keep]
//
// Inputs (see work/perf/gen-inputs.sh): screen{10,60}.webm (1080p60 H.264-in-WebM, ~15 Mbps), mic{10,60}.webm (Opus),
// cam{10,60}.webm (720p30), import-h264.mp4, import-vp9.webm. Uses LENS_FFMPEG or ffmpeg on PATH. Each case runs --runs
// times; the JSON keeps every run and the median. Heavy: take the shared lock (flock work/pkgtest.lock) around it.
import { build } from "esbuild";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const TREE = path.resolve(arg("tree", path.resolve(HERE, "..", "..", "..")));
const LABEL = arg("label", path.basename(TREE));
const RUNS = Number(arg("runs", "2"));
const INPUTS = path.resolve(arg("inputs", "inputs"));
const OUT = path.resolve(arg("out", `bench-${LABEL}.json`));
const ONLY = new Set(arg("only", "finalize,import,editor").split(","));
const SECS = arg("secs", "10,60").split(",").map(Number);
// --cases picks single cases (f10, f10c, f60, f60c, imp-h264, imp-vp9, editor) and merges them into an existing
// --out file, so a run the OOM killer took can be redone case by case (run-bench.sh does that)
const CASES = arg("cases", null)?.split(",") ?? null;
const want = (id) => !CASES || CASES.includes(id);
const WORK = path.resolve(arg("work", path.join(path.dirname(OUT), `run-${LABEL}`)));
// the editor bench writes the JPEG cache (~1 GB for a 1080p60 minute): --editor-work puts the bundle on another disk
const EDITOR_WORK = path.resolve(arg("editor-work", path.join(WORK, "editor")));
const FFMPEG = process.env.LENS_FFMPEG || "ffmpeg";

// ---- bundle the tree's finalize / import / editor-api sources (CJS, electron + packages external)
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const entry = path.join(WORK, "entry.ts");
fs.writeFileSync(entry, [
  `export { Recording } from ${JSON.stringify(path.join(TREE, "apps/desktop/src/main/recording.ts"))};`,
  `export { importVideo } from ${JSON.stringify(path.join(TREE, "apps/desktop/src/main/library.ts"))};`,
  `export { apiMiddleware } from ${JSON.stringify(path.join(TREE, "apps/editor/server/api.ts"))};`,
].join("\n"));
const bundle = path.join(WORK, "bench.cjs");
await build({
  entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "es2022", logLevel: "error",
  external: ["electron", "uiohook-napi", "electron-updater", "vite", "tesseract.js"],
  define: { "import.meta.url": "__lensMetaUrl" },
  banner: { js: 'const __lensMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  nodePaths: [path.join(TREE, "node_modules")],
});
// the desktop app's editor server environment (editorServer.ts): browser export, no ffprobe shipped
process.env.LENS_EXPORT = "browser";
process.env.LENS_TRANSLATE = "off";
process.env.LENS_ROOT = TREE;
process.env.LENS_FFMPEG = FFMPEG;
process.env.LENS_FFPROBE = process.env.LENS_FFPROBE ?? path.join(WORK, "no-ffprobe");
const mod = createRequire(import.meta.url)(bundle);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
const results = { label: LABEL, tree: TREE, ffmpeg: FFMPEG, host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, memMiB: Math.round(os.totalmem() / 2 ** 20) }, runs: RUNS, startedAt: new Date().toISOString(), cases: {} };
if (CASES && fs.existsSync(OUT)) Object.assign(results.cases, JSON.parse(fs.readFileSync(OUT, "utf8")).cases ?? {});
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const record = (name, runs) => {
  results.cases[name] = { runs, medianMs: median(runs.map((r) => r.ms)) };
  console.log(`[${LABEL}] ${name}: ${runs.map((r) => r.ms).join(", ")} ms -> median ${results.cases[name].medianMs}`);
  save();
};

// The sandbox this was written on is RAM-starved (OOM killer, ffmpeg exit null) and its workspace FS threw an
// EIO once: a run that fails is redone (at most twice) and the retry is recorded with the run.
async function retry(fn, what) {
  for (let a = 1; ; a++) {
    try {
      const r = await fn();
      if (a > 1) r.attempts = a;
      return r;
    } catch (e) {
      console.log(`[${LABEL}] ${what} attempt ${a} failed: ${String(e?.message ?? e).slice(0, 200)}`);
      if (a >= 3) throw e;
    }
  }
}

/** events.jsonl as start() would log it (bypassed here): header, 60 Hz cursor, a click every 5 s. */
function writeEvents(dir, sec) {
  const lines = [`# lens-events v1 ${JSON.stringify({ capture: { width: 1920, height: 1080 }, source: "screen", platform: process.platform, displayId: "0" })}`];
  for (let t = 0; t <= sec * 1000; t += 1000 / 60) {
    const x = Math.round(960 + 700 * Math.sin(t / 3000));
    const y = Math.round(540 + 400 * Math.cos(t / 4100));
    lines.push(JSON.stringify({ t: Math.round(t * 10) / 10, type: "move", x, y }));
    if (Math.round(t) % 5000 < 1000 / 60 && t > 0) {
      lines.push(JSON.stringify({ t: Math.round(t), type: "down", x, y, button: "left" }), JSON.stringify({ t: Math.round(t) + 80, type: "up", x, y, button: "left" }));
    }
  }
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");
}

// ---- finalize
async function finalizeOnce(sec, cam, i) {
  const root = path.join(WORK, `fin-${sec}-${cam ? "cam" : "nocam"}-${i}`);
  fs.mkdirSync(root, { recursive: true });
  const rec = new mod.Recording(root, null, null);
  // finalize only reads the raw captures: linked, not copied (the constructor opened recording.webm for writing)
  const link = (src, dst) => {
    fs.rmSync(path.join(rec.dir, dst), { force: true });
    fs.symlinkSync(path.join(INPUTS, src), path.join(rec.dir, dst));
  };
  link(`screen${sec}.webm`, "recording.webm");
  link(`mic${sec}.webm`, "mic.webm");
  if (cam) link(`cam${sec}.webm`, "cam.webm");
  writeEvents(rec.dir, sec);
  const t0v = 1_000_000;
  // the fields stopInput() / start() would have set (start() needs Electron's screen API)
  rec.info = {
    sourceId: "screen:0:0", sourceName: "bench", kind: "screen", displayId: "0", capture: { width: 1920, height: 1080 }, fps: 60, quality: "high",
    videoMime: "video/webm;codecs=h264", videoStart: t0v, mic: { mime: "audio/webm;codecs=opus", start: t0v + 12 },
    webcam: cam ? { mime: "video/webm;codecs=h264", start: t0v + 40 } : null, system: null, cursor: { requested: "never", reported: null, api: "getDisplayMedia" },
  };
  rec.stopEpoch = t0v + sec * 1000;
  const stages = [];
  const t = performance.now();
  const out = await rec.finalize(FFMPEG, (s) => stages.push([Math.round(performance.now() - t), s]));
  const ms = Math.round(performance.now() - t);
  return {
    ms, dir: out.dir, durationMs: out.durationMs, encoder: rec.finalizeInfo?.encoder ?? "libx264 (v0.1.2: fixed)", firstStageMs: stages[0]?.[0] ?? null, progressEvents: stages.length,
    screenBytes: size(path.join(out.dir, "screen.mp4")), camBytes: size(path.join(out.dir, "cam.mp4")), warnings: rec.warnings,
  };
}
let editorBundle = null;
if (ONLY.has("finalize")) {
  for (const sec of SECS) {
    for (const cam of [false, true]) {
      if (!want(`f${sec}${cam ? "c" : ""}`)) continue;
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const r = await retry(() => finalizeOnce(sec, cam, i), `finalize ${sec}s ${cam ? "cam" : "nocam"} #${i}`);
        runs.push(r);
        // keep only the last 60 s camera bundle (the editor bench opens it); the rest is ~100 MB a run
        if (!(sec === 60 && cam && i === RUNS - 1)) fs.rmSync(path.dirname(r.dir), { recursive: true, force: true });
        else {
          editorBundle = path.join(EDITOR_WORK, path.basename(r.dir));
          fs.rmSync(editorBundle, { recursive: true, force: true });
          fs.mkdirSync(EDITOR_WORK, { recursive: true });
          fs.cpSync(r.dir, editorBundle, { recursive: true, filter: (f) => !fs.lstatSync(f).isSymbolicLink() });
          fs.rmSync(path.dirname(r.dir), { recursive: true, force: true });
        }
      }
      record(`finalize ${sec}s ${cam ? "+camera" : "screen+mic"}`, runs);
    }
  }
}

// ---- import
if (ONLY.has("import")) {
  for (const [name, file, id] of [["import 60s h264 mp4", "import-h264.mp4", "imp-h264"], ["import 60s vp9 webm", "import-vp9.webm", "imp-vp9"]]) {
    if (!want(id)) continue;
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const root = path.join(WORK, `imp-${i}`);
      fs.mkdirSync(root, { recursive: true });
      runs.push(await retry(async () => {
        const t = performance.now();
        const r = await mod.importVideo(root, FFMPEG, path.join(INPUTS, file));
        const ms = Math.round(performance.now() - t);
        const dir = typeof r === "string" ? r : r.dir;
        const out = { ms, video: typeof r === "string" ? "encode (v0.1.2: always)" : r.video, screenBytes: size(path.join(dir, "screen.mp4")) };
        fs.rmSync(dir, { recursive: true, force: true });
        return out;
      }, `${name} #${i}`));
    }
    record(name, runs);
  }
}

// ---- editor: /api/bundle + first frame, cold (.lens-cache removed before each run)
if (ONLY.has("editor") && want("editor")) {
  // the bundle the f60c case left in --editor-work, or --bundle
  editorBundle ??= arg("bundle", null) ?? (fs.existsSync(EDITOR_WORK) ? fs.readdirSync(EDITOR_WORK).filter((d) => !d.includes("-open")).map((d) => path.join(EDITOR_WORK, d)).find((d) => fs.existsSync(path.join(d, "screen.mp4"))) ?? null : null);
  if (!editorBundle) throw new Error("editor bench needs the finalize 60s +camera bundle (or --bundle <dir>)");
  const api = mod.apiMiddleware();
  const server = http.createServer((req, res) => void api(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const bundleRuns = [];
  const frameRuns = [];
  const fullRuns = [];
  let attempt = 0;
  for (let i = 0; i < RUNS; i++) await retry(async () => {
    // a fresh folder per run: the editor server caches extraction / probe results per bundle path in memory,
    // so reopening the same folder in one process is not a cold open (a new recording always is a new folder)
    const dir = `${editorBundle}-open${i}-${attempt++}`;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    for (const f of fs.readdirSync(editorBundle)) {
      const src = path.join(editorBundle, f);
      if (!fs.statSync(src).isFile()) continue;
      try {
        fs.linkSync(src, path.join(dir, f));
      } catch {
        fs.copyFileSync(src, path.join(dir, f));
      }
    }
    if (!fs.existsSync(path.join(dir, "events.jsonl"))) writeEvents(dir, 60);
    const q = `dir=${encodeURIComponent(dir)}`;
    const t = performance.now();
    const b = await fetch(`${base}/api/bundle?${q}`);
    const bj = await b.json();
    const tb = Math.round(performance.now() - t);
    const f = await fetch(`${base}/api/frames/screen/0.jpg?${q}`);
    const fb = Buffer.from(await f.arrayBuffer());
    const tf = Math.round(performance.now() - t);
    if (b.status !== 200 || f.status !== 200 || fb.length < 1000) throw new Error(`editor bench: bundle ${b.status} frame ${f.status} (${fb.length} B) ${JSON.stringify(bj).slice(0, 300)}`);
    // the full JPEG pass (v0.1.2: before /api/bundle answers; v0.1.3: in the background) must end before the next run
    const done = [path.join(dir, ".lens-cache", "screen", ".done"), path.join(dir, ".lens-cache", "cam", ".done")];
    while (!done.every((d) => fs.existsSync(d))) {
      if (performance.now() - t > 900_000) throw new Error("frame cache pass did not finish in 15 min");
      await new Promise((r) => setTimeout(r, 100));
    }
    const tall = Math.round(performance.now() - t);
    bundleRuns.push({ ms: tb, frames: bj.screen?.frames, camFrames: bj.camera?.frames });
    frameRuns.push({ ms: tf, jpegBytes: fb.length });
    fullRuns.push({ ms: tall });
    fs.rmSync(dir, { recursive: true, force: true });
    return {};
  }, `editor #${i}`);
  server.close();
  record("editor /api/bundle (60s +camera, cold)", bundleRuns);
  record("editor first frame (from open)", frameRuns);
  record("editor all frames decoded (background)", fullRuns);
}
results.finishedAt = new Date().toISOString();
save();
// the editor bundle stays while an editor case is still to come (--cases runs)
if (!argv.includes("--keep")) for (const d of CASES && !CASES.includes("editor") ? [WORK] : [WORK, EDITOR_WORK]) fs.rmSync(d, { recursive: true, force: true });
console.log(`wrote ${OUT}`);
process.exit(0);
