/**
 * Regression test for the 2026-09-13 founder report: "the Secure Document
 * workflow's Continue button is broken." Root cause was
 * `nerPiiDetector.ts`'s default transformers.js loader (see its doc
 * comment) — Vite's DEV server refuses to serve a `/public` asset requested
 * via a plain `import()`, so every on-device PII/NER load failed closed
 * (§1.6) under `npm run dev`, sending the dialog straight to the loud
 * `privacy-blocked` screen instead of running AI extraction.
 *
 * Run with -c e2e/ner-dev-load.config.ts. No seeded account or Supabase
 * needed — this exercises only the client-side model-loading boundary.
 */
import { test, expect } from '@playwright/test';

test('real transformers.js loader resolves under vite dev (not jsdom-mocked)', async ({ page }) => {
  await page.goto('/e2e/fixtures/ner-dev-load.html');
  await expect(page.locator('#out')).toHaveText(/^OK:/, { timeout: 60_000 });
});
