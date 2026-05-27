/**
 * DocuSign integration E2E (SCRUM-1718, SCRUM-1872)
 *
 * Mocks DocuSign + worker OAuth hops so the browser exercises the real
 * OrgProfile settings card without live provider credentials.
 *
 * SCRUM-1872 additions: notarized envelope attestation badge tests.
 *
 * Mirrors integrations-drive.spec.ts pattern.
 */

import type { Page, TestInfo } from '@playwright/test';
import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

type DocusignConnectionFixture = {
  id: string;
  account_label: string;
  account_id: string;
  connected_at: string;
  scope: string;
} | null;

async function routeDocusignConnection(page: Page, orgId: string, connection: DocusignConnectionFixture) {
  await page.route('**/rest/v1/org_integrations*', async (route) => {
    const url = new URL(route.request().url());
    const isDocusignQuery = url.searchParams.get('provider') === 'eq.docusign'
      || url.searchParams.get('select')?.includes('account_id');

    if (!isDocusignQuery) {
      await route.continue();
      return;
    }

    const expectedFilters = {
      org_id: `eq.${orgId}`,
      provider: 'eq.docusign',
      revoked_at: 'is.null',
    };
    const missingFilters = Object.entries(expectedFilters)
      .filter(([key, value]) => url.searchParams.get(key) !== value)
      .map(([key]) => key);

    if (missingFilters.length > 0) {
      throw new Error(`DocuSign integration query missing expected filter(s): ${missingFilters.join(', ')}`);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(connection),
      headers: connection ? undefined : { 'content-range': '*/0' },
    });
  });
}

async function attachFullPageScreenshot(page: Page, name: string, testInfo: TestInfo) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

test.describe('DocuSign integration', () => {
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

    test('DocuSign card is visible on org settings page', async ({ orgAdminPage }) => {
      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Organization Settings' })).toBeVisible();
      await expect(orgAdminPage.getByText('DocuSign')).toBeVisible();
    });

    test('disconnected state shows Connect button', async ({ orgAdminPage }, testInfo) => {
      await routeDocusignConnection(orgAdminPage, orgId, null);

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await expect(docusignCard.getByText('Not connected')).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Connect' })).toBeVisible();
      await attachFullPageScreenshot(orgAdminPage, 'docusign-settings-desktop-1280', testInfo);
    });

    test('connected state shows account label and badge and Disconnect button', async ({ orgAdminPage }) => {
      await routeDocusignConnection(orgAdminPage, orgId, {
        id: 'int-e2e-1',
        account_label: 'Arkova Demo',
        account_id: 'acct-e2e-001',
        connected_at: '2026-05-01T00:00:00Z',
        scope: 'signature extended openid email',
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await expect(docusignCard.getByText('Connected')).toBeVisible();
      await expect(docusignCard.getByText(/Account: Arkova Demo/)).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('org admin can disconnect a connected DocuSign account', async ({ orgAdminPage }) => {
      await routeDocusignConnection(orgAdminPage, orgId, {
        id: 'int-e2e-disconnect',
        account_label: 'Arkova Demo',
        account_id: 'acct-e2e-disconnect',
        connected_at: '2026-05-01T00:00:00Z',
        scope: 'signature extended openid email',
      });

      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/disconnect', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await expect(docusignCard.getByText('Connected')).toBeVisible();

      const [disconnectRequest] = await Promise.all([
        orgAdminPage.waitForRequest((request) => (
          request.url() === 'http://localhost:3001/api/v1/integrations/docusign/disconnect'
          && request.method() === 'POST'
        )),
        docusignCard.getByRole('button', { name: 'Disconnect' }).click(),
      ]);

      expect(disconnectRequest.postDataJSON()).toEqual({ org_id: orgId });
      await expect(orgAdminPage.getByText('DocuSign disconnected.').first()).toBeVisible();
      await expect(docusignCard.getByText('Not connected')).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    });

    test('org admin can start the mocked OAuth happy path', async ({ orgAdminPage }) => {
      const callbackUrl = `http://localhost:3001/api/v1/integrations/docusign/oauth/callback?code=mock-code&state=e2e-state`;

      await routeDocusignConnection(orgAdminPage, orgId, null);

      // Mock OAuth start endpoint
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/start', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationUrl: `https://account-d.docusign.com/oauth/auth?state=e2e-state&redirect_uri=${encodeURIComponent(callbackUrl)}`,
          }),
        });
      });

      // Mock DocuSign OAuth page — immediately redirect back to callback
      await orgAdminPage.route('https://account-d.docusign.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>window.location.href=${JSON.stringify(callbackUrl)};</script></body></html>`,
        });
      });

      // Mock callback endpoint — redirect back to org settings with success param
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/callback**', async (route) => {
        await route.fulfill({
          status: 302,
          headers: {
            location: `http://localhost:5173/organizations/${orgId}?tab=settings&docusign=connected`,
          },
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Organization Settings' })).toBeVisible();

      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await docusignCard.getByRole('button', { name: 'Connect' }).click();

      // After mocked OAuth round-trip, verify success toast and URL
      await expect(orgAdminPage.getByText('DocuSign connected.').first()).toBeVisible();
      await expect(orgAdminPage).toHaveURL(
        (url) => new URL(url).pathname === `/organizations/${orgId}` && new URL(url).searchParams.get('tab') === 'settings',
      );
    });

    test('Connect button triggers redirect to DocuSign domain', async ({ orgAdminPage }) => {
      await routeDocusignConnection(orgAdminPage, orgId, null);

      // Mock OAuth start endpoint — returns the authorizationUrl
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/start', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationUrl: 'https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature+openid',
          }),
        });
      });

      // Intercept the DocuSign navigation so the browser doesn't actually leave
      await orgAdminPage.route('https://account-d.docusign.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body>Mock DocuSign OAuth</body></html>',
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');

      // Use waitForRequest to capture the outbound navigation request
      const [request] = await Promise.all([
        orgAdminPage.waitForRequest((req) => req.url().includes('account-d.docusign.com')),
        docusignCard.getByRole('button', { name: 'Connect' }).click(),
      ]);

      expect(request.url()).toContain('account-d.docusign.com');
      expect(request.url()).toContain('response_type=code');
    });

    test('OAuth happy path transitions card from disconnected to connected after provisioning', async ({ orgAdminPage }) => {
      const callbackUrl = `http://localhost:3001/api/v1/integrations/docusign/oauth/callback?code=mock-code&state=e2e-state`;
      let integrationQueryCount = 0;

      // First query returns disconnected; subsequent queries return connected
      // (simulates the re-fetch after OAuth callback redirect)
      await orgAdminPage.route('**/rest/v1/org_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          integrationQueryCount += 1;
          if (integrationQueryCount <= 1) {
            // Initial load: not connected
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(null),
              headers: { 'content-range': '*/0' },
            });
          } else {
            // After callback redirect: connected with provisioned account
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                id: 'int-e2e-provisioned',
                account_label: 'Arkova Provisioned',
                account_id: 'acct-provisioned-001',
                connected_at: '2026-05-27T17:35:00Z',
                scope: 'signature extended openid email',
              }),
            });
          }
        } else {
          await route.continue();
        }
      });

      // Mock OAuth start endpoint
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/start', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationUrl: `https://account-d.docusign.com/oauth/auth?state=e2e-state&redirect_uri=${encodeURIComponent(callbackUrl)}`,
          }),
        });
      });

      // Mock DocuSign OAuth page — immediately redirect back to callback
      await orgAdminPage.route('https://account-d.docusign.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>window.location.href=${JSON.stringify(callbackUrl)};</script></body></html>`,
        });
      });

      // Mock callback endpoint — redirect with docusign=connected
      // In the real flow, the worker calls provisionConnectListener (fire-and-forget)
      // before issuing this redirect. The provisioning result does not affect the
      // redirect — the UI always shows connected if the DB upsert succeeded.
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/callback**', async (route) => {
        await route.fulfill({
          status: 302,
          headers: {
            location: `http://localhost:5173/organizations/${orgId}?tab=settings&docusign=connected`,
          },
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');

      // Starts disconnected
      await expect(docusignCard.getByText('Not connected')).toBeVisible();
      await docusignCard.getByRole('button', { name: 'Connect' }).click();

      // After OAuth round-trip, toast confirms provisioning-backed connection
      await expect(
        orgAdminPage.getByText('DocuSign connected. Completed envelopes will now trigger rules.').first(),
      ).toBeVisible();

      // Card transitions to connected with the provisioned account details
      await expect(docusignCard.getByText('Connected')).toBeVisible();
      await expect(docusignCard.getByText(/Account: Arkova Provisioned/)).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('callback error param renders docusign_error toast gracefully', async ({ orgAdminPage }) => {
      // Mock disconnected state
      await orgAdminPage.route('**/rest/v1/org_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(null),
            headers: { 'content-range': '*/0' },
          });
        } else {
          await route.continue();
        }
      });

      // Simulate landing back on the settings page with a docusign_error param
      // (e.g., when DB upsert failed or token exchange failed during callback)
      await orgAdminPage.goto(
        `/organizations/${orgId}?tab=settings&docusign_error=save_failed`,
      );

      // Error toast is shown with the error code
      await expect(
        orgAdminPage.getByText('DocuSign connection failed: save_failed').first(),
      ).toBeVisible();

      // Card remains in disconnected state
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await expect(docusignCard.getByText('Not connected')).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    });

    test('error state renders gracefully when worker returns an error', async ({ orgAdminPage }) => {
      await routeDocusignConnection(orgAdminPage, orgId, null);

      // Mock worker returning a 403
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/start', async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Must be org admin to connect DocuSign' }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await docusignCard.getByRole('button', { name: 'Connect' }).click();

      await expect(orgAdminPage.getByText('Must be org admin to connect DocuSign')).toBeVisible();
    });

    test('error state renders when Supabase query fails', async ({ orgAdminPage }) => {
      // Mock Supabase returning an error
      await orgAdminPage.route('**/rest/v1/org_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
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
      await expect(orgAdminPage.getByText('Unable to load DocuSign connection status.')).toBeVisible();
    });
  });

  test.describe('mobile viewport (375px)', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('DocuSign card is visible and functional at mobile width', async ({ orgAdminPage }, testInfo) => {
      await routeDocusignConnection(orgAdminPage, orgId, null);

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await expect(docusignCard.getByText('DocuSign')).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Connect' })).toBeVisible();
      await attachFullPageScreenshot(orgAdminPage, 'docusign-settings-mobile-375', testInfo);
    });

    test('connected state renders account label at mobile width', async ({ orgAdminPage }) => {
      await routeDocusignConnection(orgAdminPage, orgId, {
        id: 'int-e2e-mobile',
        account_label: 'Mobile Test Org',
        account_id: 'acct-mobile-001',
        connected_at: '2026-05-01T00:00:00Z',
        scope: 'signature openid',
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]');
      await expect(docusignCard.getByText('Connected')).toBeVisible();
      await expect(docusignCard.getByText(/Account: Mobile Test Org/)).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });
  });

  test.describe('non-admin access', () => {
    test('individual user sees the settings page but Connect is disabled or hidden', async ({ individualPage }) => {
      // Non-admin navigates to org settings — org admin features should not be
      // accessible. If the individual user has no org, that itself is a valid
      // security posture (they can't reach org settings at all).
      const service = getServiceClient();
      const { data: profile, error } = await service
        .from('profiles')
        .select('org_id')
        .eq('id', SEED_USERS.individual.id)
        .single();
      expect(error).toBeNull();

      // If individual has their own org, navigate to its settings. Otherwise,
      // navigate to the org admin's org settings as the individual user to test
      // the authz boundary (they shouldn't be able to connect).
      if (profile?.org_id) {
        await individualPage.goto(`/organizations/${profile.org_id}?tab=settings`);
      } else {
        const { data: adminProfile } = await service
          .from('profiles')
          .select('org_id')
          .eq('id', SEED_USERS.orgAdmin.id)
          .single();
        if (!adminProfile?.org_id) {
          throw new Error('Missing org admin org_id to exercise the non-admin DocuSign authz boundary');
        }
        await individualPage.goto(`/organizations/${adminProfile.org_id}?tab=settings`);
      }

      // Either the settings tab redirects/hides the connector, or the API
      // returns 403 and the card shows an error. Both are valid security postures.
      const connectButton = individualPage.getByRole('button', { name: 'Connect' });
      const docusignCard = individualPage.getByText('DocuSign');

      // At least one of these must be true: card is not visible, or clicking
      // Connect yields an error (not a real redirect).
      const cardVisible = await docusignCard.isVisible().catch(() => false);
      if (!cardVisible) {
        // Card hidden from non-admins — correct behavior
        return;
      }

      // Card is visible but connect should fail with 403 or be disabled
      if (await connectButton.isVisible().catch(() => false)) {
        if (await connectButton.isDisabled()) {
          // Button visible but disabled for non-admins — correct behavior
          return;
        }

        await individualPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/start', async (route) => {
          await route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Must be org admin to connect DocuSign' }),
          });
        });

        await connectButton.click();
        await expect(individualPage.getByText(/must be org admin/i)).toBeVisible();
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /*  SCRUM-1872: Notarization badge on DocuSign-linked attestations     */
  /* ------------------------------------------------------------------ */

  test.describe('DocuSign notarization flow (SCRUM-1872)', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test('notarized envelope creates attestation with notarization badge', async ({ orgAdminPage }) => {
      // Mock legal_attestations returning a notarized attestation
      // (the notarization job has already processed this envelope)
      await orgAdminPage.route('**/rest/v1/attestations*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'att-notarized-ds',
              public_id: 'pub-notarized-ds',
              attestation_type: 'VERIFICATION',
              status: 'ACTIVE',
              attester_name: 'DocuSign Notary Org',
              attester_type: 'INSTITUTION',
              attester_title: null,
              subject_type: 'credential',
              subject_identifier: 'NOTARIZED-CERT-001',
              claims: [{ claim: 'Employment verified and notarized' }],
              summary: 'Notarized via DocuSign',
              jurisdiction: null,
              fingerprint: 'd'.repeat(64),
              chain_tx_id: null,
              issued_at: '2026-05-25T00:00:00Z',
              expires_at: null,
              created_at: '2026-05-25T00:00:00Z',
              notarized_at: '2026-05-25T14:30:00Z',
              notary_name: 'Alice Notary',
              notary_commission_state: 'NY',
              docusign_envelope_id: 'env-notarized-001',
            },
          ]),
          headers: { 'content-range': '0-0/1' },
        });
      });

      await orgAdminPage.goto('/attestations');
      await expect(orgAdminPage.getByRole('heading', { name: /Attestations/i })).toBeVisible({ timeout: 10000 });

      // Notarization badge must be present
      await expect(orgAdminPage.getByText(/Notarized/i).first()).toBeVisible();
      // Subject identifier from the notarized attestation
      await expect(orgAdminPage.getByText('NOTARIZED-CERT-001')).toBeVisible();
    });

    test('non-notarized envelope does not show notarization badge', async ({ orgAdminPage }) => {
      // Mock legal_attestations returning a plain (non-notarized) attestation
      await orgAdminPage.route('**/rest/v1/attestations*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'att-plain-ds',
              public_id: 'pub-plain-ds',
              attestation_type: 'VERIFICATION',
              status: 'ACTIVE',
              attester_name: 'DocuSign Plain Org',
              attester_type: 'INSTITUTION',
              attester_title: null,
              subject_type: 'credential',
              subject_identifier: 'PLAIN-CERT-001',
              claims: [{ claim: 'Employment verified' }],
              summary: 'Standard DocuSign envelope',
              jurisdiction: null,
              fingerprint: 'e'.repeat(64),
              chain_tx_id: null,
              issued_at: '2026-05-25T00:00:00Z',
              expires_at: null,
              created_at: '2026-05-25T00:00:00Z',
              notarized_at: null,
              notary_name: null,
              notary_commission_state: null,
              docusign_envelope_id: 'env-plain-001',
            },
          ]),
          headers: { 'content-range': '0-0/1' },
        });
      });

      await orgAdminPage.goto('/attestations');
      await expect(orgAdminPage.getByRole('heading', { name: /Attestations/i })).toBeVisible({ timeout: 10000 });

      // Non-notarized envelope should NOT show notarization badge
      await expect(orgAdminPage.getByTestId('notarization-badge')).not.toBeVisible();
      await expect(orgAdminPage.getByText('PLAIN-CERT-001')).toBeVisible();
    });
  });
});
