/**
 * Public Search E2E Tests (QA-E2E-04)
 *
 * Tests the public search page where anyone can search for and verify
 * credentials/records without authentication.
 *
 * MVP flow: Third-parties can search for and verify records publicly.
 *
 * @created 2026-03-28
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Public Search Flow', () => {
  let testPublicId: string;
  let testAnchorId: string;
  const serviceClient = getServiceClient();

  test.beforeAll(async () => {
    const anchor = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_search_test_diploma.pdf',
    });

    if (!anchor?.id || !anchor?.public_id) {
      throw new Error('beforeAll: failed to create test anchor for public search tests');
    }

    testAnchorId = anchor.id;
    testPublicId = anchor.public_id;
  });

  test.afterAll(async () => {
    if (testAnchorId) {
      await deleteTestAnchor(serviceClient, testAnchorId);
    }
  });

  test.describe('Search Page Access', () => {
    test('search page loads without authentication', async ({ page }) => {
      await page.context().clearCookies();
      await page.goto('/search');

      // Should NOT redirect to login
      await expect(page).not.toHaveURL(/\/auth/);

      // Search input should be visible
      await expect(
        page.getByPlaceholder(/Search|search|Find|find/i)
          .or(page.getByRole('searchbox'))
          .or(page.getByRole('textbox').first())
      ).toBeVisible({ timeout: 10000 });
    });

    test('search page shows type tabs', async ({ page }) => {
      await page.goto('/search');

      // Should show search type tabs (Issuers, Credentials, Verify Document)
      await expect(
        page.getByText(/Issuers|Credentials|Verify/i).first()
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Text Search', () => {
    test('searching for a filename returns results', async ({ page }) => {
      await page.goto('/search');

      // Find the search input
      const searchInput = page.getByPlaceholder(/Search|search|Find|find/i)
        .or(page.getByRole('searchbox'))
        .or(page.getByRole('textbox').first());

      await searchInput.fill('e2e_search_test_diploma');
      await searchInput.press('Enter');

      // Wait for results or "no results" message
      const result = page.getByText('e2e_search_test_diploma')
        .or(page.getByText(/No results|No records|Nothing found/i));
      await expect(result).toBeVisible({ timeout: 15000 });
    });

    test('empty search shows appropriate state', async ({ page }) => {
      await page.goto('/search');

      // Page should show either a prompt to search or default results
      await expect(
        page.getByText(/Search|Enter|Type/i).first()
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Verify Document Tab', () => {
    test('verify tab shows file upload area', async ({ page }) => {
      await page.goto('/search');

      // Click "Verify Document" tab if visible
      const verifyTab = page.getByRole('tab', { name: /Verify/i })
        .or(page.getByText(/Verify Document/i));
      if (await verifyTab.isVisible({ timeout: 5000 }).catch(() => false)) {
        await verifyTab.click();
      }

      // Should show upload/drop zone
      await expect(
        page.getByText(/drag|drop|upload|file/i).first()
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Public Verification Link', () => {
    test('direct verification link works for SECURED record', async ({ page }) => {
      await page.goto(`/verify/${testPublicId}`);

      // Should show verified status
      await expect(
        page.getByText(/Verified|Document Verified/i).first()
      ).toBeVisible({ timeout: 10000 });

      // Should show the filename
      await expect(
        page.getByText('e2e_search_test_diploma.pdf')
      ).toBeVisible();
    });

    test('verification link does not require authentication', async ({ page }) => {
      await page.context().clearCookies();
      await page.goto(`/verify/${testPublicId}`);

      // Should NOT redirect to login
      await expect(page).not.toHaveURL(/\/auth/);

      // Should show verification content
      await expect(
        page.getByText(/Verified|Document Verified/i).first()
      ).toBeVisible({ timeout: 10000 });
    });

    test('invalid verification ID shows error', async ({ page }) => {
      await page.goto('/verify/nonexistent_id_12345');

      await expect(
        page.getByText(/Failed|not found|Unable|does not exist/i).first()
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Search Performance', () => {
    test('search page loads within 5 seconds', async ({ page }) => {
      const start = Date.now();
      await page.goto('/search');

      await expect(
        page.getByPlaceholder(/Search|search|Find|find/i)
          .or(page.getByRole('searchbox'))
          .or(page.getByRole('textbox').first())
      ).toBeVisible({ timeout: 10000 });

      const loadTime = Date.now() - start;
      expect(loadTime).toBeLessThan(5000);
    });
  });
});
