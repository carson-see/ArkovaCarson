#!/usr/bin/env bash
set -euo pipefail

# Cloud Scheduler jobs for Arkova Worker cron endpoints.
#
# Do not run this script casually: it creates GCP Scheduler jobs.

PROJECT_ID="${PROJECT_ID:-arkova1}"
REGION="${REGION:-us-central1}"
WORKER_URL="${WORKER_URL:-https://arkova-worker-270018525501.us-central1.run.app}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-$WORKER_URL}"
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_SERVICE_ACCOUNT:-270018525501-compute@developer.gserviceaccount.com}"
TIME_ZONE="${TIME_ZONE:-UTC}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-600s}"

JOBS=(
  "recover-broadcasts|*/2 * * * *|/jobs/recover-broadcasts"
  "process-anchors|* * * * *|/jobs/process-anchors"
  "batch-anchors|*/10 * * * *|/jobs/batch-anchors"
  "check-confirmations|*/2 * * * *|/jobs/check-confirmations"
  "process-revocations|*/5 * * * *|/jobs/process-revocations"
  "webhook-retries|*/2 * * * *|/jobs/webhook-retries"
  "credit-expiry|0 0 1 * *|/jobs/credit-expiry"
  "cleanup-retention|0 2 * * *|/jobs/cleanup-retention"
  "detect-reorgs|*/10 * * * *|/jobs/detect-reorgs"
  "monitor-stuck-txs|*/10 * * * *|/jobs/monitor-stuck-txs"
  "rebroadcast-txs|0 */6 * * *|/jobs/rebroadcast-txs"
  "consolidate-utxos|0 4 * * *|/jobs/consolidate-utxos"
  "monitor-fees|*/10 * * * *|/jobs/monitor-fees"
  "monthly-allocation-rollover|0 0 1 * *|/jobs/monthly-allocation-rollover"
  "grace-expiry-sweep|*/15 * * * *|/jobs/grace-expiry-sweep"
)

for JOB in "${JOBS[@]}"; do
  IFS='|' read -r NAME SCHEDULE ENDPOINT_PATH <<< "$JOB"

  if gcloud scheduler jobs describe "$NAME" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    >/dev/null 2>&1; then
    GCLOUD_SCHEDULER_ACTION=(update http)
  else
    GCLOUD_SCHEDULER_ACTION=(create http)
  fi

  gcloud scheduler jobs "${GCLOUD_SCHEDULER_ACTION[@]}" "$NAME" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --schedule="$SCHEDULE" \
    --time-zone="$TIME_ZONE" \
    --uri="${WORKER_URL}${ENDPOINT_PATH}" \
    --http-method=POST \
    --oidc-service-account-email="$SCHEDULER_SERVICE_ACCOUNT" \
    --oidc-token-audience="$OIDC_AUDIENCE" \
    --attempt-deadline="$ATTEMPT_DEADLINE"
done
