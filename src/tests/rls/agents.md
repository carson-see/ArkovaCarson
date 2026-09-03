# agents.md — tests/rls
_Last updated: 2026-08-30_

## What This Folder Contains

RLS (Row Level Security) test helpers for creating authenticated Supabase clients in different user contexts. Used by RLS policy tests across the repo.

## Key Files
- `helpers.ts` — `withUser()` / `withAuth()` helpers that create per-user Supabase clients with unique storage keys to avoid session collisions; requires `RLS_TEST_PASSWORD` env var matching `supabase/seed.sql`. `cleanupClient()` signs out with `{ scope: 'local' }` — see the rule below. `DEMO_CREDENTIALS.*Id` / `ORG_IDS.*` are the PINNED seed identities suites must use for fixture rows (`tests/infra/seed-fixture-uuids.test.ts` format-ratchets every UUID literal here against the worker's zod; `tests/rls/rls.test.ts` "users can only read their own profile" asserts the signed-in demo user actually resolves to `DEMO_CREDENTIALS.userId`).

## Do / Don't Rules
- DO: Use `withUser()` to get an authenticated client scoped to a seed user
- DO: Keep credentials in env vars (`RLS_TEST_PASSWORD`) — never hardcode
- DO: Seed fixture rows with the pinned `DEMO_CREDENTIALS.adminId` / `.userId` / `.betaAdminId` constants, never with IDs derived from `auth.getUser()` mid-run (SCRUM-3618: a parallel suite's sign-out makes that call fail and poisons the fixture)
- DON'T: Share a single Supabase client across users in one test — each user needs its own client instance (session isolation via `clientCounter`)
- DON'T: `signOut()` without `{ scope: 'local' }` on a shared demo user — the supabase-js default scope is `global`, which revokes every session of that user and breaks suites still running in other vitest workers (`cleanupClient()` already does this right; see `tests/rls/agents.md` "Fixture rules for full-parallel runs")
- DON'T: Run RLS tests against production — local dev instance only
