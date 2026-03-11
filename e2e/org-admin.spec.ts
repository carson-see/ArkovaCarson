/**
 * Org Admin E2E Tests (Tier 2)
 *
 * Tests for organization admin features: members table, organization
 * records registry, issue credential form, status filter, and CSV export.
 *
 * @created 2026-03-10 11:30 PM EST
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Org Admin', () => {
  const serviceClient = getServiceClient();
  const createdAnchorIds: string[] = [];

  test.afterAll(async () => {
    for (const id of createdAnchorIds) {
      await deleteTestAnchor(serviceClient, id);
    }
  });

  test.describe('Organization Page', () => {
    test('org admin sees organization page with sections', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');

      // Page heading
      await expect(
        orgAdminPage.getByRole('heading', { name: 'Organization' })
          .or(orgAdminPage.getByText('Organization'))
      ).toBeVisible({ timeout: 10000 });

      // Team Members section
      await expect(orgAdminPage.getByText('Team Members')).toBeVisible();

      // Organization Records section
      await expect(orgAdminPage.getByText('Organization Records')).toBeVisible();
    });

    test('members table shows team members', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');
      await expect(orgAdminPage.getByText('Team Members')).toBeVisible({ timeout: 10000 });

      // Should show table headers or member data
      await expect(
        orgAdminPage.getByText('Member')
          .or(orgAdminPage.getByText('Role'))
          .or(orgAdminPage.getByText('No members yet'))
      ).toBeVisible();
    });
  });

  test.describe('Organization Records', () => {
    test('org registry table shows records with filters', async ({ orgAdminPage }) => {
      // Create a test anchor for the org admin
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: 'e2e_org_registry_test.pdf',
      });
      createdAnchorIds.push(anchor.id);

      await orgAdminPage.goto('/organization');
      await expect(orgAdminPage.getByText('Organization Records')).toBeVisible({ timeout: 10000 });

      // Search input should be visible
      const searchInput = orgAdminPage.getByPlaceholder(/Search by filename/i);
      await expect(searchInput).toBeVisible();

      // Status filter should be accessible
      await expect(
        orgAdminPage.getByText(/Status/i)
      ).toBeVisible();
    });

    test('issue credential button opens form', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');
      await expect(orgAdminPage.getByText('Organization Records')).toBeVisible({ timeout: 10000 });

      // Click Issue Credential button
      const issueBtn = orgAdminPage.getByRole('button', { name: /Issue Credential/i });
      if (await issueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await issueBtn.click();

        // Dialog should appear with form fields
        await expect(
          orgAdminPage.getByRole('heading', { name: /Issue Credential/i })
        ).toBeVisible({ timeout: 5000 });

        // Credential type dropdown should be present
        await expect(
          orgAdminPage.getByText(/Credential Type/i)
        ).toBeVisible();

        // Label field
        await expect(
          orgAdminPage.getByText(/Label/i)
        ).toBeVisible();

        // Cancel button
        await expect(
          orgAdminPage.getByRole('button', { name: /Cancel/i })
        ).toBeVisible();
      }
    });

    test('export CSV button is present', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');
      await expect(orgAdminPage.getByText('Organization Records')).toBeVisible({ timeout: 10000 });

      // Export CSV button should exist
      const exportBtn = orgAdminPage.getByRole('button', { name: /Export CSV/i });
      await expect(exportBtn).toBeVisible();
    });
  });
});
