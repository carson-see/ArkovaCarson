# agents.md — e2e/

_Last updated: 2026-07-28 (newest dated entry in this file; stamp was stale at 2026-05-30)._

Playwright E2E test specs and shared fixtures for the Arkova application.

## Live findings an agent must know before touching this code

- **Click-interception and paint-order bugs are E2E-only. Never answer this
  defect class with Vitest+jsdom.** jsdom has no layout engine and no
  hit-testing, so `fireEvent.click(el)` dispatches straight at the target and
  passes green against a build where a real user's click is swallowed by an
  overlaying element. Only a real browser (Playwright actionability, or
  `document.elementFromPoint`) catches it. Precedent: the 2026-07-28
  `FileUpload` Remove-button defect (an `absolute inset-0` file input painting
  over a non-positioned sibling). `FileUpload.test.tsx` had no Remove-button
  coverage — but adding a jsdom one would NOT have caught it either, which is
  the point.
- **Couple route globs to source constants, never hardcoded paths.** The
  `template-review.spec.ts` intercept hardcoded
  `**/vendor/transformers.web.min.js*`; #1416 renamed the loader target, the
  stub silently stopped matching, the real loader ran, and the spec timed out
  deterministically for days. Route on `TRANSFORMERS_BROWSER_MODULE` imported
  from `src/lib/nerPiiDetector` so a rename fails at import/typecheck time
  instead of stranding the intercept.
- **Never point E2E at a soaking rig.** `helpers/soaking-ref-guard.ts`
  (`assertNotSoakingRef`) throws before any repro `execute_sql`/deploy/load if
  the target is shared staging, prod, a `*-staging`-shaped ref, or an
  operator-listed soaking rig — and it cross-checks `E2E_SUPABASE_URL`, not
  just the ref, because the seed path writes against the URL.
- **Stub third-party network at the Playwright `route()` boundary**, not by
  hoping CSP blocks it. #1600 added `mempool.space` to `connect-src`, which
  turned previously-CSP-blocked enrichment legs into live calls and broke
  `treasury-errors.spec.ts` on every PR run until the legs were explicitly
  stubbed to fail fast.

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

### Helpers (`e2e/helpers/`)

| File | Purpose |
|------|---------|
| `soaking-ref-guard.ts` | **SCRUM-2603** hard guard. `assertNotSoakingRef(ref)` throws BEFORE any repro `execute_sql`/deploy/load if the target Supabase ref is shared staging (`ujtlwnoqfhtitcmsnrpq`), prod (`vzwyaatejekddvltxyye`), any `*-staging`-shaped ref, or any operator-listed soaking micro-rig ref (`SOAKING_PROJECT_REFS` env). Deny-list match is **case-insensitive** (both sides lowercased before `Set.has`) so a cased variant of a protected ref cannot slip past — mirroring the `/staging/i` heuristic. **Also cross-checks `E2E_SUPABASE_URL`**: the seed/teardown path (`getServiceClient()` in `fixtures/supabase.ts`) writes against the URL, not the ref, so a CLEAN throwaway ref paired with a URL still pointing at a protected project (host EQUALS or EMBEDS a denied ref, or is staging-shaped, case-insensitively) is REFUSED — closing the blind spot where `createTestAnchor()` could dirty a soaking/prod DB despite a clean ref field. `evaluateReproTargetUrl()` is the pure URL evaluator; the ref evaluator folds it in so all call sites gain URL protection. The #1147 contamination scar made mechanical (§1.11A). Pure `evaluateReproTargetRef()` / `evaluateReproTargetUrl()` are unit-tested in `tests/infra/soaking-ref-guard.test.ts`. Does NOT stand up / write / tear down any rig — validation only. |

### Existing Specs

| File | Flow | Tests | Fixtures Used |
|------|------|-------|---------------|
| `auth.spec.ts` | Login, signup, validation, sign-out | 7 | `test`, `expect`, `SEED_USERS` |
| `route-guards.spec.ts` | Unauthenticated redirects, role-based routing, mid-onboarding redirect | 5 | `test`, `expect` |
| `onboarding.spec.ts` | Role selection, org onboarding form, review gate | 7 | `test`, `expect` |
| `identity.spec.ts` | Role immutability, privileged field protection, org scoping, review gate | 7 | `test`, `expect` |
| `identity-entitlement.spec.ts` | **PAY-01 / SCRUM-2384** verified-identity entitlement gate via the worker `GET /api/v1/identity/entitlement`: granted on current entitlement+subscription, denied after revoke (closed window), denied on a STALE subscription period (SCRUM-1791), fail-closed with no subscription. Mints a real worker Bearer token (`signInWithPassword`); seeds `entitlements`+`subscriptions` via service client. Requires the worker on `E2E_WORKER_URL`. | 4 | `test`, `expect`, `getServiceClient`, `SEED_USERS`, `@supabase/supabase-js` |
| `public-verification.spec.ts` | Public verify page (valid/invalid ID, sensitive data, no auth, file size) | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS` |
| `public-org.spec.ts` | Public org page (`/issuer/:orgId`): hero, JSON-LD, OG/canonical, anon admin-CTA absence, anonymized vs public members, mobile (375px), unknown-org error | 8 | `test`, `expect` |
| `extraction-csp-fail-closed.spec.ts` | **§1.6 fail-closed exit proof (WEBEXT-02/03/04 / SCRUM-2504/2505/2506).** Serves a probe page under the EXACT deployed CSP (parsed from `vercel.json`) and proves: the CSP blocks the off-origin Tesseract/NER CDNs (jsdelivr, huggingface.co), `'self'` /vendor is reachable, and a model-load failure sends ZERO document-metadata egress (no `/api/v1/ai/extract` request). Unauthenticated (empty storageState); no backend fixtures. _(Restored 2026-07-28, lost by the union-merge-driver incident; see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`.)_ | 3 | `@playwright/test` (direct), `node:fs` (reads `vercel.json`) |
| `dashboard.spec.ts` | Dashboard: welcome, stats, My Records, Secure Document button, privacy toggle, org admin view, navigation | 7 | `test`, `expect`, `individualPage`, `orgAdminPage` |
| `anchor-creation.spec.ts` | Secure Document dialog: upload → fingerprint → confirm step → cancel, **+ Remove-file click-interception regression** (2026-07-28) | 6 | `test`, `expect`, `getServiceClient`, `individualPage` |
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
| `verify-ratelimit-contract.spec.ts` | **SCRUM-2603 (RED de-risking artifact).** Proves the verify endpoint is 429'd far below the §1.10 anon 100/min contract (first 429 ≈ request #4, ~1/25th — every `/api/*` limiter shares one no-scope per-IP bucket that a single verify request increments multiple times; the checkout limit-10 binds first) because `adminRouter`'s checkout limiter (routes/admin.ts:37) is mounted at `/api` (index.ts:351) ahead of the verify router (index.ts:458). Runs **serial** (shared per-IP bucket) with a distinct TEST-NET-3 IP per test. Test 1: 11 anon GETs → all 2xx. Test 2: asserts no sub-contract 429 (429 with `X-RateLimit-Limit` < 100) — a passing-response `=100` check is NOT fail-first because the anon(100) limiter is the last-writer, so the header reads 100 even on the broken order. Test 3: drives past 100/min → real 429 carries `Retry-After`. **Written RED**; the index.ts mount-order fix is WITHHELD (soaking surface). Runs ONLY against a Carson-provisioned throwaway rig cleared by the soaking-ref guard — skips otherwise, never touches a protected rig. | 3 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `assertNotSoakingRef` |

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
non-whitespace text. It must NOT be rewritten as
`page.locator('main, [role="main"], #root > *').first()` — see the Do/Don't rule
below for why that hangs. Heading regexes are kept tight (a miss is not a silent
pass — it falls through to the content check).

**Visual-diff posture:** baselines are attachment-based, NOT `toHaveScreenshot()`
pixel diffs (the repo has no committed golden images; pixel diffs are brittle across
OS/CI). The gate is route *rendering* (the ready signal), not pixel equality.
`playwright.config.ts` carries `expect.toHaveScreenshot` defaults + a
`snapshotPathTemplate` for any future opt-in golden-image spec.

**Local note:** the authed buckets need the `auth.setup.ts` sessions, which require
Supabase creds — exercised in CI, not on a credential-less local checkout (repo norm).

**CI time budget:** 114 full-page captures per browser project (57 cases × 2
viewports), chromium only, serialized (`workers: 1`, `retries: 2`) under the ~25-min
E2E job cap — roughly 6–10 min steady-state. **If the E2E budget tightens, this spec
is the first candidate to split into its own CI shard**: it is self-contained (one
spec file, `ROUTE_BASELINE_DIR`-scoped output), so sharding it off the critical-path
E2E job is low-risk.

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
- **DO** keep click-interception / paint-order regressions as **E2E** tests, never Vitest+jsdom. jsdom has no layout engine and no hit-testing, so `fireEvent.click(el)` dispatches directly at the target and passes green against a build where a real user's click is swallowed by an overlaying element. Only a real browser (Playwright actionability, or `document.elementFromPoint`) catches this class of bug. Precedent: the 2026-07-28 `FileUpload` Remove-button defect (an `absolute inset-0` file input painting over a non-positioned sibling). `FileUpload.test.tsx` had no Remove-button coverage at the time — but adding a jsdom one would NOT have caught it either, which is the point: don't answer this defect class with a unit test.
- **DO** pair a real `.click()` with an explicit `elementFromPoint` assertion when testing interception — a bare click failure surfaces as a generic actionability timeout, whereas the hit-test names the actual interceptor in the failure message.
- **DON'T** use a default (substring) `getByRole('button', { name })` match inside the FileUpload drop zone — the drop-zone wrapper is itself a `div[role="button"]` and its accessible name is computed from its whole subtree, so it absorbs descendant sr-only text (e.g. "Remove file") and the locator resolves to 2 elements. Use `exact: true`.
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

---

Historical change log: [./agents-changelog.md](./agents-changelog.md)
