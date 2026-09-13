/**
 * Standalone Playwright config for the sub-organisation UAT capture.
 *
 * Separate from `playwright.config.ts` for the reason documented in
 * `uat-pr2840.config.ts` and `e2e/agents.md`: the shared config loads
 * `.env.test`, runs an `auth.setup.ts` project against a real Supabase
 * project, and globs all of `e2e/`. This capture touches no rig — Supabase and
 * the worker are both stubbed in-browser.
 *
 * Declares NO `projects`, so its single implicit project has an empty name.
 * `uat-suborg-ux.spec.ts` skips itself whenever the project name is non-empty,
 * which is what stops the shared config's glob from running it by accident.
 *
 *   npm run dev -- --port 5173 --strictPort
 *   npx playwright test e2e/uat-suborg-ux.spec.ts --config=e2e/uat-suborg-ux.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'uat-suborg-ux.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Desktop Chrome'],
    // Viewport is set per-describe in the spec.
    viewport: null,
  },
});
