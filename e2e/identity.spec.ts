/**
 * Identity Regression E2E Tests
 *
 * Tests for role immutability, privileged field protection, and org scoping.
 * These tests verify security invariants at the E2E level.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { createClient } from '@supabase/supabase-js';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

const serviceClient = getServiceClient();

async function createProfilePage(
  browser: Browser,
  profile: {
    role: 'INDIVIDUAL' | 'ORG_ADMIN' | null;
    orgId?: string | null;
    requiresManualReview?: boolean;
  },
): Promise<{ page: Page; context: BrowserContext; userId: string }> {
  const timestamp = Date.now();
  const email = `e2e-identity-${timestamp}-${Math.random().toString(36).slice(2)}@test.arkova.io`;
  const password = SEED_USERS.individual.password;

  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Identity E2E User' },
  });

  if (createError || !created.user) {
    throw new Error(`Failed to create identity test user: ${createError?.message}`);
  }

  const userId = created.user.id;
  const { error: profileError } = await serviceClient
    .from('profiles')
    .upsert({
      id: userId,
      email,
      full_name: 'Identity E2E User',
      role: profile.role,
      org_id: profile.orgId ?? null,
      requires_manual_review: profile.requiresManualReview ?? false,
      is_public_profile: false,
      is_platform_admin: false,
      disclaimer_accepted_at: new Date().toISOString(),
    });

  if (profileError) {
    await serviceClient.auth.admin.deleteUser(userId);
    throw new Error(`Failed to prepare identity test profile: ${profileError.message}`);
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
    throw new Error(`Failed to sign in identity test user: ${signInError?.message}`);
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

async function disposeProfilePage(context: BrowserContext | null, userId: string | null) {
  await context?.close();
  if (userId) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
}

async function openRoleSelector(page: Page) {
  await page.goto('/onboarding/role');
  await page.getByRole('button', { name: 'Get Started' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your account type' })).toBeVisible();
}

test.describe('Identity Security', () => {
  test.describe('Role Immutability', () => {
    test('role selection page shows immutability warning', async ({ browser }) => {
      let context: BrowserContext | null = null;
      let userId: string | null = null;

      try {
        const session = await createProfilePage(browser, { role: null });
        context = session.context;
        userId = session.userId;

        await openRoleSelector(session.page);
        await expect(session.page.getByText(/cannot be changed later/i)).toBeVisible();
      } finally {
        await disposeProfilePage(context, userId);
      }
    });

    test('role selector is a one-time choice UI', async ({ browser }) => {
      let context: BrowserContext | null = null;
      let userId: string | null = null;

      try {
        const session = await createProfilePage(browser, { role: null });
        context = session.context;
        userId = session.userId;

        await openRoleSelector(session.page);

        await expect(session.page.getByRole('heading', { name: 'Individual' })).toBeVisible();
        await expect(session.page.getByRole('heading', { name: 'Organization' })).toBeVisible();

        // Continue button should be disabled until selection
        const continueBtn = session.page.getByRole('button', { name: /Continue/i });
        await expect(continueBtn).toBeDisabled();

        // Select Individual
        await session.page.getByRole('heading', { name: 'Individual' }).click();

        // Now continue should be enabled
        await expect(continueBtn).toBeEnabled();
      } finally {
        await disposeProfilePage(context, userId);
      }
    });
  });

  test.describe('Privileged Field Protection', () => {
    test('profile edit UI does not expose role field', async ({ individualPage }) => {
      await individualPage.goto('/settings/profile');

      const roleInput = individualPage.getByLabel(/^Role$/i);
      const roleSelect = individualPage.getByRole('combobox', { name: /role/i });

      await expect(roleInput.or(roleSelect)).not.toBeVisible();
    });

    test('profile edit UI does not expose org_id field', async ({ individualPage }) => {
      await individualPage.goto('/settings/profile');

      const orgIdInput = individualPage.getByLabel(/org.*id/i);
      await expect(orgIdInput).not.toBeVisible();
    });
  });

  test.describe('Organization Scoping', () => {
    test('org onboarding creates isolated organization', async ({ browser }) => {
      let context: BrowserContext | null = null;
      let userId: string | null = null;

      try {
        const session = await createProfilePage(browser, { role: 'ORG_ADMIN' });
        context = session.context;
        userId = session.userId;

        await session.page.goto('/onboarding/org');

        // No dropdown to select an existing org
        await expect(session.page.getByRole('combobox', { name: /^Organization$/i })).toHaveCount(0);

        // Only input fields for new org
        await expect(session.page.getByLabel(/Legal name/i)).toBeVisible();
      } finally {
        await disposeProfilePage(context, userId);
      }
    });

    test('organization display shows only user org', async ({ individualPage }) => {
      await individualPage.goto('/dashboard');

      // No org switcher that could allow accessing other orgs
      // Intentionally lenient — feature may not exist yet
      // Just verify the page loads without org-switching UI
      await expect(individualPage.getByRole('combobox', { name: /^Organization$/i })).toHaveCount(0);
    });
  });

  test.describe('Manual Review Gate', () => {
    test('review gate blocks all access', async ({ browser }) => {
      let context: BrowserContext | null = null;
      let userId: string | null = null;

      try {
        const session = await createProfilePage(browser, {
          role: 'INDIVIDUAL',
          requiresManualReview: true,
        });
        context = session.context;
        userId = session.userId;

        await session.page.goto('/review-pending');

        await expect(session.page.getByText('Account Under Review')).toBeVisible();

        // Links to protected areas should not be visible from review page
        const vaultLink = session.page.getByRole('link', { name: /vault/i });
        const dashboardLink = session.page.getByRole('link', { name: /dashboard/i });

        await expect(vaultLink).not.toBeVisible();
        await expect(dashboardLink).not.toBeVisible();
      } finally {
        await disposeProfilePage(context, userId);
      }
    });

    test('review gate shows support contact', async ({ browser }) => {
      let context: BrowserContext | null = null;
      let userId: string | null = null;

      try {
        const session = await createProfilePage(browser, {
          role: 'INDIVIDUAL',
          requiresManualReview: true,
        });
        context = session.context;
        userId = session.userId;

        await session.page.goto('/review-pending');

        await expect(session.page.getByText(/Questions/i)).toBeVisible();
        await expect(session.page.getByText(/support/i)).toBeVisible();
      } finally {
        await disposeProfilePage(context, userId);
      }
    });
  });
});
