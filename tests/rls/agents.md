# tests/rls/agents.md

Row Level Security integration tests. Verify RLS policies enforce tenant isolation and role-based access.

## Files
- **`oauth-email-confirmation.test.ts`** — SCRUM-4035 real SQL authority and replay/concurrency checks. Role-corruption setup uses the local Supabase bootstrap administrator, restricted to owned loopback ports 54322/55503 and the repository CI port blocks; `UAT03_DATABASE_URL` can select the owned native candidate database. Creator cases use `SET SESSION AUTHORIZATION` so a superuser session cannot hide non-superuser role behavior. Setup proves a live bootstrap connection; permission assertions match the primary server ERROR diagnostic exactly, excluding supplied SQL in Node commands or PostgreSQL LINE/CONTEXT excerpts. Transaction scripts use stdin with `SHOW_ALL_RESULTS=off` explicitly exercised: multi-command `psql -c` otherwise hides intermediate results on CI's psql. Temporary roles and grants roll back; concurrent fixtures delete only their own UUID and restore the previous activation timestamp.
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
- **`folders.test.ts`** — SCRUM-2940 folders RLS: cross-tenant isolation on `public.folders` (USER-scoped and ORG-scoped), the `trg_anchor_folder_owner_scope` join guard, and (2026-08-03, migration `0393`, founder-priority bug fix) `anchors` UPDATE as the OWNING authenticated client rather than `service_role`: an org-A ORG_ADMIN moving a teammate-owned SECURED anchor into an org-A folder now succeeds; a plain org-A member attempting the same is still a zero-row no-op (RLS widening is ORG_ADMIN-only); an org-A ORG_ADMIN cannot use the same grant to change any other column on a teammate's record (`trg_restrict_org_admin_folder_update`, `42501`); an org-B ORG_ADMIN still cannot touch org-A's anchor. Root cause: `useAnchors.ts` gives an ORG_ADMIN the whole org's anchor list, but pre-`0393` the only anchors UPDATE policy was `anchors_update_own` (owner-only) — RLS silently matched zero rows (not an error) for every record the admin didn't personally create. Also (2026-08-03, migrations `0397`/`0398`) the first-ever end-to-end RLS coverage for `revoke_anchor`, `supersede_anchor`, and `resolve_anchor_queue` — all three SECURITY DEFINER admin RPCs were broken via their real call path for two separate reasons unrelated to `0393`/`0395` (see those migrations' headers), caught by the `revoke_anchor` test in this file being the first thing that ever ran them against real Postgres. Includes a negative case proving a direct (non-RPC) client write still cannot set `status` to `REVOKED` post-`0397` — the exact boundary the narrowed trigger exemption must not cross.
- **`cpe-org-dashboard.test.ts`** — CPE-02 (SCRUM-2380) org CPE dashboard read path: cross-org isolation (two sandbox orgs), org-admin-vs-member within one org, anon denial. Also PINS the standing `anchors_select` behavior that ANY org member can read org-mates' anchor rows (org-wide `get_user_org_id()` branch) — the dashboard's "member sees only own rows" is a query-layer guarantee in `useOrgCpeMemberSummary`, not an RLS one; a new RLS policy (= migration) would be needed to express it. Creates ad-hoc users via `auth.admin.createUser` (seed has no plain-member login) and seeds SECURED anchors with `chain_tx_id` (anchors_chain_data_consistency).
- **`get_org_members_public.test.ts`** — public org members RPC access tests.
- **`public-org-profiles-security-invoker.test.ts`** — org profile view security tests.
- **`docusign-integrations.test.ts`** — RLS for the 6 DocuSign tables, including `member_integrations` (own-rows / org-admin / deny-write).
- **`credential-source-providers.test.ts`** — SCRUM-1611: verifies migration 0329 widens `member_integrations.provider` for Credly/Accredible/Udemy while preserving DocuSign back-compat, RLS policies extend to the new providers, and unknown providers stay CHECK-rejected.
- **`sanitize-metadata-helper-revoke.test.ts`** — SEC-RECON / migration 0388: proves `anon` and `authenticated` get SQLSTATE 42501 calling `public.sanitize_metadata_for_public(jsonb)` directly (it was an anon-callable oracle for the whole redaction denylist), that `service_role` keeps EXECUTE, and — the regression this must not cause — that `get_public_anchor` still projects end to end for `anon` against a REAL seeded anchor, because it reaches the helper as SECURITY DEFINER. Requires 0388 applied. The fixture is load-bearing: it throws on insert failure, since a missing anchor makes `get_public_anchor` return its "Record not found" stub and the end-to-end assertion pass vacuously (that exact bug was caught during authoring — `anchors.filename` is NOT NULL). Content-guard half runs in default CI at `src/tests/sec-0388-sanitize-metadata-helper-revoke.test.ts`.
- **`fingerprint-lookup-index-plan.test.ts`** — migration 0441. Pins the QUERY PLAN of `get_public_anchor_by_fingerprint`, not its timing. `anchors.fingerprint` is `character(64)` and the RPC parameter is `text`; comparing them bare makes Postgres cast the COLUMN (`Filter: ((fingerprint)::text = …)`), which makes `idx_anchors_fingerprint_lookup` unusable and, over prod's ~3.5M-row SECURED partition, blew `statement_timeout` — verify-by-fingerprint and `get_fingerprint` on edge.arkova.ai returned `isError: "Document verification timed out"` (found 2026-09-08, `docs/staging/edge-retro-2026-09-07/DEPLOY.md` finding 1). A TIMING assertion cannot catch this and must not be written here: the defect is invisible below roughly a million rows and the 12h retro-soak ran on a 10-row fixture. So the suite sets `enable_seqscan = off` — which removes the only row-count-dependent variable and leaves the question "is this predicate index-compatible at all?", true or false at any size — and asserts an **Index Cond** on that index rather than the index NAME appearing in the plan (with seqscan off the planner will happily FULL-scan the same index and apply `(fingerprint)::text` as a Filter, a plan that contains the name while doing the pathological thing). The query is EXTRACTED from the live `pg_proc` body, so the test degrades if someone reverts the function instead of passing against a re-typed copy. Carries a NEGATIVE CONTROL (the pre-0441 uncast form of that same extracted query must NOT reach the index — verified RED before the migration, GREEN after) and POSITIVE CONTROLS (a SECURED row still resolves, upper-case input still resolves, and an in-flight row stays byte-identical to an unknown one so 0386's SECURED-only invariant survives the cast).
- **`public-anchor-pii-projection.test.ts`** — migration 0385. Live proof that the anon-GRANTed `get_public_anchor` / `get_public_anchor_by_fingerprint` projection no longer leaks learner PII: seeds learner names into `filename` / `metadata.title` / `metadata.description` and PII into `revocation_reason`, then reads back as a real ANON client and asserts on the SERIALIZED body (so a value cannot hide in an unnamed field). Vectors come from `scripts/ci/public-pii-projection-contract.json`, the shared contract that also binds `services/worker/src/ctdl/ctdl-pii-guard.ts`, so this suite and the CTDL suite cannot drift on what counts as PII. Carries PRECISION assertions too (real institution names, ordinary titles, numeric issuer URLs must still publish) — a gate that blanks legitimate credentials is a worse product than the leak it replaced. Seeds must set `revoked_at` alongside `revocation_reason` (`anchors_revocation_consistency`).
- **`ferpa-directory-info-opt-out.test.ts`** — **FD-FERPA-1**, migration `0415`. Live proof that `anchors.directory_info_opt_out` actually suppresses directory information on all three anon-reachable SQL projections: seeds a SECURED anchor carrying an issuer name, a `cpe_metadata.field_of_study`, award/expiry dates and a name-shaped filename, then reads it back as a real ANON client and asserts on the SERIALIZED body, so a value cannot survive by moving to a key the test does not name. Every negative is paired with a POSITIVE CONTROL — the same fixture with the flag off must still publish, and the opted-out record must still VERIFY (`verified`, `fingerprint`, chain receipt, a non-empty `filename` and `issuer_name` display string). The `credential_type: null` case is not invented coverage: all three production anchors carrying the flag have a NULL type, so a suppression rule keyed on the education set alone suppresses nothing for any of them. The fingerprint path is asserted for INDISTINGUISHABILITY (`toEqual` against the public-id body) rather than merely "also suppresses", because `0415` deliberately does not redefine it and relies on its delegation to `get_public_anchor`. The search half asserts EXCLUSION FROM MATCHING, not a blanked title — a non-empty result set is itself the disclosure (0387's hit-count oracle) — and uses `CLE` so the assertion is not vacuous, since CLE is in the FERPA set but not the academic set 0387 already excludes. A `INSURANCE` case pins the recorded residual: a PRESENT non-education type still publishes, matching the REST path's own pinned boundary. Requires the local DB migrated to at least 0415.

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

## Function ACLs, not just row policies
`supplementary-proof-anchor-revokes.test.ts` asserts the *grant* surface of five
SECURITY DEFINER functions, not an RLS policy. It exists because SQL that reads
as "service_role only" can compute the opposite ACL: `ALTER DEFAULT PRIVILEGES`
grants `anon`/`authenticated` EXECUTE directly at CREATE time and
`REVOKE ... FROM PUBLIC` does not remove a direct role grant.

- **Assert the computed ACL, not the statements you think produce it** —
  `has_function_privilege('anon', fn, 'EXECUTE')` must be false.
- **Pass the exact identity arguments** so the right overload resolves.
`proof-coverage-window-revoke.test.ts` asserts the *grant* surface of a
SECURITY DEFINER function, not an RLS policy. It exists because SQL that reads
as "service_role only" can compute the opposite ACL: `ALTER DEFAULT PRIVILEGES`
grants `anon`/`authenticated` EXECUTE directly at CREATE time and
`REVOKE ... FROM PUBLIC` does not remove a direct role grant. 0406 shipped that
way and was anon-callable in prod until revoked on 2026-08-11.

- **Assert the computed ACL, not the statements you think produce it** —
  `has_function_privilege('anon', fn, 'EXECUTE')` must be false.
- **Keep the positive case in the same suite.** If `service_role` also lost
  EXECUTE the function is merely broken, and "anon cannot call it" would pass
  for the wrong reason.

## Fixture ownership — every suite owns its org (FD-FERPA-1)

An RLS suite must create its own organization, user and profile in `beforeAll` and
delete them in `afterAll`. **Do not reuse another file's `ORG_ID`.**

`ferpa-directory-info-opt-out.test.ts` originally pinned the same
`f19e2400-…c001` as `fingerprint-lookup-secured-only.test.ts` and only *read* a
profile for it. That sibling creates the org in `beforeAll` and **deletes it** in
`afterAll`, so the FERPA suite threw `could not resolve a seed profile` whenever it
ran outside the sibling's window — and no seed defines that org, on any branch.
Worse, had it run inside that window, the sibling's
`anchors.delete().eq('org_id', ORG_ID)` could remove the FERPA fixtures mid-run,
making leak assertions pass **vacuously**. Shared ids couple suites through the
database; unique ids per suite do not.
## Fixture rules for full-parallel runs (SCRUM-3618 / SCRUM-3577)

Vitest runs every file in this directory in its own worker, concurrently,
against ONE shared database and ONE shared set of seeded demo users. Two
suites (`docusign-integrations`, `credential-source-providers`) flaked for
months under full-suite runs while passing in isolation. The mechanism, and
the rules that keep it dead — the first two are CI-enforced by
`tests/infra/rls-suite-parallel-safety.test.ts` (default `npm test`, no DB
needed), which reuses the 2026-08-15 e2e sign-out guard's detector:

- **Never derive fixture identities from `auth.getUser()`.** supabase-js
  `signOut()` defaults to scope `"global"`, revoking EVERY session of that
  user server-side. Whichever suite finished first signed the shared demo
  user out from under the suites still running; their mid-run `getUser()`
  then failed ("Auth session missing!"), a `?? ''` fallback poisoned the
  seeded `user_id` to `''`, and service-role seeds died with 22P02 — while
  PostgREST queries kept "working" (JWT-only validation) or silently degraded
  to anon once supabase-js dropped the local session. Use the pinned constants
  from `src/tests/rls/helpers.ts` (`DEMO_CREDENTIALS.adminId` / `.userId` /
  `.betaAdminId`, `ORG_IDS.*`) the way `p7.test.ts` and `rls-extended.test.ts`
  always did.
- **`signOut({ scope: 'local' })` in every afterAll** (what `cleanupClient()`
  now does). A default global sign-out is un-scoped teardown of shared session
  state — it reaches into every other worker.
- **Seed inserts THROW on error.** An unchecked seed that silently fails turns
  the read assertions later in the file into count/flake noise instead of a
  clear fixture error. (Same doctrine as the load-bearing fixture note on
  `sanitize-metadata-helper-revoke.test.ts` above.)
- **Tag every seeded row with a file-unique key** (an `account_id` prefix, a
  distinctive fingerprint), delete by that tag in BOTH directions — before
  seeding (leftovers of a crashed prior run; several fixture keys sit under
  partial UNIQUE indexes) and in afterAll — and never delete more broadly
  than your own tag.
- **Never pick "any row" with `.limit(1).single()` and no ORDER BY.** Under
  parallelism the arbitrary row can be another suite's sandbox org/profile,
  deleted mid-run by that suite's teardown. Pin to seeded stable IDs.
- **Do not serialize the suite instead** (`fileParallelism: false` in
  `vitest.config.rls.ts`): it would hide this class of collision and slow
  every RLS run; parallel execution is itself part of what the suite proves.

## 2026-09-12 SCRUM-5024 — `referral-attribution.test.ts`

Live-database proof for migration `0455`. Every property here is enforced by SQL
— an RLS policy, a GRANT, a CHECK, a partial unique index, or a SECURITY DEFINER
body — so per this file's own rule none of it may live in a mocked suite.

The disclosure boundary is why the file exists: `organization_referrals` has no
SELECT policy matching `referred_org_id`, so a member of a REFERRED organization
must read zero rows about it, and the `organization.referred` audit row is filed
against the REFERRER's `org_id`. Both are asserted directly, because a future
"let's add the obvious policy" change would quietly undo them.

Also pinned: the format CHECK rejects `I`/`L`/`O`/`0`/`1` even via `service_role`;
`generate_referral_code` is 42501 for anon AND authenticated; one ACTIVE code per
org (23505); `ensure_org_referral_code` is idempotent; `record_org_referral` is
total (lower-case applies, replay is `already_attributed` with still exactly one
row, unknown writes one audit row and NO edge, self is refused, blank is
`no_code` and writes NO audit row); and neither table accepts a write from
`authenticated`.

Requires a local Supabase with `0455` applied. It was NOT run in the authoring
session (no local stack available there) — it is the T3 soak specification.

## 2026-09-10 — PR #2694 complete-schema fixture correction

The fingerprint index-plan suite now creates its own organization and required profiles row after auth.users. A complete committed Supabase replay exposed anchors_user_id_fkey during the old setup, before any of the seven plan checks executed. Teardown deletes only this run’s user/org fixture, including partial setup. An overlong fingerprint negative case also pins the unconstrained bpchar cast against accidental character(64) truncation. Migration 0441 remains immutable.

The same full-schema run showed a second fixture defect: enable_seqscan=off still permits the planner to choose another index. With only one SECURED row it legitimately chose the status index. The suite now seeds 2,048 owned SECURED background rows so the fingerprint is selective, still asserting Index Cond and the uncast negative control without a latency threshold.

## 2026-09-11 — UAT-04 mandatory MFA boundary

`uat04-mfa-enforcement.test.ts` exercises real GoTrue tokens and PostgREST for the
email-before-MFA transition, AAL1 denial, AAL2 access, private Storage, service
credentials, and preservation of an existing pre-request hook. Keep its fixture
IDs and temporary policies suite-owned, and retain the old-token negative controls.
All other RLS positive clients use a shared, process-locked TOTP factor through
`elevateRlsClientToAal2()`; keep that real GoTrue elevation instead of weakening
the production MFA gate or substituting a locally signed token.

SCRUM-4887: committed changes to the singleton OAuth confirmation policy use
`shared-fixture-lock.ts` across Vitest workers and restore the exact prior
timestamp in a separate `finally` path. The lock times out instead of evicting
an apparently stale owner. Keep file parallelism enabled so unrelated fixture
collisions remain visible.
