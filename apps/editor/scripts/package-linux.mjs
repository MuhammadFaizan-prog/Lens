#!/usr/bin/env node
/**
 * Packaged-app build for the editor UX e2e (Windows bugs #2-#20 are verified against the PACKAGED app):
 * an unpacked Linux electron-builder app laid out like the Windows installer (app.asar with the desktop
 * main, resources/editor = this editor build, resources/ffmpeg, resources/fonts, resources/lens/assets),
 * so app.isPackaged is true and the editor is served exactly as in Lens.exe.
 * Builds apps/desktop/dist and apps/editor/dist first unless --no-build. Output (outside git):
 *   $LENS_PKG_OUT (default <repo>/../editor-ux-pkg)/linux-<arch>-unpacked/lens
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.resolve(HERE, "..");
const REPO = path.resolve(EDITOR, "..", "..");
const DESKTOP = path.join(REPO, "apps", "desktop");
const OUT = path.resolve(process.env.LENS_PKG_OUT ?? path.join(REPO, "..", "editor-ux-pkg"));
const STAGE = path.join(OUT, "stage");
const RES = path.join(OUT, "resources");
const run = (cmd, args, cwd, extra = {}) => execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=700", ...extra } });

if (!process.argv.includes("--no-build")) {
  run("node", ["scripts/build.mjs"], DESKTOP);
  run(path.join(REPO, "node_modules", ".bin", "vite"), ["build", "--logLevel", "warn"], EDITOR);
}
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(path.join(DESKTOP, "dist"), path.join(STAGE, "dist"), { recursive: true, filter: (f) => !f.endsWith(".map") });
fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify({ name: "lens", productName: "Lens", version: pkg.version, description: "Lens", author: "MuhammadFaizan-prog", license: "UNLICENSED", main: "dist/main.cjs", dependencies: { "electron-updater": pkg.dependencies["electron-updater"], "uiohook-napi": pkg.dependencies["uiohook-napi"] } }, null, 2));
// production deps: reuse a staged set when one exists on this box (offline), else install from the registry
const cached = process.env.LENS_PKG_NODE_MODULES;
if (cached && fs.existsSync(cached)) fs.cpSync(cached, path.join(STAGE, "node_modules"), { recursive: true });
else run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], STAGE);
const localHook = path.join(REPO, "node_modules", "uiohook-napi", "build", "Release", "uiohook_napi.node");
if (fs.existsSync(localHook)) {
  fs.mkdirSync(path.join(STAGE, "node_modules", "uiohook-napi", "build", "Release"), { recursive: true });
  fs.copyFileSync(localHook, path.join(STAGE, "node_modules", "uiohook-napi", "build", "Release", "uiohook_napi.node"));
}
fs.rmSync(RES, { recursive: true, force: true });
fs.mkdirSync(path.join(RES, "ffmpeg"), { recursive: true });
const ff = process.env.LENS_PKG_FFMPEG ?? execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
fs.copyFileSync(ff, path.join(RES, "ffmpeg", "ffmpeg"));
fs.chmodSync(path.join(RES, "ffmpeg", "ffmpeg"), 0o755);
fs.mkdirSync(path.join(RES, "fonts"), { recursive: true });
for (const f of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) fs.copyFileSync(path.join("/usr/share/fonts/truetype/dejavu", f), path.join(RES, "fonts", f));
fs.cpSync(path.join(EDITOR, "dist"), path.join(RES, "editor"), { recursive: true, filter: (f) => !f.endsWith(".map") });
if (fs.existsSync(path.join(REPO, "assets"))) fs.cpSync(path.join(REPO, "assets"), path.join(RES, "lens", "assets"), { recursive: true });
const cfg = {
  appId: "io.github.muhammadfaizanprog.lens", productName: "Lens",
  directories: { app: STAGE, output: OUT },
  files: ["dist/**", "package.json", "node_modules/**"],
  asarUnpack: ["node_modules/uiohook-napi/**"],
  extraResources: [["ffmpeg", "ffmpeg"], ["fonts", "fonts"], ["editor", "editor"], ["lens", "lens"]].filter(([f]) => fs.existsSync(path.join(RES, f))).map(([f, to]) => ({ from: path.join(RES, f), to })),
  npmRebuild: false, nodeGypRebuild: false,
  electronVersion: JSON.parse(fs.readFileSync(path.join(REPO, "node_modules", "electron", "package.json"), "utf8")).version,
  electronDist: path.join(REPO, "node_modules", "electron", "dist"),
  linux: { target: [{ target: "dir", arch: [process.arch] }], executableName: "lens" },
};
fs.writeFileSync(path.join(OUT, "electron-builder.json"), JSON.stringify(cfg, null, 2));
run(path.join(REPO, "node_modules", ".bin", "electron-builder"), ["--linux", "dir", `--${process.arch}`, "--config", path.join(OUT, "electron-builder.json"), "--publish", "never"], STAGE,
  { ELECTRON_BUILDER_CACHE: path.join(OUT, "cache"), electron_config_cache: path.join(OUT, "cache-electron") });
const dir = fs.readdirSync(OUT).find((d) => d.startsWith("linux") && d.endsWith("unpacked"));
const exe = path.join(OUT, dir, "lens");
fs.writeFileSync(path.join(OUT, "app-path.txt"), exe);
console.log(`packaged app: ${exe}`);
