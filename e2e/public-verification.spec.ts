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

    // Should show the filename
    await expect(page.getByText('e2e_public_test.pdf')).toBeVisible();

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
      subtitle: 'This record is permanently anchored.',
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
        await expect(page.getByText(statusCase.filename)).toBeVisible();
        await expect(page.getByText(`Verification ID: ${anchor.public_id}`)).toBeVisible();

        if (statusCase.showsProof) {
          await expect(page.getByText('Cryptographic Proof')).toBeVisible();
          await expect(page.getByText('Download Proof')).toBeVisible();
        } else {
          await expect(page.getByText('Document Verified')).not.toBeVisible();
          await expect(page.getByText('Cryptographic Proof')).not.toBeVisible();
          await expect(page.getByText('Download Proof')).not.toBeVisible();
        }

        if (statusCase.status === 'SECURED') {
          await expect(page.getByText('ACTIVE', { exact: true })).not.toBeVisible();
        }
      } finally {
        await deleteTestAnchor(serviceClient, anchor.id);
      }
    });
  }
});
