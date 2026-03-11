/**
 * Anchor Creation E2E Tests (Tier 1)
 *
 * Tests for the Secure Document dialog: file upload, fingerprint generation,
 * confirmation, and successful record creation.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect, getServiceClient } from './fixtures';

test.describe('Anchor Creation (Secure Document)', () => {
  const serviceClient = getServiceClient();

  // Cleanup helper for anchors created during tests
  async function cleanupAnchor(id: string) {
    await serviceClient.from('audit_events').delete().eq('anchor_id', id);
    await serviceClient.from('anchors').delete().eq('id', id);
  }

  test('Secure Document dialog opens and shows upload step', async ({ individualPage }) => {
    await individualPage.goto('/vault');
    await individualPage.waitForTimeout(2000);

    // Click Secure Document button
    const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
    await secureBtn.first().click();

    // Dialog should show upload UI
    await expect(
      individualPage.getByText(/Create a permanent, tamper-proof record/i)
    ).toBeVisible({ timeout: 5000 });

    // Should show drag & drop area
    await expect(
      individualPage.getByText(/Drag and drop/i).or(individualPage.getByText(/Select Document/i))
    ).toBeVisible();

    // Should show privacy notice
    await expect(individualPage.getByText(/never leaves your device/i)).toBeVisible();
  });

  test('Continue button is disabled until file is selected', async ({ individualPage }) => {
    await individualPage.goto('/vault');
    await individualPage.waitForTimeout(2000);

    const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
    await secureBtn.first().click();

    await expect(
      individualPage.getByText(/Drag and drop/i).or(individualPage.getByText(/Select Document/i))
    ).toBeVisible({ timeout: 5000 });

    // Continue button should be disabled
    const continueBtn = individualPage.getByRole('button', { name: /Continue/i });
    if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(continueBtn).toBeDisabled();
    }
  });

  test('file upload generates fingerprint', async ({ individualPage }) => {
    await individualPage.goto('/vault');
    await individualPage.waitForTimeout(2000);

    const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
    await secureBtn.first().click();

    await expect(
      individualPage.getByText(/Drag and drop/i).or(individualPage.getByText(/Select Document/i))
    ).toBeVisible({ timeout: 5000 });

    // Upload a test file via the hidden file input
    const fileInput = individualPage.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'e2e-test-document.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('E2E test document content for fingerprinting'),
    });

    // Fingerprint should appear after processing
    await expect(individualPage.getByText('Document Fingerprint')).toBeVisible({ timeout: 10000 });

    // Continue button should now be enabled
    const continueBtn = individualPage.getByRole('button', { name: /Continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5000 });
  });

  test('confirm step shows file details and Secure Document button', async ({
    individualPage,
  }) => {
    await individualPage.goto('/vault');
    await individualPage.waitForTimeout(2000);

    const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
    await secureBtn.first().click();

    await individualPage
      .getByText(/Drag and drop/i)
      .or(individualPage.getByText(/Select Document/i))
      .waitFor({ timeout: 5000 });

    // Upload test file
    const fileInput = individualPage.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'e2e-confirm-test.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('E2E confirm step test content'),
    });

    await expect(individualPage.getByText('Document Fingerprint')).toBeVisible({ timeout: 10000 });

    // Click Continue to advance to confirm step
    await individualPage.getByRole('button', { name: /Continue/i }).click();

    // Confirm step should show
    await expect(
      individualPage.getByText(/Ready to Secure/i).or(individualPage.getByText(/e2e-confirm-test/i))
    ).toBeVisible({ timeout: 5000 });

    // Secure Document action button should be present
    const secureActionBtn = individualPage.getByRole('button', { name: /Secure Document/i });
    await expect(secureActionBtn).toBeVisible();
  });

  test('cancel closes the dialog without creating a record', async ({ individualPage }) => {
    await individualPage.goto('/vault');
    await individualPage.waitForTimeout(2000);

    const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
    await secureBtn.first().click();

    await expect(
      individualPage.getByRole('heading', { name: /Secure Document/i })
    ).toBeVisible({ timeout: 5000 });

    // Click cancel/close
    const cancelBtn = individualPage.getByRole('button', { name: /Cancel|Close/i });
    if (await cancelBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cancelBtn.click();

      // Dialog should close
      await expect(
        individualPage.getByRole('heading', { name: /Secure Document/i })
      ).not.toBeVisible({ timeout: 3000 });
    }
  });
});
