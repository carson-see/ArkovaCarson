# e2e/helpers/agents.md

Shared utility functions for E2E Playwright tests.

## Files
- **`cross-tenant-assertions.ts`** — DEG-4 (SOAK-PREMORTEM-SOC2-2026-08-11 §4) pure verdict evaluators for `cross-tenant.spec.ts`: `evaluateRecordBlocked()` (blocked means the explicit `Record Not Found` heading ON the record path — any navigation away, including a /login redirect from an expired session, FAILS) and `evaluatePositiveAccess()` (accessor must render its OWN record first; failures carry the distinct `precondition: <label> session not authenticated` message). Pure logic, no Playwright — unit-tested in `tests/infra/cross-tenant-assertions.test.ts` (same pattern as `soaking-ref-guard.ts`).
- **`dashboard.ts`** — dashboard navigation helpers: `openDashboard()`, `acceptDisclaimerIfVisible()`, overlay wait logic.
- **`profile-session.ts`** — creates ephemeral user profiles + authenticated browser contexts for cross-tenant and role-specific E2E tests.
- **`signout-scope-guard.ts`** — pure detector for bare `auth.signOut()` calls in e2e code. supabase-js defaults `signOut()` to `scope: 'global'`, which revokes EVERY session for that seed user — including the `.auth/*.json` storageState session every later spec in a single-invocation run reuses. Observed 2026-08-15 on the fullsoak side-rig: `cross-tenant.spec.ts`'s PostgREST-leg `afterAll` bounced every subsequent `orgAdminPage` spec to /login (GoTrue 403 `session_not_found` for the still-unexpired storageState JWT). CI's local GoTrue masks it; per-spec invocations mask it. `findUnscopedSignOutCalls()` is unit-tested and run over every `e2e/**/*.ts` file as a ratchet in `tests/infra/signout-scope-guard.test.ts`. E2e code passes an explicit scope — normally `{ scope: 'local' }`, matching `src/hooks/useAuth.ts`.
- **`soaking-ref-guard.ts`** — SCRUM-2603 hard guard; see the full entry in `e2e/agents.md`.
- **`unique.ts`** — `uniqueTestId(prefix)` generates collision-free test identifiers using timestamp + UUID.

## Conventions
- Helpers must not depend on specific test data; use seed users from `e2e/fixtures/supabase.ts`.
- Profile sessions create real Supabase auth users via `admin.createUser`; clean up after tests.
