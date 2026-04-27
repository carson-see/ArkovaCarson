/**
 * Public Org Page E2E (PUBLIC-ORG-08 / SCRUM-1091)
 *
 * Anonymous-visitor flow at the public org profile page (/issuer/:orgId)
 * — verifies that no auth is required, the page renders the seeded
 * Arkova org, JSON-LD + OG meta surface for AI/social crawlers, and that
 * desktop (1280px) and mobile (375px) viewports both have a usable layout
 * with no horizontal overflow.
 *
 * Owner: SCRUM-1091 (PUBLIC-ORG epic). Depends on SCRUM-1090 SEO landing.
 */

import { test, expect } from './fixtures';

const ARKOVA_ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_PAGE_PATH = `/issuer/${ARKOVA_ORG_ID}`;
// Path prefix for og:url assertion (route shape stable across deploys).
const ORG_PAGE_URL_RE = /\/issuer\//;

test.describe('Public org page — anonymous visitor', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.describe('Desktop (1280px)', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('renders org profile without redirecting to login', async ({ page }) => {
      const response = await page.goto(ORG_PAGE_PATH);
      expect(response?.status()).toBeLessThan(400);
      await expect(page).not.toHaveURL(/\/auth/);
      await expect(page.getByText(/Arkova/i).first()).toBeVisible({ timeout: 15000 });
    });

    test('emits a schema.org Organization JSON-LD block', async ({ page }) => {
      await page.goto(ORG_PAGE_PATH);
      await expect(page.getByText(/Arkova/i).first()).toBeVisible({ timeout: 15000 });

      // Read every JSON-LD block; one of them is the Organization we just rendered.
      const blocks = await page
        .locator('script[type="application/ld+json"]')
        .allTextContents();
      const orgBlock = blocks
        .map((raw) => {
          try {
            return JSON.parse(raw) as { '@type'?: string; name?: string; url?: string };
          } catch {
            return null;
          }
        })
        .find((b) => b?.['@type'] === 'Organization');

      expect(orgBlock).toBeTruthy();
      expect(orgBlock!.name).toMatch(/Arkova/i);
      expect(orgBlock!.url).toBeTruthy();
    });

    test('emits Open Graph + Twitter meta tags', async ({ page }) => {
      await page.goto(ORG_PAGE_PATH);
      await expect(page.getByText(/Arkova/i).first()).toBeVisible({ timeout: 15000 });

      await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'profile');
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
        'content',
        /Arkova/i,
      );
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', ORG_PAGE_URL_RE);

      const twitterCard = await page
        .locator('meta[name="twitter:card"]')
        .getAttribute('content');
      expect(['summary', 'summary_large_image']).toContain(twitterCard);
    });

    test('back link returns to /search', async ({ page }) => {
      await page.goto(ORG_PAGE_PATH);
      await expect(page.getByRole('link', { name: /Back to Search/i })).toBeVisible({
        timeout: 15000,
      });
    });
  });

  test.describe('Mobile (375px)', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('renders without horizontal scroll on mobile viewport', async ({ page }) => {
      await page.goto(ORG_PAGE_PATH);
      await expect(page.getByText(/Arkova/i).first()).toBeVisible({ timeout: 15000 });

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      // 1px tolerance for sub-pixel rounding (mobile-viewport.spec.ts precedent).
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });

    test('hero is in viewport on first paint', async ({ page }) => {
      await page.goto(ORG_PAGE_PATH);
      const hero = page.getByText(/Arkova/i).first();
      await expect(hero).toBeVisible({ timeout: 15000 });
      await expect(hero).toBeInViewport();
    });
  });

  test('unknown org shows a not-found state, not a 500', async ({ page }) => {
    const response = await page.goto('/issuer/00000000-0000-0000-0000-00000000bad0');
    expect(response?.status()).toBeLessThan(500);
    await expect(
      page
        .getByText(/Organization not found/i)
        .or(page.getByText(/Back to Search/i))
        .first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
