/**
 * L3-A6 — CE Noncredit Data Taxonomy 3.0 anchoring POC: UI entry point E2E
 * (founder amendment A2 — every user-facing capability ships a reachable UI
 * in the same PR).
 *
 * Covers the "Imported Records" (`/my-credentials`) page's "From Public
 * Registry" flow: CTID input → look-up (fetch+fingerprint result) → add
 * (resulting record link) → the added record APPEARING IN THE LIST. Both
 * worker legs are stubbed at the Playwright `route()` boundary — no live
 * Credential Engine Registry call and no live worker call runs in CI,
 * mirroring `treasury-observability.spec.ts`'s network-boundary-stub pattern.
 *
 * SCOPE OF THE STUBS — read before trusting this spec as coverage. Because
 * both worker legs AND the `get_my_credentials` RPC are stubbed, this file
 * proves the CLIENT contract only: that a successful add triggers a list
 * refetch and renders whatever that refetch returns. It canNOT prove the
 * worker actually writes the `anchor_recipients` row the RPC inner-joins
 * through — that half is pinned server-side by the "recipient linkage" suite
 * in `credentials-ctdl-registry-anchor.test.ts`. The original version of this
 * spec asserted only the in-dialog success link and stopped there, which is
 * exactly why a record that was permanently invisible in this list still
 * passed E2E. The two suites are complementary; neither alone is coverage.
 *
 * @see src/components/credentials/CtdlRegistryImportDialog.tsx
 * @see src/pages/MyCredentialsPage.tsx
 * @see services/worker/src/api/v1/credentials-ctdl-import.ts       (GET leg)
 * @see services/worker/src/api/v1/credentials-ctdl-registry-anchor.ts (POST leg)
 * @see services/worker/src/api/v1/credentials-ctdl-registry-anchor.test.ts (recipient-row proof)
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

/**
 * The list row `get_my_credentials()` would return for the anchor the POST leg
 * creates. Shape mirrors the RPC's RETURNS TABLE columns as mapped in
 * `src/hooks/useMyCredentials.ts`; `filename` is what the worker derives from
 * the registry record name (`${label}.jsonld`) and what the card renders.
 */
const RECORD_FILENAME = 'Certified Production Technician Noncredit Program.jsonld';

const MY_CREDENTIALS_ROW = {
  recipient_id: '11111111-1111-4111-8111-111111111111',
  anchor_id: '22222222-2222-4222-8222-222222222222',
  claimed_at: null,
  recipient_created_at: '2026-07-28T00:00:00.000Z',
  public_id: ANCHOR_RESPONSE.anchor.public_id,
  filename: RECORD_FILENAME,
  fingerprint: 'b'.repeat(64),
  status: 'PENDING',
  credential_type: 'OTHER',
  metadata: { ce_registry_ctid: CTID },
  issued_at: null,
  expires_at: null,
  created_at: '2026-07-28T00:00:00.000Z',
  org_name: null,
  org_id: null,
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

  test('the added record appears in the Imported Records list after the dialog closes', async ({ individualPage }) => {
    // The list is driven by `get_my_credentials()`, which INNER JOINs
    // `anchor_recipients` — an anchor with no recipient row never appears here,
    // no matter how successful the add looked. Model that causally: the RPC
    // only returns the row once the anchor leg has actually been called.
    let anchorAdded = false;

    await individualPage.route(IMPORT_LEG, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOOKUP_RESPONSE) }),
    );
    await individualPage.route(ANCHOR_LEG, (route) => {
      anchorAdded = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ANCHOR_RESPONSE) });
    });
    await individualPage.route('**/rest/v1/rpc/get_my_credentials*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(anchorAdded ? [MY_CREDENTIALS_ROW] : []),
      }),
    );

    await individualPage.goto(ROUTES.MY_CREDENTIALS);
    await acceptDisclaimerIfVisible(individualPage);

    // Precondition: the record is genuinely absent before the add.
    const recordEntry = individualPage.getByText(RECORD_FILENAME);
    await expect(recordEntry).toBeHidden();

    await individualPage.getByTestId('add-from-registry-button').click();
    await individualPage.getByLabel(/Registry identifier/i).fill(CTID);
    await individualPage.getByRole('button', { name: /Look Up/i }).click();
    await expect(individualPage.getByTestId('ctdl-registry-lookup-result')).toBeVisible({ timeout: 10_000 });

    await individualPage.getByRole('button', { name: /Add Record/i }).click();
    await expect(individualPage.getByTestId('ctdl-registry-anchor-result')).toBeVisible({ timeout: 10_000 });

    // Close the dialog — `onImported` has already fired `refreshCredentials()`.
    await individualPage.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(individualPage.getByTestId('ctdl-registry-anchor-result')).toBeHidden();

    // The point of the whole flow: the user can now see what they just added.
    await expect(recordEntry).toBeVisible({ timeout: 10_000 });
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
