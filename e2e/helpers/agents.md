# e2e/helpers/agents.md

Shared utility functions for E2E Playwright tests.

## Files
- **`cross-tenant-assertions.ts`** — DEG-4 (SOAK-PREMORTEM-SOC2-2026-08-11 §4) pure verdict evaluators for `cross-tenant.spec.ts`: `evaluateRecordBlocked()` (blocked means the explicit `Record Not Found` heading ON the record path — any navigation away, including a /login redirect from an expired session, FAILS) and `evaluatePositiveAccess()` (accessor must render its OWN record first; failures carry the distinct `precondition: <label> session not authenticated` message). Pure logic, no Playwright — unit-tested in `tests/infra/cross-tenant-assertions.test.ts` (same pattern as `soaking-ref-guard.ts`).
- **`dashboard.ts`** — dashboard navigation helpers: `openDashboard()`, `acceptDisclaimerIfVisible()`, overlay wait logic.
- **`profile-session.ts`** — creates ephemeral user profiles + authenticated browser contexts for cross-tenant and role-specific E2E tests.
- **`soaking-ref-guard.ts`** — SCRUM-2603 hard guard; see the full entry in `e2e/agents.md`.
- **`unique.ts`** — `uniqueTestId(prefix)` generates collision-free test identifiers using timestamp + UUID.

## Conventions
- Helpers must not depend on specific test data; use seed users from `e2e/fixtures/supabase.ts`.
- Profile sessions create real Supabase auth users via `admin.createUser`; clean up after tests.
