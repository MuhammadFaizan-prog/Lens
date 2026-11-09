import { defineConfig } from "vitest/config";

// Integration tests start Python renderers and an MCP server: one file at a time, one fork, long timeouts.
export default defineConfig({
  test: {
    // only test/: the scratch folder (.test-work) holds symlinks the sandbox tests point outside on purpose
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".test-work/**"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
