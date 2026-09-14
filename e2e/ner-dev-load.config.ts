import { defineConfig } from '@playwright/test';

// Isolated dev-server module-loading regression: no seeded account, auth
// setup, or remote service. Must run against a real `vite dev` server (the
// defect is in dev-server module serving, not app logic) — never point
// E2E_BASE_URL at a non-local host.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5210';
const url = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
  throw new Error('ner-dev-load requires a local Vite dev server.');
}

export default defineConfig({
  testDir: '.',
  testMatch: 'ner-dev-load.spec.ts',
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  outputDir: '../test-results/ner-dev-load',
  use: { baseURL, browserName: 'chromium', headless: true },
  webServer: {
    command: `npm run dev -- --host ${url.hostname} --port ${url.port || '5210'} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
