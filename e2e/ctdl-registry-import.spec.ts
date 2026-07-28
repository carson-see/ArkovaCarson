/**
 * L3-A6 — CE Noncredit Data Taxonomy 3.0 anchoring POC: UI entry point E2E
 * (founder amendment A2 — every user-facing capability ships a reachable UI
 * in the same PR).
 *
 * Covers the "Imported Records" (`/my-credentials`) page's "From Public
 * Registry" flow: CTID input → look-up (fetch+fingerprint result) → add
 * (resulting record link). Both worker legs are stubbed at the Playwright
 * `route()` boundary — no live Credential Engine Registry call and no live
 * worker call runs in CI, mirroring `treasury-observability.spec.ts`'s
 * network-boundary-stub pattern.
 *
 * @see src/components/credentials/CtdlRegistryImportDialog.tsx
 * @see src/pages/MyCredentialsPage.tsx
 * @see services/worker/src/api/v1/credentials-ctdl-import.ts       (GET leg)
 * @see services/worker/src/api/v1/credentials-ctdl-registry-anchor.ts (POST leg)
 */
import { test, expect } from './fixtures';
import { acceptDisclaimerIfVisible } from './helpers/dashboard';
import { ROUTES } from '../src/lib/routes';

const IMPORT_LEG = /\/api\/v1\/credentials\/ctdl\/import(?:\?.*)?$/;
const ANCHOR_LEG = /\/api\/v1\/credentials\/ctdl\/registry-anchor(?:\?.*)?$/;

const CTID = 'ce-00000000-0000-4000-8000-000000000001';
const ENVELOPE_SHA256 = 'a'.repeat(64);

const LOOKUP_RESPONSE = {
  ctid: CTID,
  registry: {
    retrievedAt: '2026-07-28T00:00:00.000Z',
    envelopeSha256: ENVELOPE_SHA256,
    envelopeSignatureVerified: null,
  },
  count: 1,
  records: [
    {
      type: 'ceterms:LearningProgram',
      name: 'Certified Production Technician Noncredit Program',
      sourceId: CTID,
      registryUrl: `https://credentialengineregistry.org/resources/${CTID}`,
      sourceUrl: 'https://example-community-college.edu/noncredit/cpt',
      retrievedAt: '2026-07-28T00:00:00.000Z',
      ceEnvelopeSha256: ENVELOPE_SHA256,
      ceEnvelopeSignatureVerified: null,
      issuer: { id: null, ctid: null, name: 'Example Community College' },
      issuedAt: '2026-01-01',
      resourceAvailableUntil: null,
      sourceStatus: 'active',
      status: 'active',
    },
  ],
};

const ANCHOR_RESPONSE = {
  duplicate: false,
  anchor: {
    public_id: 'ARK-2026-NONCRED01',
    status: 'PENDING',
    created_at: '2026-07-28T00:00:00.000Z',
    record_uri: 'https://app.test/verify/ARK-2026-NONCRED01',
  },
  registry: {
    ctid: CTID,
    registryUrl: `https://credentialengineregistry.org/resources/${CTID}`,
    envelopeSha256: ENVELOPE_SHA256,
    retrievedAt: '2026-07-28T00:00:00.000Z',
    envelopeSignatureVerified: null,
  },
  record: {
    type: 'ceterms:LearningProgram',
    name: 'Certified Production Technician Noncredit Program',
    issuerName: 'Example Community College',
  },
};

test.describe('CE Registry import — Imported Records page (L3-A6)', () => {
  test('looks up a public registry record and adds it, revealing the record link', async ({ individualPage }) => {
    await individualPage.route(IMPORT_LEG, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOOKUP_RESPONSE) }),
    );
    await individualPage.route(ANCHOR_LEG, (route) =>
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ANCHOR_RESPONSE) }),
    );

    await individualPage.goto(ROUTES.MY_CREDENTIALS);
    await acceptDisclaimerIfVisible(individualPage);

    const openButton = individualPage.getByTestId('add-from-registry-button');
    await expect(openButton).toBeVisible({ timeout: 15_000 });
    await openButton.click();

    await individualPage.getByLabel(/Registry identifier/i).fill(CTID);
    await individualPage.getByRole('button', { name: /Look Up/i }).click();

    // Fetch+fingerprint result surfaces before anything is written.
    const lookupResult = individualPage.getByTestId('ctdl-registry-lookup-result');
    await expect(lookupResult).toBeVisible({ timeout: 10_000 });
    await expect(lookupResult).toContainText('Certified Production Technician Noncredit Program');
    await expect(lookupResult).toContainText('LearningProgram');
    await expect(lookupResult).toContainText('Example Community College');
    await expect(individualPage.getByTestId('ctdl-registry-envelope-fingerprint')).toContainText('aaaaaaaaaa');

    await individualPage.getByRole('button', { name: /Add Record/i }).click();

    const anchorResult = individualPage.getByTestId('ctdl-registry-anchor-result');
    await expect(anchorResult).toBeVisible({ timeout: 10_000 });
    const anchorLink = individualPage.getByTestId('ctdl-registry-anchor-link');
    await expect(anchorLink).toContainText('ARK-2026-NONCRED01');
    await expect(anchorLink).toHaveAttribute('href', ANCHOR_RESPONSE.anchor.record_uri);
  });

  test('surfaces a lookup failure without attempting to add', async ({ individualPage }) => {
    await individualPage.route(IMPORT_LEG, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'registry_record_not_found' }) }),
    );
    let anchorCalled = false;
    await individualPage.route(ANCHOR_LEG, (route) => {
      anchorCalled = true;
      return route.fulfill({ status: 500, body: '{}' });
    });

    await individualPage.goto(ROUTES.MY_CREDENTIALS);
    await acceptDisclaimerIfVisible(individualPage);
    await individualPage.getByTestId('add-from-registry-button').click();
    await individualPage.getByLabel(/Registry identifier/i).fill(CTID);
    await individualPage.getByRole('button', { name: /Look Up/i }).click();

    await expect(individualPage.getByRole('alert')).toBeVisible({ timeout: 10_000 });
    expect(anchorCalled).toBe(false);
  });

  test('renders the dialog at desktop (1280px) and mobile (375px) — UAT screenshots', async ({ individualPage }) => {
    await individualPage.route(IMPORT_LEG, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOOKUP_RESPONSE) }),
    );

    await individualPage.goto(ROUTES.MY_CREDENTIALS);
    await acceptDisclaimerIfVisible(individualPage);

    await individualPage.setViewportSize({ width: 1280, height: 900 });
    await individualPage.getByTestId('add-from-registry-button').click();
    await individualPage.getByLabel(/Registry identifier/i).fill(CTID);
    await individualPage.getByRole('button', { name: /Look Up/i }).click();
    await expect(individualPage.getByTestId('ctdl-registry-lookup-result')).toBeVisible({ timeout: 10_000 });
    await individualPage.screenshot({ path: 'test-results/uat-ctdl-registry-import-1280.png' });

    await individualPage.setViewportSize({ width: 375, height: 812 });
    await expect(individualPage.getByTestId('ctdl-registry-lookup-result')).toBeVisible();
    await individualPage.screenshot({ path: 'test-results/uat-ctdl-registry-import-375.png' });
  });
});
