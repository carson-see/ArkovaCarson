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
  "db-health-monitor|*/5 * * * *|/cron/db-health|30s,120s,2"
)

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
