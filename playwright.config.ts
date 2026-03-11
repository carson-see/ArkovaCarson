import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

// Load E2E-specific env vars from .env.test (falls back to .env)
dotenv.config({ path: path.resolve(__dirname, '.env.test') });
dotenv.config(); // fallback to .env for any vars not in .env.test

/**
 * Playwright E2E Test Configuration
 *
 * Run tests with: npm run test:e2e
 * Run with UI: npm run test:e2e:ui
 *
 * Required environment variables (set in .env.test):
 *   E2E_SUPABASE_SERVICE_KEY — Service role key (for test data setup)
 *   E2E_SEED_PASSWORD        — Shared password for seed test users
 *
 * Optional environment variables:
 *   E2E_SUPABASE_URL         — Supabase API URL (defaults to local)
 *
 * @updated 2026-03-10 11:30 PM EST
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
