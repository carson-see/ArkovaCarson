import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Auth strategy: A `setup` project logs in seed users once and saves
 * storageState to `.auth/*.json`. All browser projects depend on setup
 * and reuse the saved state — no per-test login overhead. See
 * `e2e/auth.setup.ts` and `e2e/fixtures/auth.ts`.
 *
 * @updated 2026-04-26 — SCRUM-1302: storageState auth to fix timeout regression
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'list' : 'html',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: process.env.CI
    ? [
        // Setup project: logs in seed users and saves storageState
        {
          name: 'setup',
          testMatch: /auth\.setup\.ts/,
        },
        {
          name: 'chromium',
          use: {
            ...devices['Desktop Chrome'],
            // Default to individual (carson) storageState; tests needing
            // a different user override via the auth fixtures.
            storageState: '.auth/individual.json',
          },
          dependencies: ['setup'],
        },
      ]
    : [
        // Setup project: logs in seed users and saves storageState
        {
          name: 'setup',
          testMatch: /auth\.setup\.ts/,
        },
        {
          name: 'chromium',
          use: {
            ...devices['Desktop Chrome'],
            storageState: '.auth/individual.json',
          },
          dependencies: ['setup'],
        },
        {
          name: 'firefox',
          use: {
            ...devices['Desktop Firefox'],
            storageState: '.auth/individual.json',
          },
          dependencies: ['setup'],
        },
        {
          name: 'webkit',
          use: {
            ...devices['Desktop Safari'],
            storageState: '.auth/individual.json',
          },
          dependencies: ['setup'],
        },
        {
          name: 'mobile-chrome',
          use: {
            ...devices['Pixel 5'],
            storageState: '.auth/individual.json',
          },
          dependencies: ['setup'],
        },
        {
          name: 'mobile-safari',
          use: {
            ...devices['iPhone 13'],
            storageState: '.auth/individual.json',
          },
          dependencies: ['setup'],
        },
      ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
