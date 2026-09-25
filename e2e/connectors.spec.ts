/**
 * Connectors page E2E (SPEC-CONNECTORS §6, tests 27-28).
 *
 * Google Drive itself is mocked — the browser's call to the worker's OWN
 * `/api/v1/integrations/google_drive/folders` endpoint is intercepted at the
 * network boundary (the worker process never runs, so it never needs a real
 * KMS key or a real Google Drive grant). `/api/rules` is NOT mocked: it hits
 * the real worker + test database, so "Save, reload, selection and action
 * persist" is a genuine persistence check, not a UI-only assertion.
 */
import { test, expect, getServiceClient, SEED_USERS } from './fixtures';
import { test as base, type Page } from '@playwright/test';
import { ROUTES } from '../src/lib/routes';

const E2E_WORKER_BASE = process.env.VITE_WORKER_URL || 'http://localhost:3001';

async function waitForRulesRateLimitHeadroom(page: Page, needed: number): Promise<void> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    const url = `${E2E_WORKER_BASE}/api/rules?e2e_headroom_probe=${Date.now()}`;
    const [response] = await Promise.all([
      page.waitForResponse(candidate => candidate.url() === url),
      page.evaluate(async (probeUrl: string) => {
        const result = await fetch(probeUrl, { cache: 'no-store' });
        await result.text();
      }, url),
    ]);
    // X-RateLimit-* is intentionally not CORS-exposed. Playwright observes
    // the same browser request outside page JS so it can inspect the raw
    // response without weakening production CORS or changing client identity.
    const headers = await response.allHeaders();
    const probe = {
      status: response.status(),
      remaining: headers['x-ratelimit-remaining'],
      reset: headers['x-ratelimit-reset'],
      retryAfter: headers['retry-after'],
    };
    if (!probe.remaining || !probe.reset || !/^\d+$/.test(probe.remaining) || !/^\d+$/.test(probe.reset)) {
      throw new Error('The /api/rules headroom probe returned malformed rate-limit headers');
    }
    if (probe.status !== 429 && Number(probe.remaining) >= needed) return;

    // `/api/rules` writes are guarded by a CAPACITY quota, not a time bucket:
    // `requireOrgQuota({ kind: 'rules_total', mode: 'capacity' })`, whose
    // `getCapacityCount` is `count(*) FROM organization_rules WHERE org_id = ?`
    // (services/worker/src/middleware/perOrgRateLimit.ts). Capacity does not
    // decay — it frees only when rules are DELETED — and in capacity mode the
    // server reports `resetValue = 'none'` with a NOMINAL `retryAfter = 3600`.
    // Waiting on that reset can never succeed, so sleeping until it burns the
    // deadline and then both Playwright retries. Callers must free capacity
    // (delete the org's rules) BEFORE asking for headroom; if headroom is still
    // short here, say so truthfully instead of sleeping on a quota that will
    // not move.
    const resetSecondsAway = Number(probe.reset) - Math.floor(Date.now() / 1_000);
    if (resetSecondsAway > 600) {
      throw new Error(
        `/api/rules reports ${probe.remaining} remaining of the ${needed} needed, with a reset ` +
          `${resetSecondsAway}s away — that is the rules_total CAPACITY quota, which never decays. ` +
          'Delete this org\'s organization_rules rows to free capacity; waiting cannot help.',
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`/api/rules still reports only ${probe.remaining} of ${needed} needed after the wait deadline`);
    }

    let waitMs = 5_000;
    if (probe.status === 429) {
      if (!probe.retryAfter || !/^\d+$/.test(probe.retryAfter)) {
        throw new Error('The /api/rules 429 omitted a valid Retry-After header');
      }
      waitMs = Number(probe.retryAfter) * 1_000 + 1_000;
    } else if (probe.reset) {
      waitMs = Math.max(0, Number(probe.reset) * 1_000 - Date.now()) + 1_000;
    }
    await page.waitForTimeout(Math.min(waitMs, 65_000));
  }
}

test.describe('Connectors page', () => {
  test.afterEach(async () => {
    // Clean up whatever this test created so re-runs start from "not
    // connected" / "no rule" — this spec seeds state, it should not leak it.
    const service = getServiceClient();
    const { data: profile } = await service
      .from('profiles')
      .select('org_id')
      .eq('id', SEED_USERS.orgAdmin.id)
      .single();
    const orgId = profile?.org_id as string | undefined;
    if (!orgId) return;
    // Delete EVERY rule this org owns, not just WORKSPACE_FILE_MODIFIED. The
    // `rules_total` quota counts rows of any trigger_type, so a rule of another
    // type created anywhere in the run permanently consumes capacity for the
    // rest of it — and capacity is the thing the headroom probe waits on.
    await service.from('organization_rules').delete().eq('org_id', orgId);
    await service.from('org_integrations').delete().eq('org_id', orgId).eq('provider', 'google_drive');
  });

  test('org admin picks a Drive folder, chooses Secure it immediately, saves, and the selection persists on reload', async ({ orgAdminPage }) => {
    test.setTimeout(180_000);
    // The CI worker runs with NODE_ENV=test and intentionally does not trust
    // X-Forwarded-For, so every browser shares ::1. Wait for measured room in
    // the real /api/rules limiter before mounting the connector hooks instead
    // of pretending a header creates an isolated client.
    //
    // ORDER MATTERS. `rules_total` is a capacity quota over existing
    // `organization_rules` rows, so headroom is created by DELETING rules, not
    // by waiting. This used to probe for headroom first and delete afterwards,
    // which could never succeed once the org sat at its cap: the probe burned
    // its 150s deadline and then both Playwright retries on the 180s timeout.
    // Resolve the org, free its capacity, and only then ask for headroom.
    await orgAdminPage.goto(ROUTES.DASHBOARD);
    const service = getServiceClient();
    const { data: profile, error } = await service
      .from('profiles')
      .select('org_id')
      .eq('id', SEED_USERS.orgAdmin.id)
      .single();
    if (error || !profile?.org_id) {
      throw new Error(`Unable to resolve org admin org_id: ${error?.message ?? 'missing profile'}`);
    }
    const orgId = profile.org_id as string;

    // Free the rules_total capacity this run may have consumed, across EVERY
    // trigger_type, before measuring headroom below.
    await service.from('organization_rules').delete().eq('org_id', orgId);
    await service.from('org_integrations').delete().eq('org_id', orgId).eq('provider', 'google_drive');

    await waitForRulesRateLimitHeadroom(orgAdminPage, 16);

    // Seed a connected Drive integration directly — this test exercises the
    // Connectors page's folder/action UI and the REAL /api/rules write path,
    // not the OAuth round-trip (covered by integrations-drive.spec.ts).
    await service.from('org_integrations').insert({
      org_id: orgId,
      provider: 'google_drive',
      account_id: 'e2e-drive-account',
      scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
      connected_at: new Date().toISOString(),
      // Deliberately fake — the folder-listing call below is intercepted
      // before it ever reaches the real worker/KMS, so these bytes are never
      // decrypted in this test.
      encrypted_tokens: '\\xaabbcc',
      token_kms_key_id: 'projects/e2e/locations/e2e/keyRings/e2e/cryptoKeys/e2e',
    });

    await orgAdminPage.route('**/api/v1/integrations/google_drive/folders**', async (route) => {
      const url = new URL(route.request().url());
      const parent = url.searchParams.get('parent');
      if (parent === 'root') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ folders: [{ id: 'e2e-folder-1', name: 'Signed contracts', hasChildren: null, driveId: null }] }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ folders: [] }) });
    });

    await orgAdminPage.goto(ROUTES.CONNECTORS);
    await expect(orgAdminPage.getByRole('heading', { name: 'Connectors' })).toBeVisible();
    await expect(orgAdminPage.getByText('No folders selected yet. Arkova will not act on anything until you choose at least one.')).toBeVisible();

    await orgAdminPage.getByRole('button', { name: 'Choose folders' }).click();
    await expect(orgAdminPage.getByText('Signed contracts')).toBeVisible();
    await orgAdminPage.getByRole('checkbox', { name: 'Signed contracts' }).click();
    await orgAdminPage.getByRole('button', { name: 'Use these folders' }).click();

    await expect(orgAdminPage.locator('#main-content').getByText('Signed contracts', { exact: true })).toBeVisible();
    await orgAdminPage.getByLabel('Secure it immediately').click();

    await orgAdminPage.getByRole('button', { name: 'Save' }).click();
    await expect(orgAdminPage.getByText('Settings saved. New documents will follow this setting.')).toBeVisible();

    await orgAdminPage.reload();
    await expect(orgAdminPage.locator('#main-content').getByText('Signed contracts', { exact: true })).toBeVisible();
    await expect(orgAdminPage.getByLabel('Secure it immediately')).toBeChecked();
  });

});

// Unauthenticated — same AuthGuard/RouteGuard stack ROUTES.RULES uses
// (`<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}>`), so an
// unauthenticated hit redirects to ROUTES.LOGIN exactly as it does for Rules
// today (PM-9 — no guard behavior changed by this page).
base.describe('Connectors page — route guard', () => {
  base.use({ storageState: { cookies: [], origins: [] } });

  base('a logged-out visitor hitting /organization/connectors is redirected to login, same as /organization/rules', async ({ page }) => {
    await page.goto(ROUTES.CONNECTORS);
    await expect(page).toHaveURL(new RegExp(ROUTES.LOGIN.replace(/\//g, '\\/')));
  });
});
