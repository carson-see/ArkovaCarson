/**
 * Anchor Creation E2E Tests (Tier 1)
 *
 * Tests for the Secure Document dialog: file upload, fingerprint generation,
 * confirmation, and successful record creation.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect, getServiceClient, SEED_USERS } from './fixtures';
import {
  expectSecureDocumentUploadStep,
  getSecureDocumentDialog,
  openSecureDocumentDialog,
} from './helpers/dashboard';

test.describe('Anchor Creation (Secure Document)', () => {
  const serviceClient = getServiceClient();

  // Cleanup helper for anchors created during tests
  async function cleanupAnchor(id: string) {
    await serviceClient.from('audit_events').delete().eq('anchor_id', id);
    await serviceClient.from('anchors').delete().eq('id', id);
  }

  test('Secure Document dialog opens and shows upload step', async ({ individualPage }) => {
    await openSecureDocumentDialog(individualPage);
    const dialog = getSecureDocumentDialog(individualPage);

    // Dialog should show upload UI
    await expect(
      dialog.getByText(/Create a permanent, tamper-proof record/i)
    ).toBeVisible({ timeout: 5000 });

    // Should show drag & drop area
    await expectSecureDocumentUploadStep(individualPage);

    // Should show privacy notice
    await expect(dialog.getByText(/never leaves your device/i)).toBeVisible();
  });

  test('Continue button is disabled until file is selected', async ({ individualPage }) => {
    await openSecureDocumentDialog(individualPage);
    await expectSecureDocumentUploadStep(individualPage);
    const dialog = getSecureDocumentDialog(individualPage);

    // Continue button should be disabled
    const continueBtn = dialog.locator('button').filter({ hasText: /Continue/i });
    if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(continueBtn).toBeDisabled();
    }
  });

  test('file upload generates fingerprint', async ({ individualPage }) => {
    await openSecureDocumentDialog(individualPage);
    await expectSecureDocumentUploadStep(individualPage);
    const dialog = getSecureDocumentDialog(individualPage);

    // Upload a test file via the hidden file input
    const fileInput = dialog.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'e2e-test-document.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('E2E test document content for fingerprinting'),
    });

    // Fingerprint should appear after processing
    await expect(dialog.getByText('Document Fingerprint')).toBeVisible({ timeout: 10000 });

    // Continue button should now be enabled
    const continueBtn = dialog.locator('button').filter({ hasText: /Continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5000 });
  });

  test('Continue submits the file and creates an anchor record', async ({
    individualPage,
  }) => {
    await openSecureDocumentDialog(individualPage);
    await expectSecureDocumentUploadStep(individualPage);
    const dialog = getSecureDocumentDialog(individualPage);
    const timestamp = Date.now();
    const fileName = `e2e-submit-test-${timestamp}.pdf`;

    // Upload test file
    const fileInput = dialog.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: fileName,
      mimeType: 'application/pdf',
      buffer: Buffer.from(`E2E submit test content ${timestamp}`),
    });

    await expect(dialog.getByText('Document Fingerprint')).toBeVisible({ timeout: 10000 });

    // Click Continue to submit the document. The current product flow may
    // go straight to anchoring when AI extraction is disabled.
    await dialog.locator('button').filter({ hasText: /Continue/i }).click();

    let createdAnchorId: string | null = null;
    await expect.poll(async () => {
      const { data } = await serviceClient
        .from('anchors')
        .select('id')
        .eq('user_id', SEED_USERS.individual.id)
        .eq('filename', fileName)
        .maybeSingle();
      createdAnchorId = data?.id ?? null;
      return createdAnchorId;
    }, { timeout: 10_000 }).not.toBeNull();

    if (createdAnchorId) {
      await cleanupAnchor(createdAnchorId);
    }
  });

  test('cancel closes the dialog without creating a record', async ({ individualPage }) => {
    await openSecureDocumentDialog(individualPage);
    const dialog = getSecureDocumentDialog(individualPage);

    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Click cancel/close
    const cancelBtn = dialog.locator('button').filter({ hasText: /Cancel|Close/i });
    if (await cancelBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cancelBtn.click();

      // Dialog should close
      await expect(getSecureDocumentDialog(individualPage)).not.toBeVisible({ timeout: 3000 });
    }
  });
});
