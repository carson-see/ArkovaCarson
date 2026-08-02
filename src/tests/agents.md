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
- `scrum-2481-anchor-evidence-claim-authority.test.ts` — pins migration 0384: non-`service_role` callers cannot mint the public issuer-authenticated badge by writing `metadata.verification_level` straight into `anchors` over PostgREST, and cannot rewrite `fingerprint_source` after the fact. Content-guard only (no DB); includes the drift guard tying the migration's guarded level list to `ISSUER_AUTHENTICATED_LEVELS` in `src/lib/sourceProvenance.ts` — its worker-side twin lives in `services/worker/src/lib/credential-evidence.test.ts`
- `0363-enable-org-credit-enforcement-flag.test.ts` — pins migration 0363 + seed.sql: `ENABLE_ORG_CREDIT_ENFORCEMENT` switchboard row seeds `enabled=false` with idempotent `ON CONFLICT (flag_key) DO NOTHING` (G4; worker behavior pinned in `services/worker/src/utils/orgCreditEnforcementFlag.test.ts`)

## Subdirectories
- `edge/` — Cloudflare edge worker security tests (JWT verify, HMAC, rate-limit)
- `pages/` — page-level contract tests (URL param parsing, deep-link contracts)
- `rls/` — RLS policy tests with authenticated Supabase clients
- `security/` — CISO audit tests (PII, service-role exposure, RLS policy audit, SSRF)

## Do / Don't Rules
- DO: Use `queryTestUtils.tsx` when testing hooks that depend on React Query
- DON'T: Call real Supabase in unit tests — use mocks or the local dev instance for RLS tests only
