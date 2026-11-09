import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The UX specs against the PACKAGED desktop app (scripts/package-linux.mjs builds it). No web server:
// the app serves its own editor. LENS_PACKAGED_APP defaults to the last package-linux.mjs output.
const appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "editor-ux-pkg", "app-path.txt");
if (!process.env.LENS_PACKAGED_APP && fs.existsSync(appPath)) process.env.LENS_PACKAGED_APP = fs.readFileSync(appPath, "utf8").trim();

export default defineConfig({
  testDir: "e2e",
  testMatch: /ux-.*\.spec\.ts|layout\.spec\.ts/,
  outputDir: "test-results/artifacts-app",
  timeout: 600_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-app-report.json" }]],
});
