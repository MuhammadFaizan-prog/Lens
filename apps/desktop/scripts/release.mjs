// Publish the Windows build in out/desktop/ as a GitHub Release (docs/Releasing.md).
// Creates release v<version> on MuhammadFaizan-prog/Lens at the current HEAD (push it first) and
// uploads latest.yml, Lens-Setup-<version>.exe and its .blockmap: the three files electron-updater
// reads. Auth: curl runs through the shell's GitHub credential (Hark: credentials provider github;
// elsewhere set GITHUB_TOKEN and it is sent as a bearer token).
// Usage: node scripts/release.mjs [--notes notes.md] [--draft] [--no-upload]
// --no-upload: create the release only; the desktop-release workflow builds and uploads the assets
// (Hark's sandbox cannot upload to uploads.github.com: every upload answers 400 through its gateway).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "MuhammadFaizan-prog";
const REPO = "Lens";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const ROOT = path.resolve(DESKTOP, "..", "..");
const OUT = path.join(ROOT, "out", "desktop");
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8")).version;
const tag = `v${version}`;

const files = [`latest.yml`, `Lens-Setup-${version}.exe`, `Lens-Setup-${version}.exe.blockmap`].map((f) => path.join(OUT, f));
for (const f of files) if (!fs.existsSync(f)) throw new Error(`missing ${f}: run npm run dist:win -w @lens/desktop first`);
const yml = fs.readFileSync(files[0], "utf8");
if (!new RegExp(`^version: ${version.replace(/\./g, "\\.")}$`, "m").test(yml)) throw new Error(`latest.yml is not for ${version}`);

const auth = process.env.GITHUB_TOKEN ? ["-H", `authorization: Bearer ${process.env.GITHUB_TOKEN}`] : [];
const ca = process.env.SSL_CERT_FILE ? ["--cacert", process.env.SSL_CERT_FILE] : [];
function curl(method, url, extra = []) {
  const out = execFileSync("curl", ["-sS", "-X", method, ...ca, ...auth, "-H", "accept: application/vnd.github+json", "-w", "\n%{http_code}", url, ...extra], { encoding: "utf8", maxBuffer: 1 << 26 });
  const i = out.lastIndexOf("\n");
  const status = Number(out.slice(i + 1));
  const body = out.slice(0, i);
  return { status, json: body ? JSON.parse(body) : null };
}

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const existing = curl("GET", `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
if (existing.status === 200) throw new Error(`release ${tag} already exists: ${existing.json.html_url} (bump the version)`);
const notesFile = opt("--notes");
const body = (notesFile ? fs.readFileSync(notesFile, "utf8") : `Lens desktop ${tag} (Windows x64, unsigned NSIS installer).`) +
  `\n\nInstall: download Lens-Setup-${version}.exe and run it. Installed copies update themselves from this release.\n`;
const rel = curl("POST", `https://api.github.com/repos/${OWNER}/${REPO}/releases`, ["-H", "content-type: application/json", "--data-binary", JSON.stringify({
  tag_name: tag, target_commitish: sha, name: `Lens ${tag}`, body, draft: args.includes("--draft"), prerelease: false, make_latest: "true",
})]);
if (rel.status !== 201) throw new Error(`create release failed (${rel.status}): ${JSON.stringify(rel.json)}`);
console.log(`created ${rel.json.html_url} at ${sha}`);
if (args.includes("--no-upload")) {
  // assets uploaded by the desktop-release workflow (.github/workflows/desktop-release.yml)
  console.log(`not uploading; run the desktop-release workflow with tag ${tag}`);
  process.exit(0);
}
for (const f of files) {
  const name = path.basename(f);
  const up = curl("POST", `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.json.id}/assets?name=${encodeURIComponent(name)}`, ["-H", "content-type: application/octet-stream", "-T", f] /* -T streams the file; --data-binary @f would load it all into memory */);
  if (up.status !== 201) throw new Error(`upload ${name} failed (${up.status}): ${JSON.stringify(up.json)}`);
  console.log(`uploaded ${name} (${(up.json.size / 1048576).toFixed(1)} MB) ${up.json.browser_download_url}`);
}
console.log(rel.json.html_url);
