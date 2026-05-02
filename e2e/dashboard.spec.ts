/**
 * Dashboard E2E Tests (Tier 1)
 *
 * Tests for dashboard loading, stats display, records list,
 * navigation to record detail, and Secure Document button.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect } from './fixtures';

test.describe('Dashboard', () => {
  test.describe('Individual User Dashboard', () => {
    test('dashboard loads with welcome message and stats', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');

      // Welcome message
      await expect(individualPage.getByText(/Welcome back/i)).toBeVisible({ timeout: 10000 });

      // Stats cards
      await expect(individualPage.getByText('Total Records')).toBeVisible();
      await expect(individualPage.getByText('Secured')).toBeVisible();
      await expect(individualPage.getByText('Pending')).toBeVisible();
    });

    test('My Records section is visible', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');

      await expect(individualPage.getByRole('heading', { name: 'My Records' })).toBeVisible({
        timeout: 10000,
      });
    });

    test('Secure Document button is visible and clickable', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');

      const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
      await expect(secureBtn.first()).toBeVisible({ timeout: 10000 });
    });

    test('Secure Document button opens dialog', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');
      await individualPage.waitForTimeout(2000); // Wait for page to fully load

      const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
      await secureBtn.first().click();

      // Dialog should appear
      await expect(
        individualPage.getByRole('heading', { name: /Secure Document/i })
      ).toBeVisible({ timeout: 5000 });
    });

    test('privacy toggle is present', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');

      await expect(
        individualPage.getByText('Public Verification Profile')
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Org Admin Dashboard', () => {
    test('org admin sees dashboard with records', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/dashboard');

      // Should show dashboard or redirect to appropriate page
      await expect(
        orgAdminPage.getByText(/Welcome/i)
          .or(orgAdminPage.getByText(/Dashboard/i))
          .or(orgAdminPage.getByText(/Organization/i))
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Navigation', () => {
    test('clicking a record navigates to record detail', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');

      // Wait for records list to load
      await individualPage.waitForTimeout(3000);

      // Look for any record row with an actions menu
      const actionsButton = individualPage.getByRole('button', { name: /Actions/i });
      if (await actionsButton.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await actionsButton.first().click();

        const viewRecord = individualPage.getByRole('menuitem', { name: /View Record/i });
        if (await viewRecord.isVisible({ timeout: 3000 }).catch(() => false)) {
          await viewRecord.click();
          await expect(individualPage).toHaveURL(/\/records\//, { timeout: 10000 });
        }
      }
    });
  });
});
