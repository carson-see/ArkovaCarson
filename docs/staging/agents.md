# docs/staging/agents.md

Staging rig documentation and soak evidence artifacts. Required by CLAUDE.md 1.11/1.12.

## Files

- **`README.md`** — staging rig setup guide: Supabase preview branch, Cloud Run service, cost estimates.
- **`PR_TEMPLATE.md`** — risk-tiered staging evidence PR body template with tier matrix fields.
- **`train-c-soak-readiness-*.md`** — non-authoritative release-prep notes that freeze candidate heads, tier assumptions, merge order, and start gates before a real RC manifest exists. These files do not approve a soak or replace `rc-manifests/rc-*.json`.
- **`train-c-environment-request-*.md`** — approval-request notes for Train C environment isolation. These files do not create services, apply Scheduler jobs, change Supabase, deploy code, or start soak.
- **`train-c-*-lane-packet-*.md`** — lane-specific start packets with exact candidate heads, expected tag URL, deploy/smoke commands, start gates, and live attempt log.
- **`PATH_C_*.md`** — path-C cutover verification records.
- **`429-limiter-map-s33.md`** (L2-S0, Sprint 3.3) — the five-bucket 429 attribution map: every 429 emitter in the worker with in-tree-verified `file:line`, the two dead-code claims (perOrgRateLimit unmounted; x402 payer limiter orphan), the upstream-Vertex-429-misclassified-as-`provider_error` bug, the header+log-join attribution spec, and the exit-criterion-3a bucket list (CTO memo R2). Its `Claims ledger` table is machine-read by `scripts/ci/check-429-limiter-map.test.ts`, which fails CI when the tree drifts from the map.
- **`soak-pr*.json`** — machine-readable soak evidence for specific PRs.
- **`staging-only-rpcs.sql`** — staging-specific RPCs (not applied to prod).
- **`staging_lease.sql`** — lease table DDL for the staging environment.
- **`evidence/`** — subdirectory of soak evidence screenshots and logs.

## Conventions

- T0 docs/tests/CI/tooling-only PRs need CI only; T1/T2/T3 prod-bound PRs must include a `## Staging Soak Evidence` block with the exact fields in `PR_TEMPLATE.md`.
- Soak JSON files are append-only evidence; do not modify after creation.
- These are engineering artifacts, not documentation (Confluence is the doc source of truth).
