# scripts/ops/agents.md

Operational scripts for database maintenance and production infrastructure.

## Files
- **`ensure-pipeline-dashboard-cache-cron.ts`** — ensures the `refresh-pipeline-dashboard-cache` pg_cron job exists with correct schedule (`*/2 * * * *`), support index, and stats function. Builds read-only evidence SQL for auditing.
- **`ensure-pipeline-dashboard-cache-cron.test.ts`** — colocated tests for the cron management script.

## Conventions
- Scripts are idempotent and safe to re-run.
- Evidence queries return JSON for audit trail verification.
- Changes to cron schedules or indexes require staging soak (T2 minimum).
