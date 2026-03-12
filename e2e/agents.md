# agents.md — e2e/
_Last updated: 2026-03-12_

## What This Folder Contains

Playwright E2E test specs and shared fixtures for the Arkova application.

## File Inventory

### Fixtures (`e2e/fixtures/`)

| File | Purpose |
|------|---------|
| `auth.ts` | Extended Playwright `test` object with `individualPage`, `orgAdminPage`, `orgBAdminPage` fixtures + `loginAs` helper |
| `supabase.ts` | Supabase service client (env-var backed), `SEED_USERS` constants, `createTestAnchor()` / `deleteTestAnchor()` helpers |
| `index.ts` | Barrel export — all specs import from here |

### Existing Specs

| File | Flow | Tests | Fixtures Used |
|------|------|-------|---------------|
| `auth.spec.ts` | Login, signup, validation, sign-out | 7 | `test`, `expect`, `SEED_USERS` |
| `route-guards.spec.ts` | Unauthenticated redirects, role-based routing, mid-onboarding redirect | 5 | `test`, `expect` |
| `onboarding.spec.ts` | Role selection, org onboarding form, review gate | 7 | `test`, `expect` |
| `identity.spec.ts` | Role immutability, privileged field protection, org scoping, review gate | 7 | `test`, `expect` |
| `public-verification.spec.ts` | Public verify page (valid/invalid ID, sensitive data, no auth, file size) | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS` |
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

## Do / Don't Rules

- **DO** import `test` and `expect` from `./fixtures` (not `@playwright/test` directly)
- **DO** use `SEED_USERS` constants for known test credentials
- **DO** clean up test data in `afterAll` / `afterEach` via service client
- **DO** use timestamped unique names for test data to avoid collisions
- **DON'T** hardcode Supabase URLs, keys, or passwords in spec files
- **DON'T** create cross-spec dependencies — each spec is isolated
- **DON'T** use `page.waitForTimeout()` — use proper `waitForURL()` or `expect().toBeVisible()`

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
