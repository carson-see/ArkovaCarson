/**
 * Route Matrix + Screenshot Baseline Harness (SCRUM-1998 / GA-S2 / E3).
 *
 * Goal
 * ----
 * Enumerate the application's routes (the matrix is *derived* from the LOCKED
 * `src/lib/routes.ts` `ROUTES` map — see ROUTE_MATRIX below) and, for each
 * route, capture a deterministic full-page screenshot at BOTH the desktop
 * (1280px) and mobile (375px) baseline viewports. Each capture is:
 *   1. attached to the Playwright test report via `testInfo.attach()` (the
 *      existing repo convention — see `integrations-docusign.spec.ts`), so the
 *      baseline is visible in the CI artifact for every run, and
 *   2. written to a baseline directory on disk (default `test-results/route-
 *      baseline/`, overridable via `ROUTE_BASELINE_DIR` — e.g. point it at
 *      `docs/screenshots/baseline/` per the ticket when curating a snapshot).
 *
 * Why attachments, not `toHaveScreenshot()` pixel diffs
 * -----------------------------------------------------
 * The repo has **no** committed snapshot baselines and no `toHaveScreenshot`
 * usage anywhere (verified 2026-05-30). Pixel-diff baselines are brittle across
 * OS/font-rendering/CI and require committing large PNGs that drift constantly.
 * The established Arkova pattern (DocuSign connector spec) is attachment-based
 * full-page screenshots, which gives a stable, reviewable visual baseline
 * without a flaky golden-image gate. This harness follows that norm. The
 * `expect(page).toHaveScreenshot` config added in `playwright.config.ts` is
 * available for any future opt-in golden-image spec, but this matrix does not
 * gate on pixel diffs — it gates on the route *rendering* (a ready-signal
 * assertion per route), which is the durable, deterministic signal.
 *
 * Determinism
 * -----------
 * - Animations are disabled per-capture (`animations: 'disabled'`).
 * - Known dynamic regions (relative timestamps, live status dots, anything
 *   tagged `[data-dynamic]` or `[data-testid="relative-time"]`, plus `<time>`
 *   elements) are masked so they cannot cause visual churn.
 * - Each route waits on an explicit ready signal (a heading / main content /
 *   error surface) before the shot — never an arbitrary timeout.
 *
 * Auth
 * ----
 * - PUBLIC routes run with an empty storageState (anonymous visitor).
 * - AUTHED routes reuse the project-default `individual` storageState written
 *   by `auth.setup.ts`; the org-admin-only surface reuses `orgAdmin`.
 *   (Local runs without Supabase creds cannot mint these sessions — that is the
 *   repo norm; the authed matrix is exercised in CI where `auth.setup.ts`
 *   provides credentials. See the PR notes.)
 *
 * Parameterized routes (`/records/:id`, `/verify/:publicId`, …) are resolved at
 * runtime from seeded data via the service client and skip gracefully when the
 * seed row is absent, so the harness never hard-fails on a missing fixture.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, getServiceClient, getSeedUserOrgId, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';
import { ROUTES } from '../src/lib/routes';
import { acceptDisclaimerIfVisible } from './helpers/dashboard';

// ── Baseline viewports (the two GA baselines: 1280px desktop + 375px mobile) ──
const VIEWPORTS = [
  { label: 'desktop-1280', width: 1280, height: 900 },
  { label: 'mobile-375', width: 375, height: 812 },
] as const;
type ViewportLabel = (typeof VIEWPORTS)[number]['label'];

// ── Baseline output directory ─────────────────────────────────────────────
// Defaults under Playwright's results dir (gitignored). Override with
// ROUTE_BASELINE_DIR=docs/screenshots/baseline when curating a committed set.
const BASELINE_DIR = process.env.ROUTE_BASELINE_DIR
  ? path.resolve(process.env.ROUTE_BASELINE_DIR)
  : path.resolve('test-results', 'route-baseline');

/**
 * Create the baseline dir and (for the default, ephemeral location only) drop a
 * self-ignoring `.gitignore` so generated PNGs can never be accidentally
 * committed regardless of the repo-root ignore rules. When the caller points
 * `ROUTE_BASELINE_DIR` at a curated, committed location (e.g.
 * `docs/screenshots/baseline`), the self-ignore is NOT written — the operator
 * wants those files tracked.
 */
let baselineDirReady = false;
function ensureBaselineDir(): void {
  if (baselineDirReady) return;
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  if (!process.env.ROUTE_BASELINE_DIR) {
    fs.writeFileSync(path.join(BASELINE_DIR, '.gitignore'), '*\n');
  }
  baselineDirReady = true;
}

/** How a route is rendered: anonymous, the individual user, or an org admin. */
type AuthMode = 'public' | 'individual' | 'orgAdmin';

interface RouteCase {
  /** Stable slug used for the screenshot filename + attachment name. */
  key: string;
  /** Concrete URL to visit (params already substituted). */
  path: string;
  /**
   * Which session this route is rendered under. Descriptive metadata — the
   * actual page is selected by the describe block that owns the case (public /
   * individual blocks pass `page`; the org-admin block passes `orgAdminPage`),
   * so only org-admin cases instantiate the org-admin browser context.
   */
  auth: AuthMode;
  /**
   * Ready-signal assertion. Resolves once the route has meaningfully rendered
   * (heading, main content, or a graceful error surface). Keeps the shot
   * deterministic and doubles as the route's pass/fail gate.
   */
  ready: (page: Page) => Promise<void>;
}

// ── Ready-signal helpers ────────────────────────────────────────────────────

/**
 * Authed-shell signal: `#main-content` lives only inside the authenticated
 * AppShell, so this is the strong, authoritative gate for authed routes. It is
 * NOT a valid signal for public/marketing/legal pages (they render outside the
 * AppShell and have no `#main-content`) — those use `publicContentReady`.
 */
async function mainContentReady(page: Page): Promise<void> {
  await expect(page.locator('#main-content')).toBeVisible({ timeout: 15_000 });
}

/**
 * Public-page signal: assert that the page has actually *painted real content*,
 * not merely that `<body>` exists. A blank/white-screen public route (broken
 * marketing/legal page, crashed lazy chunk, error boundary that rendered
 * nothing) still has a visible `<body>`, so a `body`-visible check is a
 * no-op that always passes. Instead we require:
 *   1. a visible primary content region — `<main>` / `[role="main"]` where the
 *      page provides one, else the mounted React root's first child
 *      (`#root > *`) for the few public pages that render without a `<main>`
 *      (e.g. the activation card); and
 *   2. that region carries non-empty text — so a mounted-but-empty (white)
 *      screen fails the gate rather than silently passing.
 * This makes the public-route ready signal authoritative: a genuinely broken
 * public route fails the test.
 */
async function publicContentReady(page: Page): Promise<void> {
  const content = page.locator('main, [role="main"], #root > *').first();
  await expect(content).toBeVisible({ timeout: 15_000 });
  // Non-empty paint check: a blank page has no rendered text in its content
  // region. `toHaveText(/\S/)` retries until text appears or the timeout trips.
  await expect(content).toHaveText(/\S/, { timeout: 15_000 });
}

/** A visible heading whose text matches `re`. */
function headingReady(re: RegExp) {
  return async (page: Page) => {
    await expect(page.getByRole('heading', { name: re }).first()).toBeVisible({ timeout: 15_000 });
  };
}

/**
 * Race several ready signals, but stay authoritative on failure. If any check
 * settles first the route is ready. If NONE settle, we await the LAST check
 * directly (no `.catch`), so its assertion error propagates and fails the test.
 * Callers therefore pass the authoritative content signal LAST (e.g.
 * `anyReady(headingReady(/…/), publicContentReady)`): a tight heading match is
 * preferred, but a route that renders different copy still passes as long as it
 * painted real content — while a blank/broken page fails. There is no
 * `body`-visible escape hatch.
 */
function anyReady(...checks: Array<(page: Page) => Promise<void>>) {
  return async (page: Page) => {
    const settled = await Promise.race(
      checks.map((c) => c(page).then(() => true).catch(() => false)),
    );
    if (!settled) {
      // No signal won the race → assert the authoritative (last) check so a
      // genuinely unrendered route throws here instead of passing silently.
      await checks[checks.length - 1](page);
    }
  };
}

/** Authenticated app pages: dismiss the disclaimer overlay, then assert main content. */
async function authedAppReady(page: Page): Promise<void> {
  await acceptDisclaimerIfVisible(page);
  await mainContentReady(page);
}

// ── Static route matrix (derived from ROUTES; params filled below) ───────────
//
// Every entry references a `ROUTES.*` constant so this matrix tracks the LOCKED
// route table. Parameterized routes are resolved in `buildRouteMatrix()`.

/** Public, no-auth routes — anonymous visitor surface. */
const PUBLIC_ROUTES: RouteCase[] = [
  { key: 'login', path: ROUTES.LOGIN, auth: 'public', ready: headingReady(/sign in|log in|welcome/i) },
  { key: 'signup', path: ROUTES.SIGNUP, auth: 'public', ready: headingReady(/sign up|create|get started/i) },
  { key: 'verify-form', path: ROUTES.VERIFY_FORM, auth: 'public', ready: anyReady(headingReady(/verify/i), publicContentReady) },
  { key: 'search', path: ROUTES.SEARCH, auth: 'public', ready: anyReady(headingReady(/search/i), publicContentReady) },
  { key: 'about', path: ROUTES.ABOUT, auth: 'public', ready: anyReady(headingReady(/about/i), publicContentReady) },
  { key: 'privacy', path: ROUTES.PRIVACY, auth: 'public', ready: headingReady(/privacy/i) },
  { key: 'terms', path: ROUTES.TERMS, auth: 'public', ready: headingReady(/terms/i) },
  { key: 'contact', path: ROUTES.CONTACT, auth: 'public', ready: anyReady(headingReady(/contact/i), publicContentReady) },
  { key: 'developers', path: ROUTES.DEVELOPERS, auth: 'public', ready: anyReady(headingReady(/develop/i), publicContentReady) },
  { key: 'api-sandbox', path: ROUTES.API_SANDBOX, auth: 'public', ready: anyReady(headingReady(/sandbox/i), publicContentReady) },
  { key: 'cle-api', path: ROUTES.CLE_API, auth: 'public', ready: anyReady(headingReady(/cle|attorney/i), publicContentReady) },
  { key: 'how-it-works', path: ROUTES.HOW_IT_WORKS, auth: 'public', ready: anyReady(headingReady(/how it works/i), publicContentReady) },
  { key: 'use-cases', path: ROUTES.USE_CASES, auth: 'public', ready: anyReady(headingReady(/use case/i), publicContentReady) },
  { key: 'enterprise', path: ROUTES.ENTERPRISE, auth: 'public', ready: anyReady(headingReady(/enterprise/i), publicContentReady) },
  { key: 'independent-verify', path: ROUTES.INDEPENDENT_VERIFY, auth: 'public', ready: anyReady(headingReady(/verif|independent/i), publicContentReady) },
  { key: 'data-retention', path: ROUTES.DATA_RETENTION, auth: 'public', ready: anyReady(headingReady(/retention|data/i), publicContentReady) },
  { key: 'activate', path: ROUTES.ACTIVATE, auth: 'public', ready: anyReady(headingReady(/activate|activation/i), publicContentReady) },
  // Param-public routes use a deterministic non-existent id → graceful "not found"
  // surface (these pages must never blank-screen or stack-trace for anon visitors).
  { key: 'verify-public-notfound', path: ROUTES.VERIFY.replace(':publicId', 'baseline-unknown-id'), auth: 'public', ready: anyReady(headingReady(/verif|not found|invalid/i), publicContentReady) },
  { key: 'issuer-registry-notfound', path: ROUTES.ISSUER_REGISTRY.replace(':orgId', '00000000-0000-0000-0000-000000000000'), auth: 'public', ready: anyReady(headingReady(/not found|organization/i), publicContentReady) },
  { key: 'embed-verify-notfound', path: ROUTES.EMBED_VERIFY.replace(':publicId', 'baseline-unknown-id'), auth: 'public', ready: anyReady(headingReady(/verif|not found|invalid/i), publicContentReady) },
];

/** Authenticated routes rendered as the individual (demo-user) session. */
const INDIVIDUAL_ROUTES: RouteCase[] = [
  { key: 'dashboard', path: ROUTES.DASHBOARD, auth: 'individual', ready: authedAppReady },
  { key: 'documents', path: ROUTES.DOCUMENTS, auth: 'individual', ready: authedAppReady },
  { key: 'records', path: ROUTES.RECORDS, auth: 'individual', ready: authedAppReady },
  { key: 'my-credentials', path: ROUTES.MY_CREDENTIALS, auth: 'individual', ready: authedAppReady },
  { key: 'verify-my-record', path: ROUTES.VERIFY_MY_RECORD, auth: 'individual', ready: authedAppReady },
  { key: 'settings', path: ROUTES.SETTINGS, auth: 'individual', ready: authedAppReady },
  { key: 'settings-api-keys', path: ROUTES.SETTINGS_API_KEYS, auth: 'individual', ready: authedAppReady },
  { key: 'settings-webhooks', path: ROUTES.SETTINGS_WEBHOOKS, auth: 'individual', ready: authedAppReady },
  { key: 'credential-templates', path: ROUTES.CREDENTIAL_TEMPLATES, auth: 'individual', ready: authedAppReady },
  { key: 'help', path: ROUTES.HELP, auth: 'individual', ready: authedAppReady },
  { key: 'billing', path: ROUTES.BILLING, auth: 'individual', ready: authedAppReady },
  { key: 'attestations', path: ROUTES.ATTESTATIONS, auth: 'individual', ready: authedAppReady },
];

/** Authenticated org-admin surface (organizations, admin ops, compliance). */
const ORG_ADMIN_ROUTES: RouteCase[] = [
  { key: 'organizations', path: ROUTES.ORGANIZATIONS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'organization', path: ROUTES.ORGANIZATION, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'review-queue', path: ROUTES.REVIEW_QUEUE, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'ai-reports', path: ROUTES.AI_REPORTS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'compliance-dashboard', path: ROUTES.COMPLIANCE_DASHBOARD, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'compliance-trends', path: ROUTES.COMPLIANCE_TRENDS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'compliance-scorecard', path: ROUTES.COMPLIANCE_SCORECARD, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'rules', path: ROUTES.RULES, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'rule-builder', path: ROUTES.RULE_BUILDER, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'anchor-queue', path: ROUTES.ANCHOR_QUEUE, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-onboarding', path: ROUTES.ADMIN_ONBOARDING, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'signature-compliance', path: ROUTES.SIGNATURE_COMPLIANCE, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'auditor-batch', path: ROUTES.AUDITOR_BATCH, auth: 'orgAdmin', ready: authedAppReady },
  // Platform-admin / internal-ops console.
  { key: 'admin-overview', path: ROUTES.ADMIN_OVERVIEW, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-health', path: ROUTES.ADMIN_HEALTH, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-treasury', path: ROUTES.ADMIN_TREASURY, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-pipeline', path: ROUTES.ADMIN_PIPELINE, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-payments', path: ROUTES.ADMIN_PAYMENTS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-users', path: ROUTES.ADMIN_USERS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-records', path: ROUTES.ADMIN_RECORDS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-subscriptions', path: ROUTES.ADMIN_SUBSCRIPTIONS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-organizations', path: ROUTES.ADMIN_ORGANIZATIONS, auth: 'orgAdmin', ready: authedAppReady },
  { key: 'admin-controls', path: ROUTES.ADMIN_CONTROLS, auth: 'orgAdmin', ready: authedAppReady },
];

// ── Dynamic-region masking ────────────────────────────────────────────────
// Locators masked out of every shot so live/relative content can't cause churn.
function maskLocators(page: Page): Locator[] {
  return [
    page.locator('[data-dynamic]'),
    page.locator('[data-testid="relative-time"]'),
    page.locator('time'),
  ];
}

// ── Capture ──────────────────────────────────────────────────────────────
async function captureBaseline(
  page: Page,
  routeKey: string,
  viewportLabel: ViewportLabel,
  testInfo: TestInfo,
): Promise<void> {
  const fileName = `${routeKey}__${viewportLabel}.png`;
  const buffer = await page.screenshot({
    fullPage: true,
    animations: 'disabled',
    mask: maskLocators(page),
  });

  // 1. Write to the baseline directory on disk.
  ensureBaselineDir();
  fs.writeFileSync(path.join(BASELINE_DIR, fileName), buffer);

  // 2. Attach to the Playwright report (visible per-run in CI artifacts).
  await testInfo.attach(fileName, { body: buffer, contentType: 'image/png' });
}

/**
 * Run one route through both baseline viewports against the already-resolved
 * `target` page. The caller selects `target` from the right session: the public
 * and individual blocks pass their default `page`; the org-admin block passes
 * the dedicated `orgAdminPage` context fixture. Keeping the page selection at
 * the call site means blocks that never touch the org-admin surface (the ~20
 * public + ~12 individual cases) do not instantiate — and tear down — an
 * `orgAdminPage` browser context they would never use.
 */
async function screenshotRouteAtBothViewports(
  routeCase: RouteCase,
  target: Page,
  testInfo: TestInfo,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await target.setViewportSize({ width: viewport.width, height: viewport.height });
    await target.goto(routeCase.path, { waitUntil: 'domcontentloaded' });
    // Pass/fail gate: the route must render its ready signal at this viewport.
    await routeCase.ready(target);
    // Let lazy chunks settle so the full-page shot is stable; bounded so a
    // route with a long-poll never hangs the capture.
    await target.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await captureBaseline(target, routeCase.key, viewport.label, testInfo);
  }
}

// ── Suites ─────────────────────────────────────────────────────────────────

test.describe('Route screenshot baseline — public routes (1280 + 375)', () => {
  // Anonymous visitor: no stored session.
  test.use({ storageState: { cookies: [], origins: [] } });

  // Public cases never touch the org-admin surface, so they take `{ page }`
  // only — the `orgAdminPage` fixture (a full browser context + teardown) is
  // intentionally NOT destructured here so it is never instantiated for them.
  for (const routeCase of PUBLIC_ROUTES) {
    test(`${routeCase.key} (${routeCase.path})`, async ({ page }, testInfo) => {
      await screenshotRouteAtBothViewports(routeCase, page, testInfo);
    });
  }
});

test.describe('Route screenshot baseline — individual user routes (1280 + 375)', () => {
  // Uses the project-default `individual` storageState from auth.setup.ts.
  // Individual cases also take `{ page }` only — no `orgAdminPage` context.
  for (const routeCase of INDIVIDUAL_ROUTES) {
    test(`${routeCase.key} (${routeCase.path})`, async ({ page }, testInfo) => {
      await screenshotRouteAtBothViewports(routeCase, page, testInfo);
    });
  }
});

test.describe('Route screenshot baseline — org admin routes (1280 + 375)', () => {
  // Org-admin cases use the dedicated org-admin context fixture.
  for (const routeCase of ORG_ADMIN_ROUTES) {
    test(`${routeCase.key} (${routeCase.path})`, async ({ orgAdminPage }, testInfo) => {
      await screenshotRouteAtBothViewports(routeCase, orgAdminPage, testInfo);
    });
  }
});

// ── Parameterized routes resolved from seeded data ───────────────────────────
// These need a live row (a record, an org, a member). Resolved once in
// beforeAll; each test skips gracefully when its fixture is unavailable so the
// matrix never hard-fails on missing seed data.
test.describe('Route screenshot baseline — parameterized detail routes (1280 + 375)', () => {
  let recordDetailPath: string | null = null;
  let orgProfilePath: string | null = null;
  let createdAnchorId: string | null = null;

  test.beforeAll(async () => {
    const service = getServiceClient();

    // A SECURED record owned by the individual user → /records/:id.
    // NOTE: this is a *synthetic* SECURED row — `createTestAnchor(status:'SECURED')`
    // service-role-inserts the anchor and fills in fabricated chain fields
    // (chain_tx_id, chain_block_height, chain_timestamp). It is NOT a
    // worker-produced anchor and the captured /records/:id shot does not imply a
    // real on-network receipt; it exists only to render the record-detail layout.
    try {
      const anchor = await createTestAnchor(service, {
        userId: SEED_USERS.individual.id,
        status: 'SECURED',
        filename: 'route-baseline.pdf',
      });
      createdAnchorId = anchor.id as string;
      recordDetailPath = ROUTES.RECORD_DETAIL.replace(':id', anchor.id as string);
    } catch (err) {
      console.warn(`[route-baseline] could not seed a record-detail fixture: ${(err as Error).message}`);
    }

    // The org admin's org → /organizations/:orgId.
    try {
      const orgId = await getSeedUserOrgId(service, SEED_USERS.orgAdmin.id);
      orgProfilePath = ROUTES.ORG_PROFILE.replace(':orgId', orgId);
    } catch (err) {
      console.warn(`[route-baseline] could not resolve an org-profile fixture: ${(err as Error).message}`);
    }
  });

  test.afterAll(async () => {
    if (createdAnchorId) {
      await deleteTestAnchor(getServiceClient(), createdAnchorId);
    }
  });

  // Individual-owned record → default `page`; no org-admin context needed.
  test('record-detail (/records/:id)', async ({ page }, testInfo) => {
    test.skip(!recordDetailPath, 'No seeded record available for /records/:id baseline');
    await screenshotRouteAtBothViewports(
      { key: 'record-detail', path: recordDetailPath!, auth: 'individual', ready: authedAppReady },
      page,
      testInfo,
    );
  });

  // Org-admin-scoped org profile → the dedicated org-admin context fixture.
  test('org-profile (/organizations/:orgId)', async ({ orgAdminPage }, testInfo) => {
    test.skip(!orgProfilePath, 'No seeded org available for /organizations/:orgId baseline');
    await screenshotRouteAtBothViewports(
      { key: 'org-profile', path: orgProfilePath!, auth: 'orgAdmin', ready: authedAppReady },
      orgAdminPage,
      testInfo,
    );
  });
});
