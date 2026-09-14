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
  // These fixtures use standalone configs and synthetic boundaries, not seeded sessions.
  testIgnore: ['oauth-email-confirmation.spec.ts', 'uat22-people-layout.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // CI keeps the streaming `list` output AND writes the HTML report.
  //
  // `list` alone never creates `playwright-report/`, so ci.yml's E2E job
  // ("Upload Playwright report", `if: failure()`, `path: playwright-report/`)
  // has been uploading NOTHING since it was added — the step runs, finds no
  // files, and the run ends with no artifact. Verified 2026-09-08 on run
  // 34176908799 attempt 1 (PR #2496): the E2E job failed, its log names
  // `trace.zip`, `test-failed-1.png` and `error-context.md`, and the run's
  // artifact list holds only `e2e-worker-log`. Every failed E2E job has been
  // discarding its own evidence, which is why the MFA enrollment flake
  // (PR #2691) had to be diagnosed from the raw job log instead of the trace.
  //
  // The HTML reporter embeds the `test-results/` attachments — trace, failure
  // screenshot, error-context — into `playwright-report/`, so the existing
  // upload step starts carrying them with no workflow change. `open: 'never'`
  // stops the reporter trying to launch a browser on the runner.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
  timeout: 30_000,
  // Deterministic visual-diff config for any opt-in `toHaveScreenshot` /
  // `toMatchSnapshot` spec. The route screenshot baseline harness
  // (`route-screenshot-baseline.spec.ts`) writes attachment-based baselines and
  // does NOT gate on pixel diffs, but these settings keep any future
  // golden-image spec stable across CI by disabling animations and the caret
  // and allowing a small anti-aliasing tolerance. Snapshots resolve under
  // `e2e/__screenshots__/` rather than next to each spec.
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
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
        // BUG-2026-05-22-007 / SCRUM-1985 — iOS Safari upload coverage.
        // The "AI extraction unavailable" toast was first reported on iOS
        // Safari. Scoped to upload/extraction specs only to keep CI cost
        // bounded; expand testMatch if other mobile-WebKit-sensitive flows
        // emerge (PDF.js worker, Tesseract WASM, fetch keepalive).
        {
          name: 'mobile-safari',
          use: {
            ...devices['iPhone 13'],
            storageState: '.auth/individual.json',
          },
          testMatch: /(secure-document|anchor-creation)\.spec\.ts/,
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
