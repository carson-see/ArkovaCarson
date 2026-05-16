# docs/staging/agents.md

Staging rig documentation and soak evidence artifacts. Required by CLAUDE.md 1.11/1.12.

## Files
- **`README.md`** — staging rig setup guide: Supabase preview branch, Cloud Run service, cost estimates.
- **`PR_TEMPLATE.md`** — staging soak evidence PR body template with tier matrix fields.
- **`PATH_C_*.md`** — path-C cutover verification records.
- **`soak-pr*.json`** — machine-readable soak evidence for specific PRs.
- **`staging-only-rpcs.sql`** — staging-specific RPCs (not applied to prod).
- **`staging_lease.sql`** — lease table DDL for the staging environment.
- **`evidence/`** — subdirectory of soak evidence screenshots and logs.

## Conventions
- Every prod-bound PR must include a `## Staging Soak Evidence` block with `Tier: T[123]`.
- Soak JSON files are append-only evidence; do not modify after creation.
- These are engineering artifacts, not documentation (Confluence is the doc source of truth).
