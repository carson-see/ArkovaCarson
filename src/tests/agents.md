# agents.md — tests
_Last updated: 2026-05-16_

## What This Folder Contains

Integration and infrastructure test suites that cross-cut the codebase: migration drift detection, RLS performance, jurisdiction rule coverage, and shared test utilities. Subdirectories hold edge-worker, page-level, RLS, and security tests.

## Key Files
- `queryTestUtils.tsx` — React Query test wrapper (`createTestQueryClient`, `createQueryWrapper`) with no retries and no caching for isolation
- `drop-search-overload.test.ts` — validates the migration that drops a broken `search_public_credentials` overload
- `jurisdiction-rules-coverage.test.ts` — asserts `jurisdiction_rules` table shape survives baseline collapse (SCRUM-907)
- `migration-drift-logic.test.ts` — unit-tests the diff algorithm used by the migration-drift CI workflow (SCRUM-908)
- `rls-performance.test.ts` — checks RLS performance indexes exist in the baseline schema (SCRUM-348..352)
- `0363-enable-org-credit-enforcement-flag.test.ts` — pins migration 0363 + seed.sql: `ENABLE_ORG_CREDIT_ENFORCEMENT` switchboard row seeds `enabled=false` with idempotent `ON CONFLICT (flag_key) DO NOTHING` (G4; worker behavior pinned in `services/worker/src/utils/orgCreditEnforcementFlag.test.ts`)
- `f5b-stats-fn-null-identity-guard.test.ts` — pins migration 0391 (F-5b), the compensating fix for 0380's NULL-identity bypass on `get_org_anchor_stats`/`get_user_anchor_stats`: a caller with no identity passing an explicit NULL argument hit `NULL IS DISTINCT FROM NULL` = FALSE and got HTTP 200 + all-zero stats instead of 42501. Content-guard layer asserts the identity is resolved into a local and NULL-checked **before** the argument comparison (the assertion that would have caught 0380); `RUN_LIVE_RLS=1` layer invokes both RPCs with NULL as anon, org-less authenticated, and ORG_ADMIN against a throwaway DB. Note the measured PostgREST behaviour recorded in its header: 42501 surfaces as HTTP **401 for `anon`** and 403 for `authenticated`, so assert on SQLSTATE, never HTTP status

## Subdirectories
- `edge/` — Cloudflare edge worker security tests (JWT verify, HMAC, rate-limit)
- `pages/` — page-level contract tests (URL param parsing, deep-link contracts)
- `rls/` — RLS policy tests with authenticated Supabase clients
- `security/` — CISO audit tests (PII, service-role exposure, RLS policy audit, SSRF)

## Do / Don't Rules
- DO: Use `queryTestUtils.tsx` when testing hooks that depend on React Query
- DON'T: Call real Supabase in unit tests — use mocks or the local dev instance for RLS tests only
