/**
 * Onboarding E2E Tests
 *
 * Tests for role selection and organization onboarding flows.
 *
 * @updated 2026-03-10 10:30 PM EST — migrated to shared fixtures
 */

import { test, expect } from './fixtures';

test.describe('Onboarding', () => {
  test.describe('Role Selection', () => {
    test('shows role selection options', async ({ page }) => {
      await page.goto('/onboarding/role');

      await expect(page.getByText('Individual')).toBeVisible();
      await expect(page.getByText('Organization')).toBeVisible();
      await expect(page.getByText('Personal document security')).toBeVisible();
      await expect(page.getByText('Business document security')).toBeVisible();
    });

    test('can select Individual role', async ({ page }) => {
      await page.goto('/onboarding/role');

      await page.getByText('Individual').click();

      await expect(page.locator('.ring-primary').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Continue/i })).toBeEnabled();
    });

    test('can select Organization role', async ({ page }) => {
      await page.goto('/onboarding/role');

      await page.getByText('Organization').click();

      await expect(page.locator('.ring-primary').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Continue/i })).toBeEnabled();
    });

    test('shows one-time selection warning', async ({ page }) => {
      await page.goto('/onboarding/role');

      await expect(page.getByText(/cannot be changed later/i)).toBeVisible();
    });
  });

  test.describe('Organization Onboarding', () => {
    test('shows org onboarding form', async ({ page }) => {
      await page.goto('/onboarding/org');

      await expect(page.getByText('Set up your organization')).toBeVisible();
      await expect(page.getByLabel(/Legal name/i)).toBeVisible();
      await expect(page.getByLabel('Display name')).toBeVisible();
      await expect(page.getByLabel('Company domain')).toBeVisible();
    });

    test('requires legal name', async ({ page }) => {
      await page.goto('/onboarding/org');

      await page.getByRole('button', { name: 'Create organization' }).click();

      const legalNameInput = page.getByLabel(/Legal name/i);
      await expect(legalNameInput).toHaveAttribute('required');
    });

    test('validates domain format', async ({ page }) => {
      await page.goto('/onboarding/org');

      await page.getByLabel(/Legal name/i).fill('Test Corp Inc.');
      await page.getByLabel('Company domain').fill('invalid domain!');

      await page.getByRole('button', { name: 'Create organization' }).click();

      await expect(page.getByText(/valid domain/i)).toBeVisible();
    });
  });

  test.describe('Manual Review Gate', () => {
    test('shows review pending message', async ({ page }) => {
      await page.goto('/review-pending');

      await expect(page.getByText('Account Under Review')).toBeVisible();
      await expect(page.getByText(/requires manual verification/i)).toBeVisible();
      await expect(page.getByText(/1-2 business days/i)).toBeVisible();
    });

    test('shows sign out option', async ({ page }) => {
      await page.goto('/review-pending');

      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    });
  });
});
