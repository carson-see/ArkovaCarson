# Active Migration Notes

This directory now starts with the Path C baseline, `00000000000000_baseline_at_main_HEAD.sql`.

- Do not split the baseline away from `docs/migrations-archive/`; the baseline and archive are one atomic migration-history rewrite for SCRUM-1668.
- Do not edit an already-merged migration. Add a new forward migration with the next available numeric prefix.
- Treat migrations as prod-bound: a migration PR is not Done until prod Supabase schema/ledger evidence is captured.

## Recent migrations (PR #788)

- **0313_fix_anchors_rls_statement_timeout.sql** (renamed from 0309/0310 to resolve prefix collisions with merged migrations): Consolidated three separate `anchors` SELECT RLS policies into one with scalar subquery wrappers for InitPlan evaluation. Same pattern applied to `attestations` (5 branches including `status='ACTIVE'`).
- **0308_seed_arkova_org_credits.sql**: Seeds `org_credits` for Arkova prod org with `EXISTS` guard for idempotency.

## Numbering note (PR #810)

- **0311 and 0312 are intentionally absent in this worktree.** Do not backfill
  those prefixes by renaming 0313; the gap avoids collisions with concurrent
  migration branches and preserves the reviewed 0313 identifier.

_Rollback rehearsed: 2026-05-16 on staging (ujtlwnoqfhtitcmsnrpq). Forward re-applied clean._
