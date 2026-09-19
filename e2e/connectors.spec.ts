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
import { test as base } from '@playwright/test';
import { ROUTES } from '../src/lib/routes';

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
    await service.from('organization_rules').delete().eq('org_id', orgId).eq('trigger_type', 'WORKSPACE_FILE_MODIFIED');
    await service.from('org_integrations').delete().eq('org_id', orgId).eq('provider', 'google_drive');
  });

  test('org admin picks a Drive folder, chooses Secure it immediately, saves, and the selection persists on reload', async ({ orgAdminPage }) => {
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

    // Seed a connected Drive integration directly — this test exercises the
    // Connectors page's folder/action UI and the REAL /api/rules write path,
    // not the OAuth round-trip (covered by integrations-drive.spec.ts).
    await service.from('organization_rules').delete().eq('org_id', orgId).eq('trigger_type', 'WORKSPACE_FILE_MODIFIED');
    await service.from('org_integrations').delete().eq('org_id', orgId).eq('provider', 'google_drive');
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
