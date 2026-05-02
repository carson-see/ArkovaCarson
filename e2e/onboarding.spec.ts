/**
 * Onboarding E2E Tests
 *
 * Tests for role selection and organization onboarding flows.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { createClient } from '@supabase/supabase-js';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

const serviceClient = getServiceClient();

// Onboarding specs exercise pages that AuthGuard/RouteGuard only render
// for specific authenticated profile states. Use blank default storage and
// create fresh users per test so the route state is explicit.
test.use({ storageState: { cookies: [], origins: [] } });

async function createOnboardingPage(
  browser: Browser,
  profile: {
    role: 'INDIVIDUAL' | 'ORG_ADMIN' | null;
    orgId?: string | null;
    requiresManualReview?: boolean;
  },
): Promise<{ page: Page; context: BrowserContext; userId: string }> {
  const timestamp = Date.now();
  const email = `e2e-onboarding-${timestamp}-${Math.random().toString(36).slice(2)}@test.arkova.io`;
  const password = SEED_USERS.individual.password;

  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Onboarding E2E User' },
  });

  if (createError || !created.user) {
    throw new Error(`Failed to create onboarding test user: ${createError?.message}`);
  }

  const userId = created.user.id;
  const { error: profileError } = await serviceClient
    .from('profiles')
    .upsert({
      id: userId,
      email,
      full_name: 'Onboarding E2E User',
      role: profile.role,
      org_id: profile.orgId ?? null,
      requires_manual_review: profile.requiresManualReview ?? false,
      is_public_profile: false,
      is_platform_admin: false,
      disclaimer_accepted_at: new Date().toISOString(),
    });

  if (profileError) {
    await serviceClient.auth.admin.deleteUser(userId);
    throw new Error(`Failed to prepare onboarding test profile: ${profileError.message}`);
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
    await serviceClient.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in onboarding test user: ${signInError?.message}`);
  }

  const context = await browser.newContext({
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
  const page = await context.newPage();

  return { page, context, userId };
}

async function disposeOnboardingPage(context: BrowserContext | null, userId: string | null) {
  await context?.close();
  if (userId) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
}

async function withOnboardingPage(
  browser: Browser,
  profile: Parameters<typeof createOnboardingPage>[1],
  run: (page: Page) => Promise<void>,
) {
  let context: BrowserContext | null = null;
  let userId: string | null = null;

  try {
    const session = await createOnboardingPage(browser, profile);
    context = session.context;
    userId = session.userId;
    await run(session.page);
  } finally {
    await disposeOnboardingPage(context, userId);
  }
}

async function openRoleSelector(page: Page) {
  await page.goto('/onboarding/role');
  await page.getByRole('button', { name: 'Get Started' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your account type' })).toBeVisible();
}

function roleOption(page: Page, description: string) {
  return page.locator('.cursor-pointer').filter({ hasText: description }).first();
}

test.describe('Onboarding', () => {
  test.describe('Role Selection', () => {
    test('shows role selection options', async ({ browser }) => {
      await withOnboardingPage(browser, { role: null }, async (page) => {
        await openRoleSelector(page);

        await expect(page.getByRole('heading', { name: 'Individual' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Organization' })).toBeVisible();
        await expect(page.getByText('Personal document security')).toBeVisible();
        await expect(page.getByText('Business document security')).toBeVisible();
      });
    });

    test('can select Individual role', async ({ browser }) => {
      await withOnboardingPage(browser, { role: null }, async (page) => {
        await openRoleSelector(page);

        const individualOption = roleOption(page, 'Personal document security');
        await individualOption.click();

        await expect(individualOption).toHaveClass(/border-primary/);
        await expect(page.getByRole('button', { name: /Continue/i })).toBeEnabled();
      });
    });

    test('can select Organization role', async ({ browser }) => {
      await withOnboardingPage(browser, { role: null }, async (page) => {
        await openRoleSelector(page);

        const organizationOption = roleOption(page, 'Business document security');
        await organizationOption.click();

        await expect(organizationOption).toHaveClass(/border-primary/);
        await expect(page.getByRole('button', { name: /Continue/i })).toBeEnabled();
      });
    });

    test('shows one-time selection warning', async ({ browser }) => {
      await withOnboardingPage(browser, { role: null }, async (page) => {
        await openRoleSelector(page);

        await expect(page.getByText(/cannot be changed later/i)).toBeVisible();
      });
    });
  });

  test.describe('Organization Onboarding', () => {
    test('shows org onboarding form', async ({ browser }) => {
      await withOnboardingPage(browser, { role: 'ORG_ADMIN' }, async (page) => {
        await page.goto('/onboarding/org');

        await expect(page.getByRole('heading', { name: 'Set up your organization' })).toBeVisible();
        await expect(page.getByLabel(/Organization name/i)).toBeVisible();
        await expect(page.getByLabel(/Legal name/i)).toBeVisible();
        await expect(page.getByLabel('Company domain')).toBeVisible();
      });
    });

    test('requires organization name', async ({ browser }) => {
      await withOnboardingPage(browser, { role: 'ORG_ADMIN' }, async (page) => {
        await page.goto('/onboarding/org');

        await expect(page.getByLabel(/Organization name/i)).toHaveAttribute('required');
      });
    });

    test('validates domain format', async ({ browser }) => {
      await withOnboardingPage(browser, { role: 'ORG_ADMIN' }, async (page) => {
        await page.goto('/onboarding/org');

        await page.getByLabel(/Organization name/i).fill('Test Corp Inc.');
        await page.getByLabel('Company domain').fill('invalid domain!');

        await page.getByRole('button', { name: 'Create organization' }).click();

        await expect(page.getByText(/valid domain/i)).toBeVisible();
      });
    });
  });

  test.describe('Manual Review Gate', () => {
    test('shows review pending message', async ({ browser }) => {
      await withOnboardingPage(browser, { role: 'INDIVIDUAL', requiresManualReview: true }, async (page) => {
        await page.goto('/review-pending');

        await expect(page.getByText('Account Under Review')).toBeVisible();
        await expect(page.getByText(/requires manual verification/i)).toBeVisible();
        await expect(page.getByText(/1-2 business days/i)).toBeVisible();
      });
    });

    test('shows sign out option', async ({ browser }) => {
      await withOnboardingPage(browser, { role: 'INDIVIDUAL', requiresManualReview: true }, async (page) => {
        await page.goto('/review-pending');

        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      });
    });
  });
});
