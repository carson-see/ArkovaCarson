/**
 * Cross-Tenant Isolation E2E Tests (Tier 3)
 *
 * Tests that data isolation is enforced between tenants:
 * - User A cannot see User B's records
 * - Org A admin cannot see Org B's records
 * - Individual user cannot see org-owned records
 *
 * @created 2026-03-10 11:45 PM EST
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Cross-Tenant Isolation', () => {
  const serviceClient = getServiceClient();
  const createdAnchorIds: string[] = [];

  test.afterAll(async () => {
    for (const id of createdAnchorIds) {
      await deleteTestAnchor(serviceClient, id);
    }
  });

  test.describe('User-to-User Isolation', () => {
    test('individual user cannot view org admin records via direct URL', async ({ individualPage }) => {
      // Create a record owned by orgAdmin (different user)
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: 'e2e_cross_tenant_org_record.pdf',
      });
      createdAnchorIds.push(anchor.id);

      // Individual user tries to access orgAdmin's record directly
      await individualPage.goto(`/records/${anchor.id}`);

      // Should show error or empty state — NOT the record details
      await expect(
        individualPage.getByText(/Record Not Found/i)
          .or(individualPage.getByText(/not authorized/i))
          .or(individualPage.getByText(/does not exist/i))
          .or(individualPage.getByText(/Access Denied/i))
      ).toBeVisible({ timeout: 10000 });

      // Should NOT show the filename (proves data was not leaked)
      await expect(
        individualPage.getByText('e2e_cross_tenant_org_record.pdf')
      ).not.toBeVisible();
    });

    test('org admin cannot view individual user records via direct URL', async ({ orgAdminPage }) => {
      // Create a record owned by individual user
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.individual.id,
        status: 'SECURED',
        filename: 'e2e_cross_tenant_individual_record.pdf',
      });
      createdAnchorIds.push(anchor.id);

      // Org admin tries to access individual's record directly
      await orgAdminPage.goto(`/records/${anchor.id}`);

      // Should show error — NOT the record
      await expect(
        orgAdminPage.getByText(/Record Not Found/i)
          .or(orgAdminPage.getByText(/not authorized/i))
          .or(orgAdminPage.getByText(/does not exist/i))
          .or(orgAdminPage.getByText(/Access Denied/i))
      ).toBeVisible({ timeout: 10000 });

      // Should NOT show the filename
      await expect(
        orgAdminPage.getByText('e2e_cross_tenant_individual_record.pdf')
      ).not.toBeVisible();
    });
  });

  test.describe('Org-to-Org Isolation', () => {
    test('Org B admin cannot view Org A records via direct URL', async ({ orgBAdminPage }) => {
      // Create a record owned by Org A admin (University of Michigan)
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: 'e2e_cross_tenant_orgA_record.pdf',
      });
      createdAnchorIds.push(anchor.id);

      // Org B admin (Midwest Medical) tries to access Org A's record
      await orgBAdminPage.goto(`/records/${anchor.id}`);

      // Should show error — NOT the record
      await expect(
        orgBAdminPage.getByText(/Record Not Found/i)
          .or(orgBAdminPage.getByText(/not authorized/i))
          .or(orgBAdminPage.getByText(/does not exist/i))
          .or(orgBAdminPage.getByText(/Access Denied/i))
      ).toBeVisible({ timeout: 10000 });

      // Should NOT leak the filename
      await expect(
        orgBAdminPage.getByText('e2e_cross_tenant_orgA_record.pdf')
      ).not.toBeVisible();
    });

    test('Org A records do not appear in Org B dashboard list', async ({ orgBAdminPage }) => {
      // Create a record owned by Org A admin
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgAdmin.id,
        status: 'SECURED',
        filename: `e2e_cross_tenant_list_${Date.now()}.pdf`,
      });
      createdAnchorIds.push(anchor.id);

      // Org B admin views their own dashboard/organization page
      await orgBAdminPage.goto('/organization');
      await expect(
        orgBAdminPage.getByText('Organization')
      ).toBeVisible({ timeout: 10000 });

      // The Org A record filename should NOT appear anywhere on the page
      await expect(
        orgBAdminPage.getByText(anchor.filename)
      ).not.toBeVisible();
    });

    test('Org A admin cannot see Org B records in organization registry', async ({ orgAdminPage }) => {
      // Create a record owned by Org B admin (Midwest Medical)
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgBAdmin.id,
        status: 'SECURED',
        filename: `e2e_cross_tenant_orgB_${Date.now()}.pdf`,
      });
      createdAnchorIds.push(anchor.id);

      // Org A admin views their organization page
      await orgAdminPage.goto('/organization');
      await expect(
        orgAdminPage.getByText('Organization Records')
      ).toBeVisible({ timeout: 10000 });

      // The Org B record should NOT appear
      await expect(
        orgAdminPage.getByText(anchor.filename)
      ).not.toBeVisible();
    });
  });
});
