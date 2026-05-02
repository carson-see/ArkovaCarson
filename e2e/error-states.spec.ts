/**
 * Error States E2E Tests (Tier 3)
 *
 * Tests for error handling and edge cases:
 * - 404 record page
 * - Invalid verification ID
 * - Expired/cleared session redirect
 * - Malformed URLs
 *
 * @created 2026-03-10 11:45 PM EST
 */

import { test, expect } from './fixtures';

test.describe('Error States', () => {
  test.describe('Non-Existent Record', () => {
    test('shows error for non-existent record UUID', async ({ individualPage }) => {
      await individualPage.goto('/records/00000000-0000-0000-0000-000000000000');

      // Should show a meaningful error — not a blank page
      await expect(
        individualPage.getByRole('heading', { name: 'Record Not Found' })
      ).toBeVisible({ timeout: 10000 });
      await expect(individualPage.locator('main')).toContainText(/does not exist|permission to view|not found/i);
    });

    test('shows error for malformed record ID', async ({ individualPage }) => {
      await individualPage.goto('/records/not-a-valid-uuid');

      // Should show error or redirect — not crash
      await expect(
        individualPage.getByRole('heading', { name: 'Record Not Found' })
      ).toBeVisible({ timeout: 10000 });
      await expect(individualPage.locator('main')).toContainText(/not found|invalid|error/i);
    });
  });

  test.describe('Invalid Verification', () => {
    test('shows verification failed for invalid public_id', async ({ page }) => {
      await page.goto('/verify/invalid_public_id_999');

      await expect(
        page.getByRole('heading', { name: 'Verification Failed' })
      ).toBeVisible({ timeout: 10000 });

      // Should show helpful message
      await expect(page.locator('main')).toContainText(/Unable to verify|may not exist|not been verified|not found/i);
    });

    test('shows verification failed for empty public_id', async ({ page }) => {
      await page.goto('/verify/');

      // Should show error or redirect — not blank page
      await expect(
        page.getByRole('heading', { name: /Verify a Credential|Verification Failed|404/i })
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Expired Session', () => {
    test('clearing cookies redirects to auth on next navigation', async ({ individualPage }) => {
      // Verify we are authenticated first
      await individualPage.goto('/dashboard');
      await expect(
        individualPage.getByRole('heading', { name: 'My Records' }).first()
      ).toBeVisible({ timeout: 10000 });

      // Simulate session expiry by clearing browser-held auth state
      await individualPage.context().clearCookies();
      await individualPage.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });

      // Navigate to a protected route
      await individualPage.goto('/dashboard');

      // Should redirect to auth page
      await expect(
        individualPage.getByLabel('Email address')
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Unknown Routes', () => {
    test('unknown route shows 404 or redirects', async ({ individualPage }) => {
      await individualPage.goto('/this-page-does-not-exist');

      // Should show 404, redirect to a known page, or show an error
      await expect(
        individualPage.getByRole('heading', { name: '404' })
          .or(individualPage.getByRole('heading', { name: /Dashboard|My Records/i }).first())
      ).toBeVisible({ timeout: 10000 });
    });
  });
});
