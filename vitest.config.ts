import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

// Unit tests run against main-process modules directly (node env, no Electron).
// Anything importing `electron` must be stubbed by the test itself.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
  test: {
    environment: "node",
    environmentMatchGlobs: [["**/*.dom.test.ts", "jsdom"]],
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    reporters: ["default"],
    // Real-git tests spawn dozens of subprocesses; under a full parallel run
    // they starve past the default 5s and flake. A generous ceiling keeps
    // genuine hangs failing while ending the timeout lottery.
    testTimeout: 30_000,
  },
})
