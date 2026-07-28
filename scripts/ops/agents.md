# scripts/ops/agents.md

Operational scripts for database maintenance and production infrastructure.

## Files
- **`ensure-pipeline-dashboard-cache-cron.ts`** — ensures the `refresh-pipeline-dashboard-cache` pg_cron job exists with correct schedule (`*/2 * * * *`), support index, and stats function. Builds read-only evidence SQL for auditing.
- **`ensure-pipeline-dashboard-cache-cron.test.ts`** — colocated tests for the cron management script.
- **`webhook-delivery-health.sql` (WH-7, SCRUM-2899)** — read-only verification query for the webhook-delivery fix. Reports `webhook_delivery_logs` status buckets + `webhook_dead_letter_queue` counts by `failure_kind` per week, plus a single-number gauge (unresolved `log_write` DLQ rows in the last 7 days ≈ 0 when healthy). Run against prod before/after the flag flip to confirm the "fetch failed" silent-drop class is gone.
- **`materializer-preflight.ts` (SCRUM-2984, SCRUM-2917 prod-EXECUTE prereq)** — read-only preflight for the proof-materializer prod backfill (~2.96M-row `anchor_proofs` insert campaign). Reports the anchors-vs-proofs row gap (`pg_class.reltuples` planner estimate vs exact `anchor_proofs` count — never an exact `count(*)` on the hot `anchors` table, per R0-8/SCRUM-1254), table bloat (`pgstattuple_approx` when the extension is installed, else `pg_stat_user_tables` dead-tuple ratio), autovacuum staleness, and lock contention on `anchors`/`anchor_proofs` (flags the known SCRUM-3031 `batch_insert_anchors` wedge signature by name). Emits a `PASS`/`WARN` verdict per the thresholds defined in `docs/runbooks/ops/proof-materializer-execute.md` §2 and exits non-zero on `WARN` or any connectivity failure. Connects via the Supabase Management API's `/database/query/read-only` endpoint (project ref + access token via env/flags — never a raw Postgres connection string or an embedded credential), the same mechanism `scripts/ci/staging-honesty-preflight.ts` uses — deliberately not a new `pg` driver dependency. Never mutates; never invokes the materializer job itself.
- **`materializer-preflight.test.ts`** — colocated tests for the mapping/verdict logic, exercised against mocked query-result rows (no real Supabase call except a stubbed-`fetch` test of `queryReadOnly` itself).

## Conventions
- Scripts are idempotent and safe to re-run.
- Evidence queries return JSON for audit trail verification.
- Changes to cron schedules or indexes require staging soak (T2 minimum).
- Read-only preflight/reporting scripts (e.g. `materializer-preflight.ts`) reach Postgres only through the Supabase Management API's `/database/query/read-only` endpoint or existing RPCs — no raw `pg`/`postgres` driver dependency for one-off ops tooling; keeps DB access on the locked Supabase-only stack (CLAUDE.md §1.1).
