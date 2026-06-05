# Active Migration Notes

This directory now starts with the Path C baseline, `00000000000000_baseline_at_main_HEAD.sql`.

- Do not split the baseline away from `docs/migrations-archive/`; the baseline and archive are one atomic migration-history rewrite for SCRUM-1668.
- Do not edit an already-merged migration. Add a new forward migration with the next available numeric prefix. The only exception in this directory is the dated PR #841 remediation, which renumbers schema work that was merged but not safely applied to production because production already owned version 0313.
- Treat migrations as prod-bound: a migration PR is not Done until prod Supabase schema/ledger evidence is captured.
- **Before claiming a numeric prefix, add a row to the reservation table below in the same PR.** The 2026-06-01 three-way `0327` collision (#971/#1038/#1047) happened because parallel sessions skipped this step.

## In-flight migration reservations (0327–0331) — recorded 2026-06-01

`main` HEAD is **0326** (`0326_scrum1649_deduct_org_credit_idempotency.sql`); the next free prefix is `0327`. Canonical assignment for the currently-open migration PRs:

| Prefix | PR | Story | File | Status |
|---|---|---|---|---|
| `0327` | #1047 | SCRUM-2225 | `0327_scrum2225_free_tier_quota.sql` | **keep** — actively soaking on its isolated project; do not renumber |
| `0328` | #971 | SCRUM-2045 | `0328_org_integrations_suborg_inheritance.sql` | renumber `0327→0328` |
| `0329` | #1038 | SCRUM-1611 | `0329_member_integrations_credential_providers.sql` | renumber `0327→0329` |
| `0330` | #1022 | SCRUM-2203 | `0330_scrum2203_unembedded_records_query_perf.sql` | renumbered ✓ (head `2a8d1b1c`) |
| `0331` | #1031 | SCRUM-1847/1869 | `0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql` | renumbered ✓ (head `431ddbff`) |

- **Merge order must follow prefix order** (`0327→0331`): migrations apply monotonically, so merging a higher prefix before a lower one strands the lower one as out-of-order.
- Each of these soaks on its **own dedicated isolated Supabase project**, never shared staging — `main` is at `0326`, so applying any unmerged prefix to shared staging would gap the ledger and contaminate every parallel soak.
- Remove a row once its PR merges to `main` and gets a permanent `## Recent migrations` entry below.

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
