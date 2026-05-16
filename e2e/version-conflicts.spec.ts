/**
 * Version Conflicts E2E Tests (SCRUM-1126)
 *
 * Tests the version conflicts resolution page. Verifies page loads,
 * shows empty state when no conflicts, and displays loading state.
 */

import { test, expect } from './fixtures';

test.describe('Version Conflicts Page', () => {
  test('page loads at the expected route (unauthenticated redirects to login)', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto('/organization/version-conflicts');
    // Unauthenticated users get redirected to login
    await expect(page).toHaveURL(/login/, { timeout: 10000 });
    await context.close();
  });

  test('shows empty state or conflict cards when authenticated', async ({ orgAdminPage }) => {
    const page = orgAdminPage;
    await page.goto('/organization/version-conflicts');

    // Wait for page content to stabilize
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Should show either empty state or actual conflicts (depending on org data)
    const emptyState = page.getByTestId('version-conflicts-empty');
    const conflictCard = page.getByTestId('version-conflict-card').first();
    const errorState = page.getByTestId('version-conflicts-error');

    // Wait for one of the three final states
    await expect(
      emptyState.or(conflictCard).or(errorState),
    ).toBeVisible({ timeout: 15000 });
  });

  test('shows loading skeleton initially', async ({ orgAdminPage }) => {
    const page = orgAdminPage;

    // Intercept the API to delay response so we can observe loading state
    await page.route('**/api/queue/pending*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });

    await page.goto('/organization/version-conflicts');

    // Loading skeleton should appear while waiting for API
    const loading = page.getByTestId('version-conflicts-loading');
    await expect(loading).toBeVisible({ timeout: 5000 });
  });
});
