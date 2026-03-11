/**
 * Public Verification E2E Tests (P7-S7)
 *
 * Tests for the public verification flow where anyone can verify
 * a document using a public link without authentication.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Public Verification', () => {
  let testPublicId: string;
  let testAnchorId: string;
  const serviceClient = getServiceClient();

  test.beforeAll(async () => {
    const anchor = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_public_test.pdf',
    });

    testAnchorId = anchor.id;
    testPublicId = anchor.public_id;
  });

  test.afterAll(async () => {
    if (testAnchorId) {
      await deleteTestAnchor(serviceClient, testAnchorId);
    }
  });

  test('public verification page shows verified status for valid public_id', async ({ page }) => {
    test.skip(!testPublicId, 'No test public_id available');

    await page.goto(`/verify/${testPublicId}`);

    // Should show verified status
    await expect(page.getByText('Verified')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Document Verified')).toBeVisible();

    // Should show the filename
    await expect(page.getByText('e2e_public_test.pdf')).toBeVisible();

    // Should show fingerprint
    await expect(page.getByText('Fingerprint')).toBeVisible();

    // Should show verification ID
    await expect(page.getByText(new RegExp(`Verification ID.*${testPublicId}`))).toBeVisible();

    // Should show Arkova branding
    await expect(page.getByText('Secured by Arkova')).toBeVisible();
  });

  test('public verification page shows error for invalid public_id', async ({ page }) => {
    await page.goto('/verify/invalid_public_id_12345');

    // Should show verification failed
    await expect(page.getByText('Verification Failed')).toBeVisible({ timeout: 10000 });

    // Should show error message
    await expect(
      page.getByText(/Unable to verify|may not exist|not been verified/)
    ).toBeVisible();
  });

  test('public verification page does not expose sensitive data', async ({ page }) => {
    test.skip(!testPublicId, 'No test public_id available');

    await page.goto(`/verify/${testPublicId}`);
    await expect(page.getByText('Document Verified')).toBeVisible({ timeout: 10000 });

    // Should NOT show user ID or email
    await expect(page.getByText(SEED_USERS.individual.id)).not.toBeVisible();
    await expect(page.getByText(SEED_USERS.individual.email)).not.toBeVisible();
  });

  test('public verification page is accessible without authentication', async ({ page }) => {
    test.skip(!testPublicId, 'No test public_id available');

    await page.context().clearCookies();
    await page.goto(`/verify/${testPublicId}`);

    // Should NOT redirect to login
    await expect(page).not.toHaveURL(/\/auth/);

    // Should show verification content
    await expect(page.getByText('Document Verified')).toBeVisible({ timeout: 10000 });
  });

  test('public verification page shows file size when available', async ({ page }) => {
    test.skip(!testPublicId, 'No test public_id available');

    await page.goto(`/verify/${testPublicId}`);
    await expect(page.getByText('Document Verified')).toBeVisible({ timeout: 10000 });

    // Should show file size (12345 bytes ≈ 12.1 KB)
    await expect(page.getByText(/12\.1 KB|12345/)).toBeVisible();
  });
});
