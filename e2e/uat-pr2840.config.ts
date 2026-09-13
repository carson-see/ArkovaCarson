/**
 * Standalone Playwright config for the PR #2840 T1 UAT capture.
 *
 * Deliberately separate from `playwright.config.ts`: that config loads
 * `.env.test`, runs an `auth.setup.ts` project that creates real users against
 * a Supabase project, and pulls in the whole `e2e/` suite. This capture must
 * touch no rig at all — it drives the local `vite preview` build with every
 * Supabase call stubbed in-browser.
 *
 *   npm run build
 *   npx vite preview --port 4173 --strictPort
 *   npx playwright test e2e/uat-pr2840.spec.ts --config=e2e/uat-pr2840.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'uat-pr2840.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    ...devices['Desktop Chrome'],
    // Viewport is set per-describe in the spec.
    viewport: null,
  },
});
