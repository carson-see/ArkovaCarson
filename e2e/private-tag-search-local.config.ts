import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'private-tag-search-local.spec.ts', workers: 1,
  retries: 0, timeout: 45_000, expect: { timeout: 10_000 },
  reporter: 'list', outputDir: '../output/playwright/private-tag-search-local',
  use: { baseURL: 'http://127.0.0.1:5213', channel: 'chrome', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5213 --strictPort',
    cwd: '..', url: 'http://127.0.0.1:5213', reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:55321', VITE_SUPABASE_ANON_KEY: 'round3-fixture', VITE_WORKER_URL: 'http://127.0.0.1:55301', VITE_SENTRY_DSN: '' }, // gitleaks:allow — deterministic loopback-only Playwright placeholder, not a credential
  },
});
