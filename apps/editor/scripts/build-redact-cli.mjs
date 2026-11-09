// Bundles apps/editor/server/redact/cli.ts into out/redact/lens-redact.cjs (tesseract.js external).
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
await build({
  entryPoints: [path.join(here, "..", "server", "redact", "cli.ts")], outfile: path.join(repo, "out", "redact", "lens-redact.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node20", external: ["tesseract.js"], logLevel: "warning",
  define: { "import.meta.url": "__lensMetaUrl" }, banner: { js: 'const __lensMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  nodePaths: [path.join(repo, "apps", "editor", "node_modules"), path.join(repo, "node_modules")],
});
console.log("out/redact/lens-redact.cjs");
