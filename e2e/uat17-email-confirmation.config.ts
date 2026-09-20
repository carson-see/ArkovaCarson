import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'uat17-email-confirmation.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/uat17-email-report' }]],
  outputDir: '../test-results/uat17-email-confirmation',
  use: {
    baseURL: 'http://127.0.0.1:5197',
    browserName: 'chromium',
    headless: true,
    storageState: { cookies: [], origins: [] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'uat17-browser-fixture-placeholder',
    },
  },
});
