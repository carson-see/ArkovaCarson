import { defineConfig } from '@playwright/test';

// Owned client-only fixture: no seed setup and no hosted services.
export default defineConfig({
  testDir: './e2e', testMatch: 'oauth-email-confirmation.spec.ts', workers: 1,
  expect: { timeout: 20_000 }, timeout: 40_000,
  reporter: 'list', outputDir: 'output/playwright/uat03-results',
  use: { baseURL: 'http://127.0.0.1:5201', headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5201 --strictPort',
    url: 'http://127.0.0.1:5201', reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:55321', VITE_SUPABASE_ANON_KEY: 'uat03-local-anon-fixture', VITE_WORKER_URL: 'http://127.0.0.1:55301', VITE_SENTRY_DSN: '' },
  },
});
