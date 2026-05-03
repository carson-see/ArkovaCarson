/**
 * Authentication E2E Tests
 *
 * Tests for signup, login, and email confirmation flows.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect, SEED_USERS, getServiceClient } from './fixtures';
import { uniqueTestId } from './helpers/unique';

// Auth spec tests the login/signup forms themselves — they must start
// unauthenticated. Override the project-level storageState so the
// browser context has no saved session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows login form on auth page', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('shows Google OAuth button', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('button', { name: 'Google' })).toBeVisible();
  });

  test('can navigate to signup form', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('button', { name: /Create an account/i }).click();

    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByLabel('Confirm password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  });

  test('signup creates account and enters the authenticated app', async ({ page }) => {
    const serviceClient = getServiceClient();
    const email = `${uniqueTestId('e2e-signup')}@test.arkova.io`;
    let userId: string | null = null;

    await page.goto('/signup');

    try {
      await page.getByLabel('Full name').fill('Test User');
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password', { exact: true }).fill('testpassword123');
      await page.getByLabel('Confirm password').fill('testpassword123');

      await page.getByRole('button', { name: 'Create account' }).click();

      await page.waitForURL(/\/(dashboard|onboarding|review-pending)/, { timeout: 15000 });

      const { data: profile } = await serviceClient
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      userId = (profile?.id as string | undefined) ?? null;
    } finally {
      if (!userId) {
        const { data: profile } = await serviceClient
          .from('profiles')
          .select('id')
          .eq('email', email)
          .maybeSingle();
        userId = (profile?.id as string | undefined) ?? null;
      }

      if (!userId) {
        const { data: users } = await serviceClient.auth.admin.listUsers();
        userId = users.users.find((user) => user.email === email)?.id ?? null;
      }

      if (userId) {
        await serviceClient.auth.admin.deleteUser(userId);
      }
    }
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

    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await expect
      .poll(async () =>
        page.getByLabel('Password', { exact: true }).evaluate((input) => ({
          valid: (input as HTMLInputElement).validity.valid,
          message: (input as HTMLInputElement).validationMessage,
        }))
      )
      .toMatchObject({ valid: false, message: /8/ });
  });

  test('sign out redirects to auth page', async ({ page }) => {
    const serviceClient = getServiceClient();
    const email = `${uniqueTestId('e2e-signout')}@test.arkova.io`;
    let userId: string | null = null;

    try {
      const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
        email,
        password: SEED_USERS.individual.password,
        email_confirm: true,
        user_metadata: { full_name: 'Jamie Demo-User' },
      });

      if (createError || !created.user) {
        throw new Error(`Failed to create sign-out test user: ${createError?.message}`);
      }

      userId = created.user.id;

      const { error: profileError } = await serviceClient
        .from('profiles')
        .upsert({
          id: userId,
          email,
          full_name: 'Jamie Demo-User',
          role: 'INDIVIDUAL',
          org_id: null,
          is_public_profile: false,
          is_platform_admin: false,
          disclaimer_accepted_at: new Date().toISOString(),
        });

      if (profileError) {
        throw new Error(`Failed to prepare sign-out test profile: ${profileError.message}`);
      }

      await page.goto('/login');
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password').fill(SEED_USERS.individual.password);
      await page.getByRole('button', { name: 'Sign in' }).click();

      await page.waitForURL(/\/(vault|dashboard|onboarding)/, { timeout: 10000 });

      // Open user dropdown and sign out. The disposable user prevents this
      // test from invalidating the shared storageState seed session.
      await page.getByRole('button', { name: /Jamie Demo.*User/i }).click();

      await page.getByRole('menuitem', { name: 'Sign out' })
        .or(page.getByRole('button', { name: 'Sign out' }))
        .click();

      // signOut hard-redirects to /login (src/hooks/useAuth.ts), not /auth.
      await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
      await expect(page.getByLabel('Email address')).toBeVisible();
    } finally {
      if (userId) {
        await serviceClient.auth.admin.deleteUser(userId);
      }
    }
  });
});
