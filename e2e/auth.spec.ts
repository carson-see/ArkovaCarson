/**
 * Authentication E2E Tests
 *
 * Tests for signup, login, and email confirmation flows.
 */

import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows login form on auth page', async ({ page }) => {
    await page.goto('/auth');

    // Should show login form
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('shows Google OAuth button', async ({ page }) => {
    await page.goto('/auth');

    // Should show Google sign-in button
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
  });

  test('can navigate to signup form', async ({ page }) => {
    await page.goto('/auth');

    // Click "Create an account"
    await page.getByRole('button', { name: /Create an account/i }).click();

    // Should show signup form fields
    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByLabel('Confirm password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  });

  test('signup shows "Check your email" success state', async ({ page }) => {
    await page.goto('/signup');

    // Fill out signup form
    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Email address').fill('test@example.com');
    await page.getByLabel('Password', { exact: true }).fill('testpassword123');
    await page.getByLabel('Confirm password').fill('testpassword123');

    // Submit form
    await page.getByRole('button', { name: 'Create account' }).click();

    // Should show email confirmation message
    // Note: This may fail if Supabase is not running or email is rate limited
    await expect(page.getByText(/Check your email/i)).toBeVisible({ timeout: 10000 });
  });

  test('shows validation error for password mismatch', async ({ page }) => {
    await page.goto('/signup');

    // Fill out signup form with mismatched passwords
    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Email address').fill('test@example.com');
    await page.getByLabel('Password', { exact: true }).fill('testpassword123');
    await page.getByLabel('Confirm password').fill('differentpassword');

    // Submit form
    await page.getByRole('button', { name: 'Create account' }).click();

    // Should show error
    await expect(page.getByText(/Passwords do not match/i)).toBeVisible();
  });

  test('shows validation error for short password', async ({ page }) => {
    await page.goto('/signup');

    // Fill out signup form with short password
    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Email address').fill('test@example.com');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByLabel('Confirm password').fill('short');

    // Submit form
    await page.getByRole('button', { name: 'Create account' }).click();

    // Should show error
    await expect(page.getByText(/at least 8 characters/i)).toBeVisible();
  });

  test('sign out redirects to auth page', async ({ page }) => {
    // Log in with a seed user
    await page.goto('/auth');
    await page.getByLabel('Email address').fill('individual@demo.arkova.io');
    await page.getByLabel('Password').fill('Demo1234!');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Wait for navigation away from auth page (user lands on vault or dashboard)
    await page.waitForURL(/\/(vault|dashboard|onboarding)/, { timeout: 10000 });

    // Open the user dropdown menu and click Sign out
    // The sign-out button is in a dropdown menu in the Header
    const userMenuTrigger = page.locator('[data-testid="user-menu-trigger"]')
      .or(page.getByRole('button', { name: /avatar|profile|user|menu/i }));

    // If dropdown trigger exists, click it first
    if (await userMenuTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await userMenuTrigger.click();
    }

    // Click the Sign out button
    await page.getByRole('menuitem', { name: 'Sign out' })
      .or(page.getByRole('button', { name: 'Sign out' }))
      .click();

    // Should redirect to the auth/login page
    await expect(page).toHaveURL(/\/auth/, { timeout: 10000 });
    await expect(page.getByLabel('Email address')).toBeVisible();
  });
});
