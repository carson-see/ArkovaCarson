# scripts/ops/agents.md

Operational scripts for database maintenance and production infrastructure.

## Files
- **`ensure-pipeline-dashboard-cache-cron.ts`** — ensures the `refresh-pipeline-dashboard-cache` pg_cron job exists with correct schedule (`*/2 * * * *`), support index, and stats function. Builds read-only evidence SQL for auditing.
- **`ensure-pipeline-dashboard-cache-cron.test.ts`** — colocated tests for the cron management script.
- **`webhook-delivery-health.sql` (WH-7, SCRUM-2899)** — read-only verification query for the webhook-delivery fix. Reports `webhook_delivery_logs` status buckets + `webhook_dead_letter_queue` counts by `failure_kind` per week, plus a single-number gauge (unresolved `log_write` DLQ rows in the last 7 days ≈ 0 when healthy). Run against prod before/after the flag flip to confirm the "fetch failed" silent-drop class is gone.

## Conventions
- Scripts are idempotent and safe to re-run.
- Evidence queries return JSON for audit trail verification.
- Changes to cron schedules or indexes require staging soak (T2 minimum).
