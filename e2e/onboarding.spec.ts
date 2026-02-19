/**
 * Onboarding E2E Tests
 *
 * Tests for role selection and organization onboarding flows.
 */

import { test, expect } from '@playwright/test';

test.describe('Onboarding', () => {
  // Note: These tests require a logged-in user with no role set
  // In a real setup, we'd use fixtures to create test users

  test.describe('Role Selection', () => {
    test('shows role selection options', async ({ page }) => {
      await page.goto('/onboarding/role');

      // Should show both role options
      await expect(page.getByText('Individual')).toBeVisible();
      await expect(page.getByText('Organization')).toBeVisible();
      await expect(page.getByText('Personal document security')).toBeVisible();
      await expect(page.getByText('Business document security')).toBeVisible();
    });

    test('can select Individual role', async ({ page }) => {
      await page.goto('/onboarding/role');

      // Click Individual option
      await page.getByText('Individual').click();

      // Should show selection indicator
      await expect(page.locator('.ring-primary').first()).toBeVisible();

      // Continue button should be enabled
      await expect(page.getByRole('button', { name: /Continue/i })).toBeEnabled();
    });

    test('can select Organization role', async ({ page }) => {
      await page.goto('/onboarding/role');

      // Click Organization option
      await page.getByText('Organization').click();

      // Should show selection indicator
      await expect(page.locator('.ring-primary').first()).toBeVisible();

      // Continue button should be enabled
      await expect(page.getByRole('button', { name: /Continue/i })).toBeEnabled();
    });

    test('shows one-time selection warning', async ({ page }) => {
      await page.goto('/onboarding/role');

      // Should show warning about irreversible choice
      await expect(page.getByText(/cannot be changed later/i)).toBeVisible();
    });
  });

  test.describe('Organization Onboarding', () => {
    test('shows org onboarding form', async ({ page }) => {
      await page.goto('/onboarding/org');

      // Should show org form fields
      await expect(page.getByText('Set up your organization')).toBeVisible();
      await expect(page.getByLabel(/Legal name/i)).toBeVisible();
      await expect(page.getByLabel('Display name')).toBeVisible();
      await expect(page.getByLabel('Company domain')).toBeVisible();
    });

    test('requires legal name', async ({ page }) => {
      await page.goto('/onboarding/org');

      // Try to submit without legal name
      await page.getByRole('button', { name: 'Create organization' }).click();

      // Should show validation error or native HTML5 validation
      const legalNameInput = page.getByLabel(/Legal name/i);
      await expect(legalNameInput).toHaveAttribute('required');
    });

    test('validates domain format', async ({ page }) => {
      await page.goto('/onboarding/org');

      // Fill legal name
      await page.getByLabel(/Legal name/i).fill('Test Corp Inc.');

      // Fill invalid domain
      await page.getByLabel('Company domain').fill('invalid domain!');

      // Submit
      await page.getByRole('button', { name: 'Create organization' }).click();

      // Should show domain validation error
      await expect(page.getByText(/valid domain/i)).toBeVisible();
    });
  });

  test.describe('Manual Review Gate', () => {
    test('shows review pending message', async ({ page }) => {
      await page.goto('/review-pending');

      // Should show review pending UI
      await expect(page.getByText('Account Under Review')).toBeVisible();
      await expect(page.getByText(/requires manual verification/i)).toBeVisible();
      await expect(page.getByText(/1-2 business days/i)).toBeVisible();
    });

    test('shows sign out option', async ({ page }) => {
      await page.goto('/review-pending');

      // Should show sign out button
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    });
  });
});
