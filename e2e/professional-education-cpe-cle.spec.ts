/**
 * CPE-01 / CLE-01 / CPE-02 E2E (SCRUM-2378 / SCRUM-2379 / SCRUM-2380)
 *
 * Covers, on the org-admin Compliance Intelligence dashboard
 * (/organization/compliance):
 *   - CPE-01: mixed SECURED+PENDING fixture — the export response excludes
 *     un-secured records (server-gated; worker unit tests prove the builder),
 *     and the panel renders the inline "not ready yet" notice without blocking
 *     the export. The worker endpoint is route-intercepted (same convention as
 *     attestation-verification.spec.ts) with the exact contract shape the
 *     hardened endpoint returns for the seeded mixed fixture.
 *   - CLE-01: the §1.5 jurisdiction-informational disclaimer renders, and it
 *     never overclaims ("meets"/"satisfies"/"legally sufficient").
 *   - CPE-02: the per-member org CPE dashboard aggregates the seeded mixed
 *     fixture from LIVE Supabase reads (secured vs pending tiles + member row).
 *   - Dual-viewport sanity at 1280px and 375px (§0 rule 6).
 */
import { randomBytes } from 'node:crypto';
import { test, expect, getServiceClient, getSeedUserOrgId, SEED_USERS } from './fixtures';

// One worker: each parallel worker re-runs beforeAll, and concurrent seeding
// of the same org makes the computed tile expectations racy.
test.describe.configure({ mode: 'serial' });

const WORKER_URL = 'http://localhost:3001';
// Hex-only, unique per worker process (Date.now alone collides across workers).
const RUN_HEX = randomBytes(6).toString('hex');

function fp(seed: number): string {
  return (RUN_HEX + seed.toString(16).padStart(4, '0')).repeat(4).slice(0, 64);
}

/** issued_at inside the default "Year to date" reporting period. */
function recentIsoDate(): string {
  const now = new Date();
  // Mid-year safe: yesterday, which is always within year-to-date unless Jan 1.
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return (d.getUTCMonth() === 11 && now.getUTCMonth() === 0)
    ? now.toISOString()
    : d.toISOString();
}

test.describe('Professional education — CPE/CLE export hardening + org dashboard', () => {
  const serviceClient = getServiceClient();
  const seededFingerprints: string[] = [];
  let orgId: string;

  test.beforeAll(async () => {
    orgId = await getSeedUserOrgId(serviceClient, SEED_USERS.orgAdmin.id);

    // Mixed SECURED + PENDING CPE fixture for the org admin (CPE-01 + CPE-02).
    const rows = [
      { seed: 1, status: 'SECURED' },
      { seed: 2, status: 'SECURED' },
      { seed: 3, status: 'PENDING' },
    ] as const;
    for (const row of rows) {
      const fingerprint = fp(row.seed);
      seededFingerprints.push(fingerprint);
      const { error } = await serviceClient.from('anchors').insert({
        user_id: SEED_USERS.orgAdmin.id,
        org_id: orgId,
        fingerprint,
        filename: `e2e-cpe-${row.seed}.pdf`,
        file_size: 2048,
        status: row.status,
        credential_type: 'CPE',
        issued_at: recentIsoDate(),
        cpe_metadata: {
          credit_hours: 2,
          field_of_study: 'Auditing',
          requires_manual_review: false,
        },
        // anchors_chain_data_consistency: SECURED requires chain_tx_id.
        ...(row.status === 'SECURED'
          ? { chain_tx_id: fp(row.seed + 50), chain_timestamp: recentIsoDate() }
          : {}),
      });
      if (error) throw new Error(`CPE anchor seed failed: ${error.message}`);
    }
  });

  test.afterAll(async () => {
    for (const fingerprint of seededFingerprints) {
      await serviceClient.from('anchors').delete().eq('fingerprint', fingerprint);
    }
  });

  test('CPE-01: export of a mixed SECURED+PENDING period surfaces the excluded-records notice without blocking', async ({ orgAdminPage }) => {
    // Intercept the hardened worker endpoint with its exact response contract
    // for the seeded fixture: 2 secured exported, 1 pending excluded.
    await orgAdminPage.route(`${WORKER_URL}/api/v1/exports/cpe-log`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          request_id: 'e2e-req-1',
          record_count: 2,
          excluded_count: 1,
          requested_format: 'pdf',
          exports: {
            pdf: { signed_url: 'https://exports.example/e2e.pdf', path: 'e2e.pdf', expires_in: 3600 },
            json: { signed_url: 'https://exports.example/e2e.json', path: 'e2e.json', expires_in: 3600 },
          },
        }),
      });
    });
    // The panel window.open()s the signed URL — keep the popup from erroring.
    await orgAdminPage.context().route('https://exports.example/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/pdf', body: '' }),
    );

    await orgAdminPage.goto('/organization/compliance');
    await expect(orgAdminPage.getByText('Professional Education Exports')).toBeVisible({ timeout: 15000 });

    await orgAdminPage.getByLabel('CPE period start').fill('2026-01-01');
    await orgAdminPage.getByLabel('CPE period end').fill('2026-12-31');
    await orgAdminPage.getByRole('button', { name: 'Export CPE log' }).click();

    // Export completes (not blocked)…
    await expect(orgAdminPage.getByText('CPE log ready. 2 records included.')).toBeVisible({ timeout: 15000 });
    // …and the exclusion is surfaced, never silent.
    await expect(orgAdminPage.getByTestId('excluded-records-notice')).toContainText(
      "1 record isn't ready to export yet — it'll appear once secured.",
    );
  });

  test('CLE-01: the jurisdiction-informational disclaimer renders and never overclaims', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization/compliance');

    const disclaimer = orgAdminPage.getByTestId('jurisdiction-disclaimer');
    await expect(disclaimer).toBeVisible({ timeout: 15000 });
    await expect(disclaimer).toContainText('informational metadata only');

    const text = (await disclaimer.textContent()) ?? '';
    expect(text).not.toMatch(/\bmeets?\b/i);
    expect(text).not.toMatch(/\bsatisf/i);
    expect(text).not.toMatch(/legally sufficient/i);
  });

  test('CPE-02: org CPE member dashboard aggregates secured vs pending per member from live reads', async ({ orgAdminPage }) => {
    // Compute the expected tile values from the SAME live read the hook runs
    // (the org may carry seed-data CPE rows beyond this spec's fixture).
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
    const { data: expectedRows, error: expectedErr } = await serviceClient
      .from('anchors')
      .select('user_id, status')
      .eq('org_id', orgId)
      .eq('credential_type', 'CPE')
      .not('cpe_metadata', 'is', null)
      .is('deleted_at', null)
      .gte('issued_at', yearStart)
      .limit(1000);
    if (expectedErr) throw new Error(`expected-count query failed: ${expectedErr.message}`);
    const rows = (expectedRows ?? []) as Array<{ user_id: string | null; status: string }>;
    const expectedSecured = rows.filter((r) => r.status === 'SECURED').length;
    const expectedPending = rows.filter((r) => r.status === 'PENDING' || r.status === 'SUBMITTED').length;
    const expectedMembers = new Set(rows.map((r) => r.user_id).filter(Boolean)).size;
    // The fixture guarantees at least 2 secured + 1 pending exist.
    expect(expectedSecured).toBeGreaterThanOrEqual(2);
    expect(expectedPending).toBeGreaterThanOrEqual(1);

    await orgAdminPage.goto('/organization/compliance');

    const dashboard = orgAdminPage.getByTestId('org-cpe-member-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 15000 });

    await expect(dashboard.getByTestId('org-cpe-tile-secured')).toHaveText(String(expectedSecured), { timeout: 15000 });
    await expect(dashboard.getByTestId('org-cpe-tile-pending')).toHaveText(String(expectedPending));
    await expect(dashboard.getByTestId('org-cpe-tile-members')).toHaveText(String(expectedMembers));

    // Member row: name/identifier + per-member counts.
    const memberRow = dashboard.getByRole('row').filter({ hasText: 'demo-admin@arkova.local' });
    await expect(memberRow.or(dashboard.getByRole('row').filter({ hasText: 'Alex Demo-Admin' })).first()).toBeVisible();
  });

  test('dual-viewport sanity: export panel + member dashboard render at 1280px and 375px', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization/compliance');

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 375, height: 812 },
    ]) {
      await orgAdminPage.setViewportSize(viewport);
      await expect(orgAdminPage.getByText('Professional Education Exports')).toBeVisible({ timeout: 15000 });
      await expect(orgAdminPage.getByTestId('jurisdiction-disclaimer')).toBeVisible();
      await expect(orgAdminPage.getByTestId('org-cpe-member-dashboard')).toBeVisible();
      await orgAdminPage.screenshot({
        path: `test-results/uat-cpe-cle-${viewport.width}px.png`,
        fullPage: viewport.width === 375,
      });
    }
  });
});
