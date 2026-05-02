/**
 * Route Guards E2E Tests
 *
 * Tests for route protection and redirection logic.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect, getServiceClient, SEED_USERS } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

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
      const timestamp = Date.now();
      const email = `e2e-norole-${timestamp}@test.arkova.io`;
      const password = SEED_USERS.individual.password;
      let context: BrowserContext | null = null;
      let userId: string | null = null;

      try {
        const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: 'No Role User' },
        });

        if (createError || !created.user) {
          throw new Error(`Failed to create no-role test user: ${createError?.message}`);
        }

        userId = created.user.id;

        const { error: profileError } = await serviceClient
          .from('profiles')
          .upsert({
            id: userId,
            email,
            full_name: 'No Role User',
            role: null,
            org_id: null,
            is_public_profile: false,
            is_platform_admin: false,
            disclaimer_accepted_at: new Date().toISOString(),
          });

        if (profileError) {
          throw new Error(`Failed to prepare no-role seed profile: ${profileError.message}`);
        }

        const userClient = createClient(
          process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
          process.env.VITE_SUPABASE_ANON_KEY || '',
        );
        const { data: sessionData, error: signInError } = await userClient.auth.signInWithPassword({
          email,
          password,
        });

        if (signInError || !sessionData.session) {
          throw new Error(`Failed to sign in no-role test user: ${signInError?.message}`);
        }

        context = await browser.newContext({
          storageState: {
            cookies: [],
            origins: [{
              origin: 'http://localhost:5173',
              localStorage: [{
                name: 'sb-127-auth-token',
                value: JSON.stringify(sessionData.session),
              }],
            }],
          },
        });
        const guardedPage = await context.newPage();

        // Try to navigate to /dashboard directly
        await guardedPage.goto('/dashboard');

        // RouteGuard should redirect role=NULL users to /onboarding/role
        await expect(guardedPage).toHaveURL(/\/onboarding\/role/, { timeout: 10000 });
        await expect(guardedPage.locator('body')).toContainText(
          /Choose how you'll use the platform|Get Started/i,
        );
      } finally {
        await context?.close();
        if (userId) {
          await serviceClient.auth.admin.deleteUser(userId);
        }
      }
    });
  });
});
