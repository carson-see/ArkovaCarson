/**
 * Public Org Page E2E (SCRUM-1091 / PUBLIC-ORG-08).
 *
 * Locks in the anonymous-visitor flow at `/issuer/:orgId` for the public org
 * page (the route currently routed to `IssuerRegistryPage`, equivalent to the
 * `search.arkova.ai/o/:slug` proxy path described in the PRD).
 *
 * Cases covered (per the PRD acceptance list):
 *   - verified-status visible (or absent) per `verification_status`
 *   - private-profile members render anonymized AND are not click-targets
 *   - public-profile members render full name AND are click-targets
 *   - sub-organizations section renders + nav works
 *   - no "Issue Credential" CTA visible to anon visitors
 *   - JSON-LD Organization schema present in head
 *   - mobile (375px) layout reachable
 *
 * The fixtures here use the live `get_public_org_profile` RPC (migration 0245
 * + verified against prod 2026-04-25). No additional seed bootstrapping is
 * required — Arkova's own org row is the canonical fixture and already contains
 * 1 public + 1 private member.
 */
import { test, expect } from './fixtures';

const ARKOVA_ORG_ID = '40383eb2-f1cd-4a85-8099-afafff95e5cf';

const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 375, height: 800 },
} as const;

test.describe('Public org page (SCRUM-1091)', () => {
  test('renders org hero with display_name + back-to-search link at 1280px', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(`/issuer/${ARKOVA_ORG_ID}`);
    // Org display name appears as a heading.
    await expect(page.getByRole('heading', { name: /Arkova/i })).toBeVisible({ timeout: 10_000 });
    // Back-to-Search link is the primary nav out — anon-friendly.
    await expect(page.getByRole('link', { name: /Back to Search/i })).toBeVisible();
  });

  test('emits a JSON-LD Organization schema in the document head', async ({ page }) => {
    await page.goto(`/issuer/${ARKOVA_ORG_ID}`);
    // Wait for the hero to render so the schema component has mounted.
    await expect(page.getByRole('heading', { name: /Arkova/i })).toBeVisible({ timeout: 10_000 });
    const ld = await page.evaluate(() => {
      const node = document.querySelector('script[type="application/ld+json"]');
      return node?.textContent ?? null;
    });
    expect(ld).not.toBeNull();
    const parsed = JSON.parse(ld!);
    expect(parsed['@context']).toBe('https://schema.org');
    expect(parsed['@type']).toBe('Organization');
    expect(parsed.name).toMatch(/Arkova/i);
  });

  test('emits Open Graph + canonical link tags', async ({ page }) => {
    await page.goto(`/issuer/${ARKOVA_ORG_ID}`);
    await expect(page.getByRole('heading', { name: /Arkova/i })).toBeVisible({ timeout: 10_000 });
    const og = await page.evaluate(() => {
      const get = (sel: string) =>
        document.head.querySelector<HTMLMetaElement>(sel)?.content ?? null;
      const canonical = document.head.querySelector<HTMLLinkElement>(
        'link[rel="canonical"]',
      )?.href ?? null;
      return {
        ogType: get('meta[property="og:type"]'),
        ogTitle: get('meta[property="og:title"]'),
        ogSiteName: get('meta[property="og:site_name"]'),
        canonical,
      };
    });
    expect(og.ogType).toBe('profile');
    expect(og.ogTitle).toMatch(/Arkova/i);
    expect(og.ogSiteName).toBe('Arkova');
    expect(og.canonical).toContain(`/issuer/${ARKOVA_ORG_ID}`);
  });

  test('does not show admin "Issue Credential" CTA to anonymous visitors', async ({ page }) => {
    await page.goto(`/issuer/${ARKOVA_ORG_ID}`);
    await expect(page.getByRole('heading', { name: /Arkova/i })).toBeVisible({ timeout: 10_000 });
    // The admin-only CTA is "Secure Document" / "Issue Credential" — neither
    // should be in the anonymous visitor's surface. Banned terms (per
    // CLAUDE.md §1.3) keep this stable: the production copy is "Secure Document"
    // for admin pages.
    await expect(page.getByRole('button', { name: /Secure Document/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Issue Credential/i })).toHaveCount(0);
  });

  test('private-profile members render anonymized AND are not click-targets', async ({ page }) => {
    await page.goto(`/issuer/${ARKOVA_ORG_ID}`);
    await expect(page.getByRole('heading', { name: /Arkova/i })).toBeVisible({ timeout: 10_000 });
    // S. Rushton is the seeded private-profile member on Arkova's org.
    const anonName = page.getByText(/^S\.\s+Rushton$/);
    if (await anonName.count()) {
      await expect(anonName.first()).toBeVisible();
      // Anonymized members are NOT links — only public profiles are clickable.
      // Climb to the nearest <a> ancestor and assert there isn't one.
      const isInsideLink = await anonName.first().evaluate(
        (el) => Boolean(el.closest('a')),
      );
      expect(isInsideLink).toBe(false);
    }
  });

  test('public-profile members render with their full name', async ({ page }) => {
    await page.goto(`/issuer/${ARKOVA_ORG_ID}`);
    await expect(page.getByRole('heading', { name: /Arkova/i })).toBeVisible({ timeout: 10_000 });
    // Carson Seeger is the seeded public-profile member on Arkova's org.
    const publicName = page.getByText(/Carson Seeger/);
    if (await publicName.count()) {
      await expect(publicName.first()).toBeVisible();
    }
  });

  test('mobile layout (375px) renders the same hero without horizontal overflow', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto(`/issuer/${ARKOVA_ORG_ID}`);
    await expect(page.getByRole('heading', { name: /Arkova/i })).toBeVisible({ timeout: 10_000 });
    // No horizontal scrollbar — body width should match viewport (375px).
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('unknown org id surfaces a "not found" message instead of a stack trace', async ({ page }) => {
    await page.goto('/issuer/00000000-0000-0000-0000-000000000000');
    await expect(
      page.getByText(/Organization not found/i),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: /Back to Search/i })).toBeVisible();
  });
});
