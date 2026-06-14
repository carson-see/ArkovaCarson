# docs/staging/agents.md

Staging rig documentation and soak evidence artifacts. Required by CLAUDE.md 1.11/1.12.

## Files

- **`README.md`** — staging rig setup guide: Supabase preview branch, Cloud Run service, cost estimates.
- **`PR_TEMPLATE.md`** — risk-tiered staging evidence PR body template with tier matrix fields.
- **`PATH_C_*.md`** — path-C cutover verification records.
- **`t2-t3-rollout-status-*.md`** — current rollout coordination snapshots; these are not soak evidence.
- **`soak-pr*.json`** — machine-readable soak evidence for specific PRs.
- **`staging-only-rpcs.sql`** — staging-specific RPCs (not applied to prod).
- **`staging_lease.sql`** — lease table DDL for the staging environment.
- **`evidence/`** — subdirectory of soak evidence screenshots and logs.

## Conventions

- T0 docs/tests/CI/tooling-only PRs need CI only; T1/T2/T3 prod-bound PRs must include a `## Staging Soak Evidence` block with the exact fields in `PR_TEMPLATE.md`.
- Soak JSON files are append-only evidence; do not modify after creation.
- These are engineering artifacts, not documentation (Confluence is the doc source of truth).

## Current Release Evidence Note

- Current Train A/B final evidence lives under `/Volumes/Extreme/Arkova/release-evidence/train-a/` and `/Volumes/Extreme/Arkova/release-evidence/train-b/`; use the `20260611T141256Z` final JSON files for the completed 48h cron soaks.
- Current active Train C merge-grade candidate is #1154 main-sync repair under `/Volumes/Extreme/Arkova/release-evidence/train-c/code/20260614T-main-sync-repair/`; active CTDL/OPS screens are `train-c-code-main-sync-t3-ctdl-soak-20260614T172004Z` and `train-c-code-main-sync-t3-ops-soak-20260614T172004Z`, with earliest valid completion `2026-06-16T17:22:34Z`.
- Discarded Train A/B `20260611T121541Z` runs and older Train C code-clean, mixed/quality-low-rate, and CE attempts are diagnostic-only/non-merge-grade unless a later release owner explicitly promotes a fresh counted soak.
