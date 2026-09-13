/**
 * T1 UAT capture for PR #2840 (SCRUM-4989) — CTO review.
 *
 * Runs against the LOCAL PREVIEW BUILD (`vite preview`, port 4173) per the
 * CTO ruling that the T1 smoke surface is a local preview + headless browser
 * (CLAUDE.md §1.7), because the Vercel preview is blocked repo-wide.
 *
 * Supabase is STUBBED at the network layer — no rig is touched. The React
 * components, the router, `safeSocialHref`/`resolveSocialLinks`,
 * `parseSocialLinksForWrite` and `toJsonLd` are all the real shipped code;
 * only PostgREST/GoTrue responses are synthetic. The stored `social_links`
 * fixture is deliberately hostile, i.e. it is a row that pre-dates the write
 * validator — exactly what the render path has to defend against.
 *
 * Not part of the CI E2E suite: run explicitly with
 *   npx playwright test e2e/uat-pr2840.spec.ts --config=e2e/uat-pr2840.config.ts
 *
 * CI GUARD (2026-09-13, this run: 34741690944 / head 647ca9cac): `playwright.config.ts`
 * has no `testMatch` scoping and only `testIgnore: 'oauth-email-confirmation.spec.ts'`,
 * so `node_modules/.bin/playwright test --project=chromium` (ci.yml's literal E2E
 * command — no file argument) picks this file up under the SHARED config anyway,
 * despite the comment above and `e2e/agents.md` both saying it never runs there.
 * Under that config every test here ran against `npm run dev` on :5173 with the
 * `setup` project's real seed-user `storageState` already applied to the context —
 * not the `vite preview` :4173 build with a clean context this spec is written for
 * — and every case that reads Supabase-sourced profile data (auth or not) timed out
 * on its first `toBeVisible({ timeout: 15_000 })`/`.poll()` at ~16-17s; only the
 * static-page JSON-LD case, which touches no profile data, passed. Fixing the
 * environment mismatch itself is out of scope for a T0 e2e-only change (it would
 * mean asserting this file into `testIgnore` in root `playwright.config.ts`, which
 * the tier detector does not carve out to T0). Instead this file enforces its own
 * documented boundary: `uat-pr2840.config.ts` has no `projects` array, so Playwright
 * runs it as a single anonymous project (`project.name === ''`); every project in
 * the shared `playwright.config.ts` is named (`chromium`, `firefox`, `setup`, …).
 * Skipping whenever the project is named makes the file self-enforcing instead of
 * depending on the shared config to keep excluding it.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'docs/uat/pr-2840');
const SUPABASE = 'http://127.0.0.1:54321';
// supabase-js default: `sb-${hostname.split('.')[0]}-auth-token` — see
// e2e/helpers/supabase-storage-key.ts for why this has to be exact.
const STORAGE_KEY = 'sb-127-auth-token';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

/**
 * A row as it can exist in prod today: `profiles.social_links` was unvalidated
 * jsonb for its whole history, so these values are storable right now.
 */
const HOSTILE_SOCIAL_LINKS = {
  linkedin: 'javascript:alert(document.cookie)',
  twitter: 'JaVaScRiPt:alert(1)',
  github: '//evil.example/x',
  website: 'https://linkedin.com@evil.example/',
};

/** The same four keys, all legitimate — the control for the shots above. */
const SAFE_SOCIAL_LINKS = {
  linkedin: 'https://linkedin.com/in/ada',
  twitter: '@ada_l',
  github: 'github.com/ada',
  website: 'https://ada.example',
};

const PROFILE_ROW = {
  id: USER_ID,
  email: 'ada@uat.arkova.test',
  full_name: 'Ada Lovelace',
  avatar_url: null,
  role: 'ORG_ADMIN',
  role_set_at: null,
  org_id: ORG_ID,
  requires_manual_review: false,
  manual_review_reason: null,
  manual_review_completed_at: null,
  manual_review_completed_by: null,
  created_at: '2026-05-05T00:00:00.000Z',
  updated_at: '2026-05-05T00:00:00.000Z',
  is_public_profile: true,
  is_verified: true,
  subscription_tier: 'organization',
  public_id: 'profile_public_uat1',
  deleted_at: null,
  status: 'ACTIVE',
  activation_token: null,
  activation_token_expires_at: null,
  is_platform_admin: false,
  phone_number: null,
  identity_verification_status: 'verified',
  identity_verification_session_id: null,
  identity_verified_at: '2026-05-05T00:00:00.000Z',
  phone_verified_at: null,
  kyc_provider: null,
  disclaimer_accepted_at: '2026-05-05T00:00:00.000Z',
  bio: 'Stored social_links on this row pre-date the SCRUM-4989 validator.',
  social_links: HOSTILE_SOCIAL_LINKS,
};

const SESSION = {
  access_token: 'uat.fake.jwt',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'uat-fake-refresh',
  user: {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: PROFILE_ROW.email,
    email_confirmed_at: '2026-05-05T00:00:00.000Z',
    phone: '',
    confirmed_at: '2026-05-05T00:00:00.000Z',
    last_sign_in_at: '2026-09-12T00:00:00.000Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: 'Ada Lovelace' },
    identities: [],
    created_at: '2026-05-05T00:00:00.000Z',
    updated_at: '2026-09-12T00:00:00.000Z',
    factors: [],
  },
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}

/** Stub every Supabase call this app makes; no rig, no network. */
async function stubSupabase(page: Page, links: Record<string, string> = HOSTILE_SOCIAL_LINKS) {
  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    if (p.startsWith('/auth/v1/user')) return route.fulfill(json(SESSION.user));
    if (p.startsWith('/auth/v1/token')) return route.fulfill(json(SESSION));
    if (p.startsWith('/auth/v1/factors') || p.includes('/auth/v1/')) return route.fulfill(json({}));
    if (p === '/rest/v1/rpc/get_public_member_profile') {
      return route.fulfill(
        json({
          public_id: PROFILE_ROW.public_id,
          display_name: PROFILE_ROW.full_name,
          avatar_url: null,
          bio: PROFILE_ROW.bio,
          social_links: links,
          created_at: PROFILE_ROW.created_at,
          organizations: [],
        }),
      );
    }
    if (p.startsWith('/rest/v1/profiles')) {
      // PATCH (the save) is answered but never reaches a database.
      return route.fulfill(json({ ...PROFILE_ROW, social_links: links }));
    }
    if (p.startsWith('/rest/v1/organizations')) {
      return route.fulfill(json({ id: ORG_ID, display_name: 'Arkova UAT Org' }));
    }
    if (p.startsWith('/rest/v1/rpc/')) return route.fulfill(json({}));
    return route.fulfill(json([]));
  });
}

async function signIn(page: Page) {
  await page.addInitScript(
    ([key, session]) => {
      window.localStorage.setItem(key as string, JSON.stringify(session));
    },
    [STORAGE_KEY, SESSION] as const,
  );
}

async function shot(page: Page, name: string, width: number, height: number) {
  fs.mkdirSync(OUT, { recursive: true });
  const label = `${name}-${width}x${height}.png`;
  await page.screenshot({ path: path.join(OUT, label), fullPage: false });
  return label;
}

// Self-enforce the "own config only" boundary documented above and in
// e2e/agents.md. `uat-pr2840.config.ts` declares no `projects`, so its one
// implicit project has an empty name; every project declared in the shared
// `playwright.config.ts` (chromium/firefox/webkit/mobile-*/setup) is named.
// Running here under a named project means the shared config's glob picked
// this file up by accident — skip rather than fail against an environment
// (dev server, real seed-user storageState) this spec was never written for.
test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== '',
    'uat-pr2840.spec.ts only runs via its own e2e/uat-pr2840.config.ts ' +
      '(vite preview build, no seeded/shared storageState) — see e2e/agents.md',
  );
});

const VIEWPORTS = [
  { w: 1280, h: 800 },
  { w: 375, h: 812 },
];

for (const { w, h } of VIEWPORTS) {
  test.describe(`PR #2840 UAT @ ${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('settings — javascript: save rejected, error inside the Social Profiles card', async ({ page }) => {
      await stubSupabase(page);
      await signIn(page);
      await page.goto('/settings');

      const linkedin = page.getByPlaceholder('https://linkedin.com/in/yourprofile');
      await expect(linkedin).toBeVisible({ timeout: 15_000 });
      await linkedin.fill('javascript:alert(document.cookie)');

      const card = page.locator('div.rounded-lg', { has: linkedin }).last();
      await card.getByRole('button', { name: 'Save' }).click();

      const error = page.getByText('LinkedIn must be a link starting with https://.');
      await expect(error).toBeVisible();
      // The message is INSIDE the card the Save button lives in.
      await expect(card.getByText('LinkedIn must be a link starting with https://.')).toBeVisible();
      await error.scrollIntoViewIfNeeded();
      await shot(page, 'settings-social-rejected', w, h);
    });

    test('dashboard ProfileCard — hostile stored row renders no social link', async ({ page }) => {
      await stubSupabase(page);
      await signIn(page);
      await page.goto('/dashboard');

      // Anchor on the card's own control, not the nav name (hidden below md).
      const card = page.getByLabel('Toggle profile visibility');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(PROFILE_ROW.public_id)).toBeVisible();

      const hrefs = await page.locator('a').evaluateAll((els) =>
        els.map((e) => e.getAttribute('href') ?? ''),
      );
      expect(hrefs.some((x) => /^(javascript|data|vbscript):/i.test(x))).toBe(false);
      expect(hrefs.some((x) => x.startsWith('//'))).toBe(false);
      expect(hrefs.some((x) => x.includes('@evil.example'))).toBe(false);
      await expect(page.locator('a[aria-label="LinkedIn profile"]')).toHaveCount(0);
      await expect(page.locator('a[aria-label="Twitter profile"]')).toHaveCount(0);
      // Positive proof the card took the "no safe links" branch, not that it
      // failed to render: the empty-state hint is what replaces the icons.
      await expect(page.getByText('+ Add social links')).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await shot(page, 'dashboard-profilecard-no-link', w, h);
    });

    test('public profile — hostile stored row renders no social link', async ({ page }) => {
      await stubSupabase(page);
      await page.goto(`/profile/${PROFILE_ROW.public_id}`);

      await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 15_000 });
      const hrefs = await page.locator('a').evaluateAll((els) =>
        els.map((e) => e.getAttribute('href') ?? ''),
      );
      expect(hrefs.some((x) => /^(javascript|data|vbscript):/i.test(x))).toBe(false);
      expect(hrefs.some((x) => x.startsWith('//'))).toBe(false);
      expect(hrefs.some((x) => x.includes('@evil.example'))).toBe(false);
      await shot(page, 'public-profile-no-link', w, h);
    });

    test('JSON-LD emitter — block parses and carries no raw <', async ({ page }) => {
      await stubSupabase(page);
      await page.goto('/how-it-works');

      const blocks = page.locator('script[type="application/ld+json"]');
      // 5 blocks ship in index.html and mount immediately; the page's own
      // HowTo block arrives with the route chunk, so wait for it by type.
      await expect
        .poll(
          () =>
            blocks.evaluateAll((els) =>
              els.some((e) => {
                try {
                  return JSON.parse(e.innerHTML)['@type'] === 'HowTo';
                } catch {
                  return false;
                }
              }),
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      const raws = await blocks.evaluateAll((els) => els.map((e) => e.innerHTML));

      // EVERY block on the page, not just the one this PR touched.
      for (const raw of raws) {
        expect(raw).not.toContain('<');
        expect(() => JSON.parse(raw)).not.toThrow();
      }
      const parsedAll = raws.map((r) => JSON.parse(r));
      const howTo = parsedAll.find((b) => b['@type'] === 'HowTo');
      expect(howTo).toBeDefined();

      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(
        path.join(OUT, 'jsonld-howitworks-parsed.json'),
        JSON.stringify({ blockCount: raws.length, blocks: parsedAll }, null, 2),
      );
      await shot(page, 'jsonld-howitworks', w, h);
    });

    // CONTROL for the two shots above: identical page, legitimate values.
    // Without this pair, "no links rendered" is indistinguishable from "the
    // section did not render".
    test('control — safe values DO render as links (dashboard + public profile)', async ({ page }) => {
      await stubSupabase(page, SAFE_SOCIAL_LINKS);
      await signIn(page);

      await page.goto('/dashboard');
      const toggle = page.getByLabel('Toggle profile visibility');
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('a[aria-label="LinkedIn profile"]')).toHaveAttribute(
        'href',
        'https://linkedin.com/in/ada',
      );
      await expect(page.locator('a[aria-label="Twitter profile"]')).toHaveAttribute(
        'href',
        'https://x.com/ada_l',
      );
      await expect(page.getByText('+ Add social links')).toHaveCount(0);
      await toggle.scrollIntoViewIfNeeded();
      await shot(page, 'control-dashboard-safe-links-render', w, h);

      await page.goto(`/profile/${PROFILE_ROW.public_id}`);
      await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 15_000 });
      const hrefs = await page.locator('a').evaluateAll((els) =>
        els.map((e) => e.getAttribute('href') ?? ''),
      );
      expect(hrefs).toContain('https://linkedin.com/in/ada');
      expect(hrefs).toContain('https://x.com/ada_l');
      expect(hrefs).toContain('https://github.com/ada');
      expect(hrefs).toContain('https://ada.example/');
      await shot(page, 'control-public-profile-safe-links-render', w, h);
    });
  });
}
