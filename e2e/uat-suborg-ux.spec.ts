/**
 * Sub-organisation management UAT capture (founder feedback 2026-09-13:
 * "when I try and use sub orgs it's clunky and confusing").
 *
 * Runs against the LOCAL DEV SERVER (`npm run dev`, port 5173) per CLAUDE.md
 * §1.7 ("UI UAT defaults to local preview"). Supabase AND the worker are both
 * stubbed at the network layer — no rig, no Cloud Run service, no database is
 * touched, which keeps this capture inside the builder contract's clause 14.
 * Every React component, route and copy string under test is the real shipped
 * code; only the HTTP responses are synthetic.
 *
 * Not part of the CI E2E suite. It carries its own config for the same reason
 * `uat-pr2840.spec.ts` does — the shared `playwright.config.ts` loads
 * `.env.test` and runs `auth.setup.ts` against a real Supabase project — and
 * it self-skips under a named project so the shared config's `testDir: './e2e'`
 * glob cannot pick it up by accident (see e2e/agents.md, 2026-09-13).
 *
 *   npm run dev -- --port 5173 --strictPort
 *   npx playwright test e2e/uat-suborg-ux.spec.ts --config=e2e/uat-suborg-ux.config.ts
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the shots land, and which tab the sub-org panel is expected on. Both
 * are env-driven so the SAME spec reproduces the "before" capture against an
 * unmodified `origin/main` build:
 *
 *   SUBORG_UAT_OUT=before SUBORG_UAT_TAB=settings npx playwright test \
 *     e2e/uat-suborg-ux.spec.ts --config=e2e/uat-suborg-ux.config.ts
 *
 * Defaults capture the fixed build into `after/`.
 */
const OUT = path.resolve(
  process.cwd(),
  `docs/uat/suborg-ux/${process.env.SUBORG_UAT_OUT ?? 'after'}`,
);
/** `settings` reproduces the pre-fix layout; `affiliates` is where it lives now. */
const PANEL_TAB = process.env.SUBORG_UAT_TAB ?? 'affiliates';
const SUPABASE = 'http://127.0.0.1:54321';
const WORKER = 'http://localhost:3001';
/** supabase-js default key — see e2e/helpers/supabase-storage-key.ts. */
const STORAGE_KEY = 'sb-127-auth-token';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ORG_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_PENDING_ID = '44444444-4444-4444-8444-444444444444';
const CHILD_APPROVED_ID = '55555555-5555-4555-8555-555555555555';

const PROFILE_ROW = {
  id: USER_ID,
  email: 'admin@uat.arkova.test',
  full_name: 'Dana Parent',
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
  public_id: 'profile_public_uat_suborg',
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
  bio: null,
  social_links: null,
};

/** The parent org the admin above belongs to. */
const PARENT_ORG_ROW = {
  id: ORG_ID,
  display_name: 'Northwind Group',
  domain: 'northwind.example',
  description: 'Parent organisation used for the sub-org UAT walk.',
  website_url: null,
  org_type: 'corporation',
  linkedin_url: null,
  twitter_url: null,
  industry_tag: null,
  location: null,
  founded_date: null,
  logo_url: null,
  verification_status: 'VERIFIED',
  domain_verified: true,
  ein_tax_id: '12-3456789',
  parent_org_id: null,
  parent_approval_status: null,
  max_sub_orgs: null,
  created_at: '2026-05-05T00:00:00.000Z',
};

/** The same org viewed as a CHILD whose affiliation the parent has revoked. */
const REVOKED_CHILD_ORG_ROW = {
  ...PARENT_ORG_ROW,
  display_name: 'Northwind Subsidiary',
  parent_org_id: PARENT_ORG_ID,
  parent_approval_status: 'REVOKED',
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
    last_sign_in_at: '2026-09-13T00:00:00.000Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: PROFILE_ROW.full_name },
    identities: [],
    created_at: '2026-05-05T00:00:00.000Z',
    updated_at: '2026-09-13T00:00:00.000Z',
    factors: [],
  },
};

const SUB_ORGS = [
  {
    id: CHILD_PENDING_ID,
    display_name: 'Contoso Legal',
    domain: 'contoso-legal.example',
    verification_status: 'VERIFIED',
    parent_approval_status: 'PENDING',
    created_at: '2026-09-01T00:00:00.000Z',
    logo_url: null,
  },
  {
    id: CHILD_APPROVED_ID,
    display_name: 'Fabrikam Compliance',
    domain: 'fabrikam.example',
    verification_status: 'VERIFIED',
    parent_approval_status: 'APPROVED',
    created_at: '2026-08-01T00:00:00.000Z',
    logo_url: null,
    docusignInherited: false,
  },
];

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}

interface StubOptions {
  /** Which organizations row `/organizations/:orgId` resolves to. */
  orgRow?: Record<string, unknown>;
  /** Sub-org rows the parent panel lists. */
  subOrgs?: unknown[];
  /** Make the sub-orgs list endpoint fail, to capture the load-error state. */
  failSubOrgList?: boolean;
}

/** Stub Supabase (PostgREST + GoTrue) and the worker. No rig is touched. */
async function stubBackends(page: Page, opts: StubOptions = {}) {
  const orgRow = opts.orgRow ?? PARENT_ORG_ROW;
  const subOrgs = opts.subOrgs ?? SUB_ORGS;

  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    if (p.startsWith('/auth/v1/user')) return route.fulfill(json(SESSION.user));
    if (p.startsWith('/auth/v1/token')) return route.fulfill(json(SESSION));
    if (p.startsWith('/auth/v1/')) return route.fulfill(json({}));
    if (p.startsWith('/rest/v1/profiles')) return route.fulfill(json(PROFILE_ROW));
    if (p.startsWith('/rest/v1/org_members')) return route.fulfill(json({ role: 'owner' }));
    if (p.startsWith('/rest/v1/organizations')) {
      // `.single()` on the parent-name lookup wants an object, list reads an array.
      const idFilter = url.searchParams.get('id') ?? '';
      if (idFilter.includes(PARENT_ORG_ID)) {
        return route.fulfill(json({ id: PARENT_ORG_ID, display_name: 'Global Holdings' }));
      }
      return route.fulfill(json(orgRow));
    }
    if (p === '/rest/v1/rpc/search_organizations_public') {
      return route.fulfill(json([
        {
          id: PARENT_ORG_ID,
          display_name: 'Global Holdings',
          domain: 'globalholdings.example',
          logo_url: null,
          verification_status: 'VERIFIED',
        },
      ]));
    }
    if (p.startsWith('/rest/v1/rpc/')) return route.fulfill(json({}));
    if (p.startsWith('/rest/v1/anchors')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/0' },
        body: JSON.stringify([]),
      });
    }
    return route.fulfill(json([]));
  });

  await page.route(`${WORKER}/**`, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    if (p === '/api/v1/org/sub-orgs' && method === 'GET') {
      if (opts.failSubOrgList) return route.fulfill(json({ error: 'Internal server error' }, 500));
      return route.fulfill(json({ subOrgs }));
    }
    if (p === '/api/v1/org/sub-orgs/credits' && method === 'GET') {
      return route.fulfill(json({
        parentBalance: 4200,
        children: [{ childOrgId: CHILD_APPROVED_ID, balance: 150 }],
      }));
    }
    if (p === '/api/v1/org/sub-orgs/credits' && method === 'POST') {
      return route.fulfill(json({ parentBalance: 4100, childBalance: 250 }));
    }
    if (p === '/api/v1/org/sub-orgs/approve') return route.fulfill(json({ ok: true }));
    if (p === '/api/v1/org/sub-orgs/revoke') return route.fulfill(json({ ok: true }));
    if (p === '/api/v1/org/sub-orgs/offboard') {
      return route.fulfill(json({ reclaimed: 150, suspended: true }));
    }
    if (p === '/api/v1/org/sub-orgs/request') return route.fulfill(json({ ok: true }));
    if (p === '/api/v1/org/sub-orgs/create') {
      // The real worker returns the raw cap message here; the UI shows it verbatim.
      return route.fulfill(json({ error: 'Sub-org limit reached (max 5)' }, 400));
    }
    if (p === '/api/notifications/unread-count') return route.fulfill(json({ count: 0 }));
    return route.fulfill(json({}));
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

async function shot(page: Page, name: string, width: number, fullPage = false) {
  fs.mkdirSync(OUT, { recursive: true });
  const label = `${name}-${width}.png`;
  await page.screenshot({ path: path.join(OUT, label), fullPage });
  return label;
}

// Self-enforce the "own config only" boundary (e2e/agents.md 2026-09-13):
// `uat-suborg-ux.config.ts` declares no `projects`, so its single implicit
// project has an empty name; every project in the shared `playwright.config.ts`
// is named. A named project here means the shared glob picked this file up.
test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== '',
    'uat-suborg-ux.spec.ts only runs via e2e/uat-suborg-ux.config.ts — see e2e/agents.md',
  );
});

const VIEWPORTS = [
  { w: 1280, h: 800 },
  { w: 375, h: 812 },
];

for (const { w, h } of VIEWPORTS) {
  test.describe(`sub-org UAT @ ${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('step 0 — how far down the page the sub-org panel actually sits', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const heading = page.locator('h3', { hasText: 'Affiliated Organizations' }).first();
      await expect(heading).toBeVisible({ timeout: 15_000 });

      // The scrolling element is AppShell's main column, not documentElement.
      const metrics = await heading.evaluate((el) => {
        let node: HTMLElement | null = el.parentElement;
        let scroller: HTMLElement = document.scrollingElement as HTMLElement;
        while (node) {
          const style = getComputedStyle(node);
          if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
            scroller = node;
            break;
          }
          node = node.parentElement;
        }
        const scrollerTop = scroller.getBoundingClientRect().top;
        return {
          viewportHeight: window.innerHeight,
          scrollableHeight: scroller.scrollHeight,
          headingOffsetWithinScroller:
            el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop,
        };
      });

      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(
        path.join(OUT, `discoverability-${w}.json`),
        JSON.stringify(
          {
            viewportWidth: w,
            ...metrics,
            viewportsOfScrollingBeforeItAppears: Number(
              (metrics.headingOffsetWithinScroller / metrics.viewportHeight).toFixed(2),
            ),
          },
          null,
          2,
        ) + '\n',
      );
    });

    test('step 1 — dashboard home, looking for anything about sub-organisations', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto('/dashboard');
      await page.waitForTimeout(2500);
      await shot(page, 'step1-dashboard-home', w, true);
    });

    test('step 2 — organisation page as it first lands (Home tab)', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}`);
      await page.waitForTimeout(2500);
      await shot(page, 'step2-org-page-home-tab', w, true);
    });

    test('step 3 — the Settings tab, which used to hold the panel', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=settings`);
      await page.waitForTimeout(2500);
      await shot(page, 'step3-settings-tab-top', w);
      await shot(page, 'step3-settings-tab-full', w, true);
    });

    test('step 4 — the sub-organisation panel itself', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const panel = page.getByText('Manage Affiliated Organizations').first();
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1200);
      await shot(page, 'step4-suborg-panel', w);
    });

    test('step 5 — approve a pending affiliate', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const row = page.getByTestId('sub-org-row').first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await shot(page, 'step5a-pending-row-actions', w);
      await row.getByRole('button', { name: 'Approve' }).click();
      await page.waitForTimeout(1200);
      await shot(page, 'step5b-after-approve', w);
    });

    test('step 6 — allocate credits to an approved affiliate', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const row = page.getByTestId('sub-org-row').nth(1);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await shot(page, 'step6a-approved-row-actions', w);
      await row.getByLabel('Credits to move').fill('100');
      await row.getByRole('button', { name: 'Add Credits' }).click();
      await page.waitForTimeout(1200);
      await shot(page, 'step6b-after-credit-move', w);
    });

    test('step 7 — offboard confirmation', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const row = page.getByTestId('sub-org-row').nth(1);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.scrollIntoViewIfNeeded();
      await row.getByRole('button', { name: 'Offboard' }).click();
      await page.waitForTimeout(900);
      await shot(page, 'step7-offboard-dialog', w);
    });

    test('step 7b — revoke confirmation', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const row = page.getByTestId('sub-org-row').nth(1);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.scrollIntoViewIfNeeded();
      await row.getByRole('button', { name: /Revoke/ }).click();
      await page.waitForTimeout(900);
      await shot(page, 'step7b-revoke-dialog', w);
    });

    test('step 8 — how a rejected create is reported', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      await expect(page.getByTestId('sub-org-row').first()).toBeVisible({ timeout: 15_000 });
      // Post-fix the create form is a disclosure under the list.
      const discloser = page.getByRole('button', { name: 'Add an organization' });
      if (await discloser.count()) {
        await discloser.first().scrollIntoViewIfNeeded();
        await discloser.first().click();
      }
      const name = page.getByLabel('Affiliate name');
      await expect(name).toBeVisible({ timeout: 15_000 });
      await name.scrollIntoViewIfNeeded();
      await name.fill('Adventure Works');
      await page.getByLabel('Affiliate admin email').fill('admin@adventure.example');
      await page.getByRole('button', { name: 'Create Affiliate' }).click();
      await page.waitForTimeout(1200);
      await shot(page, 'step8-create-error-toast', w);
    });

    test('step 9 — request affiliation dialog', async ({ page }) => {
      await stubBackends(page);
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const cta = page.getByRole('button', { name: 'Request Affiliation' }).first();
      await expect(cta).toBeVisible({ timeout: 15_000 });
      await cta.scrollIntoViewIfNeeded();
      await cta.click();
      await page.waitForTimeout(700);
      await shot(page, 'step9a-request-dialog-empty', w);
      await page.getByPlaceholder('Search verified organizations...').fill('Global');
      await page.waitForTimeout(1200);
      await shot(page, 'step9b-request-dialog-results', w);
    });

    test('step 10 — empty state for an org with no affiliates yet', async ({ page }) => {
      await stubBackends(page, { subOrgs: [] });
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const empty = page.getByText(/No affiliated organizations yet/);
      await expect(empty).toBeVisible({ timeout: 15_000 });
      await empty.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await shot(page, 'step10-empty-state', w);
    });

    test('step 11 — a REVOKED child has no way back', async ({ page }) => {
      await stubBackends(page, { orgRow: REVOKED_CHILD_ORG_ROW });
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const revoked = page.getByText('Affiliation revoked by').first();
      await expect(revoked).toBeVisible({ timeout: 15_000 });
      await revoked.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await shot(page, 'step11-revoked-child-dead-end', w);
    });

    test('step 12 — sub-org list load failure', async ({ page }) => {
      await stubBackends(page, { failSubOrgList: true });
      await signIn(page);
      await page.goto(`/organizations/${ORG_ID}?tab=${PANEL_TAB}`);
      const err = page.getByText("Couldn't load affiliated organizations");
      await expect(err).toBeVisible({ timeout: 15_000 });
      await err.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await shot(page, 'step12-list-load-error', w);
    });
  });
}
