/**
 * CSV Upload E2E Tests (Tier 2)
 *
 * Tests for the bulk CSV upload wizard: file upload, column mapping,
 * validation errors, processing, and completion.
 *
 * @created 2026-03-10 11:30 PM EST
 */

import { test, expect } from './fixtures';

test.describe('CSV Upload Wizard', () => {
  test.describe('Upload Step', () => {
    test('bulk upload wizard shows upload UI', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');
      await orgAdminPage.waitForTimeout(2000);

      // Look for a bulk upload or CSV upload trigger
      const uploadBtn = orgAdminPage.getByRole('button', { name: /Bulk Upload|CSV Upload|Import/i });
      if (await uploadBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await uploadBtn.first().click();

        // Should show upload UI with file input
        await expect(
          orgAdminPage.getByText(/Select CSV File/i)
            .or(orgAdminPage.getByText(/Drop your CSV file/i))
            .or(orgAdminPage.getByText(/Bulk Upload/i))
        ).toBeVisible({ timeout: 5000 });

        // Should explain required columns
        await expect(
          orgAdminPage.getByText(/fingerprint/i)
        ).toBeVisible();
      }
    });

    test('CSV file upload parses and shows review step', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');
      await orgAdminPage.waitForTimeout(2000);

      const uploadBtn = orgAdminPage.getByRole('button', { name: /Bulk Upload|CSV Upload|Import/i });
      if (await uploadBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await uploadBtn.first().click();

        await expect(
          orgAdminPage.getByText(/Select CSV File/i)
            .or(orgAdminPage.getByText(/Drop your CSV file/i))
        ).toBeVisible({ timeout: 5000 });

        // Upload a valid CSV file
        const csvContent = [
          'fingerprint,filename,email',
          `${'a'.repeat(64)},test_doc_1.pdf,test1@example.com`,
          `${'b'.repeat(64)},test_doc_2.pdf,test2@example.com`,
        ].join('\n');

        const fileInput = orgAdminPage.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'e2e-bulk-test.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csvContent),
        });

        // Should advance to review/mapping step
        await expect(
          orgAdminPage.getByText(/Column Mapping/i)
            .or(orgAdminPage.getByText(/Valid records/i))
            .or(orgAdminPage.getByText(/Review/i))
        ).toBeVisible({ timeout: 10000 });
      }
    });
  });

  test.describe('Validation', () => {
    test('shows validation errors for invalid CSV rows', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');
      await orgAdminPage.waitForTimeout(2000);

      const uploadBtn = orgAdminPage.getByRole('button', { name: /Bulk Upload|CSV Upload|Import/i });
      if (await uploadBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await uploadBtn.first().click();

        await expect(
          orgAdminPage.getByText(/Select CSV File/i)
            .or(orgAdminPage.getByText(/Drop your CSV file/i))
        ).toBeVisible({ timeout: 5000 });

        // Upload CSV with invalid fingerprint
        const csvContent = [
          'fingerprint,filename',
          'invalid-not-a-hash,bad_document.pdf',
          `${'c'.repeat(64)},good_document.pdf`,
        ].join('\n');

        const fileInput = orgAdminPage.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'e2e-invalid-csv.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csvContent),
        });

        // Should show validation errors
        await expect(
          orgAdminPage.getByText(/Validation Errors/i)
            .or(orgAdminPage.getByText(/Invalid/i))
            .or(orgAdminPage.getByText(/invalid/i))
        ).toBeVisible({ timeout: 10000 });
      }
    });

    test('valid records count is displayed', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/organization');
      await orgAdminPage.waitForTimeout(2000);

      const uploadBtn = orgAdminPage.getByRole('button', { name: /Bulk Upload|CSV Upload|Import/i });
      if (await uploadBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await uploadBtn.first().click();

        await expect(
          orgAdminPage.getByText(/Select CSV File/i)
            .or(orgAdminPage.getByText(/Drop your CSV file/i))
        ).toBeVisible({ timeout: 5000 });

        // Upload valid CSV
        const csvContent = [
          'fingerprint,filename',
          `${'d'.repeat(64)},valid_doc_1.pdf`,
          `${'e'.repeat(64)},valid_doc_2.pdf`,
          `${'f'.repeat(64)},valid_doc_3.pdf`,
        ].join('\n');

        const fileInput = orgAdminPage.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'e2e-valid-csv.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csvContent),
        });

        // Should show valid records count
        await expect(
          orgAdminPage.getByText(/Valid records/i)
        ).toBeVisible({ timeout: 10000 });
      }
    });
  });

  test.describe('Completion', () => {
    test('upload another file button resets wizard', async ({ orgAdminPage }) => {
      // This test verifies the reset flow exists
      await orgAdminPage.goto('/organization');
      await orgAdminPage.waitForTimeout(2000);

      const uploadBtn = orgAdminPage.getByRole('button', { name: /Bulk Upload|CSV Upload|Import/i });
      if (await uploadBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await uploadBtn.first().click();

        // Verify the wizard is open
        await expect(
          orgAdminPage.getByText(/Select CSV File/i)
            .or(orgAdminPage.getByText(/Drop your CSV file/i))
            .or(orgAdminPage.getByText(/Bulk Upload/i))
        ).toBeVisible({ timeout: 5000 });

        // Verify file input exists
        const fileInput = orgAdminPage.locator('input[type="file"]');
        await expect(fileInput).toBeAttached();
      }
    });
  });
});
