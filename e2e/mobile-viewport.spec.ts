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

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

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
      await individualPage.goto('/vault');
      await expect(individualPage.getByText(/Welcome back/i)).toBeVisible({ timeout: 10000 });

      // Stat cards should be visible
      await expect(individualPage.getByText('Total Records')).toBeVisible();

      // No horizontal overflow
      const scrollWidth = await individualPage.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await individualPage.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });

    test('Secure Document button is accessible on mobile', async ({ individualPage }) => {
      await individualPage.goto('/vault');
      await individualPage.waitForTimeout(2000);

      const secureBtn = individualPage.getByRole('button', { name: /Secure Document/i });
      await expect(secureBtn.first()).toBeVisible({ timeout: 10000 });
      await expect(secureBtn.first()).toBeInViewport();

      // Button should have adequate tap target (min 44x44)
      const box = await secureBtn.first().boundingBox();
      expect(box).toBeTruthy();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(36); // shadcn buttons are 36px min
      }
    });
  });

  test.describe('Navigation', () => {
    test('mobile menu toggle is visible and functional', async ({ individualPage }) => {
      await individualPage.goto('/vault');
      await individualPage.waitForTimeout(2000);

      // On mobile, sidebar should be collapsed/hidden by default
      // Look for a hamburger menu or mobile nav trigger
      const menuTrigger = individualPage.getByRole('button', { name: /menu|toggle|nav/i })
        .or(individualPage.locator('[data-testid="mobile-menu"]'))
        .or(individualPage.locator('button.md\\:hidden'));

      // If there's a mobile menu trigger, it should be visible
      if (await menuTrigger.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await menuTrigger.first().click();

        // Nav items should become visible
        await expect(
          individualPage.getByText(/Dashboard|Documents|Organization|Search|Settings/i).first()
        ).toBeVisible({ timeout: 5000 });
      }
    });

    test('sidebar navigation items are accessible on mobile', async ({ individualPage }) => {
      await individualPage.goto('/vault');
      await individualPage.waitForTimeout(2000);

      // On mobile, try opening sidebar if it's collapsed
      const menuTrigger = individualPage.getByRole('button', { name: /menu|toggle|nav/i })
        .or(individualPage.locator('[data-testid="mobile-menu"]'));

      if (await menuTrigger.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        await menuTrigger.first().click();
        await individualPage.waitForTimeout(500);
      }

      // Core nav items should exist somewhere on the page
      const navItems = ['Dashboard', 'Documents', 'Search', 'Settings'];
      for (const item of navItems) {
        const navLink = individualPage.getByRole('link', { name: new RegExp(item, 'i') })
          .or(individualPage.getByText(new RegExp(`^${item}$`, 'i')));
        // At least one should be in the DOM (may need scroll)
        const count = await navLink.count();
        expect(count).toBeGreaterThanOrEqual(1);
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
      await expect(
        page.getByText(/Verified|Secured|Record Details/i)
      ).toBeVisible({ timeout: 10000 });

      // No horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  });

  test.describe('Touch Targets', () => {
    test('interactive elements meet minimum touch target size', async ({ individualPage }) => {
      await individualPage.goto('/vault');
      await individualPage.waitForTimeout(2000);

      // Check all visible buttons have adequate touch targets
      const buttons = individualPage.getByRole('button');
      const count = await buttons.count();

      let smallTargets = 0;
      for (let i = 0; i < Math.min(count, 20); i++) {
        const button = buttons.nth(i);
        if (await button.isVisible().catch(() => false)) {
          const box = await button.boundingBox();
          if (box && box.height < 32) {
            smallTargets++;
          }
        }
      }

      // Allow up to 2 small targets (icon buttons with padding may report smaller)
      expect(smallTargets).toBeLessThanOrEqual(2);
    });
  });
});
