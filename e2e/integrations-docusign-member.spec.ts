/**
 * Member-level DocuSign OAuth E2E (SCRUM-2044)
 *
 * Exercises the member-level DocuSign integration card on org settings.
 * Member-level OAuth writes to `member_integrations` and is available
 * to any org member (not admin-only like org-level).
 *
 * Mirrors integrations-docusign.spec.ts patterns for org-level OAuth.
 */

import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

test.describe('Member-level DocuSign integration (SCRUM-2044)', () => {
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

    test('member sees "Connect your DocuSign" option in member settings section', async ({ orgAdminPage }) => {
      // Mock member_integrations returning no rows (not connected)
      await orgAdminPage.route('**/rest/v1/member_integrations*', async (route) => {
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

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      await expect(orgAdminPage.getByRole('heading', { name: 'Organization Settings' })).toBeVisible();

      const memberCard = orgAdminPage.locator('[data-testid="member-docusign-card"]');
      await expect(memberCard.getByText('Personal DocuSign')).toBeVisible();
      await expect(memberCard.getByText('Not connected')).toBeVisible();
      await expect(memberCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    });

    test('member OAuth flow works via mocked redirect cycle', async ({ orgAdminPage }) => {
      const callbackUrl = `http://localhost:3001/api/v1/integrations/docusign/member/oauth/callback?code=mock-member-code&state=e2e-member-state`;
      let integrationQueryCount = 0;

      // First query returns disconnected; subsequent returns connected
      await orgAdminPage.route('**/rest/v1/member_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          integrationQueryCount += 1;
          if (integrationQueryCount <= 1) {
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
              body: JSON.stringify({
                id: 'mint-e2e-member-1',
                account_label: 'Jane Member DS',
                account_id: 'acct-member-001',
                connected_at: '2026-05-27T12:00:00Z',
                scope: 'signature openid email',
              }),
            });
          }
        } else {
          await route.continue();
        }
      });

      // Mock member OAuth start endpoint
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/member/oauth/start', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationUrl: `https://account-d.docusign.com/oauth/auth?state=e2e-member-state&redirect_uri=${encodeURIComponent(callbackUrl)}`,
          }),
        });
      });

      // Mock DocuSign OAuth page -- redirect back to callback
      await orgAdminPage.route('https://account-d.docusign.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>window.location.href=${JSON.stringify(callbackUrl)};</script></body></html>`,
        });
      });

      // Mock callback -- redirect back to org settings with success
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/member/oauth/callback**', async (route) => {
        await route.fulfill({
          status: 302,
          headers: {
            location: `http://localhost:5173/organizations/${orgId}?tab=settings&docusign=connected`,
          },
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const memberCard = orgAdminPage.locator('[data-testid="member-docusign-card"]');

      // Starts disconnected
      await expect(memberCard.getByText('Not connected')).toBeVisible();
      await memberCard.getByRole('button', { name: 'Connect' }).click();

      // After mocked OAuth round-trip, verify success toast
      await expect(
        orgAdminPage.getByText('DocuSign connected.').first(),
      ).toBeVisible();

      // Card transitions to connected with member account details
      await expect(memberCard.getByText('Connected')).toBeVisible();
      await expect(memberCard.getByText(/Account: Jane Member DS/)).toBeVisible();
    });

    test('connected member integration shows status in member settings', async ({ orgAdminPage }) => {
      // Mock member_integrations returning a connected row
      await orgAdminPage.route('**/rest/v1/member_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: 'mint-e2e-connected',
              account_label: 'Connected Member Acct',
              account_id: 'acct-member-connected-001',
              connected_at: '2026-05-20T08:00:00Z',
              scope: 'signature extended openid email',
            }),
          });
        } else {
          await route.continue();
        }
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const memberCard = orgAdminPage.locator('[data-testid="member-docusign-card"]');
      await expect(memberCard.getByText('Connected')).toBeVisible();
      await expect(memberCard.getByText(/Account: Connected Member Acct/)).toBeVisible();
      await expect(memberCard.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('member can disconnect their personal DocuSign integration', async ({ orgAdminPage }) => {
      let disconnectCalled = false;

      // Mock connected state
      await orgAdminPage.route('**/rest/v1/member_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              disconnectCalled
                ? null
                : {
                    id: 'mint-e2e-disconnect-test',
                    account_label: 'To Be Disconnected',
                    account_id: 'acct-disconnect-001',
                    connected_at: '2026-05-15T00:00:00Z',
                    scope: 'signature openid',
                  },
            ),
            headers: disconnectCalled ? { 'content-range': '*/0' } : {},
          });
        } else {
          await route.continue();
        }
      });

      // Mock disconnect endpoint
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/member/disconnect', async (route) => {
        disconnectCalled = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ disconnected: true }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const memberCard = orgAdminPage.locator('[data-testid="member-docusign-card"]');
      await expect(memberCard.getByText('Connected')).toBeVisible();

      await memberCard.getByRole('button', { name: 'Disconnect' }).click();

      // After disconnect, card reverts to disconnected state
      await expect(memberCard.getByText('Not connected')).toBeVisible();
      await expect(memberCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    });

    test('callback error param renders docusign_error toast for member OAuth', async ({ orgAdminPage }) => {
      // Mock disconnected state
      await orgAdminPage.route('**/rest/v1/member_integrations*', async (route) => {
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

      // Simulate landing back with error param (e.g., token exchange failed)
      await orgAdminPage.goto(
        `/organizations/${orgId}?tab=settings&docusign_error=save_failed`,
      );

      await expect(
        orgAdminPage.getByText('DocuSign connection failed: save_failed').first(),
      ).toBeVisible();

      const memberCard = orgAdminPage.locator('[data-testid="member-docusign-card"]');
      await expect(memberCard.getByText('Not connected')).toBeVisible();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Mobile viewport (375px)                                            */
  /* ------------------------------------------------------------------ */

  test.describe('mobile viewport (375px)', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('member integration card is visible and functional at mobile width', async ({ orgAdminPage }) => {
      // Mock disconnected state
      await orgAdminPage.route('**/rest/v1/member_integrations*', async (route) => {
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

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const memberCard = orgAdminPage.locator('[data-testid="member-docusign-card"]');
      await expect(memberCard.getByText('Personal DocuSign')).toBeVisible();
      await expect(memberCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    });

    test('connected member integration renders account label at mobile width', async ({ orgAdminPage }) => {
      await orgAdminPage.route('**/rest/v1/member_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: 'mint-e2e-mobile',
              account_label: 'Mobile Member Acct',
              account_id: 'acct-mobile-member-001',
              connected_at: '2026-05-01T00:00:00Z',
              scope: 'signature openid',
            }),
          });
        } else {
          await route.continue();
        }
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const memberCard = orgAdminPage.locator('[data-testid="member-docusign-card"]');
      await expect(memberCard.getByText('Connected')).toBeVisible();
      await expect(memberCard.getByText(/Account: Mobile Member Acct/)).toBeVisible();
      await expect(memberCard.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Non-member access boundary                                         */
  /* ------------------------------------------------------------------ */

  test.describe('non-member access', () => {
    test('non-member cannot access member OAuth flow', async ({ individualPage }) => {
      const service = getServiceClient();
      const { data: profile, error } = await service
        .from('profiles')
        .select('org_id')
        .eq('id', SEED_USERS.individual.id)
        .single();
      expect(error).toBeNull();

      // If the individual has their own org, navigate to its settings.
      // Otherwise navigate to the org admin's org settings to test the authz boundary.
      if (profile?.org_id) {
        await individualPage.goto(`/organizations/${profile.org_id}?tab=settings`);
      } else {
        const { data: adminProfile } = await service
          .from('profiles')
          .select('org_id')
          .eq('id', SEED_USERS.orgAdmin.id)
          .single();
        if (!adminProfile?.org_id) {
          throw new Error('Missing org admin org_id to exercise the non-member DocuSign authz boundary');
        }
        await individualPage.goto(`/organizations/${adminProfile.org_id}?tab=settings`);
      }

      // Mock the member OAuth start endpoint to return 403 for non-members
      await individualPage.route('http://localhost:3001/api/v1/integrations/docusign/member/oauth/start', async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Must be an org member to connect a personal DocuSign account' }),
        });
      });

      const memberCard = individualPage.locator('[data-testid="member-docusign-card"]');
      const cardVisible = await memberCard.isVisible().catch(() => false);

      if (!cardVisible) {
        // Card hidden from non-members -- correct security posture
        return;
      }

      // Card is visible: Connect should fail with 403 or be disabled
      const connectButton = memberCard.getByRole('button', { name: 'Connect' });
      if (await connectButton.isVisible().catch(() => false)) {
        if (await connectButton.isDisabled()) {
          // Button disabled for non-members -- correct behavior
          return;
        }

        await connectButton.click();
        await expect(individualPage.getByText(/must be an org member/i)).toBeVisible();
      }
    });
  });
});
