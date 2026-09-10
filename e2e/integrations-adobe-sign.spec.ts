/**
 * Adobe Sign integration E2E (SCRUM-1148 follow-up)
 *
 * Mocks Adobe + worker OAuth hops so the browser exercises the real OrgProfile
 * settings card without live provider credentials — which is not merely
 * convenient here: as of 2026-08-30 no Adobe Acrobat Sign application is
 * registered and production carries no Adobe credential at all, so there is no
 * live path to exercise.
 *
 * Mirrors integrations-docusign.spec.ts, plus the three states that are
 * specific to this connector and have no DocuSign equivalent:
 *
 *   - `adobe_sign_unconfigured` / kill-switch 503 — the LIVE production path,
 *     not an edge case.
 *   - `webhook_registration_failed` — the Adobe account plan does not grant
 *     `webhook_write`. Retrying cannot fix a plan, so the copy must not say
 *     "try again".
 *   - a disconnect that succeeded locally but left a live webhook Adobe-side
 *     (`adobe_webhook_removed: false`), which needs manual cleanup.
 *
 * Screenshots at 1280px and 375px are attached per CLAUDE.md §0 rule 6.
 */

import type { Page, TestInfo } from '@playwright/test';
import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

const WORKER = 'http://localhost:3001';
const START_URL = `${WORKER}/api/v1/integrations/adobe-sign/oauth/start`;
const DISCONNECT_URL = `${WORKER}/api/v1/integrations/adobe-sign/disconnect`;

type AdobeConnectionFixture = {
  id: string;
  account_label: string;
  account_id: string;
  connected_at: string;
  scope: string;
} | null;

async function routeAdobeConnection(page: Page, orgId: string, connection: AdobeConnectionFixture) {
  await page.route('**/rest/v1/org_integrations*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('provider') !== 'eq.adobe_sign') {
      await route.continue();
      return;
    }

    // Same discipline as the DocuSign spec: assert the card cannot silently
    // drop its org scoping and start surfacing a sibling org's connection.
    const expectedFilters = {
      org_id: `eq.${orgId}`,
      provider: 'eq.adobe_sign',
      revoked_at: 'is.null',
    };
    const missingFilters = Object.entries(expectedFilters)
      .filter(([key, value]) => url.searchParams.get(key) !== value)
      .map(([key]) => key);
    if (missingFilters.length > 0) {
      throw new Error(`Adobe Sign integration query missing expected filter(s): ${missingFilters.join(', ')}`);
    }

    // Credential-bearing columns must never be requested from the browser
    // (the GH #1836 DriveConnectorCard failure class).
    const select = url.searchParams.get('select') ?? '';
    for (const forbidden of ['encrypted_tokens', 'token_kms_key_id', 'token_secret_name', 'webhook_id']) {
      if (select.includes(forbidden)) {
        throw new Error(`Adobe Sign card selected a forbidden column from the browser: ${forbidden}`);
      }
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(connection),
      headers: connection ? undefined : { 'content-range': '*/0' },
    });
  });
}

/**
 * Attach UAT evidence for the Adobe Sign card (CLAUDE.md §0 rule 6).
 *
 * Deliberately NOT `page.screenshot({ fullPage: true })`. This app scrolls
 * inside a container rather than the document, so `fullPage` captures only the
 * above-the-fold region and the connector cards — which sit well below it —
 * never appear. The first pass of this spec produced byte-identical
 * "disconnected" and "connected" screenshots for exactly that reason: both were
 * pictures of the page header. Scroll the card into view and capture the card
 * element, then the viewport around it for layout context.
 */
async function attachCardScreenshots(page: Page, name: string, testInfo: TestInfo) {
  const card = page.locator('[data-testid="adobe-sign-card"]');
  await card.scrollIntoViewIfNeeded();
  await testInfo.attach(name, {
    body: await card.screenshot(),
    contentType: 'image/png',
  });
  await testInfo.attach(`${name}-in-page`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}

const CONNECTED_FIXTURE: NonNullable<AdobeConnectionFixture> = {
  id: 'int-adobe-e2e-1',
  account_label: 'Arkova Demo Co',
  account_id: 'adobe-user-e2e-001',
  connected_at: '2026-08-30T00:00:00Z',
  scope: 'webhook_read:account webhook_write:account webhook_retention:account',
};

test.describe('Adobe Sign integration', () => {
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

  test.describe('desktop viewport (1280px)', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test('Adobe Sign card is visible on org settings page', async ({ orgAdminPage }) => {
      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Organization Settings' })).toBeVisible();
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Adobe Sign')).toBeVisible();
    });

    test('disconnected state shows Connect button', async ({ orgAdminPage }, testInfo) => {
      await routeAdobeConnection(orgAdminPage, orgId, null);

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Not connected')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Connect' })).toBeVisible();
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-settings-desktop-1280', testInfo);
    });

    test('connected state shows account label and Disconnect button', async ({ orgAdminPage }, testInfo) => {
      await routeAdobeConnection(orgAdminPage, orgId, CONNECTED_FIXTURE);

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Connected')).toBeVisible();
      await expect(card.getByText(/Account: Arkova Demo Co/)).toBeVisible();
      await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-connected-desktop-1280', testInfo);
    });

    test('Connect redirects to the Adobe consent URL carrying the webhook scopes', async ({ orgAdminPage }) => {
      await routeAdobeConnection(orgAdminPage, orgId, null);

      const authUrl =
        'https://secure.na1.adobesign.com/public/oauth/v2?response_type=code'
        + '&scope=user_login%3Aself+agreement_read%3Aaccount+webhook_read%3Aaccount'
        + '+webhook_write%3Aaccount+webhook_retention%3Aaccount';

      await orgAdminPage.route(START_URL, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ authorizationUrl: authUrl, url: authUrl }),
        });
      });
      await orgAdminPage.route('https://secure.na1.adobesign.com/**', async (route) => {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Mock Adobe OAuth</body></html>' });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Not connected')).toBeVisible();

      const [request] = await Promise.all([
        orgAdminPage.waitForRequest((req) => req.url().includes('secure.na1.adobesign.com')),
        card.getByRole('button', { name: 'Connect' }).click(),
      ]);

      expect(request.url()).toContain('/public/oauth/v2');
      expect(request.url()).toContain('response_type=code');
      // webhook_retention is what DELETE needs at disconnect time, and Adobe
      // grants only what was requested at consent. Losing it from the consent
      // URL would not fail here — it would break disconnect months later.
      expect(decodeURIComponent(request.url())).toContain('webhook_retention:account');
      expect(decodeURIComponent(request.url())).toContain('webhook_write:account');
    });

    test('OAuth round-trip transitions the card from disconnected to connected', async ({ orgAdminPage }) => {
      const callbackUrl = `${WORKER}/api/v1/integrations/adobe-sign/oauth/callback?code=mock-code&state=e2e-state`;
      let integrationQueryCount = 0;

      // Threshold 2 tolerates React StrictMode's double-mount in dev.
      await orgAdminPage.route('**/rest/v1/org_integrations*', async (route) => {
        const url = route.request().url();
        if (!url.includes('provider=eq.adobe_sign')) {
          await route.continue();
          return;
        }
        integrationQueryCount += 1;
        if (integrationQueryCount <= 2) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(null),
            headers: { 'content-range': '*/0' },
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(CONNECTED_FIXTURE),
          });
        }
      });

      await orgAdminPage.route(START_URL, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationUrl: `https://secure.na1.adobesign.com/public/oauth/v2?state=e2e-state&redirect_uri=${encodeURIComponent(callbackUrl)}`,
          }),
        });
      });
      await orgAdminPage.route('https://secure.na1.adobesign.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>window.location.href=${JSON.stringify(callbackUrl)};</script></body></html>`,
        });
      });
      // The real worker registers the Adobe webhook and persists its id BEFORE
      // this redirect is issued; a failure there redirects with
      // adobe_sign_error instead (covered separately below).
      await orgAdminPage.route(`${WORKER}/api/v1/integrations/adobe-sign/oauth/callback**`, async (route) => {
        await route.fulfill({
          status: 302,
          headers: { location: `http://localhost:5173/organizations/${orgId}?tab=settings&adobe_sign=connected` },
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Not connected')).toBeVisible({ timeout: 10000 });
      await card.getByRole('button', { name: 'Connect' }).click();

      await expect(
        orgAdminPage.getByText('Adobe Sign connected. Completed agreements will now trigger rules.').first(),
      ).toBeVisible();
      await expect(card.getByText('Connected')).toBeVisible();
      await expect(card.getByText(/Account: Arkova Demo Co/)).toBeVisible();
      await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('unconfigured deployment shows the not-available copy — the live prod path', async ({ orgAdminPage }, testInfo) => {
      // Production has no ADOBE_SIGN_CLIENT_ID, so this is what an admin
      // actually hits today. It must read as "not available yet", never as a
      // generic failure the admin is invited to retry.
      await routeAdobeConnection(orgAdminPage, orgId, null);
      await orgAdminPage.route(START_URL, async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Adobe Sign is not configured on this deployment.',
            code: 'adobe_sign_unconfigured',
          }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await card.getByRole('button', { name: 'Connect' }).click();

      await expect(
        card.getByText('Adobe Sign is not available on this environment yet. Contact support to request access.'),
      ).toBeVisible();
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-unconfigured-desktop-1280', testInfo);
    });

    test('kill-switch 503 reads as not-available, not as a generic failure', async ({ orgAdminPage }) => {
      // ENABLE_ADOBE_SIGN_OAUTH defaults off; to an admin "disabled" and
      // "unconfigured" are one state.
      await routeAdobeConnection(orgAdminPage, orgId, null);
      await orgAdminPage.route(START_URL, async (route) => {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'integration_disabled', flag: 'ENABLE_ADOBE_SIGN_OAUTH' }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await card.getByRole('button', { name: 'Connect' }).click();

      await expect(card.getByText(/not available on this environment yet/i)).toBeVisible();
    });

    test('webhook_registration_failed explains the plan limit and does not say "try again"', async ({ orgAdminPage }, testInfo) => {
      // Adobe accepted the sign-in but refused to register the webhook —
      // almost always an account tier without webhook_write. Nothing was
      // saved. Telling the admin to retry would be actively wrong.
      await routeAdobeConnection(orgAdminPage, orgId, null);

      await orgAdminPage.goto(
        `/organizations/${orgId}?tab=settings&adobe_sign_error=webhook_registration_failed`,
      );

      // Surfaced as a toast by OrgProfilePage's searchParams effect (the same
      // handler Drive and DocuSign use), not by the card.
      const toast = orgAdminPage.locator('[data-sonner-toast]').filter({
        hasText: /would not register Arkova to receive completed agreements/i,
      });
      await expect(toast.first()).toBeVisible();

      // Scoped to the toast, not the page: other surfaces legitimately say
      // "try again". THIS message must not, because retrying cannot add
      // webhook_write to an Adobe account plan.
      await expect(toast.first()).not.toHaveText(/try again/i);
      await expect(toast.first()).toHaveText(/contact support/i);

      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Not connected')).toBeVisible();
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-webhook-refused-desktop-1280', testInfo);
    });

    test('webhook_already_claimed points at the other organization, not a retry', async ({ orgAdminPage }) => {
      // Migration 0426's partial unique index fired: another org already holds
      // this Adobe webhook id. A cross-tenant collision must not be dressed up
      // as a transient save failure.
      await routeAdobeConnection(orgAdminPage, orgId, null);

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings&adobe_sign_error=webhook_already_claimed`);

      await expect(
        orgAdminPage.getByText(/already connected to another organization/i).first(),
      ).toBeVisible();
    });

    test('org admin can disconnect and sees a clean teardown', async ({ orgAdminPage }) => {
      await routeAdobeConnection(orgAdminPage, orgId, CONNECTED_FIXTURE);
      await orgAdminPage.route(DISCONNECT_URL, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ disconnected: true, adobe_webhook_removed: true }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Connected')).toBeVisible();

      const [disconnectRequest] = await Promise.all([
        orgAdminPage.waitForRequest((req) => req.url() === DISCONNECT_URL && req.method() === 'POST'),
        card.getByRole('button', { name: 'Disconnect' }).click(),
      ]);

      expect(disconnectRequest.postDataJSON()).toEqual({ org_id: orgId });
      await expect(orgAdminPage.getByText('Adobe Sign disconnected.').first()).toBeVisible();
      await expect(card.getByText('Not connected')).toBeVisible();
    });

    test('a stranded Adobe-side webhook is surfaced, not hidden behind a clean disconnect', async ({ orgAdminPage }, testInfo) => {
      // Local teardown completed but Adobe kept the registration, so it is
      // still delivering to us and needs manual removal. Reporting only
      // "Disconnected." would hide a live webhook nobody knows about.
      await routeAdobeConnection(orgAdminPage, orgId, CONNECTED_FIXTURE);
      await orgAdminPage.route(DISCONNECT_URL, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ disconnected: true, adobe_webhook_removed: false }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await card.getByRole('button', { name: 'Disconnect' }).click();

      await expect(card.getByText(/Remove the Arkova webhook in your Adobe Acrobat Sign admin console/i)).toBeVisible();
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-stranded-webhook-desktop-1280', testInfo);
    });

    test('error state renders when the Supabase status query fails', async ({ orgAdminPage }) => {
      await orgAdminPage.route('**/rest/v1/org_integrations*', async (route) => {
        if (route.request().url().includes('provider=eq.adobe_sign')) {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'relation does not exist', code: '42P01' }),
          });
        } else {
          await route.continue();
        }
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      await expect(orgAdminPage.getByText('Unable to load Adobe Sign connection status.')).toBeVisible();
    });
  });

  test.describe('mobile viewport (375px)', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('card is visible and functional at mobile width', async ({ orgAdminPage }, testInfo) => {
      await routeAdobeConnection(orgAdminPage, orgId, null);

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Adobe Sign')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Connect' })).toBeVisible();
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-settings-mobile-375', testInfo);
    });

    test('connected state renders the account label at mobile width', async ({ orgAdminPage }, testInfo) => {
      await routeAdobeConnection(orgAdminPage, orgId, CONNECTED_FIXTURE);

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const card = orgAdminPage.locator('[data-testid="adobe-sign-card"]');
      await expect(card.getByText('Connected')).toBeVisible();
      await expect(card.getByText(/Account: Arkova Demo Co/)).toBeVisible();
      await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-connected-mobile-375', testInfo);
    });

    test('the long webhook-refusal message stays readable at mobile width', async ({ orgAdminPage }, testInfo) => {
      // This is the longest string the card can render; it is the one most
      // likely to overflow its container on a narrow viewport.
      await routeAdobeConnection(orgAdminPage, orgId, null);

      await orgAdminPage.goto(
        `/organizations/${orgId}?tab=settings&adobe_sign_error=webhook_registration_failed`,
      );
      await expect(orgAdminPage.getByText(/would not register Arkova/i).first()).toBeVisible();

      // The page must not scroll horizontally with the longest message on screen.
      const overflows = await orgAdminPage.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows).toBe(false);
      await attachCardScreenshots(orgAdminPage, 'adobe-sign-webhook-refused-mobile-375', testInfo);
    });
  });

  test.describe('entitlement gate', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test('non-admin cannot start a connection', async ({ individualPage }) => {
      const service = getServiceClient();
      const { data: profile, error } = await service
        .from('profiles')
        .select('org_id')
        .eq('id', SEED_USERS.individual.id)
        .single();
      expect(error).toBeNull();

      let targetOrgId = profile?.org_id as string | undefined;
      if (!targetOrgId) {
        const { data: adminProfile } = await service
          .from('profiles')
          .select('org_id')
          .eq('id', SEED_USERS.orgAdmin.id)
          .single();
        if (!adminProfile?.org_id) {
          throw new Error('Missing org admin org_id to exercise the non-admin Adobe Sign authz boundary');
        }
        targetOrgId = adminProfile.org_id as string;
      }

      await individualPage.goto(`/organizations/${targetOrgId}?tab=settings`);

      const card = individualPage.locator('[data-testid="adobe-sign-card"]');
      if (!(await card.isVisible().catch(() => false))) {
        // Card hidden from non-admins is a valid posture.
        return;
      }

      const connectButton = card.getByRole('button', { name: 'Connect' });
      if (!(await connectButton.isVisible().catch(() => false))) return;
      if (await connectButton.isDisabled()) return;

      await individualPage.route(START_URL, async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Must be org admin to connect Adobe Sign' }),
        });
      });
      await connectButton.click();
      await expect(individualPage.getByText(/must be org admin/i)).toBeVisible();
    });
  });
});
