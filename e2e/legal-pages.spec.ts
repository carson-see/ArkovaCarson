/**
 * Legal public page E2E tests.
 *
 * Covers production-ready notices on the public privacy and terms routes.
 */

import { test, expect } from '@playwright/test';

const launchBlockerCopy = /placeholder and will be updated|following legal review|prior to production launch|to be replaced with legal-reviewed copy|legal-reviewed copy before production launch/i;

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Legal public pages', () => {
  test('privacy page renders the update notice without launch-blocker copy', async ({ page }) => {
    await page.goto('/privacy');

    await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText(/We may update this policy from time to time\. Material changes will be posted here, and registered users will receive notice when required\./),
    ).toBeVisible();
    await expect(page.getByText(launchBlockerCopy)).toHaveCount(0);
  });

  test('terms page renders the update notice without launch-blocker copy', async ({ page }) => {
    await page.goto('/terms');

    await expect(page.getByRole('heading', { name: 'Terms of Service' })).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText(/We may update these terms from time to time\. Material changes will be posted here, and registered users will receive notice when required\./),
    ).toBeVisible();
    await expect(page.getByText(launchBlockerCopy)).toHaveCount(0);
  });
});
