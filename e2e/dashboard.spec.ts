/**
 * Dashboard E2E Tests (Tier 1)
 *
 * Tests for dashboard loading, stats display, records list,
 * navigation to record detail, and Secure Document button.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';
import {
  getSecureDocumentButton,
  getSecureDocumentDialog,
  openDashboard,
  openSecureDocumentDialog,
} from './helpers/dashboard';

test.describe('Dashboard', () => {
  const serviceClient = getServiceClient();

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

      await expect(
        individualPage.getByRole('switch', { name: /Toggle profile visibility/i }),
      ).toBeVisible();
    });
  });

  test.describe('Org Admin Dashboard', () => {
    test('org admin sees dashboard with records', async ({ orgAdminPage }) => {
      await openDashboard(orgAdminPage);

      // Should show org-admin-specific dashboard content.
      await expect(orgAdminPage.locator('#main-content')).toContainText(/Audit My Organization/i, {
        timeout: 10000,
      });
    });
  });

  test.describe('Navigation', () => {
    test('clicking a record navigates to record detail', async ({ individualPage }) => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.individual.id,
        status: 'SECURED',
        filename: `e2e_dashboard_nav_${Date.now()}.pdf`,
      });

      try {
        await openDashboard(individualPage);

        const recordCard = individualPage
          .getByRole('button')
          .filter({ hasText: anchor.filename })
          .first();
        await expect(recordCard).toBeVisible({ timeout: 15_000 });

        const actionsButton = recordCard.getByRole('button', { name: /^Actions$/ });
        await expect(actionsButton).toBeVisible({ timeout: 5_000 });
        await actionsButton.click();

        const viewRecord = individualPage.getByRole('menuitem', { name: /View Record/i });
        await expect(viewRecord).toBeVisible({ timeout: 5_000 });
        await viewRecord.click();

        await expect(individualPage).toHaveURL(`http://localhost:5173/records/${anchor.id}`, {
          timeout: 10_000,
        });
      } finally {
        await deleteTestAnchor(serviceClient, anchor.id);
      }
    });
  });
});
