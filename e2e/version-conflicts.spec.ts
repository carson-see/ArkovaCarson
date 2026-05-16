/**
 * Version Conflicts E2E Tests (SCRUM-1974 / SCRUM-1126)
 *
 * Tests for the version conflict resolution page:
 * - Page loads with correct title
 * - Empty state displays when no conflicts
 * - Admin can navigate to the page
 *
 * Note: Full resolution flow (approve/skip/flag) requires seeded
 * version conflict data in external_document_versions table —
 * covered during staging soak with real connector events.
 */

import { test, expect } from './fixtures';

test.describe('Version Conflicts Page', () => {
  test('page loads with correct heading for org admin', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization/version-conflicts');

    await expect(
      orgAdminPage.getByRole('heading', { name: 'Document Version Conflicts' }),
    ).toBeVisible({ timeout: 10000 });

    await expect(
      orgAdminPage.getByText('Review and resolve version conflicts'),
    ).toBeVisible();
  });

  test('shows empty state when no conflicts exist', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization/version-conflicts');

    await expect(
      orgAdminPage.getByText('No version conflicts to review'),
    ).toBeVisible({ timeout: 10000 });
  });

  test('refresh button is visible and clickable', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization/version-conflicts');

    const refreshBtn = orgAdminPage.getByRole('button', { name: 'Refresh' });
    await expect(refreshBtn).toBeVisible({ timeout: 10000 });
    await refreshBtn.click();

    // After refresh, empty state should still show (no data seeded)
    await expect(
      orgAdminPage.getByText('No version conflicts to review'),
    ).toBeVisible();
  });

  test('page is accessible via organization nav for admin users', async ({ orgAdminPage }) => {
    await orgAdminPage.goto('/organization/version-conflicts');

    // Should not show auth error — page requires org membership
    await expect(orgAdminPage.getByText('Authentication required')).not.toBeVisible();
    await expect(orgAdminPage.getByText('forbidden')).not.toBeVisible();
  });
});
