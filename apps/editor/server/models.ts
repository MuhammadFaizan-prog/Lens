/**
 * Where the on-device models and tools live. The desktop build ships them under
 * resources/lens/assets/models (LENS_ROOT/assets/models); a repo checkout fetches them into
 * assets/models with `node scripts/fetch-models.mjs` (git-ignored, pinned by SHA-256 in that script).
 *
 *   tessdata/eng.traineddata     Tesseract English LSTM model (tessdata_fast, Apache-2.0), 4.1 MB
 *   whisper/ggml-base.en-q5_1.bin  Whisper base.en (MIT), whisper.cpp q5_1 quantisation, 57 MB
 *   whisper/<platform>-<arch>/whisper-cli[.exe]   whisper.cpp CLI (MIT)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export function lensRoot(): string {
  return process.env.LENS_ROOT ? path.resolve(process.env.LENS_ROOT) : path.resolve(here, "..", "..", "..");
}

export function modelsDir(): string {
  return process.env.LENS_MODELS_DIR ? path.resolve(process.env.LENS_MODELS_DIR) : path.join(lensRoot(), "assets", "models");
}

/** Folder holding eng.traineddata, or null. */
export function tessdataDir(): string | null {
  const cands = [path.join(modelsDir(), "tessdata"), ...(process.env.LENS_TESSDATA ? [process.env.LENS_TESSDATA] : [])];
  return cands.find((d) => fs.existsSync(path.join(d, "eng.traineddata"))) ?? null;
}

export const WHISPER_MODEL = "ggml-base.en-q5_1.bin";

export function whisperModel(): string | null {
  const p = process.env.LENS_WHISPER_MODEL || path.join(modelsDir(), "whisper", WHISPER_MODEL);
  return fs.existsSync(p) ? p : null;
}

export function whisperCli(): string | null {
  if (process.env.LENS_WHISPER_CLI) return fs.existsSync(process.env.LENS_WHISPER_CLI) ? process.env.LENS_WHISPER_CLI : null;
  const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const p = path.join(modelsDir(), "whisper", `${process.platform}-${process.arch}`, exe);
  return fs.existsSync(p) ? p : null;
}
