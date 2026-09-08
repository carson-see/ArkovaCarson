import { defineConfig } from '@playwright/test';

// Isolated browser geometry tests: no seeded account, auth setup, or remote service.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5200';
const url = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
  throw new Error('Securing layout fixtures require a local Vite server.');
}

export default defineConfig({
  testDir: '.',
  testMatch: 'secure-dialog-layout.spec.ts',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: '../test-results/secure-dialog-layout',
  use: { baseURL, browserName: 'chromium', headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: `npm run dev -- --host ${url.hostname} --port ${url.port || '5200'} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
