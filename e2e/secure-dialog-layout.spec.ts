/**
 * UAT-10: real component/CSS geometry with isolated external boundaries.
 * Proves client layout and actions; no database write, provider, or anchoring proof.
 * Run with -c e2e/secure-dialog-layout.config.ts; no seeded account is needed.
 */
import { test, expect } from '@playwright/test';
import { assertLayout, LONG_NAME, openLayoutFixture } from './helpers/secure-dialog-layout';

test.use({ storageState: { cookies: [], origins: [] } });

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }, { width: 1280, height: 480 }, { width: 375, height: 480 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('single-document upload, review, confirm and success fit', async ({ page }, testInfo) => {
      await openLayoutFixture(page);
      await assertLayout(page, testInfo, 'upload');
      await page.locator('input[type="file"]').setInputFiles({ name: LONG_NAME, mimeType: 'application/pdf', buffer: Buffer.from('Layout fixture document') });
      await expect(page.getByTestId('secure-document-continue')).toBeEnabled();
      await assertLayout(page, testInfo, 'fingerprinted');
      await page.getByTestId('secure-document-continue').click();
      await expect(page.getByTestId('extraction-review-continue')).toBeVisible();
      await assertLayout(page, testInfo, 'extraction-review');
      await page.getByTestId('extraction-review-continue').click();
      await expect(page.getByTestId('securing-path-queue')).toBeVisible();
      await assertLayout(page, testInfo, 'confirm');
      await page.locator('#anchor-description').fill('Layout fixture description');
      await page.getByTestId('securing-path-queue').click();
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'success');
      const writes = await page.evaluate(() => window.__layout.requests.filter(request => request.kind === 'anchors'));
      expect(writes).toHaveLength(1);
      expect(writes[0].payload).toMatchObject({ filename: LONG_NAME, fingerprint_source: 'document_bytes', description: 'Layout fixture description', metadata: { securing_path: 'queue' } });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    for (const scenario of ['extracting', 'extraction-failed', 'privacy-blocked', 'processing', 'error']) {
      test(`${scenario} and its recovery actions fit`, async ({ page }, testInfo) => {
        await openLayoutFixture(page, scenario);
        await page.locator('input[type="file"]').setInputFiles({ name: LONG_NAME, mimeType: 'application/pdf', buffer: Buffer.from('Layout fixture document') });
        await expect(page.getByTestId('secure-document-continue')).toBeEnabled();
        await page.getByTestId('secure-document-continue').click();
        if (scenario === 'processing' || scenario === 'error') {
          await page.getByTestId('extraction-review-continue').click();
          await page.getByTestId('securing-path-queue').click();
          await expect(page.getByText(scenario === 'processing' ? 'Securing your document...' : 'Securing Failed', { exact: true })).toBeVisible();
        } else if (scenario === 'privacy-blocked') {
          await expect(page.getByTestId('privacy-blocked')).toBeVisible();
        } else if (scenario === 'extraction-failed') {
          await expect(page.getByRole('button', { name: /Enter.*Manually/i })).toBeVisible();
        } else {
          await expect(page.getByRole('button', { name: /Skip AI Analysis/i })).toBeVisible();
        }
        await assertLayout(page, testInfo, scenario);
        if (scenario === 'extracting' || scenario === 'extraction-failed') {
          await page.getByRole('button', { name: scenario === 'extracting' ? /Skip AI Analysis/i : /Enter.*Manually/i }).click();
          await expect(page.getByText('Choose a template for this credential', { exact: true })).toBeVisible();
          await assertLayout(page, testInfo, 'template');
          await page.getByRole('button', { name: 'Skip', exact: true }).click();
          await expect(page.getByTestId('securing-path-queue')).toBeVisible();
        }
      });
    }

    test('spreadsheet choice, mapping, extraction and processing fit', async ({ page }, testInfo) => {
      await openLayoutFixture(page);
      const csv = `fingerprint,filename,${'Long column heading '.repeat(5)}\n${'a'.repeat(64)},${LONG_NAME},value\n${'b'.repeat(64)},second.pdf,another value`;
      await page.locator('input[type="file"]').setInputFiles({ name: 'Records.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await expect(page.getByTestId('spreadsheet-mode-choice')).toBeVisible();
      await assertLayout(page, testInfo, 'spreadsheet-choice');
      await page.getByTestId('spreadsheet-mode-records').click();
      await expect(page.getByRole('heading', { name: 'Column Mapping', exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'bulk-review');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.getByText('Select File', { exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'bulk-upload');
      await page.locator('input[type=file]').setInputFiles({ name: 'Records.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await expect(page.getByRole('heading', { name: 'Column Mapping', exact: true })).toBeVisible();
      await page.getByRole('button', { name: /Process 2 Records/i }).click();
      await expect(page.getByRole('button', { name: 'Extract (2 rows)', exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'bulk-extraction');
      await page.getByRole('button', { name: 'Extract (2 rows)', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Try Again', exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'bulk-extraction-error');
      await page.getByRole('button', { name: 'Skip', exact: true }).click();
      await expect(page.getByText('Processing records...', { exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'bulk-processing');
      await page.evaluate(() => window.__layout.finishBulk?.());
      // The actual parent closes on completion; there is no persistent bulk completion dialog.
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('spreadsheet extraction progress fits and retry remains reachable', async ({ page }, testInfo) => {
      await openLayoutFixture(page, 'bulk-extracting');
      const csv = `fingerprint,filename\n${'a'.repeat(64)},record.pdf`;
      await page.locator('input[type=file]').setInputFiles({ name: 'Records.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByTestId('spreadsheet-mode-records').click();
      await page.getByRole('button', { name: /Process 1 Records/ }).click();
      await page.getByRole('button', { name: 'Extract (1 rows)', exact: true }).click();
      await expect(page.getByText('Analyzing 1 rows...', { exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'bulk-extracting');
      await page.evaluate(() => window.__layout.finishExtraction?.());
      await expect(page.getByRole('button', { name: 'Try Again', exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'bulk-retry');
    });

    for (const scenario of ['mixed-fingerprinting', 'mixed-submitting', 'mixed-error', 'mixed-blocked', 'mixed-complete']) {
      test(`${scenario} fits`, async ({ page }, testInfo) => {
        await openLayoutFixture(page, scenario);
        await page.locator('input[type="file"]').setInputFiles([
          { name: LONG_NAME, mimeType: 'application/pdf', buffer: Buffer.from('one') },
          { name: `${'another-long-name-'.repeat(8)}.docx`, mimeType: 'application/octet-stream', buffer: Buffer.from('two') },
        ]);
        const labels: Record<string, RegExp> = {
          'mixed-fingerprinting': /Fingerprinting documents/i, 'mixed-submitting': /Securing 2 documents/i,
          'mixed-error': /Failed to secure the batch/i, 'mixed-blocked': /requires an organization account/i, 'mixed-complete': /Done/i,
        };
        await expect(page.getByText(labels[scenario]).first()).toBeVisible();
        await assertLayout(page, testInfo, scenario);
      });
    }

    test('attestation review and submission fit', async ({ page }, testInfo) => {
      await openLayoutFixture(page, 'attestation-submitting');
      const attestation = { attestation_type: 'VERIFICATION', subject_identifier: 'SubjectReference'.repeat(14), attester_name: 'LongAttesterName'.repeat(14), claims: [{ claim: 'A bounded fixture claim' }], summary: 'Summary '.repeat(70), jurisdiction: 'LongJurisdiction'.repeat(8) };
      await page.locator('input[type="file"]').setInputFiles({ name: 'attestation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(attestation)) });
      await expect(page.getByText('Attestation detected', { exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'attestation-review');
      await page.getByRole('button', { name: /Create Attestation/ }).click();
      await expect(page.getByText('Creating attestation and anchoring to network...', { exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'attestation-submitting');
    });

    test('instant capability controls fit without changing the selected path', async ({ page }, testInfo) => {
      await openLayoutFixture(page, 'ai-off', true);
      await page.locator('input[type="file"]').setInputFiles({ name: LONG_NAME, mimeType: 'application/pdf', buffer: Buffer.from('Layout fixture document') });
      await expect(page.getByTestId('secure-document-continue')).toBeEnabled();
      await page.getByTestId('secure-document-continue').click();
      await expect(page.getByTestId('securing-path-instant')).toBeVisible();
      await assertLayout(page, testInfo, 'confirm-instant-capability');
      await page.getByTestId('securing-path-instant').focus();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('securing-path-queue')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByTestId('securing-path-instant')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
      const writes = await page.evaluate(() => window.__layout.requests.filter(request => request.kind === 'anchors'));
      expect(writes).toHaveLength(1);
      expect(writes[0].payload).toMatchObject({ metadata: { securing_path: 'instant' } });
    });
  });
}
