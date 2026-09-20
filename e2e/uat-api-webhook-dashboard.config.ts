import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "uat-api-webhook-dashboard.spec.ts",
  fullyParallel: true,
  workers: 8,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4179",
    ...devices["Desktop Chrome"],
    viewport: null,
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
