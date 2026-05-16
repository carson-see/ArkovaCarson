# e2e/helpers/agents.md

Shared utility functions for E2E Playwright tests.

## Files
- **`dashboard.ts`** — dashboard navigation helpers: `openDashboard()`, `acceptDisclaimerIfVisible()`, overlay wait logic.
- **`profile-session.ts`** — creates ephemeral user profiles + authenticated browser contexts for cross-tenant and role-specific E2E tests.
- **`unique.ts`** — `uniqueTestId(prefix)` generates collision-free test identifiers using timestamp + UUID.

## Conventions
- Helpers must not depend on specific test data; use seed users from `e2e/fixtures/supabase.ts`.
- Profile sessions create real Supabase auth users via `admin.createUser`; clean up after tests.
