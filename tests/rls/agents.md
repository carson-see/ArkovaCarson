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

## Conventions
- Requires local Supabase running (`supabase start`) with seed data (`supabase db reset`).
- Public endpoints (attestations, public_records, verification/lookup) are intentionally cross-tenant; do not flag as isolation gaps.

### A mock may stand in for a COLLABORATOR, never for the INVARIANT under test

This is why this directory exists, and it is not an abstract principle — it has
cost real production exposure.

`services/edge/src/mcp-tools.test.ts` has long contained
`it('PENDING fingerprint filtered by RPC → UNKNOWN, not an existence leak')` and
its SUBMITTED twin. Both passed continuously while production served exactly
that leak, because they **mock the RPC**: they assert that the edge layer maps
`{error:'Record not found'}` to an `UNKNOWN` envelope, while the fixture
supplies the premise that the database filters those statuses at all. Prod had
drifted from migration `0339` to `status IN ('SECURED','SUBMITTED','PENDING')`,
and 3 PENDING + 48,149 SUBMITTED anchors became confirmable by an anonymous
caller. The tests did not merely fail to catch it — they **certified** it, by
asserting a premise that had stopped being true. Fixed by `0386` +
`fingerprint-lookup-secured-only.test.ts`.

So: when the assertion is "the database refuses", the database has to be the one
refusing. Concretely, a test belongs in THIS directory (live Postgres, real
`anon`/authenticated client) rather than in a mocked unit suite whenever the
property under test is enforced by SQL — an RLS policy, a `GRANT`, a `WHERE`
predicate, a CHECK constraint, or a trigger. A unit test may still own the
caller's handling of the result; the two are complementary, not substitutes.

Two shapes worth copying when you write one:

- **Always pair a negative with a POSITIVE CONTROL.** "Returns not found for
  in-flight rows" passes just as well against an RPC that is broken, renamed, or
  returning not-found for everything — which looks like a fix and is an outage.
  Assert in the same suite that the allowed case still resolves.
- **For an information leak, assert INDISTINGUISHABILITY, not just refusal.**
  The disclosure is the *difference* between the two answers, so compare the
  bodies (`toEqual`) rather than checking each says "not found" — otherwise a
  distinguishable error path, timing, or envelope shape still leaks.
