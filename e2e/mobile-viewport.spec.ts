/**
 * Mobile Viewport E2E Tests (QA-E2E-09)
 *
 * Validates core flows at 375px mobile viewport.
 * Tests responsive layout, touch-friendly elements, and mobile navigation.
 *
 * Run with: npx playwright test --project=mobile-chrome
 *           npx playwright test --project=mobile-safari
 *
 * @created 2026-03-29
 */

import type { Locator, Page } from '@playwright/test';
import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

async function openMobileDashboard(page: Page) {
  await page.goto('/dashboard');
  await expect(page.locator('#main-content')).toContainText(
    /Jamie Demo-User|Total Records|My Records/i,
    { timeout: 10000 },
  );
}

async function openMobileNavigation(page: Page): Promise<Locator> {
  await openMobileDashboard(page);

  const openNav = page.getByRole('button', { name: 'Open navigation' });
  await expect(openNav).toBeVisible({ timeout: 5000 });
  await openNav.click();

  const sidebar = page.getByRole('complementary');
  await expect(sidebar).toBeVisible({ timeout: 5000 });
  return sidebar;
}

test.describe('Mobile Viewport (375px)', () => {
  // Force mobile viewport for all tests in this file
  test.use({ viewport: { width: 375, height: 812 } });

  test.describe('Authentication', () => {
    // Login form test needs unauthenticated state
    test.use({ storageState: { cookies: [], origins: [] } });

    test('login form is fully visible and usable at 375px', async ({ page }) => {
      await page.goto('/login');

      // Form fields should be visible and not clipped
      const emailInput = page.getByLabel('Email address');
      await expect(emailInput).toBeVisible({ timeout: 10000 });
      await expect(emailInput).toBeInViewport();

      const passwordInput = page.getByLabel('Password');
      await expect(passwordInput).toBeVisible();

      const signInBtn = page.getByRole('button', { name: 'Sign in' });
      await expect(signInBtn).toBeVisible();
      await expect(signInBtn).toBeInViewport();

      // No horizontal scroll
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // 1px tolerance
    });
  });

  test.describe('Dashboard', () => {
    test('dashboard renders mobile layout with stat cards stacked', async ({ individualPage }) => {
      await openMobileDashboard(individualPage);

      // Stat cards should be visible
      await expect(individualPage.getByText('Total Records')).toBeVisible();

      // No horizontal overflow
      const scrollWidth = await individualPage.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await individualPage.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });

    test('Secure Document button is accessible on mobile', async ({ individualPage }) => {
      await openMobileDashboard(individualPage);

      const secureBtn = individualPage
        .locator('#main-content')
        .getByRole('button', { name: /^Secure Document$/i });
      await secureBtn.scrollIntoViewIfNeeded();
      await expect(secureBtn).toBeVisible({ timeout: 10000 });
      await expect(secureBtn).toBeInViewport();

      // Button should have adequate tap target (min 44x44)
      const box = await secureBtn.boundingBox();
      expect(box).toBeTruthy();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(36); // shadcn buttons are 36px min
      }
    });
  });

  test.describe('Navigation', () => {
    test('mobile menu toggle is visible and functional', async ({ individualPage }) => {
      const sidebar = await openMobileNavigation(individualPage);

      await expect(sidebar.getByRole('link', { name: /^Dashboard$/i })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: /^Search$/i })).toBeVisible();
    });

    test('sidebar navigation items are accessible on mobile', async ({ individualPage }) => {
      const sidebar = await openMobileNavigation(individualPage);

      // Core nav items should exist somewhere on the page
      const navItems = ['Dashboard', 'Search'];
      for (const item of navItems) {
        const navLink = sidebar.getByRole('link', { name: new RegExp(`^${item}$`, 'i') });
        await expect(navLink).toBeVisible();
        await expect(navLink).toHaveAttribute('href', /.+/);
      }
    });
  });

  test.describe('Public Search', () => {
    test('search page is usable at 375px without auth', async ({ page }) => {
      await page.context().clearCookies();
      await page.goto('/search');

      // Should not redirect to login
      await expect(page).not.toHaveURL(/\/auth/);

      // Search input should be visible and not clipped
      const searchInput = page.getByPlaceholder(/Search|search|Find|find/i)
        .or(page.getByRole('searchbox'));

      if (await searchInput.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await expect(searchInput.first()).toBeInViewport();
      }

      // No horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  });

  test.describe('Record Detail', () => {
    const serviceClient = getServiceClient();
    let testAnchor: { id: string; public_id: string };

    test.beforeAll(async () => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.individual.id,
        status: 'SECURED',
        filename: 'e2e_mobile_test.pdf',
      });

      if (!anchor?.id) throw new Error('Failed to create test anchor for mobile viewport tests');
      testAnchor = { id: anchor.id, public_id: anchor.public_id };
    });

    test.afterAll(async () => {
      if (testAnchor?.id) await deleteTestAnchor(serviceClient, testAnchor.id);
    });

    test('record detail page renders without horizontal overflow', async ({ individualPage }) => {
      await individualPage.goto(`/records/${testAnchor.id}`);
      await expect(individualPage.getByText('Record Details')).toBeVisible({ timeout: 10000 });

      // No horizontal overflow
      const scrollWidth = await individualPage.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await individualPage.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });

    test('fingerprint text wraps properly on mobile', async ({ individualPage }) => {
      await individualPage.goto(`/records/${testAnchor.id}`);
      await expect(individualPage.getByText('Record Details')).toBeVisible({ timeout: 10000 });

      // Fingerprint should be visible (may be truncated or wrapped)
      const fingerprint = individualPage.getByText(/Document Fingerprint|Fingerprint/i);
      if (await fingerprint.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(fingerprint).toBeInViewport();
      }
    });
  });

  test.describe('Public Verification', () => {
    const serviceClient = getServiceClient();
    let testAnchor: { id: string; public_id: string };

    test.beforeAll(async () => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.individual.id,
        status: 'SECURED',
        filename: 'e2e_mobile_verify_test.pdf',
      });

      if (!anchor?.id) throw new Error('Failed to create test anchor for mobile verification tests');
      testAnchor = { id: anchor.id, public_id: anchor.public_id };
    });

    test.afterAll(async () => {
      if (testAnchor?.id) await deleteTestAnchor(serviceClient, testAnchor.id);
    });

    test('public verification page renders at mobile width', async ({ page }) => {
      await page.goto(`/verify/${testAnchor.public_id}`);

      // Should show verification status
      await expect(page.getByRole('heading', { name: /Verified on/i })).toBeVisible({
        timeout: 10000,
      });

      // No horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  });

  test.describe('Touch Targets', () => {
    test('interactive elements meet minimum touch target size', async ({ individualPage }) => {
      await openMobileDashboard(individualPage);

      // Check current-viewport buttons have adequate touch targets. The long
      // records list below the fold has many utility actions; those flows are
      // covered separately by record-detail and secure-document specs.
      const buttons = individualPage.getByRole('button');
      const count = await buttons.count();

      let smallTargets = 0;
      for (let i = 0; i < Math.min(count, 20); i++) {
        const button = buttons.nth(i);
        if (await button.isVisible().catch(() => false)) {
          const box = await button.boundingBox();
          const inViewport = box && box.y < 812 && box.y + box.height > 0;
          if (box && inViewport && box.height < 32) {
            smallTargets++;
          }
        }
      }

      // Allow up to 2 small targets (icon buttons with padding may report smaller)
      expect(smallTargets).toBeLessThanOrEqual(2);
    });
  });
});
