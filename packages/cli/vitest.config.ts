import { defineConfig } from "vitest/config";

// Integration tests start Python renderers and an MCP server: one file at a time, one fork, long timeouts.
export default defineConfig({
  test: {
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
