/**
 * Frontend Performance Smoke Tests
 *
 * Lightweight performance checks for critical user-facing pages:
 * - Dashboard load time
 * - Public verification page load time
 * - Records list rendering
 *
 * These are E2E smoke tests, not benchmarks. Thresholds are generous
 * to avoid flaky CI failures while catching severe regressions.
 *
 * @created 2026-03-11 12:00 AM EST
 * @category e2e-performance
 */

import { test, expect, getServiceClient, getSeedUserOrgId, SEED_USERS } from './fixtures';

test.describe('Frontend Performance', () => {
  const serviceClient = getServiceClient();

  test.describe('Dashboard Load', () => {
    test('dashboard loads within 5 seconds', async ({ individualPage }) => {
      const start = Date.now();
      await individualPage.goto('/dashboard');

      // Wait for meaningful content to render
      await expect(
        individualPage.getByRole('button', { name: 'My Records' })
          .or(individualPage.getByRole('button', { name: 'Secure Document' }))
          .first()
      ).toBeVisible({ timeout: 10000 });

      const elapsed = Date.now() - start;

      // Dashboard should load in under 5 seconds (generous for CI)
      expect(elapsed).toBeLessThan(5000);

      // eslint-disable-next-line no-console
      console.log(`[PERF] Dashboard loaded in ${elapsed}ms`);
    });

    test('dashboard stats render without long delay', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');

      const start = Date.now();

      // Wait for stats cards or empty state to render
      await expect(
        individualPage.getByText('Total Records', { exact: true })
          .or(individualPage.getByText('No records yet'))
          .first()
      ).toBeVisible({ timeout: 10000 });

      const elapsed = Date.now() - start;

      // Stats should render within 3 seconds of page load
      expect(elapsed).toBeLessThan(3000);

      // eslint-disable-next-line no-console
      console.log(`[PERF] Dashboard stats rendered in ${elapsed}ms`);
    });
  });

  test.describe('Public Verification Page', () => {
    test('verification page loads within 3 seconds', async ({ page }) => {
      const start = Date.now();

      // Navigate to public verification page (no auth required)
      await page.goto('/verify/nonexistent-id');

      // Wait for page to render (either error or verification result)
      await expect(page.getByRole('heading', { name: /Verify a Credential|Verification Failed/i }).first()).toBeVisible({ timeout: 10000 });

      const elapsed = Date.now() - start;

      // Public page should be fast — under 3 seconds
      expect(elapsed).toBeLessThan(3000);

      // eslint-disable-next-line no-console
      console.log(`[PERF] Verification page loaded in ${elapsed}ms`);
    });
  });

  test.describe('Navigation Performance', () => {
    test('navigating between pages does not exceed 3 seconds', async ({ individualPage }) => {
      // Start on vault
      await individualPage.goto('/dashboard');
      await expect(
        individualPage.getByRole('button', { name: 'My Records' })
          .or(individualPage.getByRole('button', { name: 'Secure Document' }))
          .first()
      ).toBeVisible({ timeout: 10000 });

      // Navigate to settings
      const navStart = Date.now();
      await individualPage.goto('/settings');
      await expect(
        individualPage.locator('#main-content').getByRole('heading', { name: /Settings/i }).first()
      ).toBeVisible({ timeout: 10000 });
      const navElapsed = Date.now() - navStart;

      expect(navElapsed).toBeLessThan(3000);

      // eslint-disable-next-line no-console
      console.log(`[PERF] Vault → Settings navigation: ${navElapsed}ms`);
    });

    test('org admin page loads within 5 seconds', async ({ orgAdminPage }) => {
      const orgId = await getSeedUserOrgId(serviceClient, SEED_USERS.orgAdmin.id);
      const start = Date.now();
      await orgAdminPage.goto(`/organizations/${orgId}`);

      await expect(
        orgAdminPage.getByRole('heading', { name: /Acme Corp|Organization/i })
          .or(orgAdminPage.getByRole('tab', { name: 'People' }))
          .first()
      ).toBeVisible({ timeout: 10000 });

      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5000);

      // eslint-disable-next-line no-console
      console.log(`[PERF] Org admin page loaded in ${elapsed}ms`);
    });
  });
});
