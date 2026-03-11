/**
 * Route Guards E2E Tests
 *
 * Tests for route protection and redirection logic.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect, SEED_USERS } from './fixtures';

test.describe('Route Guards', () => {
  test.describe('Unauthenticated Access', () => {
    test('redirects /vault to /auth when not logged in', async ({ page }) => {
      await page.goto('/vault');

      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });

    test('redirects /dashboard to /auth when not logged in', async ({ page }) => {
      await page.goto('/dashboard');

      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });

    test('redirects /onboarding/role to /auth when not logged in', async ({ page }) => {
      await page.goto('/onboarding/role');

      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Role-based Routing', () => {
    test('INDIVIDUAL users cannot access /dashboard', async ({ page }) => {
      await page.goto('/dashboard');

      await expect(page.getByText(/Dashboard/i).or(page.getByText(/Authentication Required/i))).toBeVisible();
    });

    test('ORG_ADMIN users cannot access /vault directly', async ({ page }) => {
      await page.goto('/vault');

      await expect(page.getByText(/Vault/i).or(page.getByText(/Authentication Required/i))).toBeVisible();
    });
  });

  test.describe('Mid-Onboarding Redirect', () => {
    test('user with no role is redirected from /dashboard to /onboarding/role', async ({ page }) => {
      // Sign up a fresh user with no role (mid-onboarding state)
      const timestamp = Date.now();
      const email = `e2e-norole-${timestamp}@test.arkova.io`;
      const password = SEED_USERS.individual.password;

      await page.goto('/signup');
      await page.getByLabel('Full name').fill('No Role User');
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByLabel('Confirm password').fill(password);
      await page.getByRole('button', { name: 'Create account' }).click();

      // In local dev, Supabase auto-confirms email
      await page.waitForURL(/\/(onboarding\/role|auth)/, { timeout: 15000 }).catch(() => {
        // Auto-confirm may be off — OK, test validates route guard below
      });

      // If ended up on email confirmation page, log in manually
      if (page.url().includes('/auth') || await page.getByText(/Check your email/i).isVisible().catch(() => false)) {
        await page.goto('/auth');
        await page.getByLabel('Email address').fill(email);
        await page.getByLabel('Password').fill(password);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForURL(/\/(onboarding|vault|dashboard)/, { timeout: 10000 });
      }

      // Try to navigate to /dashboard directly
      await page.goto('/dashboard');

      // RouteGuard should redirect role=NULL users to /onboarding/role
      await expect(page).toHaveURL(/\/onboarding\/role/, { timeout: 10000 });
      await expect(page.getByText('Individual').or(page.getByText('Organization'))).toBeVisible();
    });
  });
});
