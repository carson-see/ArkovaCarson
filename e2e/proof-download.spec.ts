/**
 * Proof Download E2E Tests (QA-E2E-05)
 *
 * Tests clicking PDF and JSON download buttons on record detail page
 * and verifies downloads are triggered.
 *
 * @created 2026-03-28
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Proof Download', () => {
  const serviceClient = getServiceClient();
  let securedAnchor: { id: string; public_id: string; fingerprint: string };

  test.beforeAll(async () => {
    const secured = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_proof_download_test.pdf',
    });

    if (!secured?.id || !secured?.public_id) {
      throw new Error('beforeAll: failed to create SECURED test anchor for proof download tests');
    }

    securedAnchor = {
      id: secured.id,
      public_id: secured.public_id,
      fingerprint: secured.fingerprint,
    };
  });

  test.afterAll(async () => {
    if (securedAnchor?.id) await deleteTestAnchor(serviceClient, securedAnchor.id);
  });

  test('PDF download button triggers file download', async ({ individualPage }) => {
    await individualPage.goto(`/records/${securedAnchor.id}`);
    await expect(individualPage.getByText('Record Details')).toBeVisible({ timeout: 10000 });

    // Wait for download proof section
    await expect(individualPage.getByText(/Download Proof Package/i)).toBeVisible();

    // Set up download listener before clicking
    const downloadPromise = individualPage.waitForEvent('download', { timeout: 10000 });

    // Click PDF download button
    await individualPage.getByRole('button', { name: /PDF/i }).click();

    // Verify download was triggered
    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    expect(filename).toBeTruthy();
    // PDF audit reports typically end with .pdf
    expect(filename.toLowerCase()).toContain('.pdf');
  });

  test('JSON download button triggers file download', async ({ individualPage }) => {
    await individualPage.goto(`/records/${securedAnchor.id}`);
    await expect(individualPage.getByText('Record Details')).toBeVisible({ timeout: 10000 });

    await expect(individualPage.getByText(/Download Proof Package/i)).toBeVisible();

    // Set up download listener before clicking
    const downloadPromise = individualPage.waitForEvent('download', { timeout: 10000 });

    // Click JSON download button
    await individualPage.getByRole('button', { name: /JSON/i }).click();

    // Verify download was triggered
    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    expect(filename).toBeTruthy();
    // JSON proof packages end with .json
    expect(filename.toLowerCase()).toContain('.json');
  });

  test('JSON proof package contains valid structure', async ({ individualPage }) => {
    await individualPage.goto(`/records/${securedAnchor.id}`);
    await expect(individualPage.getByText('Record Details')).toBeVisible({ timeout: 10000 });

    await expect(individualPage.getByText(/Download Proof Package/i)).toBeVisible();

    const downloadPromise = individualPage.waitForEvent('download', { timeout: 10000 });
    await individualPage.getByRole('button', { name: /JSON/i }).click();

    const download = await downloadPromise;

    // Read the downloaded file content
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString('utf-8');

    // Parse and validate structure
    const proof = JSON.parse(content);
    expect(proof).toHaveProperty('fingerprint');
    expect(proof).toHaveProperty('status');
    expect(proof.status).toBe('SECURED');
  });

  test('PENDING records do not show download proof section', async ({ individualPage }) => {
    // Create a PENDING anchor for this test
    const pending = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'PENDING',
      filename: 'e2e_proof_no_download_pending.pdf',
    });

    try {
      await individualPage.goto(`/records/${pending.id}`);
      await expect(individualPage.getByText('Record Details')).toBeVisible({ timeout: 10000 });

      // Pending records should NOT show download proof section
      // (or the buttons should be hidden/disabled)
      await expect(individualPage.getByText('Pending')).toBeVisible();

      // The Download Proof Package section should not be visible for PENDING
      await expect(individualPage.getByText(/Download Proof Package/i)).not.toBeVisible();
    } finally {
      await deleteTestAnchor(serviceClient, pending.id);
    }
  });
});
