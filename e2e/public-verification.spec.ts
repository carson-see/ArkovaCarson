/**
 * Public Verification E2E Tests (P7-S7)
 *
 * Tests for the public verification flow where anyone can verify
 * a document using a public link without authentication.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import {
  test,
  expect,
  getServiceClient,
  createTestAnchor,
  deleteTestAnchor,
  resolveSeedIndividualOrFallbackProfileId,
  SEED_USERS,
  PUBLIC_FALLBACK_FILENAME_LABEL,
} from './fixtures';

test.describe('Public Verification', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let testPublicId: string;
  let testAnchorId: string;
  let publicVerificationUserId: string;
  const serviceClient = getServiceClient();

  async function expectVerifiedPage(page: import('@playwright/test').Page) {
    await expect(page.getByRole('heading', { name: /^Verified on/i })).toBeVisible({ timeout: 10000 });
  }

  test.beforeAll(async () => {
    publicVerificationUserId = await resolveSeedIndividualOrFallbackProfileId(serviceClient, {
      errorLabel: 'public verification E2E user',
      fallbackLabel: 'staging-backed public verification fixtures',
      warningPrefix: 'public-verification',
    });

    const anchor = await createTestAnchor(serviceClient, {
      userId: publicVerificationUserId,
      status: 'SECURED',
      filename: 'e2e_public_test.pdf',
    });

    // Fail loudly if test data setup didn't work — never silently skip
    if (!anchor?.id || !anchor?.public_id) {
      throw new Error('beforeAll: failed to create test anchor — cannot run public verification tests');
    }

    testAnchorId = anchor.id;
    testPublicId = anchor.public_id;
  });

  test.afterAll(async () => {
    if (testAnchorId) {
      await deleteTestAnchor(serviceClient, testAnchorId);
    }
  });

  test('public verification page shows verified status for valid public_id', async ({ page }) => {
    await page.goto(`/verify/${testPublicId}`);

    // Should show verified status
    await expectVerifiedPage(page);

    // The public projection redacts the uploaded filename (0385/0387/0390):
    // an anonymous viewer sees the controlled fallback label, never the raw
    // name. Assert both directions so a regression that re-leaks the filename
    // cannot pass while the label also happens to render somewhere.
    await expect(page.getByText(PUBLIC_FALLBACK_FILENAME_LABEL).first()).toBeVisible();
    await expect(page.getByText('e2e_public_test.pdf')).toHaveCount(0);

    // Should show fingerprint
    await expect(page.getByText('Fingerprint (SHA-256)', { exact: true })).toBeVisible();

    // Should show verification ID
    await expect(page.getByText(`Verification ID: ${testPublicId}`)).toBeVisible();

    // Should show Arkova branding
    await expect(page.getByText('Secured by Arkova')).toBeVisible();
  });

  test('public verification page shows error for invalid public_id', async ({ page }) => {
    await page.goto('/verify/invalid_public_id_12345');

    // Should show verification failed
    await expect(page.getByText('Verification Failed')).toBeVisible({ timeout: 10000 });

    // Should show error message
    await expect(
      page.getByText(/Unable to verify|may not exist|not been verified/)
    ).toBeVisible();
  });

  test('public verification page does not expose sensitive data', async ({ page }) => {
    await page.goto(`/verify/${testPublicId}`);
    await expectVerifiedPage(page);

    // Should NOT show user ID or email
    await expect(page.getByText(publicVerificationUserId, { exact: true })).not.toBeVisible();
    if (publicVerificationUserId === SEED_USERS.individual.id) {
      await expect(page.getByText(SEED_USERS.individual.email, { exact: true })).not.toBeVisible();
    }
  });

  test('public verification page is accessible without authentication', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`/verify/${testPublicId}`);

    // Should NOT redirect to login
    await expect(page).not.toHaveURL(/\/auth/);

    // Should show verification content
    await expectVerifiedPage(page);
  });

  test('public verification page shows proof details when available', async ({ page }) => {
    await page.goto(`/verify/${testPublicId}`);
    await expectVerifiedPage(page);

    await expect(page.getByText('Fingerprint (SHA-256)', { exact: true })).toBeVisible();
    await expect(page.getByText(`Verification ID: ${testPublicId}`)).toBeVisible();
  });

  const statusCases = [
    {
      status: 'PENDING',
      filename: 'e2e_public_pending.pdf',
      title: 'Submitting to network...',
      badge: 'Processing',
      subtitle: 'This record is being submitted. Check back shortly for confirmation.',
      showsProof: false,
    },
    {
      status: 'SUBMITTED',
      filename: 'e2e_public_submitted.pdf',
      title: 'Record Submitted · Awaiting Network Confirmation',
      badge: 'Awaiting Confirmation',
      subtitle: 'Finalization usually takes ≈60 minutes once the network observes the next checkpoint.',
      showsProof: false,
    },
    {
      status: 'SECURED',
      filename: 'e2e_public_secured.pdf',
      title: /^Verified on/i,
      badge: 'Secured',
      subtitle: 'This record’s fingerprint is permanently anchored.',
      showsProof: true,
    },
    {
      status: 'EXPIRED',
      filename: 'e2e_public_expired.pdf',
      title: 'Record Expired',
      badge: 'Expired',
      subtitle: 'This record has passed its expiration date',
      showsProof: true,
    },
    {
      status: 'REVOKED',
      filename: 'e2e_public_revoked.pdf',
      title: 'Record Revoked',
      badge: 'Revoked',
      subtitle: 'This record has been revoked by the issuing organization',
      showsProof: true,
    },
  ] as const;

  for (const statusCase of statusCases) {
    test(`public verification renders ${statusCase.status} without contradictory trust signals`, async ({ page }) => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: publicVerificationUserId,
        status: statusCase.status,
        filename: statusCase.filename,
      });

      if (!anchor?.id || !anchor?.public_id) {
        throw new Error(`failed to create ${statusCase.status} public verification fixture`);
      }

      try {
        await page.goto(`/verify/${anchor.public_id}`);

        await expect(page.getByRole('heading', { name: statusCase.title })).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(statusCase.badge, { exact: true }).first()).toBeVisible();
        await expect(page.getByText(statusCase.subtitle, { exact: true })).toBeVisible();

        // The public projection WITHHOLDS the uploaded filename here — this is
        // the contract, not a rendering gap. 0385 suppresses issuer-authored
        // free text for records the academic gate cannot positively classify as
        // safe, and 0390 (SCRUM-3102) flipped that gate to FAIL CLOSED on an
        // ABSENT credential_type: `is_academic_record_credential_type(NULL)` is
        // now TRUE, so `filename` projects
        // `academic_record_public_label(NULL)` — the controlled fallback label.
        // `createTestAnchor` never sets credential_type, so EVERY fixture in
        // this matrix is NULL-typed and must render the label, never the raw
        // upload name (which in prod is frequently the learner's own name).
        //
        // Assert BOTH directions, matching the SECURED case above: the negative
        // alone would pass on a blank card, and the positive alone would pass
        // while the raw name still leaked somewhere else on the page.
        await expect(page.getByText(PUBLIC_FALLBACK_FILENAME_LABEL).first()).toBeVisible();
        await expect(page.getByText(statusCase.filename)).toHaveCount(0);

        await expect(page.getByText(`Verification ID: ${anchor.public_id}`)).toBeVisible();

        if (statusCase.showsProof) {
          // The Cryptographic Proof SECTION is gated by hasPublicVerificationProof
          // (any terminal proof state: SECURED/EXPIRED/REVOKED/SUPERSEDED), so it
          // stays visible for a record that HAS a proof.
          await expect(page.getByText('Cryptographic Proof')).toBeVisible();
          // FE-PROOF-GATE (SCRUM-2501 / contract §3): the "Download Proof"
          // affordance now reflects real proof AVAILABILITY, not just status.
          if (statusCase.status !== 'SECURED') {
            // Terminal-but-non-SECURED (EXPIRED/REVOKED/SUPERSEDED): the download
            // gate is closed entirely (isProofDownloadable is SECURED-only) — no
            // download affordance at all, regardless of the proof endpoint.
            await expect(page.getByText('Download Proof')).not.toBeVisible();
          }
          // For SECURED we deliberately do NOT assert a specific download
          // outcome here: this test hits the LIVE worker, and whether a real
          // batch proof exists for a directly-created fixture is environment-
          // dependent (404 → honest empty-state, or a real bundle → download).
          // The full state matrix (state 1 download vs state 2 empty vs the
          // retry/record-missing branches) is pinned deterministically in
          // e2e/public-proof-gate.spec.ts via contract-verbatim /proof
          // interception. Here we only assert the stable, worker-independent
          // facts (section present above; no ACTIVE badge below).
        } else {
          await expect(page.getByText('Document Verified')).not.toBeVisible();
          await expect(page.getByText('Cryptographic Proof')).not.toBeVisible();
          await expect(page.getByText('Download Proof')).not.toBeVisible();
        }

        if (statusCase.status === 'SECURED') {
          await expect(page.getByText('ACTIVE', { exact: true })).not.toBeVisible();
        }

        // SCRUM-2495 (ABUSE-DISCLAIMER): the does-not-assert disclaimer is
        // always-visible on the public verification surface, independent of
        // status/proof gating — pin it here so a regression that hides it
        // (e.g. re-gating behind hasProof) fails E2E, not just component tests.
        await expect(page.getByTestId('does-not-assert-disclaimer')).toBeVisible();
        await expect(
          page.getByText('What This Anchor Does and Does Not Assert')
        ).toBeVisible();
      } finally {
        await deleteTestAnchor(serviceClient, anchor.id);
      }
    });
  }
});
