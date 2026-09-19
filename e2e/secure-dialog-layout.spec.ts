/**
 * UAT-10: real component/CSS geometry with isolated external boundaries.
 * Proves client layout and actions; no database write, provider, or anchoring proof.
 * Run with -c e2e/secure-dialog-layout.config.ts; no seeded account is needed.
 */
import { test, expect } from '@playwright/test';
import { ANCHOR_ID, assertLayout, CHILD_ORG_ID, LONG_NAME, openLayoutFixture } from './helpers/secure-dialog-layout';

test.use({ storageState: { cookies: [], origins: [] } });

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }, { width: 1280, height: 480 }, { width: 375, height: 480 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('single-document upload, review, confirm and success fit', async ({ page }, testInfo) => {
      const { httpRequests } = await openLayoutFixture(page);
      await assertLayout(page, testInfo, 'upload');
      await page.locator('input[type="file"]').setInputFiles({ name: LONG_NAME, mimeType: 'application/pdf', buffer: Buffer.from('Layout fixture document') });
      await expect(page.getByTestId('secure-document-continue')).toBeEnabled();
      await assertLayout(page, testInfo, 'fingerprinted');
      await page.getByTestId('secure-document-continue').dispatchEvent('click');
      await expect(page.getByTestId('extraction-review-continue')).toBeVisible();
      await assertLayout(page, testInfo, 'extraction-review');
      await page.getByTestId('review-edit-field0').click();
      await expect(page.getByTestId('review-input-field0')).toBeFocused();
      await assertLayout(page, testInfo, 'extraction-field-edit');
      await page.getByTestId('review-input-field0').fill('Edited fixture value');
      await page.getByTestId('review-save-field0').click();
      await expect(page.getByTestId('review-field-field0')).toContainText('Edited fixture value');
      await page.getByTestId('extraction-review-continue').click();
      await expect(page.getByTestId('securing-path-queue')).toBeVisible();
      await assertLayout(page, testInfo, 'confirm');
      await page.locator('#anchor-description').fill('Layout fixture description');
      await page.getByTestId('securing-path-queue').click();
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'success');
      const writes = httpRequests.filter(request => request.kind === 'POST /api/v1/anchor-self-service');
      expect(writes).toHaveLength(1);
      expect(writes[0].payload).toMatchObject({ filename: LONG_NAME, fingerprint_source: 'document_bytes', description: 'Layout fixture description', action: 'queue', metadata: { securing_path: 'queue' } });
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
      await openLayoutFixture(page, 'review', true);
      const csv = `fingerprint,filename,${'Long column heading '.repeat(5)}\n${'a'.repeat(64)},${LONG_NAME},value\n${'b'.repeat(64)},second.pdf,another value`;
      await page.locator('input[type="file"]').setInputFiles({ name: 'Records.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await expect(page.getByTestId('spreadsheet-mode-choice')).toBeVisible();
      await assertLayout(page, testInfo, 'spreadsheet-choice');
      await page.getByTestId('spreadsheet-mode-records').click();
      await expect(page.getByRole('heading', { name: 'Column Mapping', exact: true })).toBeVisible();
      await expect(page.getByLabel('Public description for every row')).toBeVisible();
      await expect(page.getByLabel('Private tags for every row')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add all to queue' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Secure all instantly' })).toBeVisible();
      await page.getByLabel('Public description for every row').fill('Quarterly spreadsheet import');
      await page.getByLabel('Private tags for every row').fill('legal, quarterly');
      await page.getByRole('button', { name: 'Add all to queue' }).focus();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Secure all instantly' })).toBeFocused();
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
      // The fixture exercises the production parent, which closes on completion.
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
      for (const label of ['Type', 'Subject', 'Attester', 'Claims', 'Jurisdiction']) {
        const lineCount = await page.getByText(label, { exact: true }).evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        });
        expect(lineCount, `${label} must remain an intact label beside or above the long value`).toBe(1);
      }
      await page.getByRole('button', { name: /Create Attestation/ }).click();
      await expect(page.getByText('Creating attestation and anchoring to network...', { exact: true })).toBeVisible();
      await assertLayout(page, testInfo, 'attestation-submitting');
    });

    test('instant capability controls fit without changing the selected path', async ({ page }, testInfo) => {
      const { httpRequests } = await openLayoutFixture(page, 'ai-off', true);
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
      const writes = httpRequests.filter(request => request.kind === 'POST /api/v1/anchor-self-service');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ payload: { action: 'instant', metadata: { securing_path: 'instant' } } });
      expect(writes[0].authorization).toContain('Bearer eyJ');
    });
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test.describe(`UAT-12 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('selected child keeps metadata while private tags use the atomic queue bridge', async ({ browser }, testInfo) => {
      async function submit(tagged: boolean) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const { httpRequests } = await openLayoutFixture(page, 'selected-child');
        await page.locator('input[type="file"]').setInputFiles({ name: LONG_NAME, mimeType: 'application/pdf', buffer: Buffer.from('UAT12 selected child fixture') });
        await page.getByTestId('secure-document-continue').click();
        await page.getByTestId('extraction-review-continue').click();
        await page.locator('#anchor-description').fill('Quarterly compliance evidence');
        if (tagged) {
          await page.getByLabel('Private tags').fill('legal, quarterly');
          await page.getByLabel('Organization tags').fill('audit');
          await assertLayout(page, testInfo, 'uat12-selected-child-tagged');
        }
        await page.getByTestId('securing-path-queue').click();
        await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
        const browserRequests = await page.evaluate(() => window.__layout.requests);
        await context.close();
        return [...browserRequests, ...httpRequests];
      }

      const plain = await submit(false);
      const tagged = await submit(true);
      const plainAtomic = plain.find(request => request.kind === 'POST /api/v1/anchor-self-service')?.payload;
      const atomic = tagged.find(request => request.kind === 'POST /api/v1/anchor-self-service')?.payload;
      expect(plainAtomic).toMatchObject({ org_id: CHILD_ORG_ID, description: 'Quarterly compliance evidence', metadata: { field0: expect.any(String), securing_path: 'queue' }, private_tags: { user: [], organization: [] } });
      expect(atomic).toMatchObject({ org_id: CHILD_ORG_ID, description: 'Quarterly compliance evidence', metadata: { field0: plainAtomic?.metadata && (plainAtomic.metadata as Record<string, unknown>).field0, securing_path: 'queue' }, private_tags: { user: ['legal', 'quarterly'], organization: ['audit'] } });
      expect(tagged.find(request => request.kind === 'POST /api/v1/anchor-self-service')?.authorization).toContain('Bearer eyJ');
      expect(tagged.find(request => request.kind === 'anchor-id-resolution')?.payload).toEqual({ id: ANCHOR_ID });
    });

    test('zero-credit purchase and member guidance remain usable', async ({ browser }, testInfo) => {
      const buyerContext = await browser.newContext({ viewport });
      const buyer = await buyerContext.newPage();
      await openLayoutFixture(buyer, 'personal-zero');
      await buyer.locator('input[type="file"]').setInputFiles({ name: 'personal.pdf', mimeType: 'application/pdf', buffer: Buffer.from('personal') });
      await buyer.getByTestId('secure-document-continue').click();
      const buyCredit = buyer.getByRole('button', { name: 'Buy 1 credit for $2' });
      await expect(buyCredit).toBeVisible();
      const popupPromise = buyer.waitForEvent('popup');
      await buyCredit.click();
      const checkout = await popupPromise;
      await expect(checkout).toHaveURL(/checkout=1/);
      await checkout.close();
      await assertLayout(buyer, testInfo, 'uat12-personal-purchase');
      await buyerContext.close();

      const memberContext = await browser.newContext({ viewport });
      const member = await memberContext.newPage();
      await openLayoutFixture(member, 'member-zero');
      await member.locator('input[type="file"]').setInputFiles({ name: 'member.pdf', mimeType: 'application/pdf', buffer: Buffer.from('member') });
      await member.getByTestId('secure-document-continue').click();
      await expect(member.getByText('Ask an organization administrator to purchase credits.')).toBeVisible();
      await expect(member.getByRole('button', { name: 'Buy 1 credit for $2' })).toHaveCount(0);
      await assertLayout(member, testInfo, 'uat12-member-guidance');
      await memberContext.close();
    });

    test('durable instant status is truthful and rearm is explicit and single-flight', async ({ browser }, testInfo) => {
      const heldContext = await browser.newContext({ viewport });
      const held = await heldContext.newPage();
      await openLayoutFixture(held, 'status-held');
      await held.locator('input[type="file"]').setInputFiles({ name: 'held.pdf', mimeType: 'application/pdf', buffer: Buffer.from('held') });
      await held.getByTestId('secure-document-continue').click();
      await held.getByTestId('securing-path-instant').click();
      await expect(held.getByTestId('instant-submission-status')).toContainText('on hold while network evidence is checked');
      await expect(held.getByText('The request is on hold for reconciliation. No network receipt or completion time is promised.')).toBeVisible();
      await expect(held.getByText(/you.ll see the network receipt shortly/i)).toHaveCount(0);
      await expect(held.getByText(/permanently verified/i)).toHaveCount(0);
      await expect(held.getByRole('button', { name: 'Try instant securing again' })).toHaveCount(0);
      await assertLayout(held, testInfo, 'uat12-instant-held');
      await heldContext.close();

      for (const state of [
        { scenario: 'status-failed', body: 'The document was saved, but instant securing stopped safely. This does not confirm network submission.', artifact: 'uat12-instant-failed' },
        { scenario: 'status-no-intent', body: 'The document was saved, but its network-submission state is unavailable. Refresh the status before acting.', artifact: 'uat12-instant-status-unavailable' },
        { scenario: 'status-loading', body: 'The document was saved, but its network-submission state is unavailable. Refresh the status before acting.', artifact: 'uat12-instant-status-loading' },
      ]) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await openLayoutFixture(page, state.scenario);
        await page.locator('input[type="file"]').setInputFiles({ name: `${state.scenario}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(state.scenario) });
        await page.getByTestId('secure-document-continue').click();
        await page.getByTestId('securing-path-instant').click();
        await expect(page.getByText(state.body)).toBeVisible();
        await expect(page.getByText(/you.ll see the network receipt shortly/i)).toHaveCount(0);
        await expect(page.getByText(/permanently verified/i)).toHaveCount(0);
        await assertLayout(page, testInfo, state.artifact);
        await context.close();
      }

      const retryContext = await browser.newContext({ viewport });
      const retry = await retryContext.newPage();
      const { httpRequests } = await openLayoutFixture(retry, 'needs-credit');
      await retry.locator('input[type="file"]').setInputFiles({ name: 'retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from('same-fingerprint') });
      await retry.getByTestId('secure-document-continue').click();
      await retry.getByTestId('securing-path-instant').click();
      const rearm = retry.getByRole('button', { name: 'Try instant securing again' });
      await expect(rearm).toBeVisible();
      await rearm.dblclick();
      await expect(retry.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
      const submissions = httpRequests.filter(request => request.kind === 'POST /api/v1/anchor-self-service');
      expect(submissions).toHaveLength(2);
      expect(submissions[0]?.payload?.fingerprint).toBe(submissions[1]?.payload?.fingerprint);
      expect(submissions[1]?.payload?.action).toBe('instant');
      await retryContext.close();
    });
  });
}
