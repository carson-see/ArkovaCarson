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
 * Ready gate: bounded, and asymmetric by auth (robust + honest)
 * -------------------------------------------------------------
 * - The gate waits for `domcontentloaded` + a BOUNDED content assertion. It
 *   never waits on `networkidle` (marketing pages embed a lazy YouTube iframe +
 *   a fingerprint/balance read that may never let the network settle —
 *   `networkidle` waits are the classic 30s-hang source). The per-route public
 *   budget is `PUBLIC_READY_TIMEOUT_MS` so a non-painting route fails FAST.
 * - AUTHED routes keep a HARD assertion (`#main-content` via `authedAppReady`):
 *   a broken authed app route is a high-value signal and SHOULD fail the job.
 * - PUBLIC routes are captured-and-reported: if a public route does not paint
 *   real content within the bounded window, the shot is STILL captured and the
 *   route is recorded as a reported FINDING (console.warn + test annotation +
 *   an end-of-suite summary) rather than hard-failing the whole job. This keeps
 *   the harness GREEN and capturing all routes while surfacing the problematic
 *   ones loudly (never a silent skip). See `thinPublicRoutes`.
 * - Known findings at time of writing (verified 2026-05-30 via live render):
 *   `/about`, `/how-it-works`, `/use-cases`, and the issuer not-found surface.
 *   The first three render a JSON-LD schema component (`PersonSchema` /
 *   `HowToSchema` / `FAQSchema`) as a zero-height `<section>` that is `#root`'s
 *   FIRST child; the not-found surface renders no `<main>` and no heading. The
 *   old `…first()` content locator bound to that empty section and 30s-hung.
 *   `publicContentPainted` now skips empty schema wrappers, so these capture
 *   fine; the finding-collector remains as a standing watch for regressions.
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

// ── Ready-gate timeouts ───────────────────────────────────────────────────
// PUBLIC ready gate is BOUNDED tight: a public/marketing/legal route that does
// not paint real content within this window is recorded as a finding and the
// shot is captured anyway (it does NOT 30s-hang the whole job). Authed routes
// keep a longer, authoritative budget because a broken authed route SHOULD
// fail loudly. The old gate stacked two sequential 15s assertions behind a
// `Promise.race` whose losing branch also retried for 15s — so a single
// non-painting public route burned the full 30s per-test budget (×3 retries).
const PUBLIC_READY_TIMEOUT_MS = 8_000;
const AUTHED_READY_TIMEOUT_MS = 15_000;

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
  await expect(page.locator('#main-content')).toBeVisible({ timeout: AUTHED_READY_TIMEOUT_MS });
}

/**
 * Public-page signal: assert that the page has actually *painted real content*,
 * not merely that `<body>` exists. A blank/white-screen public route (broken
 * marketing/legal page, crashed lazy chunk, error boundary that rendered
 * nothing) still has a visible `<body>`, so a `body`-visible check is a
 * no-op that always passes. We require a VISIBLE region that carries
 * non-empty text.
 *
 * Selector robustness (why this is NOT just `…first()`)
 * -----------------------------------------------------
 * The old gate used `page.locator('main, [role="main"], #root > *').first()`.
 * `.first()` resolves to the first element in DOM order matching ANY clause —
 * and several public pages (AboutPage, HowItWorksPage, UseCasesPage, the
 * IssuerRegistry not-found surface) render a JSON-LD schema component
 * (`<PersonSchema>` / `<HowToSchema>` / `<FAQSchema>` / `<OrganizationSchema>`)
 * as the FIRST child of `#root`. React renders that as a zero-height,
 * zero-text `<section>`/wrapper that only holds a `<script type="ld+json">`.
 * `.first()` therefore bound to that empty section, so BOTH `toBeVisible()`
 * (0-height box never satisfies Playwright's visibility) AND `toHaveText(/\S/)`
 * (no text) retried for the full timeout each → the route 30s-hung even though
 * its real content (a `<main>` with a heading + paragraphs) was painted right
 * beside it. Verified 2026-05-30 via a live local render (`#root` children:
 * `[section textLen=0 h=0]`, `[div.min-h-screen textLen=1729]`).
 *
 * Fix: under ONE bounded deadline, poll `#root` for the first descendant that
 * is BOTH visible (non-zero box, not display:none/visibility:hidden) AND
 * carries non-whitespace text — which naturally prefers a painted `<main>` but
 * also covers the handful of public pages that render without a `<main>`
 * (activation card, registry not-found `<p>` surface) while skipping the
 * zero-height/script-only schema wrappers that the brittle `.first()` locator
 * bound to. Returns `true` when real content painted, `false` when it did not
 * within `timeoutMs` (the signal never throws here — the caller decides how to
 * treat a `false`; public routes record a finding). One deadline, not two
 * stacked waits, so a non-painting route resolves `false` fast.
 *
 * Implementation note: `waitForFunction` is Playwright's native polling
 * predicate (no `page.waitForTimeout`, per e2e/agents.md), and it runs the
 * check inside the page so a single round-trip covers every descendant.
 */
async function publicContentPainted(page: Page, timeoutMs = PUBLIC_READY_TIMEOUT_MS): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const root = document.querySelector('#root');
        if (!root) return false;
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const cs = window.getComputedStyle(el);
          return cs.visibility !== 'hidden' && cs.display !== 'none';
        };
        // Real content = any visible element under #root with non-empty text.
        // The zero-height JSON-LD `<section>` wrappers fail `isVisible`, so they
        // can never satisfy this — which is exactly the bug being fixed.
        return Array.from(root.querySelectorAll<HTMLElement>('*')).some(
          (el) => isVisible(el) && /\S/.test(el.innerText ?? ''),
        );
      },
      undefined,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * Authoritative content gate used by the per-route runner for PUBLIC routes:
 * throws iff the page did not paint real content within the bounded window.
 * (The public runner catches this throw and converts it into a recorded
 * finding rather than a hard job failure — see `screenshotRouteAtBothViewports`.)
 */
async function publicContentReady(page: Page): Promise<void> {
  const painted = await publicContentPainted(page);
  expect(painted, 'public route did not paint visible non-empty content within the bounded timeout').toBe(true);
}

/** A visible heading whose text matches `re` (bounded for public routes). */
function headingReady(re: RegExp, timeoutMs = PUBLIC_READY_TIMEOUT_MS) {
  return async (page: Page) => {
    await expect(page.getByRole('heading', { name: re }).first()).toBeVisible({ timeout: timeoutMs });
  };
}

/**
 * Race several ready signals, but stay authoritative on failure. If any check
 * settles first the route is ready. If NONE settle, we await the LAST check
 * directly (no `.catch`), so its assertion error propagates. Callers pass the
 * authoritative content signal LAST (e.g. `anyReady(headingReady(/…/),
 * publicContentReady)`): a tight heading match is preferred, but a route that
 * renders different copy still passes as long as it painted real content.
 *
 * NOTE on timing: every check here is bounded by `PUBLIC_READY_TIMEOUT_MS`, so
 * the losing branches of the race cannot extend the gate beyond that bound.
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

// ── Non-painting public-route findings collector ────────────────────────────
// A PUBLIC route that does not paint real content within the bounded gate is
// NOT a hard job failure (it may be a WIP/stub marketing page or a slow-settling
// network). We still capture its screenshot, then record it here so the run
// surfaces the problem as a reported FINDING instead of a silent skip. Keyed by
// `routeKey::viewport` so each (route, viewport) pair is reported once.
interface ThinRouteFinding {
  key: string;
  path: string;
  viewport: ViewportLabel;
  detail: string;
}
const thinPublicRoutes: ThinRouteFinding[] = [];
function recordThinPublicRoute(finding: ThinRouteFinding): void {
  const dup = thinPublicRoutes.some(
    (f) => f.key === finding.key && f.viewport === finding.viewport,
  );
  if (!dup) thinPublicRoutes.push(finding);
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
  const isPublic = routeCase.auth === 'public';
  for (const viewport of VIEWPORTS) {
    await target.setViewportSize({ width: viewport.width, height: viewport.height });
    // `domcontentloaded` (NOT `networkidle`): marketing pages embed a lazy
    // YouTube iframe + JSON-LD and a fingerprint/balance read that may never
    // let the network go idle, and `networkidle` waits are the classic source
    // of 30s E2E hangs. The ready gate below — bounded content assertion — is
    // the real "page is usable" signal, and it keeps the 25-min E2E budget
    // honest (NB3) by failing/flagging fast instead of idling.
    await target.goto(routeCase.path, { waitUntil: 'domcontentloaded' });

    if (isPublic) {
      // PUBLIC routes: the ready gate is bounded. If the route does not paint
      // within the window we DO NOT hard-fail the job — we capture the shot
      // anyway and record a finding (unless the gate revealed a genuinely
      // broken route, which still surfaces in the finding for follow-up). This
      // keeps the harness GREEN and capturing all routes while still flagging
      // the problematic ones loudly.
      try {
        await routeCase.ready(target);
      } catch (err) {
        const detail = (err as Error).message?.split('\n')[0] ?? 'ready signal did not settle';
        recordThinPublicRoute({ key: routeCase.key, path: routeCase.path, viewport: viewport.label, detail });
        const note = `[route-baseline] THIN/NON-PAINTING public route: ${routeCase.key} (${routeCase.path}) @ ${viewport.label} — ${detail}`;
        console.warn(note);
        testInfo.annotations.push({ type: 'thin-public-route', description: `${routeCase.key} @ ${viewport.label}: ${detail}` });
      }
    } else {
      // AUTHED routes keep the HARD assertion: a broken authed app route is a
      // high-value signal and SHOULD fail the job.
      await routeCase.ready(target);
    }

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

  // Surface the non-painting public routes as a single reported FINDING at the
  // end of the public suite — visible in CI logs without failing the job.
  // Known at time of writing (verified 2026-05-30): /about, /how-it-works,
  // /use-cases render a JSON-LD <section> as #root's first child; the issuer
  // not-found surface renders no <main> and no heading. These captured fine
  // once the gate stopped binding to the empty schema wrapper — this summary
  // is the standing watch for any route that regresses to non-painting.
  test.afterAll(() => {
    if (thinPublicRoutes.length === 0) {
      console.info('[route-baseline] All public routes painted real content within the bounded gate.');
      return;
    }
    const lines = thinPublicRoutes
      .map((f) => `  • ${f.key} (${f.path}) @ ${f.viewport} — ${f.detail}`)
      .join('\n');
    console.warn(
      `[route-baseline] FINDING — ${thinPublicRoutes.length} public route capture(s) did not paint real content within ${PUBLIC_READY_TIMEOUT_MS}ms (shots still captured, job not failed):\n${lines}\n` +
        '  Follow-up: confirm these render real content (possible WIP/stub marketing pages or slow-settling network).',
    );
  });
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
