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
- `public-anchor-pii-projection.contract.test.ts` — ANTI-DRIFT for the **four** public projections of an anchor (SQL `get_public_anchor`, GRANTed to `anon`; TS `ctdl-pii-guard.ts`; TS `api/v1/verify.ts`, behind the anon-allowed `GET /api/v1/verify/:publicId`; TS `api/v1/provenance.ts`, mounted with no scope and no auth at all) plus the shared TS value layer `api/v1/public-projection-text.ts`. The provenance suite additionally pins a **never-emit** field (`signatures.signer_name`, an X.509 Subject CN) — asserted absent from the source *including the SELECT list*, since a value detector cannot protect a bare name — and pins the three-fact revocation wording so `no reason provided` is never asserted over a suppressed reason. A dedicated suite asserts `publicFreeTextOrNull` is defined in exactly one module and imported everywhere else. The verify suite (added 2026-08-02) asserts **source shape**, not behaviour — behaviour is proved by supertest in `services/worker/src/api/v1/verify-pii-projection.test.ts`, but a behavioural suite alone cannot catch an edit that deletes the gate and its tests together. It pins: the detector is imported from the guard rather than re-implemented; the academic branch keys off `isEducationCredentialType` and is **not** conditioned on `suppressDirectory` (the policy decision — opt-out means default-publish, which is the defect class); `STRUCTURAL_API_RICH_KEYS` matches the contract; and no learner-name heuristic or fail-closed error type appears. It reads verify.ts through `stripTsComments` for the same reason the SQL half uses `stripSqlComments` — verify.ts documents at length why it does **not** import `containsLearnerNamePii`, and a raw substring match reads that explanation as the import it warns against, i.e. a test that fails on its own documentation and passes once you delete it. Mutation-verified in both directions: a real import still fails. Asserts migration 0385 implements `scripts/ci/public-pii-projection-contract.json`; enforces the **latest-definition invariant** (whichever migration redefines `get_public_anchor` with the highest numeric prefix must still carry the PII gate and the keyed recipient HMAC — this is the 0376-clobber class that put an unsalted recipient hash live for four days); and self-arms cross-implementation parity the moment `ctdl-pii-guard.ts` lands from #1815, with no `test.skip` and no follow-up ticket. Behavioural proof lives in `tests/rls/public-anchor-pii-projection.test.ts`. **The derived value gate is FAIL-CLOSED:** it exempts only the keys named in the contract's `structural_keys` allow-list and requires a cleaner on everything else. Its first form did the inverse — it tried to recognise anchor-controlled expressions (`a.metadata ->> '…'`) and skipped what it did not recognise, so it never evaluated the six free-text keys 0385 reads through the `g.safe_metadata` LATERAL alias, and adding `'awarded_to', g.safe_metadata ->> 'awarded_to'` passed 23/23. A companion assertion pins `projection_keys`, because an empty "ungated" list is otherwise indistinguishable between "everything is gated" and "the matcher matched nothing".

## Subdirectories
- `edge/` — Cloudflare edge worker security tests (JWT verify, HMAC, rate-limit)
- `pages/` — page-level contract tests (URL param parsing, deep-link contracts)
- `rls/` — RLS policy tests with authenticated Supabase clients
- `security/` — CISO audit tests (PII, service-role exposure, RLS policy audit, SSRF)

## Do / Don't Rules
- DO: Use `queryTestUtils.tsx` when testing hooks that depend on React Query
- DON'T: Call real Supabase in unit tests — use mocks or the local dev instance for RLS tests only
