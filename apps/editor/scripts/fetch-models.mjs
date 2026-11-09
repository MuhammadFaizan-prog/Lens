// Fetches the on-device models the app ships into assets/models (git-ignored), pinned by SHA-256.
// The desktop build (apps/desktop/scripts/dist-win.mjs) runs this and copies assets/models into
// resources/lens/assets/models. Usage: node apps/editor/scripts/fetch-models.mjs [--only tessdata]
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const dir = process.env.LENS_MODELS_DIR || path.join(repo, "assets", "models");
export const MODELS = [
  // RNNoise "somnolent-hogwash-2018-09-01" (recording noise, speech signal) for ffmpeg arnndn (export noise
  // reduction), from github.com/GregorR/rnnoise-models; that repository states the models are not creative
  // work and not subject to copyright. ffmpeg's arnndn (RNNoise, BSD-3-Clause) runs it. 0.3 MB
  { group: "rnnoise", file: "rnnoise/sh.rnnn", url: "https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn",
    sha256: "70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0" },
];
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
for (const m of MODELS) {
  if (only && m.group !== only) continue;
  const out = path.join(dir, m.file);
  if (fs.existsSync(out) && sha(out) === m.sha256) continue;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync("curl", ["-sSfL", ...(process.env.SSL_CERT_FILE ? ["--cacert", process.env.SSL_CERT_FILE] : []), "-o", out + ".part", m.url], { stdio: "inherit" });
  const got = sha(out + ".part");
  if (got !== m.sha256) throw new Error(`${m.file}: sha256 ${got}, expected ${m.sha256}`);
  fs.renameSync(out + ".part", out);
  console.log(`fetched ${m.file} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}
