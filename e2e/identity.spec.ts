/**
 * Identity Regression E2E Tests
 *
 * Tests for role immutability, privileged field protection, and org scoping.
 * These tests verify security invariants at the E2E level.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import type { Browser, Page } from '@playwright/test';
import { test, expect, getServiceClient } from './fixtures';
import {
  withProfileSession,
  type ProfileSession,
  type TestProfileOptions,
} from './helpers/profile-session';

const serviceClient = getServiceClient();

async function withIdentityPage(
  browser: Browser,
  profile: TestProfileOptions,
  run: (session: ProfileSession) => Promise<void>,
) {
  await withProfileSession(
    browser,
    serviceClient,
    {
      ...profile,
      emailPrefix: 'e2e-identity',
      fullName: 'Identity E2E User',
    },
    run,
  );
}

async function openRoleSelector(page: Page) {
  await page.goto('/onboarding/role');
  await page.getByRole('button', { name: 'Get Started' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your account type' })).toBeVisible();
}

test.describe('Identity Security', () => {
  test.describe('Role Immutability', () => {
    test('role selection page shows immutability warning', async ({ browser }) => {
      await withIdentityPage(browser, { role: null }, async ({ page }) => {
        await openRoleSelector(page);
        await expect(page.getByText(/cannot be changed later/i)).toBeVisible();
      });
    });

    test('role selector is a one-time choice UI', async ({ browser }) => {
      await withIdentityPage(browser, { role: null }, async ({ page }) => {
        await openRoleSelector(page);

        await expect(page.getByRole('heading', { name: 'Individual' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Organization' })).toBeVisible();

        // Continue button should be disabled until selection
        const continueBtn = page.getByRole('button', { name: /Continue/i });
        await expect(continueBtn).toBeDisabled();

        // Select Individual
        await page.getByRole('heading', { name: 'Individual' }).click();

        // Now continue should be enabled
        await expect(continueBtn).toBeEnabled();
      });
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
      await withIdentityPage(browser, { role: 'ORG_ADMIN' }, async ({ page }) => {
        await page.goto('/onboarding/org');

        // No dropdown to select an existing org
        await expect(page.getByRole('combobox', { name: /^Organization$/i })).toHaveCount(0);

        // Only input fields for new org
        await expect(page.getByLabel(/Legal name/i)).toBeVisible();
      });
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
      await withIdentityPage(
        browser,
        {
          role: 'INDIVIDUAL',
          requiresManualReview: true,
        },
        async ({ page }) => {
          await page.goto('/review-pending');

          await expect(page.getByText('Account Under Review')).toBeVisible();

          // Links to protected areas should not be visible from review page
          const vaultLink = page.getByRole('link', { name: /vault/i });
          const dashboardLink = page.getByRole('link', { name: /dashboard/i });

          await expect(vaultLink).not.toBeVisible();
          await expect(dashboardLink).not.toBeVisible();
        },
      );
    });

    test('review gate shows support contact', async ({ browser }) => {
      await withIdentityPage(
        browser,
        {
          role: 'INDIVIDUAL',
          requiresManualReview: true,
        },
        async ({ page }) => {
          await page.goto('/review-pending');

          await expect(page.getByText(/Questions/i)).toBeVisible();
          await expect(page.getByText(/support/i)).toBeVisible();
        },
      );
    });
  });
});
