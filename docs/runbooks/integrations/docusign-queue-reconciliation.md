# Runbook — DocuSign Queue Reconciliation (DS-05 / SCRUM-2365)

> Internal engineering note. Canonical operator doc lives in Confluence (space A).
> This file is the in-repo quick reference for the DS-05 queue-drift cron.

## What it does

`reconcileDocusignQueueDrift` detects completed DocuSign envelopes that are
**missing from the connector-artifact queue** (`connector_artifact`, mig 0343)
and re-materializes them idempotently. It is the queue counterpart to the
SCRUM-2042 webhook-delivery reconciliation:

| Job | Reconciles | Source of truth | Gap table / action |
|---|---|---|---|
| `docusign-reconciliation.ts` (SCRUM-2042) | webhook **delivery** | `docusign_webhook_nonces` | inserts `docusign_reconciliation_gaps` |
| `docusign-queue-reconciliation.ts` (DS-05) | **queue** materialization | `connector_artifact` | re-submits producer job + `queue_drift_detected` audit |

Per active org/member DocuSign integration it:

1. lists completed envelopes in the last 24h (DocuSign Envelopes API),
2. diffs against `connector_artifact.external_ref` for that org+`source='docusign'`,
3. for each missing envelope: writes a bounded `integration_events`
   (`event_type='queue_drift_detected'`) row, fires a Sentry drift alert, and
   re-submits the audited `docusign.envelope_completed` producer job.

Re-materialization is **idempotent by construction**: the producer runs the 0343
`enqueue_connector_artifact` RPC, whose unique dedupe key
`(org_id, source, external_ref, COALESCE(external_revision,''))` makes a re-drive
of an already-queued envelope a no-op.

## §1.6A byte safety

This job **never** handles document bytes. Detection is metadata-only (envelope
ids + status). Materialization is delegated to the single audited producer path
(`fetch → SHA-256 → discard → enqueue_connector_artifact`). No fingerprint or raw
bytes ever cross the reconciliation boundary — audit rows and Sentry extras carry
ids only.

## Queue routing (member vs org)

`listActiveIntegrations` tags each integration `scope: 'org' | 'member'` and
carries `owner_user_id` for member (personal) connections. Member-owned drift
re-materializes into the owning user's personal queue (the producer stamps
`queue_scope` + `owner_user_id` into `connector_artifact.metadata`); org drift
routes to the org queue. Org policy always wins (mirrors the webhook
`findIntegration` precedence).

## Feature flag

`ENABLE_DOCUSIGN_QUEUE_RECONCILIATION` — **default OFF in prod**. When off, the
cron route returns `{ skipped: true }`. The re-materialization goes through the
DS-03 producer, which is itself gated by `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`
(also default off until the QUEUE-06/QUEUE-08 drain ships). Enable order:
`ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true` first (so re-materialized rows drain),
then `ENABLE_DOCUSIGN_QUEUE_RECONCILIATION=true`.

## Scheduler

Cron route: `POST /jobs/docusign-queue-reconciliation`. Cloud Scheduler → HTTP,
daily `0 7 * * *` (in-process node-cron does not fire under Cloud Run CPU
throttling — always drive via Scheduler). Bind alongside the existing DocuSign
crons in `scripts/gcp-setup/cloud-scheduler.sh`.

## Recovery — completed documents are missing from the queue

1. Confirm the flags: `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true` and
   `ENABLE_DOCUSIGN_QUEUE_RECONCILIATION=true` (assert against prod env, don't
   infer from code defaults).
2. Trigger a run: `POST /jobs/docusign-queue-reconciliation`. Response JSON
   reports `drift_detected`, `materialized`, `alerts_fired`, and per-integration
   `errors`.
3. Verify: the re-submitted `docusign.envelope_completed` jobs run on the next
   envelope-completed drain and materialize `connector_artifact` rows. Re-running
   the reconciliation is safe (0343 dedupe) — `drift_detected` should fall to 0
   once the producer has drained.
4. Watch Sentry for the `docusign-queue-reconciliation` monitor check-in and the
   per-drift warning alerts.

## Rollback

Set `ENABLE_DOCUSIGN_QUEUE_RECONCILIATION=false` (route becomes a `skipped`
no-op) and, if needed, remove the Cloud Scheduler binding. No schema/migration
is owned by DS-05, so there is nothing to reverse in the database — the job only
reads DocuSign + `connector_artifact` and writes audit rows + re-submits producer
jobs. Rolling back does not delete any `connector_artifact` rows already
materialized (they are legitimate, deduped queue entries).

## Related

- DS-03 producer: `services/worker/src/jobs/docusign-envelope-completed.ts`
- DS-04 member materializer: same file + `docusign-connection-resolver.ts`
- Queue schema: `supabase/migrations/0343_scrum2348_connector_artifact_queue_schema.sql`
- SCRUM-2042 webhook reconciliation: `services/worker/src/jobs/docusign-reconciliation.ts`
