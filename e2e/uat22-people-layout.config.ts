import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'uat22-people-layout.spec.ts', workers: 1,
  retries: 0, timeout: 45_000, expect: { timeout: 20_000 },
  reporter: 'list', outputDir: '../output/playwright/uat22-people-layout',
  use: { baseURL: 'http://127.0.0.1:5207', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5207 --strictPort',
    cwd: '..', url: 'http://127.0.0.1:5207', reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:55321', VITE_SUPABASE_ANON_KEY: 'local-layout-fixture', VITE_WORKER_URL: 'http://127.0.0.1:55301', VITE_SENTRY_DSN: '' },
  },
});
