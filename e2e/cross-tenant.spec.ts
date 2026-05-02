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

import type { Page } from '@playwright/test';
import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

async function expectRecordBlocked(page: Page, recordId: string, protectedValues: string[]) {
  const recordPath = `/records/${recordId}`;

  await page.waitForFunction(
    (path) => {
      if (window.location.pathname !== path) return true;

      return Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
        .some((el) => el.textContent?.trim() === 'Record Not Found');
    },
    recordPath,
    { timeout: 10000 }
  );

  if (new URL(page.url()).pathname === recordPath) {
    await expect(page.getByRole('heading', { name: 'Record Not Found' })).toBeVisible();
  } else {
    await expect(page).not.toHaveURL(new RegExp(`${recordPath}$`));
  }

  for (const value of protectedValues) {
    await expect(page.locator('body')).not.toContainText(value);
  }
}

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

      // Should show an access-safe state or redirect — NOT the record details.
      await expectRecordBlocked(individualPage, anchor.id, [
        'e2e_cross_tenant_org_record.pdf',
        anchor.fingerprint,
      ]);
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

      // Should show an access-safe state or redirect — NOT the record details.
      await expectRecordBlocked(orgAdminPage, anchor.id, [
        'e2e_cross_tenant_individual_record.pdf',
        anchor.fingerprint,
      ]);
    });
  });

  test.describe('Org-to-Org Isolation', () => {
    test('Org A admin cannot view Org B records via direct URL', async ({ orgAdminPage }) => {
      // Create a record owned by Org B admin (Arkova platform org)
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgBAdmin.id,
        status: 'SECURED',
        filename: 'e2e_cross_tenant_orgB_record.pdf',
      });
      createdAnchorIds.push(anchor.id);

      // Org A admin (Acme) tries to access Org B's record
      await orgAdminPage.goto(`/records/${anchor.id}`);

      // Should show an access-safe state or redirect — NOT the record details.
      await expectRecordBlocked(orgAdminPage, anchor.id, [
        'e2e_cross_tenant_orgB_record.pdf',
        anchor.fingerprint,
      ]);
    });

    test('Org B records do not appear in Org A dashboard list', async ({ orgAdminPage }) => {
      // Create a record owned by Org B admin (Arkova platform org)
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.orgBAdmin.id,
        status: 'SECURED',
        filename: `e2e_cross_tenant_orgB_list_${Date.now()}.pdf`,
      });
      createdAnchorIds.push(anchor.id);

      // Org A admin views their own dashboard/organization page
      await orgAdminPage.goto('/organization');
      await expect(orgAdminPage).toHaveURL(/\/organizations\/[0-9a-f-]+/i, { timeout: 10000 });

      // The Org B record filename should NOT appear anywhere on the page
      await expect(
        orgAdminPage.locator('body')
      ).not.toContainText(anchor.filename);
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
      await expect(orgAdminPage).toHaveURL(/\/organizations\/[0-9a-f-]+/i, { timeout: 10000 });

      // The Org B record should NOT appear
      await expect(
        orgAdminPage.locator('body')
      ).not.toContainText(anchor.filename);
    });
  });
});
