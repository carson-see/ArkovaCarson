/**
 * CSV Upload E2E Tests (Tier 2)
 *
 * Tests for the bulk CSV upload wizard: file upload, column mapping,
 * validation errors, record counts, and reset behavior.
 *
 * @created 2026-03-10 11:30 PM EST
 * @updated 2026-08-01 — a single spreadsheet drop (CSV/XLSX/XLS/TSV) no
 * longer routes straight to bulk mode. W2/F1 (founder ruling 2026-07-28,
 * `src/components/anchor/FileUpload.tsx` `dispatchFiles`) pauses a LONE
 * spreadsheet file on an explicit mode-choice step
 * (`data-testid="spreadsheet-mode-choice"`) so the user can pick "Import as
 * a list of records" vs "Secure this file as a document" — a mixed/multi-file
 * drop is untouched and still goes straight to bulk mode (see
 * `openBulkUploadDialog`, which uploads two files). This spec's single-CSV
 * helper now clicks through that choice before asserting the review step.
 * See docs/release/wave-merge-choreography-2026-08.md "Collision 2" for the
 * ratified behavior and precedent fix commit 0001a0f39 (same class of
 * stale-dispatch-expectation fix from the same merge wave).
 */

import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function openSecureDocumentDialog(page: Page): Promise<Locator> {
  await page.goto('/organization');

  const uploadButton = page.getByRole('button', { name: /^Secure Document$/i });
  await expect(uploadButton).toBeVisible({ timeout: 15_000 });
  await uploadButton.click();

  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Secure Document/i }).first();
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect(dialog.getByText('Secure Document', { exact: true }).first()).toBeVisible();

  return dialog;
}

async function openBulkUploadDialog(page: Page): Promise<Locator> {
  const dialog = await openSecureDocumentDialog(page);

  // SCRUM-2911 W1 (PR #1738, 2026-08-01): a multi-file drop only takes the
  // bulk-CSV-import path when EVERY dropped file is a spreadsheet
  // (`isBulkUploadFile` in FileUpload.tsx) — otherwise it routes to
  // `onMixedBatchDetected` / MixedBatchUploadWizard, the new mixed-format
  // batch anchoring flow. Two PDFs (the previous fixture here) now hit that
  // new path instead of Bulk Upload Records, so this helper must drop two
  // spreadsheet files to keep exercising the CSV bulk-upload wizard this
  // spec is actually testing. NOTE: as of this fix, the mixed-format batch
  // anchoring flow itself (MixedBatchUploadWizard, /api/v1/anchor/bulk) has
  // no E2E coverage — see e2e/agents.md.
  await dialog.locator('input[type="file"]').first().setInputFiles([
    {
      name: 'bulk-route-one.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('bulk route one'),
    },
    {
      name: 'bulk-route-two.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('bulk route two'),
    },
  ]);

  await expect(dialog.getByRole('heading', { name: 'Bulk Upload Records' })).toBeVisible();

  return dialog;
}

async function expectUploadStep(dialog: Locator) {
  await expect(dialog.getByText('Drop your CSV or Excel file here')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Select File$/i })).toBeVisible();
  await expect(dialog.locator('input#csv-file-upload[type="file"]')).toBeAttached();
  await expect(dialog.getByText(/Upload any spreadsheet/i)).toBeVisible();
  await expect(dialog.getByText(/Auto-detected columns/i)).toBeVisible();
}

async function openBulkUploadReview(
  page: Page,
  name: string,
  rows: string[],
  validCount: number,
  invalidCount: number
): Promise<Locator> {
  const dialog = await openSecureDocumentDialog(page);

  await dialog.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n')),
  });

  // W2/F1: a lone spreadsheet file pauses on the mode-choice step instead of
  // routing straight to bulk mode — pick "Import as a list of records" to
  // continue down the bulk-upload path this spec exercises.
  await expect(dialog.getByTestId('spreadsheet-mode-choice')).toBeVisible();
  await dialog.getByTestId('spreadsheet-mode-records').click();

  await expect(dialog.getByRole('heading', { name: 'Bulk Upload Records' })).toBeVisible();
  await expectReviewStep(dialog, validCount, invalidCount);

  return dialog;
}

async function expectReviewStep(dialog: Locator, validCount: number, invalidCount: number) {
  await expect(
    dialog.getByRole('heading', { name: 'Column Mapping' })
  ).toBeVisible({ timeout: 10_000 });
  const validRecordsLabel = dialog.getByText('Valid records', { exact: true });
  const invalidRecordsLabel = dialog.getByText('Invalid records', { exact: true });

  await expect(validRecordsLabel).toBeVisible();
  await expect(invalidRecordsLabel).toBeVisible();
  await expect(
    validRecordsLabel.locator('xpath=preceding-sibling::div[1]')
  ).toHaveText(String(validCount));
  await expect(
    invalidRecordsLabel.locator('xpath=preceding-sibling::div[1]')
  ).toHaveText(String(invalidCount));
}

test.describe('CSV Upload Wizard', () => {
  test.describe('Upload Step', () => {
    test('bulk upload wizard shows upload UI', async ({ orgAdminPage }) => {
      const dialog = await openBulkUploadDialog(orgAdminPage);

      await expectUploadStep(dialog);
    });

    test('CSV file upload parses and shows review step', async ({ orgAdminPage }) => {
      const dialog = await openBulkUploadReview(orgAdminPage, 'e2e-bulk-test.csv', [
        'fingerprint,filename,email',
        `${'a'.repeat(64)},test_doc_1.pdf,test1@example.com`,
        `${'b'.repeat(64)},test_doc_2.pdf,test2@example.com`,
      ], 2, 0);
      await expect(dialog.getByRole('button', { name: /^Process 2 Records$/i })).toBeVisible();
    });
  });

  test.describe('Validation', () => {
    test('shows validation errors for invalid CSV rows', async ({ orgAdminPage }) => {
      const dialog = await openBulkUploadReview(orgAdminPage, 'e2e-invalid-csv.csv', [
        'fingerprint,filename',
        'invalid-not-a-hash,bad_document.pdf',
        `${'c'.repeat(64)},good_document.pdf`,
      ], 1, 1);
      await expect(dialog.getByText('Validation Errors')).toBeVisible();
      await expect(
        dialog.getByText('Invalid fingerprint format (expected 64-character hex)')
      ).toBeVisible();
    });

    test('valid records count is displayed', async ({ orgAdminPage }) => {
      const dialog = await openBulkUploadReview(orgAdminPage, 'e2e-valid-csv.csv', [
        'fingerprint,filename',
        `${'d'.repeat(64)},valid_doc_1.pdf`,
        `${'e'.repeat(64)},valid_doc_2.pdf`,
        `${'f'.repeat(64)},valid_doc_3.pdf`,
      ], 3, 0);
      await expect(dialog.getByRole('button', { name: /^Process 3 Records$/i })).toBeVisible();
    });
  });

  test.describe('Reset', () => {
    test('back button resets wizard to upload step', async ({ orgAdminPage }) => {
      const dialog = await openBulkUploadReview(orgAdminPage, 'e2e-reset-csv.csv', [
        'fingerprint,filename',
        `${'1'.repeat(64)},reset_doc_1.pdf`,
      ], 1, 0);
      await dialog.getByRole('button', { name: /^Back$/i }).click();

      await expectUploadStep(dialog);
      await expect(dialog.getByRole('heading', { name: 'Column Mapping' })).toBeHidden();
    });
  });
});
