import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 *
 * Run tests with: npm run test:e2e
 * Run with UI: npm run test:e2e:ui
 *
 * Environment variables (optional, defaults to local Supabase):
 *   E2E_SUPABASE_URL         — Supabase API URL
 *   E2E_SUPABASE_SERVICE_KEY — Service role key (for test data setup)
 *
 * @updated 2026-03-10 10:30 PM EST
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
