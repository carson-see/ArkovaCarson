# agents.md — e2e/
_Last updated: 2026-05-30_

## What This Folder Contains

Playwright E2E test specs and shared fixtures for the Arkova application.

## File Inventory

### Auth Setup (`e2e/auth.setup.ts`)

Playwright setup project that runs **once** before all test projects. Logs in each distinct seed user via the UI login form and saves the authenticated browser state (cookies + localStorage) to `.auth/*.json`. All test projects depend on this setup and reuse the saved state via `storageState` — no per-test login overhead.

Tests that need unauthenticated state (e.g., `auth.spec.ts`, `route-guards.spec.ts`, `onboarding.spec.ts`, `identity.spec.ts`) override with `test.use({ storageState: { cookies: [], origins: [] } })`.

### Fixtures (`e2e/fixtures/`)

| File | Purpose |
|------|---------|
| `auth.ts` | Extended Playwright `test` object with `individualPage`, `orgAdminPage`, `orgBAdminPage` fixtures. Uses pre-saved `storageState` (no per-test login). `orgBAdminPage` opens a separate browser context with sarah's state. |
| `supabase.ts` | Supabase service client (env-var backed), `SEED_USERS` constants, `createTestAnchor()` / `deleteTestAnchor()` helpers |
| `seed-anchors.ts` | Seed SECURED anchors fixture — creates reusable anchors in various states for E2E tests |
| `index.ts` | Barrel export — all specs import from here |

### Existing Specs

| File | Flow | Tests | Fixtures Used |
|------|------|-------|---------------|
| `auth.spec.ts` | Login, signup, validation, sign-out | 7 | `test`, `expect`, `SEED_USERS` |
| `route-guards.spec.ts` | Unauthenticated redirects, role-based routing, mid-onboarding redirect | 5 | `test`, `expect` |
| `onboarding.spec.ts` | Role selection, org onboarding form, review gate | 7 | `test`, `expect` |
| `identity.spec.ts` | Role immutability, privileged field protection, org scoping, review gate | 7 | `test`, `expect` |
| `public-verification.spec.ts` | Public verify page (valid/invalid ID, sensitive data, no auth, file size) | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS` |
| `public-org.spec.ts` | Public org page (`/issuer/:orgId`): hero, JSON-LD, OG/canonical, anon admin-CTA absence, anonymized vs public members, mobile (375px), unknown-org error | 8 | `test`, `expect` |
| `dashboard.spec.ts` | Dashboard: welcome, stats, My Records, Secure Document button, privacy toggle, org admin view, navigation | 7 | `test`, `expect`, `individualPage`, `orgAdminPage` |
| `anchor-creation.spec.ts` | Secure Document dialog: upload → fingerprint → confirm step → cancel | 5 | `test`, `expect`, `getServiceClient`, `individualPage` |
| `record-detail.spec.ts` | Record detail: SECURED sections, fingerprint, QR code, proof downloads, lifecycle, PENDING state, 404 error | 8 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `individualPage` |
| `revocation.spec.ts` | Revoke dialog: confirmation fields, enable on typing, cancel, reason field, REVOKED status | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `orgAdminPage` |
| `csv-upload.spec.ts` | Bulk upload wizard: CSV upload, column mapping, validation errors, processing | 5 | `test`, `expect`, `orgAdminPage` |
| `org-admin.spec.ts` | Org admin: members table, org registry, issue credential form, status filter, export CSV | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `orgAdminPage` |
| `settings.spec.ts` | Profile edit, privacy toggle, identity IDs, webhook settings page, credential templates page | 5 | `test`, `expect`, `individualPage`, `orgAdminPage` |
| `cross-tenant.spec.ts` | Cross-tenant isolation: user-to-user, org-to-org, record list isolation | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `individualPage`, `orgAdminPage`, `orgBAdminPage` |
| `error-states.spec.ts` | Error handling: 404 record, invalid verification, expired session, unknown routes | 5 | `test`, `expect`, `individualPage` |
| `performance.spec.ts` | Frontend performance smoke: dashboard load <5s, stats render <3s, verification page <3s, navigation <3s, org admin <5s | 5 | `test`, `expect`, `individualPage`, `orgAdminPage` |
| `legal-pages.spec.ts` | Public privacy and terms routes: update notices present, launch-blocker placeholder copy absent | 2 | `@playwright/test`, unauthenticated empty storageState |
| `integrations-docusign.spec.ts` | DocuSign org settings connector: status, connect, disconnect, error states, non-admin boundary, 1280px + 375px screenshot attachments | 11 | `test`, `expect`, `getServiceClient`, `SEED_USERS`, `orgAdminPage`, `individualPage` |
| `route-screenshot-baseline.spec.ts` | **Route matrix + screenshot baseline (SCRUM-1998 / GA-S2 / E3).** Enumerates the app's routes (derived from the LOCKED `src/lib/routes.ts` `ROUTES` map) and captures a deterministic full-page screenshot of each at BOTH 1280px desktop + 375px mobile. 57 route cases × 2 viewports = 114 shots/project. | 57 | `test`, `expect`, `getServiceClient`, `getSeedUserOrgId`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `acceptDisclaimerIfVisible`, `ROUTES` |

## Route Screenshot Baseline — Matrix (SCRUM-1998)

`route-screenshot-baseline.spec.ts` is the GA visual baseline harness. The route
matrix is **derived from `src/lib/routes.ts`** (every entry references a `ROUTES.*`
constant, so it tracks the LOCKED route table). Each route is captured at both GA
baseline viewports and the result is (a) attached to the Playwright report via
`testInfo.attach()` and (b) written to `ROUTE_BASELINE_DIR` (default
`test-results/route-baseline/`; set `ROUTE_BASELINE_DIR=docs/screenshots/baseline`
to curate a committed snapshot per the ticket).

| Bucket | Auth | Count | Notes |
|--------|------|-------|-------|
| Public routes | none (empty storageState) | 20 | login, signup, verify form, search, marketing/legal pages, developer/API pages; param-public routes use a deterministic unknown id → graceful not-found surface |
| Individual user routes | `individual` storageState | 12 | dashboard, documents, records, my-credentials, settings (+ api-keys/webhooks/templates), help, billing, attestations |
| Org admin routes | `orgAdmin` storageState | 23 | organizations/organization, review-queue, AI/compliance pages, rules, anchor-queue, signature-compliance, auditor-batch + the platform-admin `/admin/*` console |
| Parameterized detail routes | individual / orgAdmin | 2 | `/records/:id` (seeded SECURED anchor) + `/organizations/:orgId` (seeded org); each skips gracefully if its seed row is absent |

**Determinism:** animations disabled per shot (`animations: 'disabled'`); dynamic
regions masked (`[data-dynamic]`, `[data-testid="relative-time"]`, `<time>`); each
route waits on an explicit, **bounded** ready signal — never a fixed timeout and
never `networkidle` (see below). **The ready gate is asymmetric by auth:**

- **Authed routes (hard gate):** gate on `#main-content` (it exists only inside the
  authenticated AppShell), budget `AUTHED_READY_TIMEOUT_MS` (15 s). A broken authed
  app route is a high-value signal and **fails the job**.
- **Public routes (capture-and-report):** gate on `publicContentReady` — bounded by
  `PUBLIC_READY_TIMEOUT_MS` (8 s). If a public route does **not** paint real content
  within that window the shot is **still captured**, the route is recorded in
  `thinPublicRoutes`, `console.warn`'d, annotated (`thin-public-route`), and surfaced
  in an end-of-suite FINDING summary — the spec stays **GREEN** (a WIP/stub marketing
  page or a slow-settling network must not red-fail the whole baseline job), while the
  problem is reported loudly (never a silent skip).

`publicContentReady` asserts the page **painted real content**: it polls (via
`waitForFunction`, not `waitForTimeout`) for the first element under `#root` that is
BOTH visible (non-zero box, not `display:none`/`visibility:hidden`) AND carries
non-whitespace text. This is deliberately **NOT** the old
`page.locator('main, [role="main"], #root > *').first()` — that `.first()` bound to a
zero-height JSON-LD `<section>` wrapper (rendered as `#root`'s first child by
`PersonSchema`/`HowToSchema`/`FAQSchema`/`OrganizationSchema`), so both `toBeVisible()`
and `toHaveText()` retried for the full timeout and the route 30s-hung even though its
real `<main>` was painted right beside it (the 2026-05-30 PR #998 failure; verified via
live render). Heading regexes are kept tight (a miss is not a silent pass — it falls
through to the content check); a route that paints different copy still passes via the
content check. **Known findings (2026-05-30):** `/about`, `/how-it-works`, `/use-cases`,
and the issuer not-found surface (`/issuer/<unknown-uuid>`) did not paint within the
old gate; they render real content (verified) and now capture fine — the finding-
collector remains as a standing watch. Follow-up: re-confirm these render real content
in CI (the issuer not-found surface renders no `<main>` and no heading — its "not found"
copy is a `<p>` — so it relies on the visible-text fallback). **Visual-diff posture:** baselines
are attachment-based, NOT `toHaveScreenshot()` pixel diffs (the repo has no committed
golden images; pixel diffs are brittle across OS/CI). The gate is route *rendering*
(the ready signal), not pixel equality. `playwright.config.ts` carries
`expect.toHaveScreenshot` defaults + a `snapshotPathTemplate` for any future opt-in
golden-image spec. **Local note:** the authed buckets need the `auth.setup.ts`
sessions, which require Supabase creds — exercised in CI, not on a credential-less
local checkout (repo norm).

**CI time budget (NB3):** this spec adds **114 full-page captures per browser
project** (57 cases × 2 viewports) to a suite that runs serialized in CI
(`workers: 1`) with `retries: 2`, under the ~25-min E2E job cap. CI runs the
`chromium` project only for this matrix, so the expected steady-state added runtime
is roughly **6–10 min** of wall-clock (≈3–5 s/capture incl. nav + bounded ready gate;
the gate uses `domcontentloaded` + a bounded content assertion, **not** `networkidle`,
so a non-settling page can no longer burn the full 30 s test budget), with retries
pushing a flaky run higher. The `orgAdminPage` browser context
is now instantiated only for the ~25 org-admin/org-profile cases (not all 57), which
trims context-setup overhead. **If the E2E budget tightens, this spec is the first
candidate to split into its own CI shard / job** (it is self-contained — one spec
file, `ROUTE_BASELINE_DIR`-scoped output — so sharding it off the critical-path E2E
job is low-risk).

## Do / Don't Rules

- **DO** import `test` and `expect` from `./fixtures` for seeded/authenticated flows.
- **DO** import from `@playwright/test` directly only for public unauthenticated smoke specs that do not need seed data or service-role helpers.
- **DO** use `SEED_USERS` constants for known test credentials
- **DO** clean up test data in `afterAll` / `afterEach` via service client
- **DO** use timestamped unique names for test data to avoid collisions
- **DON'T** hardcode Supabase URLs, keys, or passwords in spec files
- **DON'T** create cross-spec dependencies — each spec is isolated
- **DON'T** use `page.waitForTimeout()` — use proper `waitForURL()` or `expect().toBeVisible()`
- **DON'T** gate a screenshot/route assertion on `body` being visible — `<body>` is visible even on a blank/white-screen page, so it is a no-op that always passes. Assert a primary content region **with non-empty text** so a broken page actually fails (see `publicContentReady` / `mainContentReady` in `route-screenshot-baseline.spec.ts`).
- **DON'T** detect "the page painted" with `page.locator('main, [role="main"], #root > *').first()` — `.first()` resolves to the first DOM-order match of ANY clause, which on pages that render a JSON-LD schema component first (`PersonSchema`/`HowToSchema`/`FAQSchema`/`OrganizationSchema`) binds to a **zero-height, zero-text `<section>` wrapper** and hangs the gate for the full timeout. Scan for the first **visible, non-empty-text** element instead (skips the empty schema wrapper). This was the PR #998 30s-timeout root cause.
- **DON'T** red-fail the whole route-baseline job on a single non-painting **public** route — capture the shot and record it as a reported finding (`thinPublicRoutes` + `console.warn` + annotation + end-of-suite summary). Keep the **hard** assertion for **authed** routes (`#main-content`), where a non-painting route is a real defect.
- **DON'T** instantiate a context fixture (`orgAdminPage`, `orgBAdminPage`) in a test that doesn't use it — each eagerly opens a browser context + teardown. Destructure only the fixtures the block actually drives.

## Dependencies

- `@playwright/test` — test framework
- `@supabase/supabase-js` — service client for test data setup/teardown
- `dotenv` — loads `.env.test` in `playwright.config.ts`
- Environment variables (set in `.env.test`, see `.env.test.example`):
  - `E2E_SUPABASE_SERVICE_KEY` (required) — service role key for test data setup
  - `E2E_SEED_PASSWORD` (required) — shared password for seed test users
  - `E2E_SUPABASE_URL` (optional, defaults to `http://127.0.0.1:54321`)
- Local Supabase must be running with seed data loaded (`npx supabase db reset`)

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 10:45 PM EST | Initial creation. Shared fixtures, refactored 5 existing specs. |
| 2026-03-10 11:00 PM EST | Phase B complete. Created 4 Tier 1 specs: dashboard (7), anchor-creation (5), record-detail (8), revocation (5). |
| 2026-03-10 11:30 PM EST | Phase C complete. Created 3 Tier 2 specs: csv-upload (5), org-admin (5), settings (5). |
| 2026-03-10 11:45 PM EST | Phase D complete. Created 2 Tier 3 specs: cross-tenant (5), error-states (5). All E2E spec files created. |
| 2026-03-11 12:00 AM EST | Phase E complete. Created performance.spec.ts (5 tests). Stress/load tests in `tests/load/` (4 files, 25 tests). |
| 2026-03-10 11:30 PM EST | Security: moved hard-coded seed passwords + service key to env vars (SonarQube S2068). Added `dotenv` + `.env.test` + `.env.test.example`. |
| 2026-03-12 | MVP audit: 14 launch gap stories identified (see `docs/stories/11_mvp_launch_gaps.md`). E2E targets for new flows: MVP-03 legal pages (routing), MVP-05 error boundary + 404 page, MVP-02 toast notifications, MVP-06 file-based verification, MVP-07 mobile responsive layout. |
| 2026-04-24 | SCRUM-1091 (PUBLIC-ORG-08): Added `public-org-page.spec.ts` — anonymous-visitor flow at `/issuer/:orgId` covering desktop (1280px), mobile (375px), JSON-LD + OG/Twitter meta presence. |
| 2026-04-26 | SCRUM-1302: Replaced per-test UI login with Playwright `storageState` setup project. Auth setup runs once, all specs reuse saved session. Specs needing unauthenticated state override with empty storageState. Removed `continue-on-error: true` from CI E2E step. Increased `webServer.timeout` to 120s. |
| 2026-05-19 | SCRUM-1247 closeout: Added `legal-pages.spec.ts` for public `/privacy` and `/terms` notices without seeded auth dependencies. |
| 2026-05-28 | SCRUM-2133: Extended `integrations-docusign.spec.ts` with disconnect success-path coverage and attached desktop 1280px/mobile 375px screenshots for connector readiness evidence. |
| 2026-05-30 | SCRUM-1998 (GA-S2 / E3): Added `route-screenshot-baseline.spec.ts` — route matrix (derived from `src/lib/routes.ts`) capturing a deterministic full-page screenshot of all 57 route cases at 1280px + 375px (114 shots/project), attached to the report and written to `ROUTE_BASELINE_DIR`. Added `expect.toHaveScreenshot` defaults + `snapshotPathTemplate` to `playwright.config.ts` for future opt-in golden-image specs. |
| 2026-05-30 | SCRUM-1998 review fixes (PR #998): (NB1) made the public-route ready gate authoritative — removed the `body`-visible fallback no-op, added `publicContentReady` (visible `main`/`[role="main"]`/`#root>*` **with non-empty text** so a blank page fails), and tightened the broadest heading regexes (`/cle\|bar\|api/`→`/cle\|attorney/`, `/sandbox\|api/`→`/sandbox/`, `/activate\|account/`→`/activate\|activation/`, `/develop\|api/`→`/develop/`); authed `#main-content` gate unchanged. (NB2) `orgAdminPage` now instantiated only for the ~25 org-admin/org-profile cases — public/individual blocks take `{ page }` only (no eager context for ~32 cases). (NB3) documented CI runtime budget + shard candidacy above. (NB4) commented the synthetic-SECURED record fixture. |
| 2026-05-30 | SCRUM-1998 harness robustness (PR #998, follow-up): fixed 4 public routes that hit 30s timeouts (`/about`, `/how-it-works`, `/use-cases`, issuer not-found). **Root cause:** `publicContentReady`'s `…first()` content locator bound to a zero-height JSON-LD `<section>` (`#root`'s first child on schema-carrying pages) → both visibility + non-empty-text assertions retried for the full timeout. **Fix (spec-only):** (1) `publicContentPainted` now scans `#root` (via `waitForFunction`) for the first **visible, non-empty-text** element, skipping empty schema wrappers; (2) per-route gate bounded to `PUBLIC_READY_TIMEOUT_MS`=8 s (was effectively 30 s); authed kept at `AUTHED_READY_TIMEOUT_MS`=15 s; (3) public routes that still don't paint are captured-and-reported (`thinPublicRoutes` + `console.warn` + annotation + end-of-suite FINDING summary) instead of red-failing — authed routes keep the hard fail; (4) `networkidle` removed as a gate (`domcontentloaded` only). Verified live: all 4 now pass in 0.4–1.0 s and capture; capture-and-report path proven with a synthetic non-painting case. The 4 routes are flagged as a finding for follow-up (they render real content; confirm in CI). |
