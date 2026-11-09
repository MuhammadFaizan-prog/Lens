/**
 * lens-redact in Node (no Python), the same command line as redact/lens-redact:
 *   node lens-redact.cjs <screen.mp4> [--events events.jsonl] -o privacy.json [--thumbs DIR] [--progress]
 *   node lens-redact.cjs steps <screen.mp4> --events events.jsonl -o steps.json
 * Built by scripts/build-redact-cli.mjs; used by the tests (tests/test_redact_inapp.py) and for
 * debugging. The app itself calls scan() / stepLabels() through api.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { scan } from "./scan";
import { stepLabels } from "./steps";

function arg(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  // out/redact/lens-redact.cjs sits two levels under the repo root
  if (!process.env.LENS_ROOT && !process.env.LENS_MODELS_DIR && typeof __dirname !== "undefined") process.env.LENS_ROOT = path.resolve(__dirname, "..", "..");
  const args = process.argv.slice(2);
  const ffmpeg = process.env.LENS_FFMPEG || "ffmpeg";
  if (args[0] === "steps") {
    const r = await stepLabels(ffmpeg, args[1]!, arg(args, "--events")!);
    fs.writeFileSync(arg(args, "-o")!, JSON.stringify(r, null, 1));
    process.stderr.write(`${(r.drafts as unknown[]).length} step drafts\n`);
    return;
  }
  const prog = args.includes("--progress") ? (s: string, d: number, t: number) => process.stderr.write(`progress ${s} ${d} ${t}\n`) : undefined;
  const r = await scan(ffmpeg, args[0]!, arg(args, "--events"), arg(args, "--thumbs"), prog);
  fs.writeFileSync(arg(args, "-o")!, JSON.stringify(r, null, 1));
  const st = r.stats as { samples: number; seconds: { total: number } };
  process.stderr.write(`${r.detections.length} detections, ${st.samples} OCR samples, ${st.seconds.total} s\n`);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
