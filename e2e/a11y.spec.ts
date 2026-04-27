/**
 * Accessibility E2E Tests (Design Audit #11)
 *
 * Uses @axe-core/playwright to test key pages for WCAG 2.1 AA compliance.
 * Run with: npx playwright test e2e/a11y.spec.ts
 *
 * @updated 2026-04-26 — SCRUM-1302: split unauthenticated a11y tests
 */

import { test, expect } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

test.describe('Accessibility (WCAG 2.1 AA)', () => {
  test.describe('Unauthenticated pages', () => {
    // Login page test needs unauthenticated state
    test.use({ storageState: { cookies: [], origins: [] } });

    test('login page has no critical a11y violations', async ({ page }) => {
      await page.goto('/login');
      await page.waitForLoadState('domcontentloaded');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();

      expect(results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
    });
  });

  test('public verification page has no critical a11y violations', async ({ page }) => {
    await page.goto('/verify');
    await page.waitForLoadState('domcontentloaded');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    expect(results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
  });

  test('search page has no critical a11y violations', async ({ page }) => {
    await page.goto('/search');
    await page.waitForLoadState('domcontentloaded');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    expect(results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
  });

  test('dashboard has no critical a11y violations', async ({ individualPage }) => {
    await individualPage.goto('/dashboard');
    await individualPage.waitForLoadState('domcontentloaded');

    const results = await new AxeBuilder({ page: individualPage })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    expect(results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
  });
});
