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
- `public-anchor-pii-projection.contract.test.ts` — ANTI-DRIFT for the two public projections of an anchor (SQL `get_public_anchor`, GRANTed to `anon`; TS `ctdl-pii-guard.ts`). Asserts migration 0385 implements `scripts/ci/public-pii-projection-contract.json`; enforces the **latest-definition invariant** (whichever migration redefines `get_public_anchor` with the highest numeric prefix must still carry the PII gate and the keyed recipient HMAC — this is the 0376-clobber class that put an unsalted recipient hash live for four days); and self-arms cross-implementation parity the moment `ctdl-pii-guard.ts` lands from #1815, with no `test.skip` and no follow-up ticket. Behavioural proof lives in `tests/rls/public-anchor-pii-projection.test.ts`. **The derived value gate is FAIL-CLOSED:** it exempts only the keys named in the contract's `structural_keys` allow-list and requires a cleaner on everything else. Its first form did the inverse — it tried to recognise anchor-controlled expressions (`a.metadata ->> '…'`) and skipped what it did not recognise, so it never evaluated the six free-text keys 0385 reads through the `g.safe_metadata` LATERAL alias, and adding `'awarded_to', g.safe_metadata ->> 'awarded_to'` passed 23/23. A companion assertion pins `projection_keys`, because an empty "ungated" list is otherwise indistinguishable between "everything is gated" and "the matcher matched nothing".
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
