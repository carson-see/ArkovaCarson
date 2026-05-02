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
        individualPage.getByText(/Record Not Found/i)
          .or(individualPage.getByText(/does not exist/i))
          .or(individualPage.getByText(/not found/i))
      ).toBeVisible({ timeout: 10000 });
    });

    test('shows error for malformed record ID', async ({ individualPage }) => {
      await individualPage.goto('/records/not-a-valid-uuid');

      // Should show error or redirect — not crash
      await expect(
        individualPage.getByText(/Record Not Found/i)
          .or(individualPage.getByText(/not found/i))
          .or(individualPage.getByText(/Invalid/i))
          .or(individualPage.getByText(/Error/i))
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Invalid Verification', () => {
    test('shows verification failed for invalid public_id', async ({ page }) => {
      await page.goto('/verify/invalid_public_id_999');

      await expect(
        page.getByText(/Verification Failed/i)
      ).toBeVisible({ timeout: 10000 });

      // Should show helpful message
      await expect(
        page.getByText(/Unable to verify/i)
          .or(page.getByText(/may not exist/i))
          .or(page.getByText(/not been verified/i))
      ).toBeVisible();
    });

    test('shows verification failed for empty public_id', async ({ page }) => {
      await page.goto('/verify/');

      // Should show error or redirect — not blank page
      await expect(
        page.getByText(/Verification Failed/i)
          .or(page.getByText(/not found/i))
          .or(page.getByText(/Invalid/i))
          .or(page.getByRole('heading', { name: /Verify/i }))
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Expired Session', () => {
    test('clearing cookies redirects to auth on next navigation', async ({ individualPage }) => {
      // Verify we are authenticated first
      await individualPage.goto('/dashboard');
      await expect(
        individualPage.getByText(/Vault/i)
          .or(individualPage.getByText(/My Records/i))
          .or(individualPage.getByText(/Secure Document/i))
      ).toBeVisible({ timeout: 10000 });

      // Simulate session expiry by clearing cookies
      await individualPage.context().clearCookies();

      // Navigate to a protected route
      await individualPage.goto('/dashboard');

      // Should redirect to auth page
      await expect(
        individualPage.getByText(/Authentication Required/i)
          .or(individualPage.getByLabel('Email address'))
          .or(individualPage.getByText(/Sign in/i))
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Unknown Routes', () => {
    test('unknown route shows 404 or redirects', async ({ individualPage }) => {
      await individualPage.goto('/this-page-does-not-exist');

      // Should show 404, redirect to a known page, or show an error
      await expect(
        individualPage.getByText(/Not Found/i)
          .or(individualPage.getByText(/404/i))
          .or(individualPage.getByText(/Vault/i))
          .or(individualPage.getByText(/Dashboard/i))
      ).toBeVisible({ timeout: 10000 });
    });
  });
});
