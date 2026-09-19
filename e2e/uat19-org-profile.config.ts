import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5219';
const url = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('UAT-19 fixture requires a loopback Vite server.');

export default defineConfig({
  testDir: '.', testMatch: 'uat19-org-profile.spec.ts', workers: 1, timeout: 30_000,
  reporter: 'list', outputDir: '../test-results/uat19-org-profile',
  use: { baseURL, browserName: 'chromium', headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: `npm run dev -- --host ${url.hostname} --port ${url.port || '5219'} --strictPort`,
    url: baseURL, reuseExistingServer: !process.env.CI, timeout: 120_000,
  },
});
