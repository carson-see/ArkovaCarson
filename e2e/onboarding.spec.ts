/**
 * Onboarding E2E Tests
 *
 * Tests for role selection and organization onboarding flows.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import type { Browser, Page } from '@playwright/test';
import { test, expect, getServiceClient } from './fixtures';
import { withProfileSession, type TestProfileOptions } from './helpers/profile-session';

const serviceClient = getServiceClient();

// Onboarding specs exercise pages that AuthGuard/RouteGuard only render
// for specific authenticated profile states. Use blank default storage and
// create fresh users per test so the route state is explicit.
test.use({ storageState: { cookies: [], origins: [] } });

async function withOnboardingPage(
  browser: Browser,
  profile: TestProfileOptions,
  run: (page: Page) => Promise<void>,
) {
  await withProfileSession(
    browser,
    serviceClient,
    {
      ...profile,
      emailPrefix: 'e2e-onboarding',
      fullName: 'Onboarding E2E User',
    },
    async (session) => {
      await run(session.page);
    },
  );
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
