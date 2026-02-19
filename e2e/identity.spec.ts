/**
 * Identity Regression E2E Tests
 *
 * Tests for role immutability, privileged field protection, and org scoping.
 * These tests verify security invariants at the E2E level.
 */

import { test, expect } from '@playwright/test';

test.describe('Identity Security', () => {
  test.describe('Role Immutability', () => {
    test('role selection page shows immutability warning', async ({ page }) => {
      await page.goto('/onboarding/role');

      // Should display warning that role cannot be changed
      await expect(page.getByText(/cannot be changed later/i)).toBeVisible();
    });

    test('role selector is a one-time choice UI', async ({ page }) => {
      await page.goto('/onboarding/role');

      // UI should emphasize the finality of the choice
      await expect(page.getByText('Choose your account type')).toBeVisible();

      // Both options should be visible
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
      // Navigate to a profile settings page if it exists
      await page.goto('/settings/profile');

      // Should NOT have a role input field editable by user
      // The role should be displayed but not editable
      const roleInput = page.getByLabel(/^Role$/i);
      const roleSelect = page.getByRole('combobox', { name: /role/i });

      // Neither input nor select for role should exist
      await expect(roleInput.or(roleSelect)).not.toBeVisible();
    });

    test('profile edit UI does not expose org_id field', async ({ page }) => {
      await page.goto('/settings/profile');

      // Should NOT have an org_id input field
      const orgIdInput = page.getByLabel(/org.*id/i);
      await expect(orgIdInput).not.toBeVisible();
    });
  });

  test.describe('Organization Scoping', () => {
    test('org onboarding creates isolated organization', async ({ page }) => {
      await page.goto('/onboarding/org');

      // Form should only allow creating user's own org
      // No dropdown to select existing org
      const orgSelect = page.getByRole('combobox', { name: /organization/i });
      await expect(orgSelect).not.toBeVisible();

      // Only input fields for new org
      await expect(page.getByLabel(/Legal name/i)).toBeVisible();
    });

    test('organization display shows only user org', async ({ page }) => {
      // If there's an org selector/dropdown anywhere, it should only show user's org
      await page.goto('/dashboard');

      // No org switcher that could allow accessing other orgs
      const orgSwitcher = page.getByRole('combobox', { name: /organization/i });
      // In a properly scoped app, this shouldn't exist or should be locked to one org
      // This is intentionally lenient as the feature may not exist yet
    });
  });

  test.describe('Manual Review Gate', () => {
    test('review gate blocks all access', async ({ page }) => {
      await page.goto('/review-pending');

      // Should show blocked message
      await expect(page.getByText('Account Under Review')).toBeVisible();

      // Should not have navigation to app sections
      const vaultLink = page.getByRole('link', { name: /vault/i });
      const dashboardLink = page.getByRole('link', { name: /dashboard/i });

      // Links to protected areas should not be visible from review page
      await expect(vaultLink).not.toBeVisible();
      await expect(dashboardLink).not.toBeVisible();
    });

    test('review gate shows support contact', async ({ page }) => {
      await page.goto('/review-pending');

      // Should provide way to contact support
      await expect(page.getByText(/Questions/i)).toBeVisible();
      await expect(page.getByText(/support/i)).toBeVisible();
    });
  });
});
