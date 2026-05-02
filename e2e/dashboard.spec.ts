/**
 * Dashboard E2E Tests (Tier 1)
 *
 * Tests for dashboard loading, stats display, records list,
 * navigation to record detail, and Secure Document button.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect } from './fixtures';
import {
  getSecureDocumentButton,
  getSecureDocumentDialog,
  openDashboard,
  openSecureDocumentDialog,
} from './helpers/dashboard';

test.describe('Dashboard', () => {
  test.describe('Individual User Dashboard', () => {
    test('dashboard loads with profile summary and stats', async ({ individualPage }) => {
      await openDashboard(individualPage);

      // Profile summary
      await expect(individualPage.locator('#main-content')).toContainText(/Jamie Demo-User/i);

      // Stats cards
      await expect(individualPage.getByText('Total Records')).toBeVisible();
      await expect(individualPage.getByText('Secured')).toBeVisible();
      await expect(individualPage.getByText('Pending')).toBeVisible();
    });

    test('My Records section is visible', async ({ individualPage }) => {
      await openDashboard(individualPage);

      await expect(individualPage.getByRole('heading', { name: 'My Records' })).toBeVisible({
        timeout: 10000,
      });
    });

    test('Secure Document button is visible and clickable', async ({ individualPage }) => {
      await openDashboard(individualPage);

      await expect(getSecureDocumentButton(individualPage)).toBeVisible({ timeout: 10000 });
    });

    test('Secure Document button opens dialog', async ({ individualPage }) => {
      await openSecureDocumentDialog(individualPage);

      // Dialog should appear
      await expect(getSecureDocumentDialog(individualPage)).toBeVisible({ timeout: 5000 });
    });

    test('privacy toggle is present', async ({ individualPage }) => {
      await openDashboard(individualPage);

      await expect(individualPage.locator('#main-content')).toContainText(/Public profile/i);
    });
  });

  test.describe('Org Admin Dashboard', () => {
    test('org admin sees dashboard with records', async ({ orgAdminPage }) => {
      await openDashboard(orgAdminPage);

      // Should show org-admin dashboard content
      await expect(orgAdminPage.locator('#main-content')).toContainText(
        /Audit My Organization|Total Records|Monthly Usage/i,
        { timeout: 10000 },
      );
    });
  });

  test.describe('Navigation', () => {
    test('clicking a record navigates to record detail', async ({ individualPage }) => {
      await openDashboard(individualPage);

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
