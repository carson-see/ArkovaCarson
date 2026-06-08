# docs/staging/agents.md

Staging rig documentation and soak evidence artifacts. Required by CLAUDE.md 1.11/1.12.

## Files

- **`README.md`** — staging rig setup guide: Supabase preview branch, Cloud Run service, cost estimates.
- **`PR_TEMPLATE.md`** — risk-tiered staging evidence PR body template with tier matrix fields.
- **`PATH_C_*.md`** — path-C cutover verification records.
- **`soak-pr*.json`** — machine-readable soak evidence for specific PRs.
- **`t2-t3-rollout-status-*.md`** — rollout coordination snapshots; not soak evidence and not a Confluence/Jira replacement.
- **`staging-only-rpcs.sql`** — staging-specific RPCs (not applied to prod).
- **`staging_lease.sql`** — lease table DDL for the staging environment.
- **`evidence/`** — subdirectory of soak evidence screenshots and logs.

## Conventions

- T0 docs/tests/CI/tooling-only PRs need CI only; T1/T2/T3 prod-bound PRs must include a `## Staging Soak Evidence` block with the exact fields in `PR_TEMPLATE.md`.
- Soak JSON files are append-only evidence; do not modify after creation.
- These are engineering artifacts, not documentation (Confluence is the doc source of truth).
