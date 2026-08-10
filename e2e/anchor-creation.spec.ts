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

    await dialog.locator('button').filter({ hasText: /Continue/i }).click();

    // AI extraction is on by default (seed). In CI it fails (no AI service),
    // showing a recovery step. waitFor handles the async wait that isVisible() cannot.
    const skipBtn = dialog.locator('button').filter({ hasText: /Anchor Without Metadata/i });
    try {
      await skipBtn.waitFor({ state: 'visible', timeout: 25_000 });
      await skipBtn.click();
    } catch {
      // AI was off — handleUploadContinue's else-branch routed straight to the
      // confirm step (QUEUE-01). Either way we land on the securing-path choice
      // below; neither branch creates the anchor on its own any more.
    }

    // QUEUE-01 / SCRUM-2894: every path (including the extraction-failed
    // "Anchor Without Metadata" skip above) now lands on the confirm step
    // instead of calling handleConfirm([]) directly — the anchor is only
    // created once the securing-path choice is made. This sprint only
    // "Add to Queue" is exposed (Secure Instantly is R5-dark), so that is
    // the confirm button to click here.
    // FLAKE FIX: this step is UNCONDITIONAL, so assert it instead of probing it.
    // Both branches above (extraction-failed Skip, and the AI-off Continue)
    // `await autoSelectTemplate('OTHER')` — a live Supabase round-trip to
    // `credential_templates` — BEFORE `setStep('confirm')`, and the confirm step
    // always renders `securing-path-queue`. The previous
    // `if (await ...isVisible({ timeout: 10_000 }).catch(() => false))` guard
    // turned a slow round-trip into a SILENT SKIP: the click never fired, the
    // anchor was never created, and the run failed 15s later in the poll below
    // with a misleading "anchor row never appeared" — then passed on retry.
    // `toBeVisible` makes Playwright WAIT for the step rather than race it, and
    // fails at the real cause if it genuinely never arrives.
    const confirmQueueBtn = dialog.getByTestId('securing-path-queue');
    await expect(confirmQueueBtn).toBeVisible({ timeout: 30_000 });
    await confirmQueueBtn.click();

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
    }, { timeout: 15_000 }).not.toBeNull();

    if (createdAnchorId) {
      await cleanupAnchor(createdAnchorId);
    }
  });

  /**
   * Regression: the drop zone's full-bleed `<input type="file">` painted over
   * the Remove button and swallowed its clicks. Full root cause + fix in
   * `e2e/agents.md` (2026-07-28 entry).
   *
   * MUST stay E2E: jsdom has no layout or hit-testing, so `fireEvent.click`
   * dispatches straight at the target and passes against the broken build.
   * Asserts the OUTCOME (button is the hit-test winner and the click lands),
   * not the CSS mechanism, so it holds if the fix is ever reimplemented.
   */
  test('Remove file button is not intercepted by the drop-zone input', async ({
    individualPage,
  }) => {
    await openSecureDocumentDialog(individualPage);
    await expectSecureDocumentUploadStep(individualPage);
    const dialog = getSecureDocumentDialog(individualPage);

    const fileInput = dialog.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'e2e-remove-intercept.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('E2E remove-button hit-test regression'),
    });

    await expect(dialog.getByText('Document Fingerprint')).toBeVisible({ timeout: 10_000 });

    // `exact: true` is required: the drop-zone wrapper is itself a
    // `div[role="button"]`, and its accessible name is computed from its
    // subtree — so it swallows the sr-only "Remove file" text and a default
    // (substring) name match resolves to 2 elements.
    const removeBtn = dialog.getByRole('button', { name: 'Remove file', exact: true });
    // Not redundant with the click below: this guarantees a non-zero box
    // before the hit-test measures its centre point.
    await expect(removeBtn).toBeVisible();

    // Explicit hit-test so a regression reports the actual interceptor rather
    // than a bare click timeout. `elementFromPoint` is the same paint-order
    // resolution a real user click goes through.
    const topElementAtButtonCenter = await removeBtn.evaluate((btn) => {
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit) return 'NONE (outside viewport)';
      return btn.contains(hit)
        ? 'REMOVE_BUTTON'
        : `${hit.tagName}[type=${hit.getAttribute('type') ?? 'n/a'}] class="${hit.className}"`;
    });
    expect(topElementAtButtonCenter).toBe('REMOVE_BUTTON');

    // Real trusted click — Playwright's actionability check fails with
    // "…intercepts pointer events" against the unfixed build.
    await removeBtn.click({ timeout: 5_000 });

    // handleRemove() actually ran: back to the empty drop zone.
    await expect(dialog.getByText('Document Fingerprint')).toBeHidden();
    await expect(dialog.getByText(/Drag and drop/i).first()).toBeVisible();
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
