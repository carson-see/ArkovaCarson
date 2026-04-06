/**
 * Provenance Timeline E2E Tests (COMP-02)
 *
 * Tests for the provenance timeline component on the public verification page.
 * Verifies the collapsible timeline renders and can be expanded.
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Provenance Timeline', () => {
  let testPublicId: string;
  let testAnchorId: string;
  const serviceClient = getServiceClient();

  test.beforeAll(async () => {
    const anchor = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_provenance_test.pdf',
    });

    if (!anchor?.id || !anchor?.public_id) {
      throw new Error('beforeAll: failed to create test anchor — cannot run provenance timeline tests');
    }

    testAnchorId = anchor.id;
    testPublicId = anchor.public_id;
  });

  test.afterAll(async () => {
    if (testAnchorId) {
      await deleteTestAnchor(serviceClient, testAnchorId);
    }
  });

  test('provenance timeline section is visible on verification page', async ({ page }) => {
    await page.goto(`/verify/${testPublicId}`);

    await expect(page.getByText('Provenance Timeline')).toBeVisible({ timeout: 10000 });
  });

  test('provenance timeline can be expanded', async ({ page }) => {
    await page.goto(`/verify/${testPublicId}`);

    const toggle = page.getByText('Provenance Timeline');
    await expect(toggle).toBeVisible({ timeout: 10000 });
    await toggle.click();

    // After expanding, should show at least the upload event
    await expect(page.getByText('Credential Uploaded')).toBeVisible({ timeout: 5000 });
  });
});
