// Windows build from Linux (docs/Desktop.md, docs/Releasing.md): stages the app with only what Windows
// needs (the editor build, ffmpeg.exe, DejaVu fonts, uiohook-napi's win32-x64 prebuild,
// electron-updater) and runs electron-builder for an unsigned NSIS installer (x64) that auto-updates
// from GitHub Releases. Output: out/desktop/ (git-ignored):
//   Lens-Setup-<version>.exe, Lens-Setup-<version>.exe.blockmap, latest.yml, win-unpacked/
// Run `npm run build -w @lens/editor` first (dist-win checks for apps/editor/dist).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { writeIcon } from "./make-icon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const REPO = path.resolve(DESKTOP, "..", "..");
const OUT = path.join(REPO, "out", "desktop");
const CACHE = path.join(REPO, "out", "desktop-cache");
const STAGE = path.join(CACHE, "stage");
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
const version = pkg.version;
const FFMPEG_URL = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64.gz";
const FFMPEG_LICENSE_URL = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/win32-x64.LICENSE";

const editorDist = path.join(REPO, "apps", "editor", "dist", "index.html");
if (!fs.existsSync(editorDist)) throw new Error("apps/editor/dist missing: run `npm run build -w @lens/editor` first");
if (!fs.existsSync(path.join(DESKTOP, "dist", "main.cjs"))) throw new Error("apps/desktop/dist missing: run `node scripts/build.mjs` first");

fs.mkdirSync(CACHE, { recursive: true });
const curl = (url, file) => execFileSync("curl", ["-sSfL", ...(process.env.SSL_CERT_FILE ? ["--cacert", process.env.SSL_CERT_FILE] : []), "-o", file, url], { stdio: "inherit" });

// ffmpeg for Windows (GPL build from the ffmpeg-static project, b6.0), cached on the workspace disk
const ffGz = path.join(CACHE, "ffmpeg-win32-x64.gz");
const ffExe = path.join(CACHE, "ffmpeg.exe");
if (!fs.existsSync(ffGz)) curl(FFMPEG_URL, ffGz);
if (!fs.existsSync(ffExe)) fs.writeFileSync(ffExe, zlib.gunzipSync(fs.readFileSync(ffGz)));
const ffLic = path.join(CACHE, "win32-x64.LICENSE");
if (!fs.existsSync(ffLic)) curl(FFMPEG_LICENSE_URL, ffLic);

// ---- stage
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(path.join(DESKTOP, "dist"), path.join(STAGE, "dist"), { recursive: true, filter: (f) => !f.endsWith(".map") });
// unpackaged runs of the staged app (the update test on Linux) read the feed from dev-app-update.yml
fs.copyFileSync(path.join(DESKTOP, "dev-app-update.yml"), path.join(STAGE, "dev-app-update.yml"));
const deps = { "electron-updater": pkg.dependencies["electron-updater"], "uiohook-napi": pkg.dependencies["uiohook-napi"] };
fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify({
  name: "lens", productName: "Lens", version, description: "Lens screen recorder with auto-zoom", author: "MuhammadFaizan-prog",
  license: "UNLICENSED", main: "dist/main.cjs", dependencies: deps,
}, null, 2));
// production deps from the registry, no install scripts (uiohook-napi ships its Windows prebuild)
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: STAGE, stdio: "inherit" });
const pre = path.join(STAGE, "node_modules", "uiohook-napi", "prebuilds");
for (const d of fs.readdirSync(pre)) if (d !== "win32-x64") fs.rmSync(path.join(pre, d), { recursive: true, force: true });
for (const d of ["libuiohook", "src", "build"]) fs.rmSync(path.join(STAGE, "node_modules", "uiohook-napi", d), { recursive: true, force: true });

// resources next to app.asar
const res = path.join(CACHE, "resources");
fs.rmSync(res, { recursive: true, force: true });
fs.mkdirSync(path.join(res, "ffmpeg"), { recursive: true });
fs.copyFileSync(ffExe, path.join(res, "ffmpeg", "ffmpeg.exe"));
fs.copyFileSync(ffLic, path.join(res, "ffmpeg", "LICENSE.txt"));
fs.mkdirSync(path.join(res, "fonts"), { recursive: true });
for (const f of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) fs.copyFileSync(path.join("/usr/share/fonts/truetype/dejavu", f), path.join(res, "fonts", f));
if (fs.existsSync("/usr/share/doc/fonts-dejavu-core/copyright")) fs.copyFileSync("/usr/share/doc/fonts-dejavu-core/copyright", path.join(res, "fonts", "LICENSE.txt"));
fs.cpSync(path.join(REPO, "apps", "editor", "dist"), path.join(res, "editor"), { recursive: true, filter: (f) => !f.endsWith(".map") });
if (fs.existsSync(path.join(REPO, "assets", "fonts"))) fs.cpSync(path.join(REPO, "assets", "fonts"), path.join(res, "lens", "assets", "fonts"), { recursive: true });

// installer and uninstaller share one icon: NSIS patches the uninstaller icon into the exe header
// when it writes the uninstaller, and the no-wine path (eb-nowine.cjs) reads the uninstaller out
// without that patch, so the two must be identical for the uninstaller's CRC to hold
const icon = path.join(CACHE, "lens.ico");
writeIcon(icon);
const config = {
  appId: "io.github.muhammadfaizanprog.lens",
  productName: "Lens",
  copyright: "MuhammadFaizan-prog",
  directories: { app: STAGE, output: OUT },
  files: ["dist/**", "package.json", "node_modules/**", "!dev-app-update.yml"],
  asarUnpack: ["node_modules/uiohook-napi/**"],
  extraResources: [
    { from: path.join(res, "ffmpeg"), to: "ffmpeg" },
    { from: path.join(res, "fonts"), to: "fonts" },
    { from: path.join(res, "editor"), to: "editor" },
    ...(fs.existsSync(path.join(res, "lens")) ? [{ from: path.join(res, "lens"), to: "lens" }] : []),
  ],
  npmRebuild: false,
  nodeGypRebuild: false,
  electronVersion: JSON.parse(fs.readFileSync(path.join(REPO, "node_modules", "electron", "package.json"), "utf8")).version,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    // unsigned: no signing, and no rcedit (needs wine); publisherName is deliberately not set so
    // electron-updater does not demand an Authenticode signature on updates
    signAndEditExecutable: false,
    artifactName: "Lens-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    differentialPackage: true,
    shortcutName: "Lens",
    installerIcon: icon,
    uninstallerIcon: icon,
    artifactName: "Lens-Setup-${version}.${ext}",
  },
  publish: [{ provider: "github", owner: "MuhammadFaizan-prog", repo: "Lens", releaseType: "release" }],
};
fs.writeFileSync(path.join(CACHE, "electron-builder.json"), JSON.stringify(config, null, 2));
// electron-builder's bundled Linux makensis is an x86-64 binary. On other hosts (arm64) or with
// USE_SYSTEM_MAKENSIS=1, point it at the system NSIS (apt install nsis): a folder laid out like its own
// download (linux/makensis + Stubs / Include / Contrib / Plugins / Bin), all from the system NSIS so the
// compiler and its stubs match.
let nsisDir = process.env.ELECTRON_BUILDER_NSIS_DIR ?? "";
const wantSystemNsis = (process.env.USE_SYSTEM_MAKENSIS && process.env.USE_SYSTEM_MAKENSIS !== "0") || (process.platform === "linux" && process.arch !== "x64");
if (!nsisDir && wantSystemNsis) {
  const sysMakensis = ["/usr/bin/makensis", "/usr/local/bin/makensis"].find((f) => fs.existsSync(f));
  const sysShare = ["/usr/share/nsis", "/usr/local/share/nsis"].find((d) => fs.existsSync(path.join(d, "Stubs")));
  if (!sysMakensis || !sysShare) throw new Error("system NSIS not found: apt install nsis (needed on non-x64 Linux)");
  nsisDir = path.join(CACHE, "nsis-system");
  fs.rmSync(nsisDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(nsisDir, "linux"), { recursive: true });
  for (const d of ["Stubs", "Include", "Contrib", "Plugins", "Bin"]) if (fs.existsSync(path.join(sysShare, d))) fs.symlinkSync(path.join(sysShare, d), path.join(nsisDir, d));
  // electron-builder also copies its elevate.exe helper from the NSIS folder into the app resources;
  // it ships in electron-builder's own NSIS download (nsis-3.0.4.1), not in NSIS itself
  const ebNsis = path.join(CACHE, "electron-builder", "nsis", "nsis-3.0.4.1");
  if (!fs.existsSync(path.join(ebNsis, "elevate.exe"))) {
    const z = path.join(CACHE, "nsis-3.0.4.1.7z");
    if (!fs.existsSync(z)) curl("https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z", z);
    const sevenZip = (await import("7zip-bin")).default.path7za;
    fs.mkdirSync(ebNsis, { recursive: true });
    execFileSync(sevenZip, ["x", "-y", `-o${ebNsis}`, z, "elevate.exe"], { stdio: "ignore" });
  }
  fs.copyFileSync(path.join(ebNsis, "elevate.exe"), path.join(nsisDir, "elevate.exe"));
  fs.writeFileSync(path.join(nsisDir, "linux", "makensis"), `#!/bin/sh\nexec ${sysMakensis} "$@"\n`, { mode: 0o755 });
  console.log(`using system NSIS: ${sysMakensis} (${execFileSync(sysMakensis, ["-VERSION"], { encoding: "utf8" }).trim()}), data ${sysShare}`);
}
const builder = path.join(REPO, "node_modules", ".bin", "electron-builder");
// without wine (non-x64 Linux, or no wine installed) run electron-builder through eb-nowine.cjs, which
// extracts the NSIS uninstaller instead of running the helper installer under wine
const hasWine = (() => { try { execFileSync("wine", ["--version"], { stdio: "ignore" }); return process.arch === "x64"; } catch { return false; } })();
const ebCmd = process.platform !== "win32" && !hasWine ? [process.execPath, [path.join(HERE, "eb-nowine.cjs")]] : [builder, []];
execFileSync(ebCmd[0], [...ebCmd[1], "--win", "--x64", "--config", path.join(CACHE, "electron-builder.json"), "--publish", "never"], {
  cwd: STAGE,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_BUILDER_CACHE: path.join(CACHE, "electron-builder"), electron_config_cache: path.join(CACHE, "electron"), ...(nsisDir ? { ELECTRON_BUILDER_NSIS_DIR: nsisDir } : {}) },
});
for (const f of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, f));
  if (st.isFile()) console.log(`${f}\t${(st.size / 1048576).toFixed(1)} MB`);
}
