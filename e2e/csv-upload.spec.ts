/**
 * CSV Upload E2E Tests (Tier 2)
 *
 * Tests for the bulk CSV upload wizard: file upload, column mapping,
 * validation errors, record counts, and reset behavior.
 *
 * @created 2026-03-10 11:30 PM EST
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
  await expect(dialog.getByRole('heading', { name: /^Secure Document$/i })).toBeVisible();

  return dialog;
}

async function openBulkUploadDialog(page: Page): Promise<Locator> {
  const dialog = await openSecureDocumentDialog(page);

  await dialog.locator('input[type="file"]').first().setInputFiles([
    {
      name: 'bulk-route-one.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('bulk route one'),
    },
    {
      name: 'bulk-route-two.pdf',
      mimeType: 'application/pdf',
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
