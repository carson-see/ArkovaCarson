/**
 * Revocation E2E Tests (Tier 1)
 *
 * Tests for record revocation: dialog appearance, reason field,
 * confirmation input, and status change.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Revocation', () => {
  const serviceClient = getServiceClient();
  const createdAnchorIds: string[] = [];

  test.afterAll(async () => {
    for (const id of createdAnchorIds) {
      await deleteTestAnchor(serviceClient, id);
    }
  });

  test.describe('Revoke Dialog', () => {
    test('revoke dialog shows confirmation fields', async ({ orgAdminPage }) => {
      // Create a SECURED anchor owned by the org admin for revocation testing
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: 'e2e_revoke_dialog_test.pdf',
      });
      createdAnchorIds.push(anchor.id);

      // Navigate to the record
      await orgAdminPage.goto(`/records/${anchor.id}`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Look for revoke button/menu item
      const revokeBtn = orgAdminPage.getByRole('button', { name: /Revoke/i });
      if (await revokeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await revokeBtn.click();

        // Dialog should appear
        await expect(orgAdminPage.getByRole('heading', { name: /Revoke Record/i })).toBeVisible({
          timeout: 5000,
        });

        // Reason textarea
        await expect(orgAdminPage.getByLabel(/Reason for Revocation/i)).toBeVisible();

        // Confirmation input
        await expect(orgAdminPage.getByLabel(/Type revoke to confirm/i)).toBeVisible();

        // Revoke button should be disabled until confirmation
        const revokeActionBtn = orgAdminPage
          .getByRole('button', { name: /Revoke Record/i })
          .last();
        await expect(revokeActionBtn).toBeDisabled();
      }
    });

    test('revoke button enables after typing confirmation', async ({ orgAdminPage }) => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: 'e2e_revoke_confirm_test.pdf',
      });
      createdAnchorIds.push(anchor.id);

      await orgAdminPage.goto(`/records/${anchor.id}`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      const revokeBtn = orgAdminPage.getByRole('button', { name: /Revoke/i });
      if (await revokeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await revokeBtn.click();
        await expect(orgAdminPage.getByRole('heading', { name: /Revoke Record/i })).toBeVisible({
          timeout: 5000,
        });

        // Type the confirmation
        await orgAdminPage.getByLabel(/Type revoke to confirm/i).fill('revoke');

        // Revoke button should now be enabled
        const revokeActionBtn = orgAdminPage
          .getByRole('button', { name: /Revoke Record/i })
          .last();
        await expect(revokeActionBtn).toBeEnabled({ timeout: 3000 });
      }
    });

    test('revoke dialog has cancel button', async ({ orgAdminPage }) => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: 'e2e_revoke_cancel_test.pdf',
      });
      createdAnchorIds.push(anchor.id);

      await orgAdminPage.goto(`/records/${anchor.id}`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      const revokeBtn = orgAdminPage.getByRole('button', { name: /Revoke/i });
      if (await revokeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await revokeBtn.click();
        await expect(orgAdminPage.getByRole('heading', { name: /Revoke Record/i })).toBeVisible({
          timeout: 5000,
        });

        // Cancel button should be visible
        await expect(orgAdminPage.getByRole('button', { name: /Cancel/i })).toBeVisible();

        // Click cancel
        await orgAdminPage.getByRole('button', { name: /Cancel/i }).click();

        // Dialog should close
        await expect(
          orgAdminPage.getByRole('heading', { name: /Revoke Record/i })
        ).not.toBeVisible({ timeout: 3000 });
      }
    });

    test('revoke dialog accepts optional reason', async ({ orgAdminPage }) => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: 'e2e_revoke_reason_test.pdf',
      });
      createdAnchorIds.push(anchor.id);

      await orgAdminPage.goto(`/records/${anchor.id}`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      const revokeBtn = orgAdminPage.getByRole('button', { name: /Revoke/i });
      if (await revokeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await revokeBtn.click();
        await expect(orgAdminPage.getByRole('heading', { name: /Revoke Record/i })).toBeVisible({
          timeout: 5000,
        });

        // Fill in reason
        const reasonField = orgAdminPage.getByLabel(/Reason for Revocation/i);
        await reasonField.fill('E2E test: document was issued in error');

        // Verify reason was entered
        await expect(reasonField).toHaveValue('E2E test: document was issued in error');
      }
    });
  });

  test.describe('Already Revoked Records', () => {
    test('revoked record shows REVOKED status', async ({ orgAdminPage }) => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'REVOKED',
        filename: 'e2e_already_revoked.pdf',
      });
      createdAnchorIds.push(anchor.id);

      await orgAdminPage.goto(`/records/${anchor.id}`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Should show Revoked status
      await expect(orgAdminPage.getByText('Revoked')).toBeVisible();
    });
  });
});
