/**
 * Attestation Verification E2E (SCRUM-1873 / SCRUM-1874)
 *
 * Tests the attestation list page status badges, attestation detail
 * notarization badge, public verification API, and status transitions.
 *
 * Mirrors public-verification.spec.ts and attestations-page patterns.
 */

import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

/* ------------------------------------------------------------------ */
/*  Shared mock helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Builds a mock attestation row for Supabase route intercepts.
 */
function buildMockAttestation(overrides: Partial<{
  id: string;
  public_id: string;
  attestation_type: string;
  status: string;
  attester_name: string;
  attester_type: string;
  attester_title: string | null;
  subject_type: string;
  subject_identifier: string;
  claims: Array<{ claim: string; evidence?: string }>;
  summary: string | null;
  jurisdiction: string | null;
  fingerprint: string | null;
  chain_tx_id: string | null;
  issued_at: string;
  expires_at: string | null;
  created_at: string;
  notarized_at: string | null;
  notary_name: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 'att-e2e-001',
    public_id: overrides.public_id ?? 'pub-att-e2e-001',
    attestation_type: overrides.attestation_type ?? 'VERIFICATION',
    status: overrides.status ?? 'ACTIVE',
    attester_name: overrides.attester_name ?? 'E2E Attester Corp',
    attester_type: overrides.attester_type ?? 'INSTITUTION',
    attester_title: overrides.attester_title ?? null,
    subject_type: overrides.subject_type ?? 'credential',
    subject_identifier: overrides.subject_identifier ?? 'CERT-E2E-001',
    claims: overrides.claims ?? [{ claim: 'Employment verified' }],
    summary: overrides.summary ?? 'E2E test attestation',
    jurisdiction: overrides.jurisdiction ?? null,
    fingerprint: overrides.fingerprint ?? 'a'.repeat(64),
    chain_tx_id: overrides.chain_tx_id ?? null,
    issued_at: overrides.issued_at ?? '2026-05-20T00:00:00Z',
    expires_at: overrides.expires_at ?? null,
    created_at: overrides.created_at ?? '2026-05-20T00:00:00Z',
    notarized_at: overrides.notarized_at ?? null,
    notary_name: overrides.notary_name ?? null,
  };
}

/**
 * Builds a mock public attestation verify API response.
 */
function buildMockPublicVerifyResponse(overrides: Partial<{
  public_id: string;
  attestation_type: string;
  status: string;
  subject_type: string;
  subject_identifier: string;
  attester: { name: string; type: string; title: string | null };
  claims: Array<{ claim: string; evidence?: string }>;
  summary: string | null;
  jurisdiction: string | null;
  fingerprint: string | null;
  evidence_fingerprint: string | null;
  evidence: Array<unknown>;
  evidence_count: number;
  chain_proof: { tx_id: string; block_height: number | null; timestamp: string | null; explorer_url: string | null } | null;
  linked_credential: null;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  notarized_at: string | null;
  notary_name: string | null;
  notary_commission_state: string | null;
}> = {}) {
  return {
    public_id: overrides.public_id ?? 'pub-att-verify-001',
    attestation_type: overrides.attestation_type ?? 'VERIFICATION',
    status: overrides.status ?? 'ACTIVE',
    subject_type: overrides.subject_type ?? 'credential',
    subject_identifier: overrides.subject_identifier ?? 'CERT-VERIFY-001',
    attester: overrides.attester ?? { name: 'Verify Attester Corp', type: 'INSTITUTION', title: null },
    claims: overrides.claims ?? [{ claim: 'Employment verified for E2E' }],
    summary: overrides.summary ?? 'Public verify test attestation',
    jurisdiction: overrides.jurisdiction ?? null,
    fingerprint: overrides.fingerprint ?? 'b'.repeat(64),
    evidence_fingerprint: overrides.evidence_fingerprint ?? null,
    evidence: overrides.evidence ?? [],
    evidence_count: overrides.evidence_count ?? 0,
    chain_proof: overrides.chain_proof ?? null,
    linked_credential: overrides.linked_credential ?? null,
    issued_at: overrides.issued_at ?? '2026-05-20T00:00:00Z',
    expires_at: overrides.expires_at ?? null,
    revoked_at: overrides.revoked_at ?? null,
    revocation_reason: overrides.revocation_reason ?? null,
    created_at: overrides.created_at ?? '2026-05-20T00:00:00Z',
    notarized_at: overrides.notarized_at ?? null,
    notary_name: overrides.notary_name ?? null,
    notary_commission_state: overrides.notary_commission_state ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

test.describe('Attestation verification (SCRUM-1873/1874)', () => {
  let orgId: string;

  test.beforeAll(async () => {
    const service = getServiceClient();
    const { data: profile, error } = await service
      .from('profiles')
      .select('org_id')
      .eq('id', SEED_USERS.orgAdmin.id)
      .single();

    if (error || !profile?.org_id) {
      throw new Error(`Unable to resolve org admin org_id: ${error?.message ?? 'missing profile'}`);
    }

    orgId = profile.org_id as string;
  });

  /* ------------------------------------------------------------------ */
  /*  Desktop viewport (1280px)                                          */
  /* ------------------------------------------------------------------ */

  test.describe('desktop viewport (1280px)', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test('attestation list page shows status badges for each attestation', async ({ orgAdminPage }) => {
      const attestations = [
        buildMockAttestation({ id: 'att-1', public_id: 'pub-1', status: 'ACTIVE', subject_identifier: 'CERT-001' }),
        buildMockAttestation({ id: 'att-2', public_id: 'pub-2', status: 'PENDING', subject_identifier: 'CERT-002' }),
        buildMockAttestation({ id: 'att-3', public_id: 'pub-3', status: 'REVOKED', subject_identifier: 'CERT-003' }),
        buildMockAttestation({ id: 'att-4', public_id: 'pub-4', status: 'EXPIRED', subject_identifier: 'CERT-004', expires_at: '2025-01-01T00:00:00Z' }),
      ];

      // Mock Supabase legal_attestations query
      await orgAdminPage.route('**/rest/v1/attestations*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(attestations),
          headers: { 'content-range': `0-${attestations.length - 1}/${attestations.length}` },
        });
      });

      await orgAdminPage.goto('/attestations');
      await expect(orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Attestations', exact: true })).toBeVisible({ timeout: 10000 });

      // Verify each status badge renders the human-readable label (SCRUM-2003:
      // the AttestationsPage list badge now uses getStatusLabel, not the raw
      // enum). Per src/lib/statusDisplay.ts: PENDING -> "Processing",
      // ACTIVE -> "Active", REVOKED -> "Revoked", EXPIRED -> "Expired".
      await expect(orgAdminPage.getByText('Active', { exact: true }).first()).toBeVisible();
      await expect(orgAdminPage.getByText('Processing', { exact: true }).first()).toBeVisible();
      await expect(orgAdminPage.getByText('Revoked', { exact: true }).first()).toBeVisible();
      await expect(orgAdminPage.getByText('Expired', { exact: true }).first()).toBeVisible();
    });

    test('attestation detail shows notarization badge when notarized', async ({ orgAdminPage }) => {
      const notarizedAttestation = buildMockAttestation({
        id: 'att-notarized',
        public_id: 'pub-notarized',
        status: 'ACTIVE',
        notarized_at: '2026-05-25T14:00:00Z',
        notary_name: 'Jane Notary, Esq.',
      });

      // Mock Supabase legal_attestations single-row fetch
      await orgAdminPage.route('**/rest/v1/attestations*', async (route) => {
        const url = route.request().url();
        if (url.includes('id=eq.att-notarized') || url.includes('public_id=eq.pub-notarized')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(notarizedAttestation),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([notarizedAttestation]),
            headers: { 'content-range': '0-0/1' },
          });
        }
      });

      await orgAdminPage.goto('/attestations');
      await expect(orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Attestations', exact: true })).toBeVisible({ timeout: 10000 });

      // Click the attestation row to open the detail panel
      await orgAdminPage.getByText('pub-notarized').first().click();

      // Notarization badge should be visible in the detail panel
      await expect(orgAdminPage.getByTestId('notarization-badge').first()).toBeVisible({ timeout: 10000 });
      await expect(orgAdminPage.getByText(/Notarized/i).first()).toBeVisible();
    });

    test('attestation detail does NOT show notarization badge when not notarized', async ({ orgAdminPage }) => {
      const plainAttestation = buildMockAttestation({
        id: 'att-plain',
        public_id: 'pub-plain',
        status: 'ACTIVE',
        notarized_at: null,
        notary_name: null,
      });

      await orgAdminPage.route('**/rest/v1/attestations*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([plainAttestation]),
          headers: { 'content-range': '0-0/1' },
        });
      });

      await orgAdminPage.goto('/attestations');
      await expect(orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Attestations', exact: true })).toBeVisible({ timeout: 10000 });

      // Click the attestation row to open the detail panel
      await orgAdminPage.getByText('pub-plain').first().click();

      // Notarization badge should NOT be present in the detail panel
      await expect(orgAdminPage.getByTestId('notarization-badge')).not.toBeVisible();
    });

    test('attestation status transitions display correctly (pending -> active -> notarized)', async ({ orgAdminPage }) => {
      // Start with PENDING attestation, then ACTIVE, then notarized ACTIVE
      const stages = [
        buildMockAttestation({ id: 'att-transition', public_id: 'pub-transition', status: 'PENDING' }),
        buildMockAttestation({ id: 'att-transition', public_id: 'pub-transition', status: 'ACTIVE' }),
        buildMockAttestation({
          id: 'att-transition',
          public_id: 'pub-transition',
          status: 'ACTIVE',
          notarized_at: '2026-05-27T10:00:00Z',
          notary_name: 'Transition Notary',
        }),
      ];

      let stageIndex = 0;

      await orgAdminPage.route('**/rest/v1/attestations*', async (route) => {
        const current = stages[Math.min(stageIndex, stages.length - 1)];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([current]),
          headers: { 'content-range': '0-0/1' },
        });
      });

      // Stage 0: PENDING -> rendered as "Processing" (SCRUM-2003 label map)
      await orgAdminPage.goto('/attestations');
      await expect(orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Attestations', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(orgAdminPage.getByText('Processing', { exact: true }).first()).toBeVisible();

      // Stage 1: ACTIVE -> rendered as "Active"
      stageIndex = 1;
      await orgAdminPage.reload();
      await expect(orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Attestations', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(orgAdminPage.getByText('Active', { exact: true }).first()).toBeVisible();

      // Stage 2: ACTIVE + notarized -> still "Active"
      stageIndex = 2;
      await orgAdminPage.reload();
      await expect(orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Attestations', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(orgAdminPage.getByText('Active', { exact: true }).first()).toBeVisible();
      // Click into detail to see notarization badge
      await orgAdminPage.getByText('pub-transition').first().click();
      await expect(orgAdminPage.getByText(/Notarized/i).first()).toBeVisible({ timeout: 10000 });
    });

    test('public verification API returns correct result for active attestation', async ({ page }) => {
      const publicId = 'pub-api-verify-001';

      // Mock the worker attestation verify API
      await page.route(`http://localhost:3001/api/v1/attestations/${publicId}**`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildMockPublicVerifyResponse({
            public_id: publicId,
            status: 'ACTIVE',
            attestation_type: 'VERIFICATION',
          })),
        });
      });

      await page.goto(`/verify/attestation/${publicId}`);

      // AttestationStatusCard renders the label "Active" (not "ACTIVE")
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('CERT-VERIFY-001')).toBeVisible();
      await expect(page.getByText('Verify Attester Corp')).toBeVisible();
    });

    test('public verification API returns correct result for notarized attestation', async ({ page }) => {
      const publicId = 'pub-api-notarized-001';

      await page.route(`http://localhost:3001/api/v1/attestations/${publicId}**`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildMockPublicVerifyResponse({
            public_id: publicId,
            status: 'ACTIVE',
            attestation_type: 'VERIFICATION',
            notarized_at: '2026-05-25T14:00:00Z',
            notary_name: 'Public Verify Notary',
            notary_commission_state: 'CA',
          })),
        });
      });

      await page.goto(`/verify/attestation/${publicId}`);

      // AttestationStatusCard renders the label "Active" (not "ACTIVE")
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 10000 });
      // Public verification page renders attestation details (notarization data
      // is not in AttestationVerifyData interface, so we verify the page loaded)
      await expect(page.getByText('CERT-VERIFY-001')).toBeVisible();
    });

    test('public verification returns error for invalid public_id', async ({ page }) => {
      const badId = 'invalid-attestation-id-xyz';

      await page.route(`http://localhost:3001/api/v1/attestations/${badId}**`, async (route) => {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Attestation not found' }),
        });
      });

      await page.goto(`/verify/attestation/${badId}`);

      await expect(
        page.getByText(/not found|verification failed|unable to verify/i).first(),
      ).toBeVisible({ timeout: 10000 });
    });

    test('public verification does not expose sensitive data', async ({ page }) => {
      const publicId = 'pub-api-security-001';

      await page.route(`http://localhost:3001/api/v1/attestations/${publicId}**`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildMockPublicVerifyResponse({
            public_id: publicId,
            status: 'ACTIVE',
          })),
        });
      });

      await page.goto(`/verify/attestation/${publicId}`);
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 10000 });

      // Internal IDs and user data should not be exposed
      await expect(page.getByText(SEED_USERS.orgAdmin.id, { exact: true })).not.toBeVisible();
      await expect(page.getByText(SEED_USERS.orgAdmin.email, { exact: true })).not.toBeVisible();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Mobile viewport (375px)                                            */
  /* ------------------------------------------------------------------ */

  test.describe('mobile viewport (375px)', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('attestation status card renders correctly at 375px', async ({ orgAdminPage }) => {
      const attestations = [
        buildMockAttestation({ id: 'att-mobile-1', public_id: 'pub-mobile-1', status: 'ACTIVE' }),
        buildMockAttestation({ id: 'att-mobile-2', public_id: 'pub-mobile-2', status: 'PENDING' }),
      ];

      await orgAdminPage.route('**/rest/v1/attestations*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(attestations),
          headers: { 'content-range': `0-${attestations.length - 1}/${attestations.length}` },
        });
      });

      await orgAdminPage.goto('/attestations');
      await expect(orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Attestations', exact: true })).toBeVisible({ timeout: 10000 });

      // Both status badges should be visible at mobile width, rendered as the
      // human-readable labels (SCRUM-2003): ACTIVE -> "Active", PENDING -> "Processing".
      await expect(orgAdminPage.getByText('Active', { exact: true }).first()).toBeVisible();
      await expect(orgAdminPage.getByText('Processing', { exact: true }).first()).toBeVisible();
    });

    test('public attestation verification page renders at 375px', async ({ page }) => {
      const publicId = 'pub-mobile-verify-001';

      await page.route(`http://localhost:3001/api/v1/attestations/${publicId}**`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildMockPublicVerifyResponse({
            public_id: publicId,
            status: 'ACTIVE',
            notarized_at: '2026-05-25T14:00:00Z',
            notary_name: 'Mobile Notary',
          })),
        });
      });

      await page.goto(`/verify/attestation/${publicId}`);
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 10000 });
      // Public verification page does not render notarization metadata (not in AttestationVerifyData interface)
      await expect(page.getByText('CERT-VERIFY-001')).toBeVisible();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Desktop viewport (1280px) — additional                             */
  /* ------------------------------------------------------------------ */

  test.describe('desktop viewport (1280px) -- attestation status card', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test('attestation status card renders correctly at 1280px with chain proof', async ({ page }) => {
      const publicId = 'pub-desktop-proof-001';

      await page.route(`http://localhost:3001/api/v1/attestations/${publicId}**`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildMockPublicVerifyResponse({
            public_id: publicId,
            status: 'ACTIVE',
            chain_proof: {
              tx_id: 'c'.repeat(64),
              block_height: 850000,
              timestamp: '2026-05-20T12:00:00Z',
              explorer_url: null,
            },
          })),
        });
      });

      await page.goto(`/verify/attestation/${publicId}`);
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 10000 });
      // Chain proof section should be visible when proof exists
      await expect(page.getByText(/Cryptographic Proof|Chain Proof|Anchored/i).first()).toBeVisible();
    });
  });
});
