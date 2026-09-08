/**
 * TEMPORARY — DO NOT MERGE. Reverted in the commit immediately after this one.
 *
 * Exists for exactly one CI cycle, to prove that the reporter change in
 * playwright.config.ts makes ci.yml's "Upload Playwright report" step
 * (`if: failure()`, `path: playwright-report/`) actually produce an artifact.
 * Before this PR that step logged "No files were found with the provided path"
 * on every failing job. A deliberately failing test is the only way to exercise
 * the failure path end-to-end in CI.
 */
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('TEMPORARY artifact-upload probe: fails on purpose so the E2E job uploads a report', async ({ page }) => {
  await page.setContent('<div data-testid="probe">present</div>');
  await expect(page.getByTestId('probe')).toHaveText('deliberate mismatch — see file header');
});
