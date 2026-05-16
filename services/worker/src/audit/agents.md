# services/worker/src/audit/

Cloud Logging sink for piping Postgres `audit_events` rows to GCP Cloud Logging (SOC 2 CC7.1 compliance).

## Files

- **cloud-logging-sink.ts** — Drains `cloud_logging_queue` table to GCP Cloud Logging REST API. Deletes queue rows only on confirmed write. Requires `roles/logging.logWriter` on the Cloud Run service account.
- **cloud-logging-sink.test.ts** — Tests for the sink: batching, retry, confirmed-delete-only semantics.

## Rules

- Audit events are buffered in `cloud_logging_queue` (migration 0235) and drained on cron — never stream directly from Postgres.
- Queue rows are deleted only after Cloud Logging confirms the write. A transient failure must not drop events.
- No PII in log payloads beyond what `audit_events` already contains.
