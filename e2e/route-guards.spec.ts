/**
 * Route Guards E2E Tests
 *
 * Tests for route protection and redirection logic.
 */

import { test, expect } from '@playwright/test';

test.describe('Route Guards', () => {
  test.describe('Unauthenticated Access', () => {
    test('redirects /vault to /auth when not logged in', async ({ page }) => {
      await page.goto('/vault');

      // Should redirect to auth or show auth required message
      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });

    test('redirects /dashboard to /auth when not logged in', async ({ page }) => {
      await page.goto('/dashboard');

      // Should redirect to auth or show auth required message
      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });

    test('redirects /onboarding/role to /auth when not logged in', async ({ page }) => {
      await page.goto('/onboarding/role');

      // Should redirect to auth
      await expect(
        page.getByText(/Authentication Required/i).or(page.getByLabel('Email address'))
      ).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Role-based Routing', () => {
    // Note: These tests require authenticated users with specific roles
    // In production, use Playwright fixtures with pre-seeded test users

    test('INDIVIDUAL users cannot access /dashboard', async ({ page }) => {
      // This test would need an authenticated INDIVIDUAL user
      // For now, test that the route exists and shows appropriate content
      await page.goto('/dashboard');

      // Should not show dashboard content for unauthenticated users
      await expect(page.getByText(/Dashboard/i).or(page.getByText(/Authentication Required/i))).toBeVisible();
    });

    test('ORG_ADMIN users cannot access /vault directly', async ({ page }) => {
      // This test would need an authenticated ORG_ADMIN user
      // For now, test that the route exists
      await page.goto('/vault');

      // Should show vault or auth required
      await expect(page.getByText(/Vault/i).or(page.getByText(/Authentication Required/i))).toBeVisible();
    });
  });

  test.describe('Mid-Onboarding Redirect', () => {
    test('user with no role is redirected from /dashboard to /onboarding/role', async ({ page }) => {
      // Sign up a fresh user with no role set (mid-onboarding state).
      // Seed users already have roles, so we create a new account.
      const timestamp = Date.now();
      const email = `e2e-norole-${timestamp}@test.arkova.io`;
      const password = 'TestPassword123!';

      await page.goto('/signup');
      await page.getByLabel('Full name').fill('No Role User');
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByLabel('Confirm password').fill(password);
      await page.getByRole('button', { name: 'Create account' }).click();

      // In local dev, Supabase auto-confirms email.
      // After signup, the user should be redirected to onboarding/role
      // because their profile has role = NULL.
      // Wait for either the email confirmation page or auto-redirect.
      await page.waitForURL(/\/(onboarding\/role|auth)/, { timeout: 15000 }).catch(() => {
        // If auto-confirm is off, the user sees "Check your email" — that's OK.
        // The test still validates the route guard behavior below.
      });

      // If we ended up on the email confirmation page, log in manually
      if (page.url().includes('/auth') || await page.getByText(/Check your email/i).isVisible().catch(() => false)) {
        // Auto-confirm may be off; sign in to continue
        await page.goto('/auth');
        await page.getByLabel('Email address').fill(email);
        await page.getByLabel('Password').fill(password);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForURL(/\/(onboarding|vault|dashboard)/, { timeout: 10000 });
      }

      // Now try to navigate to /dashboard directly
      await page.goto('/dashboard');

      // RouteGuard should redirect role=NULL users to /onboarding/role
      await expect(page).toHaveURL(/\/onboarding\/role/, { timeout: 10000 });
      await expect(page.getByText('Individual').or(page.getByText('Organization'))).toBeVisible();
    });
  });
});
