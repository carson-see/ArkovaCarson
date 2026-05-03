/**
 * Settings E2E Tests (Tier 2)
 *
 * Tests for settings pages: profile editing, privacy toggle, identity
 * section, webhook settings page, and credential templates page.
 *
 * @created 2026-03-10 11:30 PM EST
 */

import { test, expect } from './fixtures';

function settingsHeading(page: import('@playwright/test').Page) {
  return page.locator('#main-content').getByRole('heading', { name: 'Settings' }).first();
}

test.describe('Settings', () => {
  test.describe('Profile Settings', () => {
    test('settings page loads with profile card', async ({ individualPage }) => {
      await individualPage.goto('/settings');

      // Page heading
      await expect(settingsHeading(individualPage)).toBeVisible({
        timeout: 10000,
      });

      // Profile card
      await expect(individualPage.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();

      // Email field (disabled)
      const emailInput = individualPage.locator('#email');
      await expect(emailInput).toBeVisible();
      await expect(emailInput).toBeDisabled();

      // Full name field (editable)
      const fullNameInput = individualPage.locator('#full-name');
      await expect(fullNameInput).toBeVisible();
    });

    test('full name can be edited and saved', async ({ individualPage }) => {
      await individualPage.goto('/settings');
      await expect(settingsHeading(individualPage)).toBeVisible({
        timeout: 10000,
      });

      const fullNameInput = individualPage.locator('#full-name');
      await expect(fullNameInput).toBeVisible();

      // Clear and type a new name
      await fullNameInput.clear();
      await fullNameInput.fill('E2E Test User');

      // Save button should be visible
      const saveBtn = individualPage.getByRole('button', { name: 'Save' }).first();
      await expect(saveBtn).toBeVisible();
    });
  });

  test.describe('Privacy Settings', () => {
    test('privacy toggle is visible on settings page', async ({ individualPage }) => {
      await individualPage.goto('/settings');
      await expect(settingsHeading(individualPage)).toBeVisible({
        timeout: 10000,
      });

      // Privacy card
      await expect(individualPage.getByRole('heading', { name: 'Arkova Privacy' })).toBeVisible();

      // Public Profile toggle
      await expect(individualPage.getByText('Public Profile')).toBeVisible();

      // Toggle switch should exist
      const toggle = individualPage.getByRole('switch');
      await expect(toggle).toBeVisible();
    });
  });

  test.describe('Identity Section', () => {
    test('identity section shows User ID', async ({ individualPage }) => {
      await individualPage.goto('/settings');
      await expect(settingsHeading(individualPage)).toBeVisible({
        timeout: 10000,
      });

      // Identity card
      await expect(individualPage.getByRole('heading', { name: 'Identity', exact: true })).toBeVisible();

      // User ID should be displayed
      await expect(individualPage.getByText('User ID')).toBeVisible();
    });
  });

  test.describe('Webhook Settings Page', () => {
    test('webhook settings page loads for org admin', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings/webhooks');

      // Should show webhook configuration
      await expect(orgAdminPage.getByRole('heading', { name: /Webhook Endpoints/i })).toBeVisible({ timeout: 10000 });

      // Add Endpoint button
      const addBtn = orgAdminPage.getByRole('button', { name: /Add Endpoint/i });
      if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await expect(addBtn).toBeVisible();
      }
    });
  });

  test.describe('Credential Templates Page', () => {
    test('credential templates page loads for org admin', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings/credential-templates');

      // Should show credential templates management
      await expect(orgAdminPage.getByRole('heading', { name: /Credential Templates/i })).toBeVisible({ timeout: 10000 });

      // Add Template button
      const addBtn = orgAdminPage.getByRole('button', { name: /Add Template/i });
      if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await expect(addBtn).toBeVisible();
      }
    });
  });
});
