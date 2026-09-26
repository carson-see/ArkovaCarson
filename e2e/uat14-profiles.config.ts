import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'uat14-profiles.spec.ts', workers: 1, use: { baseURL: 'http://127.0.0.1:4184' }, webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4184 --strictPort', url: 'http://127.0.0.1:4184/e2e/fixtures/uat14-profiles.html', reuseExistingServer: false, timeout: 120000 } });
