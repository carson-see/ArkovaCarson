/**
 * Record Detail E2E Tests (Tier 1)
 *
 * Tests for record detail page: metadata display, fingerprint, status,
 * lifecycle timeline, proof downloads, and QR code.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Record Detail', () => {
  const serviceClient = getServiceClient();
  let securedAnchor: { id: string; public_id: string; fingerprint: string };
  let pendingAnchor: { id: string; fingerprint: string };

  test.beforeAll(async () => {
    // Create a SECURED anchor for detail tests
    const secured = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_record_detail_secured.pdf',
    });

    // Fail loudly if test data setup didn't work — never silently skip
    if (!secured?.id || !secured?.public_id) {
      throw new Error('beforeAll: failed to create SECURED test anchor — cannot run record detail tests');
    }

    securedAnchor = {
      id: secured.id,
      public_id: secured.public_id,
      fingerprint: secured.fingerprint,
    };

    // Create a PENDING anchor for pending state tests
    const pending = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'PENDING',
      filename: 'e2e_record_detail_pending.pdf',
    });

    if (!pending?.id) {
      throw new Error('beforeAll: failed to create PENDING test anchor — cannot run record detail tests');
    }

    pendingAnchor = { id: pending.id, fingerprint: pending.fingerprint };
  });

  test.afterAll(async () => {
    if (securedAnchor?.id) await deleteTestAnchor(serviceClient, securedAnchor.id);
    if (pendingAnchor?.id) await deleteTestAnchor(serviceClient, pendingAnchor.id);
  });

  test.describe('SECURED Record', () => {
    test('shows record details page with all sections', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);

      // Page title
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Subtitle
      await expect(individualPage.getByText(/View and verify/i)).toBeVisible();

      // Status badge should show Secured
      await expect(individualPage.getByText('Secured', { exact: true }).first()).toBeVisible();
    });

    test('shows document fingerprint with copy button', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Fingerprint section
      await expect(individualPage.getByText(/Document Fingerprint/).first()).toBeVisible();

      // Copy button
      const copyBtn = individualPage.getByRole('button', { name: /Copy document fingerprint/i });
      await expect(copyBtn).toBeVisible();
    });

    test('shows filename and file metadata', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Filename
      await expect(individualPage.getByText('e2e_record_detail_secured.pdf')).toBeVisible();
    });

    test('shows QR code for SECURED records', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // QR Code section should be visible for SECURED records
      await expect(individualPage.getByText('Verification QR Code')).toBeVisible();
    });

    test('shows download proof package buttons', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Download proof section
      await expect(individualPage.getByText(/Download Proof Package/i)).toBeVisible();

      // PDF and JSON buttons
      await expect(individualPage.getByRole('button', { name: /PDF/i })).toBeVisible();
      await expect(individualPage.getByRole('button', { name: /JSON/i })).toBeVisible();
    });

    test('shows lifecycle timeline', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Lifecycle section
      await expect(individualPage.getByText('Record Lifecycle')).toBeVisible();
    });
  });

  test.describe('PENDING Record', () => {
    test('shows Pending status badge', async ({ individualPage }) => {

      await individualPage.goto(`/records/${pendingAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Status should show Pending
      await expect(individualPage.getByText('Pending', { exact: true }).first()).toBeVisible();
    });

    test('does not show QR code for PENDING records', async ({ individualPage }) => {

      await individualPage.goto(`/records/${pendingAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // QR Code should NOT be visible for PENDING
      await expect(individualPage.getByText('Verification QR Code')).not.toBeVisible();
    });
  });

  test.describe('Error States', () => {
    test('shows error for non-existent record', async ({ individualPage }) => {
      await individualPage.goto('/records/00000000-0000-0000-0000-000000000000');

      // Should show error state
      await expect(
        individualPage.getByText(/Record Not Found/i)
          .or(individualPage.getByText(/does not exist/i))
          .first()
      ).toBeVisible({ timeout: 10000 });
    });
  });
});
