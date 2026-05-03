/**
 * Data Retention Page E2E Tests (COMP-04)
 *
 * Tests for the public data retention policy page.
 * Verifies the page is accessible without authentication
 * and renders the retention schedule correctly.
 */

import { test, expect } from './fixtures';

test.describe('Data Retention Policy Page', () => {
  test('loads without authentication', async ({ page }) => {
    await page.goto('/privacy/data-retention');

    await expect(page.getByRole('heading', { name: 'Data Retention Policy' })).toBeVisible({ timeout: 5000 });
  });

  test('renders retention schedule table', async ({ page }) => {
    await page.goto('/privacy/data-retention');

    await expect(page.getByRole('heading', { name: 'Retention Schedule' })).toBeVisible();

    const schedule = page.getByRole('table');
    await expect(schedule.getByRole('cell', { name: 'Anchor Records' })).toBeVisible();
    await expect(schedule.getByRole('cell', { name: 'Audit Events' })).toBeVisible();
    await expect(schedule.getByRole('cell', { name: 'User Accounts' })).toBeVisible();
  });

  test('renders right to erasure section', async ({ page }) => {
    await page.goto('/privacy/data-retention');

    await expect(page.getByRole('heading', { name: 'Right to Erasure' })).toBeVisible();
  });

  test('renders legal hold section', async ({ page }) => {
    await page.goto('/privacy/data-retention');

    await expect(page.getByRole('heading', { name: 'Legal Hold' })).toBeVisible();
  });

  test('renders network permanence note', async ({ page }) => {
    await page.goto('/privacy/data-retention');

    await expect(page.getByText(/Network anchor records are permanent/)).toBeVisible();
  });

  test('is responsive at mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/privacy/data-retention');

    await expect(page.getByRole('heading', { name: 'Data Retention Policy' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('table').getByRole('cell', { name: 'Anchor Records' })).toBeVisible();
  });
});
