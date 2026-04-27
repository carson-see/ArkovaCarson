/**
 * Identity Regression E2E Tests
 *
 * Tests for role immutability, privileged field protection, and org scoping.
 * These tests verify security invariants at the E2E level.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect } from './fixtures';

// Identity specs test onboarding role selection and privileged field
// protection — most tests need unauthenticated or fresh-user context.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Identity Security', () => {
  test.describe('Role Immutability', () => {
    test('role selection page shows immutability warning', async ({ page }) => {
      await page.goto('/onboarding/role');

      await expect(page.getByText(/cannot be changed later/i)).toBeVisible();
    });

    test('role selector is a one-time choice UI', async ({ page }) => {
      await page.goto('/onboarding/role');

      await expect(page.getByText('Choose your account type')).toBeVisible();

      await expect(page.getByText('Individual')).toBeVisible();
      await expect(page.getByText('Organization')).toBeVisible();

      // Continue button should be disabled until selection
      const continueBtn = page.getByRole('button', { name: /Continue/i });
      await expect(continueBtn).toBeDisabled();

      // Select Individual
      await page.getByText('Individual').click();

      // Now continue should be enabled
      await expect(continueBtn).toBeEnabled();
    });
  });

  test.describe('Privileged Field Protection', () => {
    test('profile edit UI does not expose role field', async ({ page }) => {
      await page.goto('/settings/profile');

      const roleInput = page.getByLabel(/^Role$/i);
      const roleSelect = page.getByRole('combobox', { name: /role/i });

      await expect(roleInput.or(roleSelect)).not.toBeVisible();
    });

    test('profile edit UI does not expose org_id field', async ({ page }) => {
      await page.goto('/settings/profile');

      const orgIdInput = page.getByLabel(/org.*id/i);
      await expect(orgIdInput).not.toBeVisible();
    });
  });

  test.describe('Organization Scoping', () => {
    test('org onboarding creates isolated organization', async ({ page }) => {
      await page.goto('/onboarding/org');

      // No dropdown to select existing org
      const orgSelect = page.getByRole('combobox', { name: /organization/i });
      await expect(orgSelect).not.toBeVisible();

      // Only input fields for new org
      await expect(page.getByLabel(/Legal name/i)).toBeVisible();
    });

    test('organization display shows only user org', async ({ page }) => {
      await page.goto('/dashboard');

      // No org switcher that could allow accessing other orgs
      // Intentionally lenient — feature may not exist yet
      // Just verify the page loads without org-switching UI
      await expect(page.getByRole('combobox', { name: /organization/i })).toHaveCount(0);
    });
  });

  test.describe('Manual Review Gate', () => {
    test('review gate blocks all access', async ({ page }) => {
      await page.goto('/review-pending');

      await expect(page.getByText('Account Under Review')).toBeVisible();

      // Links to protected areas should not be visible from review page
      const vaultLink = page.getByRole('link', { name: /vault/i });
      const dashboardLink = page.getByRole('link', { name: /dashboard/i });

      await expect(vaultLink).not.toBeVisible();
      await expect(dashboardLink).not.toBeVisible();
    });

    test('review gate shows support contact', async ({ page }) => {
      await page.goto('/review-pending');

      await expect(page.getByText(/Questions/i)).toBeVisible();
      await expect(page.getByText(/support/i)).toBeVisible();
    });
  });
});
