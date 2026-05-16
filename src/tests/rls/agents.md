# agents.md — tests/rls
_Last updated: 2026-05-16_

## What This Folder Contains

RLS (Row Level Security) test helpers for creating authenticated Supabase clients in different user contexts. Used by RLS policy tests across the repo.

## Key Files
- `helpers.ts` — `withUser()` / `withAuth()` helpers that create per-user Supabase clients with unique storage keys to avoid session collisions; requires `RLS_TEST_PASSWORD` env var matching `supabase/seed.sql`

## Do / Don't Rules
- DO: Use `withUser()` to get an authenticated client scoped to a seed user
- DO: Keep credentials in env vars (`RLS_TEST_PASSWORD`) — never hardcode
- DON'T: Share a single Supabase client across users in one test — each user needs its own client instance (session isolation via `clientCounter`)
- DON'T: Run RLS tests against production — local dev instance only
