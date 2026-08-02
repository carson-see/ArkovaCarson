# agents.md — tests
_Last updated: 2026-08-01_

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
- `sec-0388-sanitize-metadata-helper-revoke.test.ts` — content-guard for migration 0388 (SEC-RECON): pins the exact `REVOKE ALL … FROM PUBLIC, anon, authenticated` / `GRANT EXECUTE … TO service_role` pair on `sanitize_metadata_for_public(jsonb)`, that nothing re-grants anon/authenticated (grant-count asserted first so an empty match set cannot pass), and that the deliberately-public verification RPCs are untouched. Also pins the SAFETY ARGUMENT itself — every migration defining `get_public_anchor` must stay `SECURITY DEFINER`, and no `src/`/`services/` file may call the helper via `.rpc()` — because a SECURITY INVOKER flip or a direct call site would turn this revoke into a prod outage on the anon verification page. Runs without a DB; the live half is `tests/rls/sanitize-metadata-helper-revoke.test.ts`.
- `sec-recon-unguarded-rpc-family-revokes.test.ts` — content-guard (always-run) + opt-in live-RLS (`RUN_LIVE_RLS=1`) proof for migration 0377's anon/authenticated REVOKEs on the unguarded SECURITY DEFINER RPC family + the dropped `invite_member` 4-arg overload
- `f5-stats-fn-ownership-guard.test.ts` — F-5 (`docs/staging/SOAK-FINDINGS-2026-08.md`): TDD content-guard (always-run, RED-before/GREEN-after migration 0380 existed) + opt-in live-RLS (`RUN_LIVE_RLS=1`) proof that `get_org_anchor_stats`/`get_user_anchor_stats` now reject a caller-supplied org/user id that doesn't match the caller's own identity (service_role exempt); also pins that the only real caller (`DashboardPage.tsx` via `dashboardStats.ts`) always passes the caller's own id, so the fix is non-breaking for the live dashboard

## Subdirectories
- `edge/` — Cloudflare edge worker security tests (JWT verify, HMAC, rate-limit)
- `pages/` — page-level contract tests (URL param parsing, deep-link contracts)
- `rls/` — RLS policy tests with authenticated Supabase clients
- `security/` — CISO audit tests (PII, service-role exposure, RLS policy audit, SSRF)

## Do / Don't Rules
- DO: Use `queryTestUtils.tsx` when testing hooks that depend on React Query
- DON'T: Call real Supabase in unit tests — use mocks or the local dev instance for RLS tests only
