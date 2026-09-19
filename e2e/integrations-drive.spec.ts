/**
 * Google Drive integration E2E (SCRUM-1168)
 *
 * Mocks Google + worker OAuth hops so the browser exercises the real
 * OrgProfile settings card without live provider credentials.
 */

import { test, expect } from './fixtures';
import { ROUTES } from '../src/lib/routes';

test.describe('Google Drive integration', () => {
  test('org admin can start and complete the mocked OAuth happy path', async ({ orgAdminPage }) => {
    const callbackUrl = 'http://localhost:3001/api/v1/integrations/google_drive/oauth/callback?code=mock-code&state=e2e-state';

    await orgAdminPage.route('http://localhost:3001/api/v1/integrations/google_drive/oauth/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=e2e-state&redirect_uri=${encodeURIComponent(callbackUrl)}`,
        }),
      });
    });

    await orgAdminPage.route('https://accounts.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body><script>window.location.href=${JSON.stringify(callbackUrl)};</script></body></html>`,
      });
    });

    await orgAdminPage.route('http://localhost:3001/api/v1/integrations/google_drive/oauth/callback**', async (route) => {
      await route.fulfill({
        status: 302,
        headers: {
          location: `http://localhost:5173${ROUTES.CONNECTORS}?drive=connected`,
        },
      });
    });

    await orgAdminPage.goto(ROUTES.CONNECTORS);
    await expect(orgAdminPage.getByRole('heading', { name: 'Connectors' })).toBeVisible();
    const driveHeading = orgAdminPage.getByRole('heading', { name: 'Google Drive' });
    await expect(driveHeading).toBeVisible();
    const driveCard = driveHeading.locator('../..');

    await driveCard.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(orgAdminPage.getByText('Google Drive connected.').first()).toBeVisible();
    await expect(orgAdminPage).toHaveURL((url) => new URL(url).pathname === ROUTES.CONNECTORS);
  });
});
