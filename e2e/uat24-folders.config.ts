import { defineConfig } from '@playwright/test';
const baseURL = 'http://127.0.0.1:5204';
export default defineConfig({ testDir: '.', testMatch: ['uat24-folders.spec.ts', 'uat24-member.spec.ts'], workers: 1, reporter: 'list', outputDir: '../test-results/uat24-folders', use: { baseURL, browserName: 'chromium', headless: true }, webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5204 --strictPort', url: baseURL, reuseExistingServer: false, timeout: 120000 } });
