# Active Migration Notes

This directory now starts with the Path C baseline, `00000000000000_baseline_at_main_HEAD.sql`.

- Do not split the baseline away from `docs/migrations-archive/`; the baseline and archive are one atomic migration-history rewrite for SCRUM-1668.
- Do not edit an already-merged migration. Add a new forward migration with the next available numeric prefix. The only exception in this directory is the dated PR #841 remediation, which renumbers schema work that was merged but not safely applied to production because production already owned version 0313.
- Treat migrations as prod-bound: a migration PR is not Done until prod Supabase schema/ledger evidence is captured.
- **Before claiming a numeric prefix, add a row to the reservation table below in the same PR.** The 2026-06-01 three-way `0327` collision (#971/#1038/#1047) happened because parallel sessions skipped this step.

## Release-drain migration reservations (0327–0339) — updated 2026-06-13

Remote/main is at least `8e62198345932a8e9ff25c41421adf112e3af6a0` for the active release-drain lane after #1107 merged. This is a documentation/control-plane note only; it does not change migrations or production evidence.

Merged during release drain:

| Prefix | PR | Story | File | Status |
|---|---|---|---|---|
| `0327` | #1047 | SCRUM-2225 | `0327_scrum2225_free_tier_quota.sql` | merged to `main` during release drain |
| `0328` | #971 | SCRUM-2045 | `0328_org_integrations_suborg_inheritance.sql` | merged to `main` during release drain |
| `0329` | #1038 | SCRUM-1611 | `0329_member_integrations_credential_providers.sql` | merged to `main` during release drain |
| `0333` | #1101 | SCRUM-2193 | `0333_scrum2193_validate_anchors_metadata_constraints.sql` | merged to `main` during release drain |
| `0334` | #1100 | SCRUM-2248 | `0334_scrum2248_sanitize_metadata_strip_underscore.sql` | merged to `main` during release drain |
| `0335` | #1111 | SCRUM-2236 | `0335_scrum2236_dashboard_cache_budgets.sql` | merged to `main` during release drain |
| `0336` | #1112 | SCRUM-2252 | `0336_scrum2252_revocation_metadata.sql` | merged to `main` during release drain |
| `0337` | #1114 | SCRUM-2250 | `0337_scrum2250_webhook_event_sequence.sql` | merged to `main` during release drain |
| `0338` | #1107 | SCRUM-2244 | `0338_scrum2244_dlq_idempotency.sql` | merged to `main` during release drain |

Remaining strict order:

| Prefix | PR | Story | File | Status |
|---|---|---|---|---|
| `0339` | #1122 | SCRUM-2285 | `0339_get_public_anchor_by_fingerprint.sql` | current strict-order PR |
| `0342` | perf/cpe-cle-dashboard-partial-index | — (perf) | `0342_cpe_cle_dashboard_partial_index.sql` | reserved (next free after Train D `0340`/`0341`) — org CPE/CLE dashboard partial indexes (T3 soak PENDING) |

- Remaining migration order is strict: #1122.
- Do not reserve or reuse `0327`, `0328`, `0329`, `0333`, `0334`, `0335`, `0336`, `0337`, or `0338`; those prefixes are already consumed by merged drain PRs.
- Do not infer a current `0332` release-drain owner from older stale reservations; no active `0332` release-drain PR is asserted by this mirror sync.
- Remaining soaks must use a dedicated isolated Supabase project or a proven `clean_mirror`, never dirty shared staging.
- Remove a remaining row once its PR merges to `main` and gets a durable `## Recent migrations` entry below.

## Train D migration reservations (2026-06-16)

Reserved by the Train D MVP-launch train (GitHub milestone #2). **Pre-soak; not yet merged.** Merge order is strict **0340 → 0341** (0341 is stacked on 0340). Do not reserve or reuse `0340` or `0341`.

| Prefix | Branch | Story | File | Status |
|---|---|---|---|---|
| `0340` | `feat/train-d-proof-foundation` | SCRUM-2335 / 2490 / 2491 | `0340_scrum2335_proof_completeness_columns_and_trigger.sql` | RESERVED — pre-soak |
| `0341` | `feat/train-d-credit-foundation` (stacked on 0340) | SCRUM-2349 / 2350 | `0341_scrum2349_2350_credit_integrity_foundation.sql` | RESERVED — pre-soak |

Train D soaks once (consolidated RC) after Train C (#1154) merges, then rebases onto the new `main`; see HANDOFF.md + the "Release Soak Protection — No-Restart Process" Confluence page.

## Lane 2 migration reservation (2026-06-29)

Reserved by the Lane 2 QUEUE-09 follow-up (stacked on QUEUE-06 PR #1366). **Pre-soak; not yet merged.** Next free after main head `0348` (`0349` is reserved by open PR #1260): `0350`.

| Prefix | Branch | Story | File | Status |
|---|---|---|---|---|
| `0350` | `lane2/s2-queue09-fair-enum` (stacked on `lane2/s2-queue0605-wt` / PR #1366) | QUEUE-09 (SCRUM-2352 follow-up) | `0350_list_drainable_connector_orgs.sql` | RESERVED — pre-soak |

## Recent migrations (PR #817)

- **0311_scrum1599_public_anchor_provenance.sql**: Replaces `get_public_anchor` so public verification can return `SUPERSEDED` records and CSI-03 source provenance fields from sanitized anchor metadata.

## PR #841 ledger remediation (2026-05-21)

- **0313_anchors_index_consolidation.sql**: Records production's existing SCRUM-1286 anchors index consolidation ledger row. The concurrent index drops are manual/operator SQL and have already been applied in production.
- **0314_legally_binding_attestations.sql** and **0315_professional_education_foundations.sql**: Renumbered PR #841 schema work so production can apply it after the existing 0313 anchors ledger row. Do not reintroduce `0313_legally_binding_attestations.sql`.

## Recent migrations (PR #788)

- **0315_professional_education_foundations.sql**: Adds CPE/CLE metadata
  columns on `anchors`, service-role-only CPE/CLE provider registries with RLS
  + `FORCE ROW LEVEL SECURITY`, static seed entries, and secured-anchor
  immutability protection for the new metadata fields.
- **0307_fix_anchors_rls_statement_timeout.sql**: Consolidated three separate `anchors` SELECT RLS policies into one with scalar subquery wrappers for InitPlan evaluation. Same pattern applied to `attestations` (5 branches including `status='ACTIVE'`).
- **0308_seed_arkova_org_credits.sql**: Seeds `org_credits` for Arkova prod org with `EXISTS` guard for idempotency.

_Rollback rehearsed: 2026-05-16 on staging (ujtlwnoqfhtitcmsnrpq). Forward re-applied clean._

## Recent migrations (SCRUM-2044)

- **0320_member_integrations.sql**: Creates `member_integrations` table for member-level DocuSign integration support. RLS: SELECT for own rows + org admins, deny-all write for authenticated (service_role only). Partial unique index on `(user_id, org_id, provider, account_id) WHERE revoked_at IS NULL`. Indexes for webhook account_id lookup and user-org settings page queries.

## Recent migrations (PR #868, renumbered from closed PR #807)

- **0322_bump_cloud_logging_retry_counts_rpc.sql**: SECURITY DEFINER function `bump_cloud_logging_retry_counts(p_audit_ids text[], p_error_msg text)` - bulk retry-count bump replacing N read-modify-write round-trips. `SET search_path = public`. NOTIFY pgrst reload.
- **0323_external_document_versions.sql**: `external_document_versions` table (org-scoped, status check constraint, unique on org+file+fingerprint) + `version_reviews` table (reviewer decision log). RLS: service_role full, authenticated org-member SELECT, admin/owner INSERT on reviews. Indexes on `(org_id, status)` and `(org_id, external_file_id)`.

_Rollback rehearsed: 2026-05-16 on staging (ujtlwnoqfhtitcmsnrpq). Both tables dropped + function dropped, then re-applied clean._

## Recent migrations (SCRUM-1649)

- **0326_scrum1649_deduct_org_credit_idempotency.sql**: Adds `org_credit_deductions`, a service-role idempotency ledger keyed by `(org_id, reference_id, reason)`, and updates `deduct_org_credit` / `refund_org_credit` so FAST_TRACK_ANCHOR retries do not double-charge after worker crash or execution-finalization retry.

## Recent migrations (SCRUM-2203)

- **0330_scrum2203_unembedded_records_query_perf.sql**: Rewrites `get_unembedded_public_records` from a `LEFT JOIN public_record_embeddings ... WHERE pre.id IS NULL` anti-join to `NOT EXISTS` so the planner drives the ordered scan off `idx_public_records_created_at` (Index Only Scan on `idx_pre_record_id` probe) and stops after `p_limit` — killing the full Parallel Seq Scan + Sort that timed out the `embed-public-records` cron every 2 min (prod EXPLAIN: Limit cost 861549 → 170.94). Signature/columns/ordering/grants unchanged; `STABLE SECURITY DEFINER SET search_path = public` preserved. Optional `(created_at, id)` hardening index is documented as a standalone `CREATE INDEX CONCURRENTLY` for operator apply (non-transactional, per the 0313 convention) — the rewrite alone fixes the incident.

## Recent migrations (SCRUM-1847 / SCRUM-1869)

- **0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql**: `CREATE OR REPLACE get_public_anchor` — adds additive-nullable `cpe_metadata` / `cle_metadata` keys built from an **explicit public allowlist** (`jsonb_build_object` + `jsonb_strip_nulls`, sourced from the `anchors` jsonb columns with `->`). Only public display keys are projected — CPE: `credit_hours`, `field_of_study`, `delivery_method`, `nasba_status`, `nasba_lookup_date`, `requires_manual_review`; CLE: `credit_hours`, `ethics_hours`, `jurisdiction`, `approved_provider_name`, `provider_approval_status`, `provider_lookup_date`, `delivery_format`, `course_title`, `requires_manual_review`. Internal fields (`sponsor_id`/`course_id`/`reporting_period_*`/`extraction_confidence`/`extraction_source`, and any FUTURE internal field) are excluded by default — the allowlist mirrors the worker `Cpe`/`CleMetadataSchema` and the frontend `cpe`/`cleMetadataView` allowlists (#1023/#1025). Replaced the original 2-key denylist (`a.cpe_metadata - 'extraction_confidence' - 'extraction_source'`) which under-stripped and would have leaked `sponsor_id`/`course_id`/`reporting_period_*` to anonymous callers (MEDIUM data-exposure fix). Body otherwise unchanged from the prod/0311 definition — preserves SECURITY DEFINER + `search_path` + status filter + `deleted_at` guard + recipient SHA-256 hash; only the two additive keys are new. §1.8 additive — no API version bump. (Renumbered 0329→0331 to resolve a cross-session 0327 collision; the agreed order above main HEAD 0326 is: 0327 #1047 → 0328 #971 → 0329 #1038 → 0330 #1022 → 0331 this PR, taking the top slot to stay collision-proof.)
## Recent migrations (SCRUM-1611 CSI-04A)

- **0329_member_integrations_credential_providers.sql**: Widens the `member_integrations.provider` CHECK constraint from `{'docusign'}` to `{'docusign', 'credly', 'accredible', 'udemy'}` so the same table can hold credential-source provider tokens for the SCRUM-1596 epic. Adds `kek_version smallint NOT NULL DEFAULT 1` for KMS key-rotation tracking (RFC 9700). No new RLS policies — the policies established by 0320 apply to all providers polymorphically. Tier T2 (CHECK widening + additive column). Rollback rehearsal pending on staging.

## Recent migrations (perf/cpe-cle-dashboard-partial-index)

- **0342_cpe_cle_dashboard_partial_index.sql**: Adds two PARTIAL btree indexes on `public.anchors` for the org Compliance CPE/CLE reporting panels (`src/pages/ComplianceDashboardPage.tsx`): `idx_anchors_org_cpe_metadata_issued ON (org_id, issued_at DESC) WHERE cpe_metadata IS NOT NULL` and `idx_anchors_org_cle_metadata_issued ON (org_id, issued_at DESC) WHERE cle_metadata IS NOT NULL`. The panel query `WHERE org_id=$1 AND cpe_metadata IS NOT NULL ORDER BY issued_at DESC LIMIT 1000` had no selective index — the only `org_id` indexes are created_at-ordered composites — so on prod (anchors ~3M rows / 22 GB, primary org owns ~99%) it did a full Parallel Seq Scan + Sort and exceeded the statement timeout (prod EXPLAIN cost ~1.77M; a bare `count(*) FILTER (WHERE cpe_metadata IS NOT NULL)` already times out). The partial predicate stores only the few CPE/CLE rows and the `(org_id, issued_at DESC)` key serves both the filter and the order → Index Scan, no Sort (local throwaway EXPLAIN ANALYZE: Seq Scan 1383 buffers / Rows-Removed-by-Filter 79993 → Index Scan, 2 buffers; 16 kB partial indexes). **CONCURRENTLY decision:** a plain `CREATE INDEX` on this hot table takes a write-blocking lock for the full-heap scan a partial build still requires (a partial index is NOT cheap to build), and `CREATE INDEX CONCURRENTLY` cannot run inside the transaction `supabase db push` wraps a migration in — so, per the 0313 / 0330 / 0335 convention, the migration body is a transactional `DO`/`RAISE NOTICE` marker and the two `CREATE INDEX CONCURRENTLY ... IF NOT EXISTS` statements are operator-applied, NON-TRANSACTIONAL (documented at the file bottom). Index-only change → no `database.types.ts` delta, no `NOTIFY pgrst`. Tier **T3** (touches `supabase/migrations/`); isolated-staging soak PENDING (RM/Carson-scheduled). Forward + rollback (`DROP INDEX CONCURRENTLY IF EXISTS`, run standalone) both rehearsed clean on a throwaway local Postgres; plan reverts to Seq Scan on rollback.

## Lane 1 migration reservation (2026-07-07) — PR #1455 (SCRUM-2486)

Reserved by the Lane-1 S3 chain-primitives PR (`lane1/s3-chain-primitives-tests` / PR #1455). **FILE-ONLY / PRE-SOAK / NEVER-APPLIED — Sprint-4 T3 deferred.** Next free above the soak-locked `0354` band and the current main head `0353`: `0357` (`0355`/`0356` are the security-lane reservations noted in #1457's Sprint-4 carry; Lane-1 takes `0357` to stay collision-proof).

| `0357` | `lane1/s3-chain-primitives-tests` / PR #1455 | SCRUM-2486 | `0357_scrum2486_secured_chain_integrity_trigger.sql` | RESERVED — pre-soak, file-only, NOT applied to prod/rig; does not close the ticket (defers to Sprint-4 with its own 48h T3 soak) |

## Recent migrations (PR #1455)

- **0357_scrum2486_secured_chain_integrity_trigger.sql** (FILE-ONLY / PRE-SOAK / NOT APPLIED): SCRUM-2486 "SECURED ⇒ on-chain receipt present" integrity trigger. Adds `enforce_secured_anchor_chain_present()` (SECURITY DEFINER, `SET search_path = public`) + a `BEFORE INSERT OR UPDATE OF status` trigger on `public.anchors` that refuses any transition INTO `status='SECURED'` unless `chain_tx_id IS NOT NULL AND chain_timestamp IS NOT NULL`. GATED behind the GUC `arkova.secured_enforce_chain_present` (default OFF) with the same two-phase fail-safe rollout as 0340 (SCRUM-2335): Phase 1 (this file) is inert; Phase 2 flips the GUC on after a back-catalogue backfill audit + a clean 48h T3 staging soak, with no further migration. **Authored file-only this window per the 3.25 ART decision (net-new never-soaked T3 work); it is NOT applied to prod or any rig and does NOT close SCRUM-2486.** The remaining ACs — the hash-invariance backfill gate (AC-2), the frozen-fixture `evidence_package_hash` regression test (AC-3, lives in worker test-land, `evidence_package_hash` is derived, not an `anchors` column), and the importer-can't-set-SECURED guard (AC-4) — are Sprint-4 deliverables tracked on the ticket. Tier T3 (touches `supabase/migrations/`). Rollback in the file header.

## Lane 2 migration reservation (2026-07-21) — PR #1614 (G4, PI-0.5 24h slice)

Reserved by the Lane-2 G4 flag-seed PR (`lane2/g4-org-credit-enforcement-flag` / PR #1614). Numbering per the max(main head, reservations, open PRs)+1 rule: main head is `0357`, open PR #1552 owns `0358` (chain rail, `0358_scrum2692_anchor_txid_journal.sql`), RTE holds the `0359` reservation for the 24h window. **Renumbered `0360` → `0363` (2026-07-21):** Lane 1 #1615 (materializer) independently claimed `0359`/`0360`, `0361` is the SCRUM-2916 watermark-index reservation, and `0362` is Lane 2 #1618 (`get_public_anchor` allow-list) — so Lane 2 G4 takes the next free slot, `0363`. (CTO Technical Decision Queue, Confluence 110198785, ratified this band resolution.)

| `0363` | `lane2/g4-org-credit-enforcement-flag` / PR #1614 | G4 (pairs with merged #1570 / SCRUM-2970) | `0363_g4_enable_org_credit_enforcement_flag.sql` | RESERVED — Draft/slice-freeze, NOT applied to prod or any rig; T2 soak PENDING (founder directive: no soak starts without explicit go-ahead). Renumbered from `0360` (Lane 1 #1615 collision on 0359/0360). |

## Recent migrations (PR #1614)

- **0363_g4_enable_org_credit_enforcement_flag.sql** (FILE-ONLY / DRAFT / NOT APPLIED; renumbered from `0360` to dodge Lane 1 #1615's 0359/0360 claim): seeds the `ENABLE_ORG_CREDIT_ENFORCEMENT` row in `switchboard_flags` with `enabled = false` via `ON CONFLICT (flag_key) DO NOTHING` — idempotent, and deliberately NOT `DO UPDATE`, so a re-apply can never flip an operator-set value in either direction. Row insert only: no schema shape change, no `database.types.ts` delta, no `NOTIFY pgrst` needed. Runtime semantics are UNCHANGED by this seed: the worker gate is the env-backed `config.enableOrgCreditEnforcement` (Zod default false) and DB `get_flag()` returns `p_default=false` for an absent row, so "row missing" ≡ "row false" ≡ enforcement OFF (`deductOrgCredit` short-circuits `{allowed:true, reason:'feature_disabled'}`); the row is an **AUDIT MIRROR ONLY** — the worker never reads it (the key sits in flagRegistry `ENV_FLAG_GETTERS`, not `DB_FLAGS`) and it is NOT rendered by the admin UI (`PlatformControlsPage.tsx` / `src/lib/switchboard.ts` omit the key); flipping the row ON changes nothing at runtime, and the row description says so to prevent a misleading audit-trigger trail. **G3 coupling: enforcement must NOT go ON before HakiChain's credit balance is funded (founder-owned) — enabling early 402-blocks partner submissions at zero balance. The enforced coupling is the R-5 config-drift pin (`scripts/ci/config-drift/expected-prod-config.json` + `prod-config-snapshot.json` assert `ENABLE_ORG_CREDIT_ENFORCEMENT=false`; a pre-G3 `=true` in deploy-worker.yml fails CI as flag-SPOF `env-flag-on-no-db-guard`).** Rollback in the file header deletes the row only while still `enabled = false`. Content pinned by `src/tests/0363-enable-org-credit-enforcement-flag.test.ts`; worker fail-closed behavior pinned by `services/worker/src/utils/orgCreditEnforcementFlag.test.ts`. Tier T2; seed.sql updated in the same PR.
