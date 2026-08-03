#!/usr/bin/env bash
set -euo pipefail

# Cloud Scheduler jobs for Arkova Worker cron endpoints.
#
# Do not run this script casually: it creates GCP Scheduler jobs.
# Idempotent — re-runs `update` an existing job rather than fail on duplicate.

PROJECT_ID="${PROJECT_ID:-arkova1}"
REGION="${REGION:-us-central1}"
WORKER_URL="${WORKER_URL:-https://arkova-worker-270018525501.us-central1.run.app}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-$WORKER_URL}"
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_SERVICE_ACCOUNT:-270018525501-compute@developer.gserviceaccount.com}"
TIME_ZONE="${TIME_ZONE:-UTC}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-600s}"

# Format: NAME|SCHEDULE|ENDPOINT_PATH|RETRY
# RETRY is either NO_RETRY or "MIN_BACKOFF,MAX_BACKOFF,MAX_RETRY_ATTEMPTS"
JOBS=(
  "monthly-allocation-rollover|0 0 1 * *|/jobs/monthly-allocation-rollover|NO_RETRY"
  "grace-expiry-sweep|*/15 * * * *|/jobs/grace-expiry-sweep|NO_RETRY"
  # SCRUM-1308 (R0-8-FU2): db-health-monitor every 5 min. Endpoint at
  # services/worker/src/routes/cron.ts:1339. Emits Sentry events on pg_cron
  # failures, dead-tuple bloat, and smoke fail-streaks. See
  # docs/sentry/r0-8-drift-telemetry.md + infra/sentry/alert-rules.json
  # for the alert rules to create in the Sentry UI (admin step — alert
  # creation is not script-automatable). Tight retry policy so a transient
  # error doesn't suppress the next 5-min slot.
  "db-health-monitor|*/5 * * * *|/jobs/db-health|30s,120s,2"
  # SCRUM-1723: BigQuery export — incremental sync every 5 min for the three
  # append-only tables (anchors, verifications, audit_events). Endpoint at
  # services/worker/src/routes/cron.ts. Watermark-driven; failure does not
  # advance, so the next slot retries the same window. Tight retry — a
  # transient BQ outage should not stack delays beyond a few minutes.
  "bq-export-incremental|*/5 * * * *|/jobs/bq-export-incremental|30s,120s,2"
  # SCRUM-1724: BigQuery export — daily snapshot of organizations + api_keys
  # at 02:00 UTC. Idempotent partition replace (DELETE WHERE snapshot_date=
  # today, then INSERT). NO_RETRY because re-running same day repeats the
  # delete-then-insert and double-pays the BQ DML cost; manual re-trigger
  # via /jobs/bq-export-snapshot if a run fails.
  "bq-export-snapshot|0 2 * * *|/jobs/bq-export-snapshot|NO_RETRY"
  # SCRUM-2040 (SOC 2 CC7.4): sweep expired webhook nonces daily at 04:00 UTC.
  # 14-day retention. Partial failures return 500 to trigger retry; idempotent.
  "nonce-sweep|0 4 * * *|/jobs/nonce-sweep|30s,120s,2"
  # SCRUM-2041 (SOC 2 CC7.1): connector health check every 15 min.
  # Evaluates all org integrations, fires Sentry alerts on state transitions.
  "connector-health-check|*/15 * * * *|/jobs/connector-health-check|30s,120s,2"
  # SCRUM-2042 (SOC 2 CC7.2): DocuSign retry exhaustion reconciliation daily
  # at 06:00 UTC. Polls Envelopes API, diffs against webhook nonces, inserts
  # gap rows, fires Sentry per gap. Also keeps OAuth tokens alive (30-day expiry).
  "docusign-reconciliation|0 6 * * *|/jobs/docusign-reconciliation|30s,120s,2"
  # SCRUM-2099 (DS-FAIL-01): DocuSign Connect Failures API poller hourly.
  # Polls failed delivery attempts from DocuSign and dedups into the existing
  # reconciliation gaps table so actionable webhook gaps surface within ~1h.
  "docusign-connect-failures-poll|0 * * * *|/jobs/docusign-connect-failures-poll|30s,120s,2"
  # SCRUM-2098 (DS-LISTEN-01): DocuSign Connect listener drift check hourly.
  # Detection only: reads DocuSign Connect config and emits Sentry warnings
  # for missing/disabled/HMAC/event/payload-format drift; no DocuSign writes.
  "docusign-listener-drift|15 * * * *|/jobs/docusign-listener-drift|30s,120s,2"
  # SCRUM-2902 (R-1 FATAL): Credential Engine API key expiry alarm, daily 08:00 UTC.
  # Fail-LOUD: fires escalating Sentry events at T-30/T-14/T-7 + continuously after
  # expiry, and EVERY run when CE_API_KEY_EXPIRES_AT is unset/sentinel. NO_RETRY —
  # the job is idempotent and re-fires daily anyway; a retry would only double-page.
  "ce-key-expiry-check|0 8 * * *|/jobs/ce-key-expiry-check|NO_RETRY"
  # SCRUM-2913 (L3-A6 follow-up): CE Registry drift reconciliation, daily
  # 05:00 UTC. Read-only read-back — re-reads every anchored CE Registry CTID
  # from the public registry and records where it no longer matches what was
  # anchored (services/worker/src/jobs/ce-registry-drift.ts). No-ops
  # (skipped:true) until ENABLE_CE_REGISTRY_DRIFT_CHECK=true — the route
  # shipped flag-gated OFF on purpose (new outbound traffic to a partner's
  # infra), but had NO Cloud Scheduler declaration anywhere, so there was no
  # way to ever invoke it even after deliberately enabling the flag. Adding
  # the declaration here does not itself flip the flag or change any runtime
  # behavior while it stays default-off; it only means the "turn it on
  # deliberately" step is a one-line env var once an operator runs this
  # script. Retried (not NO_RETRY): the route 500s specifically when the
  # anchor load itself failed, precisely so a transient failure is retried
  # rather than recorded as a false "nothing to reconcile".
  "ce-registry-drift-check|0 5 * * *|/jobs/ce-registry-drift-check|30s,120s,2"
  # QUEUE-06 (SCRUM-2352): connector_artifact drain consumer every 5 min.
  # Drains pending|queued rows → materialize PENDING anchor → charge at SECURING
  # (debit_and_enqueue_anchor) → batch-anchor. Endpoint at
  # services/worker/src/routes/cron.ts. No-ops (skipped:true) until
  # ENABLE_CONNECTOR_ARTIFACT_DRAIN=true. Idempotent (compare-and-set claim), so
  # retries never double-anchor; a non-200 (e.g. cycle select failure) retries.
  "drain-connector-artifacts|*/5 * * * *|/jobs/drain-connector-artifacts|30s,120s,2"
  # SCRUM-2234: stuck-anchor monitor, hourly. Reads the oldest non-deleted
  # PENDING anchor's created_at and pages via Sentry past
  # STUCK_ANCHOR_ALERT_HOURS (default 24h). This is the dead-man for the exact
  # 2026-06-01 shape, where the daily-anchor-flush 401 blackout ran ~6 weeks
  # undetected because nothing alerted on the queue failing to drain. The route
  # shipped in services/worker/src/routes/cron.ts but the Scheduler binding was
  # never created in prod — added here 2026-08-01 after a three-way scheduler
  # reconciliation found it missing. A DETECTED stall returns 200 (a correct
  # finding must not be retried); only a broken DB probe 500s, hence the retry.
  "check-stuck-anchors|0 * * * *|/jobs/check-stuck-anchors|30s,120s,2"
  # SCRUM-1130: durable 24-hour per-organization queue scheduler. Claims due orgs
  # via the claim_due_org_queue_runs RPC (migration 0294) and runs
  # processBatchAnchors({ force: true, orgId }) for each. This is the ONLY driver
  # for the "Add to Queue" / scheduled-anchoring customer path — the global
  # batch-anchors job does not cover it, because a handful of per-org PENDING
  # anchors never crosses Trigger A (>=10,000) or Trigger B (>=3,000 AND >=3h).
  #
  # This job was MISSING from prod entirely until 2026-08-01 while every isolated
  # soak rig had one — which is exactly the drift this script exists to prevent.
  # Two customer anchors sat PENDING for three days as a result. Keep it here.
  #
  # Cadence */15 (not the rigs' */5) is deliberate:
  #   * it matches the RPC's own 15-minute stale-lock reclaim window, so a tick
  #     that dies mid-claim has its orgs reclaimable on the very next tick;
  #   * the contract it serves is a 24-HOUR per-org timer, so sub-15-minute
  #     granularity buys nothing at prod scale (~10 orgs, claim limit 25/tick —
  #     one tick covers the whole tenant base);
  #   * every tick re-probes a 2.97M-row anchors table; 96/day beats 288/day.
  #
  # NO_RETRY is deliberate too: on a 500 the claim rows may already be committed
  # and locked, so a Cloud Scheduler retry would claim nothing and report a
  # misleading success. The 15-minute lock expiry IS the recovery path.
  "org-queue-scheduler|*/15 * * * *|/jobs/org-queue-scheduler|NO_RETRY"
  # SCRUM-2903 (GD-PROD): Drive file-changed producer job every 5 min. Drains
  # the google_drive.file_changed queue that drive-changes-runner.ts writes on
  # a matched change → fetch bytes → SHA-256 in memory → discard (§1.6A) →
  # enqueue_connector_artifact, for drain-connector-artifacts above to anchor.
  # Endpoint at services/worker/src/routes/cron.ts. No-ops (per-job disabled
  # sentinel, no hash/enqueue) until ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true.
  # Idempotent (0343 RPC dedupes on org/source/file/revision).
  "drive-file-changed|*/5 * * * *|/jobs/drive-file-changed|30s,120s,2"
)
# SCRUM-1727 (one-shot historical backfill) is INTENTIONALLY NOT in JOBS.
# It's a manual operator endpoint at /jobs/bq-export-backfill?table=<name>.
# Run once per backfillable table; the next 5-min incremental cron picks
# up new rows from the watermark the backfill leaves behind.

for JOB in "${JOBS[@]}"; do
  IFS='|' read -r NAME SCHEDULE ENDPOINT_PATH RETRY <<< "$JOB"

  # Idempotent — if the job already exists, update; else create.
  if gcloud scheduler jobs describe "$NAME" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
    ACTION=update
  else
    ACTION=create
  fi

  CMD=(
    gcloud scheduler jobs "$ACTION" http "$NAME"
    --project="$PROJECT_ID"
    --location="$REGION"
    --schedule="$SCHEDULE"
    --time-zone="$TIME_ZONE"
    --uri="${WORKER_URL}${ENDPOINT_PATH}"
    --http-method=POST
    --oidc-service-account-email="$SCHEDULER_SERVICE_ACCOUNT"
    --oidc-token-audience="$OIDC_AUDIENCE"
    --attempt-deadline="$ATTEMPT_DEADLINE"
  )

  if [[ "$RETRY" != "NO_RETRY" ]]; then
    IFS=',' read -r MIN_BACKOFF MAX_BACKOFF MAX_RETRY <<< "$RETRY"
    CMD+=(
      --min-backoff="$MIN_BACKOFF"
      --max-backoff="$MAX_BACKOFF"
      --max-retry-attempts="$MAX_RETRY"
    )
  fi

  "${CMD[@]}"
done
