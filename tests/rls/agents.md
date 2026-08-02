# tests/rls/agents.md

Row Level Security integration tests. Verify RLS policies enforce tenant isolation and role-based access.

## Files
- **`rls.test.ts`** — core RLS tests: cross-tenant reads, own-data reads, insert/update/delete policies. Uses `withUser()` and `createServiceClient()` from `src/tests/rls/helpers.ts`.
- **`rls-extended.test.ts`** — extended RLS coverage for newer tables and edge cases.
- **`p7.test.ts`** — Phase 7 RLS policy tests.
- **`payment-ledger.test.ts`** — RLS tests for payment ledger tables.
- **`public_records.test.ts`** — verifies public record endpoints are intentionally cross-tenant.
- **`views-security-invoker.test.ts`** — verifies all views use `security_invoker=true`.
- **`scrum-1275-rls-policy-backfill.test.ts`** — backfill coverage for policies added in SCRUM-1275.
- **`scrum-1284-matview-revokes.test.ts`** — materialized view REVOKE tests.
- **`security-hardening-0160.test.ts`** — security hardening migration verification.
- **`x402_payments.test.ts`** — x402 payment protocol RLS tests.
- **`cpe-org-dashboard.test.ts`** — CPE-02 (SCRUM-2380) org CPE dashboard read path: cross-org isolation (two sandbox orgs), org-admin-vs-member within one org, anon denial. Also PINS the standing `anchors_select` behavior that ANY org member can read org-mates' anchor rows (org-wide `get_user_org_id()` branch) — the dashboard's "member sees only own rows" is a query-layer guarantee in `useOrgCpeMemberSummary`, not an RLS one; a new RLS policy (= migration) would be needed to express it. Creates ad-hoc users via `auth.admin.createUser` (seed has no plain-member login) and seeds SECURED anchors with `chain_tx_id` (anchors_chain_data_consistency).
- **`get_org_members_public.test.ts`** — public org members RPC access tests.
- **`public-org-profiles-security-invoker.test.ts`** — org profile view security tests.
- **`docusign-integrations.test.ts`** — RLS for the 6 DocuSign tables, including `member_integrations` (own-rows / org-admin / deny-write).
- **`credential-source-providers.test.ts`** — SCRUM-1611: verifies migration 0329 widens `member_integrations.provider` for Credly/Accredible/Udemy while preserving DocuSign back-compat, RLS policies extend to the new providers, and unknown providers stay CHECK-rejected.
- **`sanitize-metadata-helper-revoke.test.ts`** — SEC-RECON / migration 0388: proves `anon` and `authenticated` get SQLSTATE 42501 calling `public.sanitize_metadata_for_public(jsonb)` directly (it was an anon-callable oracle for the whole redaction denylist), that `service_role` keeps EXECUTE, and — the regression this must not cause — that `get_public_anchor` still projects end to end for `anon` against a REAL seeded anchor, because it reaches the helper as SECURITY DEFINER. Requires 0388 applied. The fixture is load-bearing: it throws on insert failure, since a missing anchor makes `get_public_anchor` return its "Record not found" stub and the end-to-end assertion pass vacuously (that exact bug was caught during authoring — `anchors.filename` is NOT NULL). Content-guard half runs in default CI at `src/tests/sec-0388-sanitize-metadata-helper-revoke.test.ts`.
- **`public-anchor-pii-projection.test.ts`** — migration 0385. Live proof that the anon-GRANTed `get_public_anchor` / `get_public_anchor_by_fingerprint` projection no longer leaks learner PII: seeds learner names into `filename` / `metadata.title` / `metadata.description` and PII into `revocation_reason`, then reads back as a real ANON client and asserts on the SERIALIZED body (so a value cannot hide in an unnamed field). Vectors come from `scripts/ci/public-pii-projection-contract.json`, the shared contract that also binds `services/worker/src/ctdl/ctdl-pii-guard.ts`, so this suite and the CTDL suite cannot drift on what counts as PII. Carries PRECISION assertions too (real institution names, ordinary titles, numeric issuer URLs must still publish) — a gate that blanks legitimate credentials is a worse product than the leak it replaced. Seeds must set `revoked_at` alongside `revocation_reason` (`anchors_revocation_consistency`).

## Conventions
- Requires local Supabase running (`supabase start`) with seed data (`supabase db reset`).
- Public endpoints (attestations, public_records, verification/lookup) are intentionally cross-tenant; do not flag as isolation gaps.
