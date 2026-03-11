/**
 * Authentication E2E Tests
 *
 * Tests for signup, login, and email confirmation flows.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect, SEED_USERS } from './fixtures';

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows login form on auth page', async ({ page }) => {
    await page.goto('/auth');

    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('shows Google OAuth button', async ({ page }) => {
    await page.goto('/auth');

    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
  });

  test('can navigate to signup form', async ({ page }) => {
    await page.goto('/auth');

    await page.getByRole('button', { name: /Create an account/i }).click();

    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByLabel('Confirm password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  });

  test('signup shows "Check your email" success state', async ({ page }) => {
    await page.goto('/signup');

    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Email address').fill('test@example.com');
    await page.getByLabel('Password', { exact: true }).fill('testpassword123');
    await page.getByLabel('Confirm password').fill('testpassword123');

    await page.getByRole('button', { name: 'Create account' }).click();

    // Note: May fail if Supabase not running or email rate limited
    await expect(page.getByText(/Check your email/i)).toBeVisible({ timeout: 10000 });
  });

  test('shows validation error for password mismatch', async ({ page }) => {
    await page.goto('/signup');

    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Email address').fill('test@example.com');
    await page.getByLabel('Password', { exact: true }).fill('testpassword123');
    await page.getByLabel('Confirm password').fill('differentpassword');

    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText(/Passwords do not match/i)).toBeVisible();
  });

  test('shows validation error for short password', async ({ page }) => {
    await page.goto('/signup');

    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Email address').fill('test@example.com');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByLabel('Confirm password').fill('short');

    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText(/at least 8 characters/i)).toBeVisible();
  });

  test('sign out redirects to auth page', async ({ page }) => {
    // Log in with seed user via shared helper
    await page.goto('/auth');
    await page.getByLabel('Email address').fill(SEED_USERS.individual.email);
    await page.getByLabel('Password').fill(SEED_USERS.individual.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(/\/(vault|dashboard|onboarding)/, { timeout: 10000 });

    // Open user dropdown and sign out
    const userMenuTrigger = page.locator('[data-testid="user-menu-trigger"]')
      .or(page.getByRole('button', { name: /avatar|profile|user|menu/i }));

    if (await userMenuTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await userMenuTrigger.click();
    }

    await page.getByRole('menuitem', { name: 'Sign out' })
      .or(page.getByRole('button', { name: 'Sign out' }))
      .click();

    await expect(page).toHaveURL(/\/auth/, { timeout: 10000 });
    await expect(page.getByLabel('Email address')).toBeVisible();
  });
});
