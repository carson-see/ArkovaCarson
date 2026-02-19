/**
 * Public Verification E2E Tests (P7-S7)
 *
 * Tests for the public verification flow where anyone can verify
 * a document using a public link without authentication.
 */

import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

// Test configuration - matches local Supabase
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const DEMO_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

test.describe('Public Verification', () => {
  let testPublicId: string;
  let testAnchorId: string;
  let serviceClient: ReturnType<typeof createClient>;

  test.beforeAll(async () => {
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Create a secured anchor for testing
    const fingerprint = 'e2e_public_' + 'a'.repeat(53);

    // First create as PENDING
    const { data: anchor } = await serviceClient
      .from('anchors')
      .insert({
        user_id: DEMO_USER_ID,
        fingerprint: fingerprint,
        filename: 'e2e_public_test.pdf',
        file_size: 12345,
        status: 'PENDING',
      })
      .select()
      .single();

    if (anchor) {
      testAnchorId = anchor.id;

      // Update to SECURED to trigger public_id generation
      await serviceClient
        .from('anchors')
        .update({
          status: 'SECURED',
          chain_tx_id: 'e2e_receipt_xyz',
          chain_block_height: 99999,
          chain_timestamp: new Date().toISOString(),
        })
        .eq('id', testAnchorId);

      // Get the generated public_id
      const { data: updated } = await serviceClient
        .from('anchors')
        .select('public_id')
        .eq('id', testAnchorId)
        .single();

      if (updated?.public_id) {
        testPublicId = updated.public_id;
      }
    }
  });

  test.afterAll(async () => {
    // Cleanup test anchor
    if (testAnchorId) {
      await serviceClient.from('anchors').delete().eq('id', testAnchorId);
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

    // Should show network receipt
    await expect(page.getByText('e2e_receipt_xyz')).toBeVisible();

    // Should show verification ID
    await expect(page.getByText(`Verification ID: ${testPublicId}`)).toBeVisible();

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

    // Wait for content to load
    await expect(page.getByText('Document Verified')).toBeVisible({ timeout: 10000 });

    // Should NOT show user email or ID
    await expect(page.getByText('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).not.toBeVisible();
    await expect(page.getByText('user_demo@arkova.local')).not.toBeVisible();

    // Should NOT show organization ID
    await expect(page.getByText('11111111-1111-1111-1111-111111111111')).not.toBeVisible();
  });

  test('public verification page is accessible without authentication', async ({ page }) => {
    test.skip(!testPublicId, 'No test public_id available');

    // Clear any existing auth
    await page.context().clearCookies();

    // Navigate to public verification page
    await page.goto(`/verify/${testPublicId}`);

    // Should NOT redirect to login
    await expect(page).not.toHaveURL(/\/auth/);

    // Should show verification content
    await expect(page.getByText('Document Verified')).toBeVisible({ timeout: 10000 });
  });

  test('public verification page shows file size when available', async ({ page }) => {
    test.skip(!testPublicId, 'No test public_id available');

    await page.goto(`/verify/${testPublicId}`);

    // Wait for content to load
    await expect(page.getByText('Document Verified')).toBeVisible({ timeout: 10000 });

    // Should show file size
    await expect(page.getByText(/12\.1 KB|12345/)).toBeVisible();
  });
});
