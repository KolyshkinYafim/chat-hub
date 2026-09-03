import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 12_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
})
