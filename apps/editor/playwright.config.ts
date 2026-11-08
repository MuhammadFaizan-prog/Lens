import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

// Playwright's own Chromium when installed; otherwise a system Chromium (scripts/ensure-chromium.sh).
const systemChromium = [process.env.LENS_CHROMIUM, "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p));
// The dev server is local: never send its health check or test requests through an HTTP proxy.
for (const k of ["NO_PROXY", "no_proxy"]) process.env[k] = ["127.0.0.1", "localhost", process.env[k]].filter(Boolean).join(",");
// Low-memory Chromium for a 2-core / ~1.3 GB sandbox (LENS_E2E_LOWMEM=0 to turn off): GPU work in the
// browser process, no zygotes, one renderer, no background services. A default headless Chromium
// (~900 MB over 8 processes) plus the export's compositor got the worker OOM-killed here.
// (--single-process is lighter still but crashes the browser when Playwright closes a context.)
const LOWMEM = process.env.LENS_E2E_LOWMEM !== "0";
const CHROMIUM_ARGS = ["--disable-gpu-sandbox", "--disable-dev-shm-usage", ...(LOWMEM ? ["--in-process-gpu", "--no-zygote"] : []),
  "--renderer-process-limit=1", "--disable-extensions",
  "--disable-background-networking", "--disable-component-update", "--disable-features=Translate,MediaRouter,OptimizationHints,site-per-process"];
const PORT = Number(process.env.LENS_E2E_PORT ?? 5188);

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/artifacts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-report.json" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    launchOptions: { args: CHROMIUM_ARGS, ...(systemChromium ? { executablePath: systemChromium } : {}) },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 } }],
  webServer: {
    // The built app (npm run e2e builds it first) on the preview server: same API middleware, far
    // less memory than the dev server. The CI sandbox has ~1.3 GB free; building here, while
    // Chromium starts, got test workers OOM-killed.
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/api/bundle`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
