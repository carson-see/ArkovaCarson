/**
 * Error States E2E Tests (Tier 3)
 *
 * Tests for error handling and edge cases:
 * - 404 record page
 * - Invalid verification ID
 * - Expired/cleared session redirect
 * - Malformed URLs
 * - SCRUM-1999: data-fetch failure surfaces an explicit error state (not a
 *   silent empty table) on the org registry.
 *
 * @created 2026-03-10 11:45 PM EST
 */

import { test, expect, getServiceClient, getSeedUserOrgId, SEED_USERS } from './fixtures';

test.describe('Error States', () => {
  test.describe('Non-Existent Record', () => {
    test('shows error for non-existent record UUID', async ({ individualPage }) => {
      await individualPage.goto('/records/00000000-0000-0000-0000-000000000000');

      // Should show a meaningful error — not a blank page
      await expect(
        individualPage.getByRole('heading', { name: 'Record Not Found' })
      ).toBeVisible({ timeout: 10000 });
      await expect(individualPage.locator('main')).toContainText(/does not exist|permission to view|not found/i);
    });

    test('shows error for malformed record ID', async ({ individualPage }) => {
      await individualPage.goto('/records/not-a-valid-uuid');

      // Should show error or redirect — not crash
      await expect(
        individualPage.getByRole('heading', { name: 'Record Not Found' })
      ).toBeVisible({ timeout: 10000 });
      await expect(individualPage.locator('main')).toContainText(/not found|invalid|error/i);
    });
  });

  test.describe('Invalid Verification', () => {
    test('shows verification failed for invalid public_id', async ({ page }) => {
      await page.goto('/verify/invalid_public_id_999');

      await expect(
        page.getByRole('heading', { name: 'Verification Failed' })
      ).toBeVisible({ timeout: 10000 });

      // Should show helpful message
      await expect(page.locator('main')).toContainText(/Unable to verify|may not exist|not been verified|not found/i);
    });

    test('shows verification failed for empty public_id', async ({ page }) => {
      await page.goto('/verify/');

      // Should show error or redirect — not blank page
      await expect(
        page.getByRole('heading', { name: /Verify a Credential|Verification Failed|404/i })
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Expired Session', () => {
    test('clearing cookies redirects to auth on next navigation', async ({ individualPage }) => {
      // Verify we are authenticated first
      await individualPage.goto('/dashboard');
      await expect(
        individualPage.getByRole('heading', { name: 'My Records' }).first()
      ).toBeVisible({ timeout: 10000 });

      // Simulate session expiry by clearing browser-held auth state
      await individualPage.context().clearCookies();
      await individualPage.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });

      // Navigate to a protected route
      await individualPage.goto('/dashboard');

      // Should redirect to auth page
      await expect(
        individualPage.getByLabel('Email address')
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Org Registry Data-Fetch Failure (SCRUM-1999)', () => {
    test('registry shows an explicit error state — not a silent empty table — when the records fetch fails', async ({ orgAdminPage }) => {
      const orgId = await getSeedUserOrgId(getServiceClient(), SEED_USERS.orgAdmin.id);

      // Force the org registry's records read to fail.
      //
      // OrgRegistryTable.fetchAnchors issues a PostgREST table read:
      //   GET <SUPABASE_URL>/rest/v1/anchors?select=...&org_id=eq.<id>&...
      // (supabase-js `.from('anchors').select(..., { count: 'exact' })`). The
      // sibling records-count read is a HEAD on the same path and must pass
      // through so the surrounding page still renders. We 500 only the GET,
      // which drives the component's retryable `'load'` branch (a 42501 /
      // `insufficient_privilege` body would instead trip the non-retryable
      // `'permission'` branch — not what we want here). The route is registered
      // before navigation so the very first records fetch is intercepted.
      const anchorsGlob = '**/rest/v1/anchors*';
      await orgAdminPage.route(anchorsGlob, async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Internal Server Error' }),
          });
          return;
        }
        // HEAD (count probe), OPTIONS (CORS preflight), etc. — let them through.
        await route.continue();
      });

      await orgAdminPage.goto(`/organizations/${orgId}`);

      // Wait until we're past the page's role/access gate and the registry
      // region has actually mounted — otherwise we'd race the SPA's async
      // mount + role fetch before the records fetch (and its failure) fires.
      await expect(
        orgAdminPage.getByRole('heading', { name: 'Records' }).first()
      ).toBeVisible({ timeout: 15000 });

      // OrgRegistryTable renders BOTH a mobile (`sm:hidden`) and a desktop
      // (`hidden sm:block`) copy of the error banner; only one is visible at a
      // given viewport. The previous `.first()` selector matched the mobile
      // banner first in DOM order, which is display:none on the desktop CI
      // viewport — so `toBeVisible()` saw `hidden` and timed out. Filter to the
      // *visible* banner instead of taking the first DOM match.
      const errorBanner = orgAdminPage
        .getByRole('alert')
        .filter({ hasText: /couldn.?t load records/i, visible: true });
      await expect(errorBanner).toBeVisible({ timeout: 10000 });

      // The explicit error state carries a retry affordance (Retry is shown for
      // the transient `'load'` kind). Target the visible instance, not `.first()`.
      await expect(
        orgAdminPage.getByRole('button', { name: /try again/i }).filter({ visible: true })
      ).toBeVisible();

      // And it must NOT fall through to the misleading "No records found" empty
      // state in either layout — error must read as error, never as empty.
      await expect(orgAdminPage.getByText(/no records found/i)).toHaveCount(0);

      await orgAdminPage.unroute(anchorsGlob);
    });
  });

  test.describe('Unknown Routes', () => {
    test('unknown route shows 404 or redirects', async ({ individualPage }) => {
      await individualPage.goto('/this-page-does-not-exist');

      // Should show 404, redirect to a known page, or show an error
      await expect(
        individualPage.getByRole('heading', { name: '404' })
          .or(individualPage.getByRole('heading', { name: /Dashboard|My Records/i }).first())
      ).toBeVisible({ timeout: 10000 });
    });
  });
});
