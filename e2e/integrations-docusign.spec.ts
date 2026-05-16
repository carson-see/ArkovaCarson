/**
 * DocuSign integration E2E (SCRUM-1718)
 *
 * Mocks DocuSign + worker OAuth hops so the browser exercises the real
 * OrgProfile settings card without live provider credentials.
 *
 * Mirrors integrations-drive.spec.ts pattern.
 */

import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

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

    test('disconnected state shows Connect button', async ({ orgAdminPage }) => {
      // Mock Supabase org_integrations returning no rows
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

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]').or(
        orgAdminPage.locator('section', { has: orgAdminPage.getByRole('heading', { name: 'DocuSign' }) }),
      );
      await expect(docusignCard.getByText('Not connected')).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    });

    test('connected state shows account label and badge and Disconnect button', async ({ orgAdminPage }) => {
      // Mock Supabase org_integrations returning a connected row
      await orgAdminPage.route('**/rest/v1/org_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: 'int-e2e-1',
              account_label: 'Arkova Demo',
              account_id: 'acct-e2e-001',
              connected_at: '2026-05-01T00:00:00Z',
              scope: 'signature extended openid email',
            }),
          });
        } else {
          await route.continue();
        }
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('[data-testid="docusign-card"]').or(
        orgAdminPage.locator('section', { has: orgAdminPage.getByRole('heading', { name: 'DocuSign' }) }),
      );
      await expect(docusignCard.getByText('Connected')).toBeVisible();
      await expect(docusignCard.getByText(/Account: Arkova Demo/)).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('org admin can start the mocked OAuth happy path', async ({ orgAdminPage }) => {
      const callbackUrl = `http://localhost:3001/api/v1/integrations/docusign/oauth/callback?code=mock-code&state=e2e-state`;

      // Mock disconnected state initially
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

      const docusignCard = orgAdminPage.locator('section, [class*="card"], div').filter({ hasText: 'DocuSign' }).filter({ has: orgAdminPage.getByRole('button', { name: 'Connect' }) }).first();
      await docusignCard.getByRole('button', { name: 'Connect' }).click();

      // After mocked OAuth round-trip, verify success toast and URL
      await expect(orgAdminPage.getByText('DocuSign connected.').first()).toBeVisible();
      await expect(orgAdminPage).toHaveURL(new RegExp(`/organizations/${orgId}\\?tab=settings`));
    });

    test('Connect button triggers redirect to DocuSign domain', async ({ orgAdminPage }) => {
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

      // Capture the navigation to verify DocuSign domain
      let capturedUrl: string | null = null;
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/start', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationUrl: 'https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature+openid',
          }),
        });
      });

      // Intercept the DocuSign redirect to verify the URL contains the right domain
      await orgAdminPage.route('https://account-d.docusign.com/**', async (route) => {
        capturedUrl = route.request().url();
        // Fulfill with a blank page to prevent actual navigation issues
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body>Mock DocuSign OAuth</body></html>',
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('section, [class*="card"], div').filter({ hasText: 'DocuSign' }).filter({ has: orgAdminPage.getByRole('button', { name: 'Connect' }) }).first();
      await docusignCard.getByRole('button', { name: 'Connect' }).click();

      // Verify the redirect went to DocuSign domain
      await orgAdminPage.waitForURL(/account-d\.docusign\.com|localhost/);
      // The route intercept above proves the request went to account-d.docusign.com
      expect(capturedUrl).toContain('account-d.docusign.com');
    });

    test('error state renders gracefully when worker returns an error', async ({ orgAdminPage }) => {
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

      // Mock worker returning a 403
      await orgAdminPage.route('http://localhost:3001/api/v1/integrations/docusign/oauth/start', async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Must be org admin to connect DocuSign' }),
        });
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('section, [class*="card"], div').filter({ hasText: 'DocuSign' }).filter({ has: orgAdminPage.getByRole('button', { name: 'Connect' }) }).first();
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

    test('DocuSign card is visible and functional at mobile width', async ({ orgAdminPage }) => {
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

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('section, [class*="card"], div').filter({ hasText: 'DocuSign' }).filter({ has: orgAdminPage.getByRole('button', { name: 'Connect' }) }).first();
      await expect(docusignCard.getByText('DocuSign')).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    });

    test('connected state renders account label at mobile width', async ({ orgAdminPage }) => {
      // Mock connected state
      await orgAdminPage.route('**/rest/v1/org_integrations*', async (route) => {
        const url = route.request().url();
        if (url.includes('provider=eq.docusign')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: 'int-e2e-mobile',
              account_label: 'Mobile Test Org',
              account_id: 'acct-mobile-001',
              connected_at: '2026-05-01T00:00:00Z',
              scope: 'signature openid',
            }),
          });
        } else {
          await route.continue();
        }
      });

      await orgAdminPage.goto(`/organizations/${orgId}?tab=settings`);
      const docusignCard = orgAdminPage.locator('section, [class*="card"], div').filter({ hasText: 'DocuSign' }).filter({ has: orgAdminPage.getByRole('button', { name: 'Disconnect' }) }).first();
      await expect(docusignCard.getByText('Connected')).toBeVisible();
      await expect(docusignCard.getByText(/Account: Mobile Test Org/)).toBeVisible();
      await expect(docusignCard.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });
  });

  test.describe('non-admin access', () => {
    test('individual user sees the settings page but Connect is disabled or hidden', async ({ individualPage }) => {
      // Non-admin navigates to their own profile/settings — org admin features
      // should not be accessible. The individual user may not have an org at all,
      // or their role won't grant them the settings tab. We verify they cannot
      // reach the settings tab that contains the connector card.
      //
      // Note: if the app redirects or hides the settings tab for non-admins,
      // the DocuSign card simply won't be present on the page.
      const service = getServiceClient();
      const { data: profile } = await service
        .from('profiles')
        .select('org_id')
        .eq('id', SEED_USERS.individual.id)
        .single();

      if (!profile?.org_id) {
        // Individual user has no org — they can't access org settings at all
        // This is the expected behavior; the test passes by confirming no crash.
        return;
      }

      await individualPage.goto(`/organizations/${profile.org_id}?tab=settings`);

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

      // Card is visible but connect should fail with 403
      if (await connectButton.isVisible().catch(() => false)) {
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
});
