# Active Migration Notes

This directory now starts with the Path C baseline, `00000000000000_baseline_at_main_HEAD.sql`.

- Do not split the baseline away from `docs/migrations-archive/`; the baseline and archive are one atomic migration-history rewrite for SCRUM-1668.
- Do not edit an already-merged migration. Add a new forward migration with the next available numeric prefix.
- Treat migrations as prod-bound: a migration PR is not Done until prod Supabase schema/ledger evidence is captured.

## Recent migrations (PR #788)

- **0307_fix_anchors_rls_statement_timeout.sql**: Consolidated three separate `anchors` SELECT RLS policies into one with scalar subquery wrappers for InitPlan evaluation. Same pattern applied to `attestations` (5 branches including `status='ACTIVE'`).
- **0308_seed_arkova_org_credits.sql**: Seeds `org_credits` for Arkova prod org with `EXISTS` guard for idempotency.

_Rollback rehearsed: 2026-05-16 on staging (ujtlwnoqfhtitcmsnrpq). Forward re-applied clean._

## Recent migrations (PR #807)

- **0309_bump_cloud_logging_retry_counts_rpc.sql**: SECURITY DEFINER function `bump_cloud_logging_retry_counts(p_audit_ids text[], p_error_msg text)` — bulk retry-count bump replacing N read-modify-write round-trips. `SET search_path = public`. NOTIFY pgrst reload.
- **0310_external_document_versions.sql**: `external_document_versions` table (org-scoped, status check constraint, unique on org+file+fingerprint) + `version_reviews` table (reviewer decision log). RLS: service_role full, authenticated org-member SELECT, INSERT on reviews. Indexes on `(org_id, status)` and `(org_id, external_file_id)`.

_Rollback rehearsed: 2026-05-16 on staging (ujtlwnoqfhtitcmsnrpq). Both tables dropped + function dropped, then re-applied clean._
