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
  // Tesseract English LSTM model, tessdata_fast 4.1.0 (Apache-2.0); the same file Debian's tesseract-ocr-eng ships.
  // In-app OCR (privacy scan, step labels) runs it through tesseract.js. 4.1 MB
  { group: "tessdata", file: "tessdata/eng.traineddata", url: "https://github.com/tesseract-ocr/tessdata_fast/raw/4.1.0/eng.traineddata",
    sha256: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2" },
  // Whisper base.en (MIT, OpenAI), whisper.cpp q5_1 quantisation from the whisper.cpp project's model repo.
  // In-app speech-to-text (Transcribe button, auto-run on Stop) runs it through whisper-cli. 57 MB
  { group: "whisper", file: "whisper/ggml-base.en-q5_1.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
    sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f" },
  // whisper.cpp v1.8.2 (MIT) official Windows x64 CPU build: only whisper-cli.exe and its DLLs are kept
  // (whisper/win32-x64/). Linux builds whisper-cli from source instead (scripts/build-whisper.sh). 1.6 MB
  { group: "whisper", file: "whisper/win32-x64/whisper-bin-x64.zip", url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-bin-x64.zip",
    sha256: "b1514ebc099765e39fa37eb780b92a140a94c86bb0b3b3d98226b38825979732",
    extract: ["Release/whisper-cli.exe", "Release/whisper.dll", "Release/ggml.dll", "Release/ggml-base.dll", "Release/ggml-cpu.dll"] },
  // The official whisper.cpp Windows build is MSVC-linked (MSVCP140, VCRUNTIME140, VCRUNTIME140_1, VCOMP140;
  // linker 14.44). Those four Microsoft Visual C++ 2015-2022 runtime DLLs (14.44.35208, Authenticode-signed by
  // Microsoft) are shipped next to whisper-cli.exe, where Windows looks first, so speech-to-text works without
  // the VC++ Redistributable installed. They are redistributable under the Visual Studio redistributable licence
  // (redist.txt). Source: conda-forge's vc14_runtime / vcomp14 packages, which repackage the Microsoft files
  // unchanged; the .conda archive is SHA-256 pinned. ~0.9 MB
  { group: "whisper", file: "whisper/win32-x64/vc14_runtime-14.44.35208-h818238b_42.conda", url: "https://conda.anaconda.org/conda-forge/win-64/vc14_runtime-14.44.35208-h818238b_42.conda",
    sha256: "cccaf9fe5e2a8d04d5a56a5a77d2392a0ed2a7d1669dabf16fd21e6270a0e9ae", conda: true,
    extract: ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"] },
  { group: "whisper", file: "whisper/win32-x64/vcomp14-14.44.35208-h818238b_42.conda", url: "https://conda.anaconda.org/conda-forge/win-64/vcomp14-14.44.35208-h818238b_42.conda",
    sha256: "fd7aeae7ca092213a1e4ac50cec26e825792a12c642538614a892ab3ec3590d8", conda: true,
    extract: ["vcomp140.dll"] },
  { group: "whisper", file: "whisper/LICENSE-whisper.cpp.txt", url: "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.8.2/LICENSE",
    sha256: "e562a2ddfaf8280537795ac5ecd34e3012b6582a147ef69ba6a6a5c08c84757d" },
];
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
// an archive entry (`extract`): the listed members are unpacked flat next to it and the archive deleted;
// a stamp file holding the archive's SHA-256 marks it done
const unzip = (zip, members, to) => {
  try {
    execFileSync("unzip", ["-o", "-j", "-q", zip, ...members, "-d", to], { stdio: "inherit" });
  } catch {
    execFileSync("tar", ["-xf", zip, "-C", to, "--strip-components=1", ...members], { stdio: "inherit" }); // Windows bsdtar
  }
  for (const m of members) if (!fs.existsSync(path.join(to, path.basename(m)))) throw new Error(`${zip}: ${m} missing after unzip`);
};
// a conda package (`conda`): a zip holding pkg-*.tar.zst; the listed top-level members are unpacked next to it
const unconda = (pkg, members, to) => {
  const tmp = fs.mkdtempSync(path.join(to, ".conda-"));
  try {
    execFileSync("unzip", ["-o", "-q", pkg, "pkg-*.tar.zst", "-d", tmp], { stdio: "inherit" });
    const zst = fs.readdirSync(tmp).find((f) => f.startsWith("pkg-") && f.endsWith(".tar.zst"));
    if (!zst) throw new Error(`${pkg}: no pkg-*.tar.zst`);
    execFileSync("tar", ["--zstd", "-xf", path.join(tmp, zst), "-C", to, ...members], { stdio: "inherit" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const m of members) if (!fs.existsSync(path.join(to, m))) throw new Error(`${pkg}: ${m} missing after extract`);
};
const VCRT_NOTICE = `msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll and vcomp140.dll in this folder are the
Microsoft Visual C++ 2015-2022 Redistributable runtime files, version 14.44.35208 (x64), (c) Microsoft
Corporation, Authenticode-signed by Microsoft. They are redistributed unmodified with whisper-cli.exe under the
Microsoft Visual Studio redistributable code terms (https://learn.microsoft.com/visualstudio/releases/2022/redistribution).
`;
for (const m of MODELS) {
  if (only && m.group !== only) continue;
  const out = path.join(dir, m.file);
  const stamp = out + ".sha256";
  if (m.extract && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === m.sha256 && m.extract.every((f) => fs.existsSync(path.join(path.dirname(out), path.basename(f))))) continue;
  if (!m.extract && fs.existsSync(out) && sha(out) === m.sha256) continue;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync("curl", ["-sSfL", ...(process.env.SSL_CERT_FILE ? ["--cacert", process.env.SSL_CERT_FILE] : []), "-o", out + ".part", m.url], { stdio: "inherit" });
  const got = sha(out + ".part");
  if (got !== m.sha256) throw new Error(`${m.file}: sha256 ${got}, expected ${m.sha256}`);
  fs.renameSync(out + ".part", out);
  console.log(`fetched ${m.file} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  if (m.extract) {
    (m.conda ? unconda : unzip)(out, m.extract, path.dirname(out));
    if (m.conda) fs.writeFileSync(path.join(path.dirname(out), "VCRUNTIME-NOTICE.txt"), VCRT_NOTICE);
    fs.rmSync(out);
    fs.writeFileSync(stamp, m.sha256 + "\n");
  }
}
