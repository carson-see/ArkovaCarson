/**
 * Route Guards E2E Tests
 *
 * Tests for route protection and redirection logic.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect, getServiceClient } from './fixtures';
import { withProfileSession } from './helpers/profile-session';

// Route guard specs test unauthenticated redirect behavior and
// mid-onboarding flows — must start with no saved session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Route Guards', () => {
  const serviceClient = getServiceClient();

  test.describe('Unauthenticated Access', () => {
    test('redirects /records to auth when not logged in', async ({ page }) => {
      await page.goto('/records');
      await expect(page).toHaveURL(/\/(auth|login)(\/|\?|$)/);

      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });

    test('redirects /vault to auth when not logged in', async ({ page }) => {
      await page.goto('/vault');
      await expect(page).toHaveURL(/\/(auth|login)(\/|\?|$)/);

      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });

    test('redirects /dashboard to /auth when not logged in', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/(auth|login)(\/|\?|$)/);

      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });

    test('redirects /onboarding/role to /auth when not logged in', async ({ page }) => {
      await page.goto('/onboarding/role');
      await expect(page).toHaveURL(/\/(auth|login)(\/|\?|$)/);

      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Authenticated Routing', () => {
    test.use({ storageState: '.auth/individual.json' });

    test('INDIVIDUAL users can access the dashboard entrypoint', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard(\/|\?|$)/);

      await expect(page.locator('#main-content')).toContainText(
        /My Records|Secure Document|Total Records/i,
        { timeout: 10000 },
      );
    });
  });

  test.describe('Org Admin Routing', () => {
    test.use({ storageState: '.auth/orgAdmin.json' });

    test('ORG_ADMIN users can access the dashboard entrypoint', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard(\/|\?|$)/);

      await expect(page.locator('#main-content')).toContainText(
        /Audit My Organization|Total Records|Monthly Usage/i,
        { timeout: 10000 },
      );
    });
  });

  test.describe('Mid-Onboarding Redirect', () => {
    test('user with no role is redirected from /dashboard to /onboarding/role', async ({ browser }) => {
      await withProfileSession(
        browser,
        serviceClient,
        { role: null, emailPrefix: 'e2e-norole', fullName: 'No Role User' },
        async ({ page: guardedPage }) => {
          // Try to navigate to /dashboard directly
          await guardedPage.goto('/dashboard');

          // RouteGuard should redirect role=NULL users to /onboarding/role
          await expect(guardedPage).toHaveURL(/\/onboarding\/role/, { timeout: 10000 });
          await expect(guardedPage.locator('body')).toContainText(
            /Choose how you'll use the platform|Get Started/i,
          );
        },
      );
    });
  });
});
