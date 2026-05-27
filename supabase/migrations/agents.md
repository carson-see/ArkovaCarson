# Active Migration Notes

This directory now starts with the Path C baseline, `00000000000000_baseline_at_main_HEAD.sql`.

- Do not split the baseline away from `docs/migrations-archive/`; the baseline and archive are one atomic migration-history rewrite for SCRUM-1668.
- Do not edit an already-merged migration. Add a new forward migration with the next available numeric prefix. The only exception in this directory is the dated PR #841 remediation, which renumbers schema work that was merged but not safely applied to production because production already owned version 0313.
- Treat migrations as prod-bound: a migration PR is not Done until prod Supabase schema/ledger evidence is captured.

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
