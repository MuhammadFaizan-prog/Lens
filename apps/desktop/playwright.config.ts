import { defineConfig } from "@playwright/test";

// One spec per run, one worker (2-core / ~1.3 GB sandbox). The specs start their own Xvfb.
for (const k of ["NO_PROXY", "no_proxy"]) process.env[k] = ["127.0.0.1", "localhost", process.env[k]].filter(Boolean).join(",");
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/artifacts",
  timeout: 600_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
});
