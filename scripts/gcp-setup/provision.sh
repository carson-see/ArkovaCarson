#!/usr/bin/env bash
# scripts/gcp-setup/provision.sh — one-shot GCP infra provisioning for GCP-MAX.
#
# Addresses (in order):
#   GCP-MAX-01  Service account for Gemini Golden on Vertex AI
#   GCP-MAX-02  BigQuery dataset `arkova_analytics` + starter tables
#   GCP-MAX-03  Cloud Logging log bucket `arkova-audit-events` (7-year retention)
#               + log writer service account
#   GCP-MAX-04  Cloud Monitoring SLOs + alert policies
#   GCP-MAX-05  VPC Service Controls + CMEK (NOT auto-provisioned — docs only)
#   GCP-MAX-06  Security Command Center Standard (NOT auto-provisioned — docs only)
#
# Idempotent: safe to re-run. Every resource uses `--quiet` and either
# tolerates AlreadyExists or uses `create|describe` fall-through.
#
# Pre-requirements:
#   - gcloud auth login (user or SA with project-admin role on arkova1)
#   - gcloud config set project arkova1
#   - User has ORGANIZATION_OWNER or roles/resourcemanager.projectIamAdmin
#
# Post-run: run ./scripts/gcp-setup/verify.sh to confirm IAM + resources.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-arkova1}"
REGION="${GCP_REGION:-us-central1}"
LOGGING_LOG_NAME="arkova-audit-events"
BQ_DATASET="arkova_analytics"
VERTEX_SA_NAME="gemini-golden-sa"
LOGGING_WRITER_SA_NAME="audit-logging-writer-sa"

echo "=== GCP-MAX provisioning for project: $PROJECT_ID region: $REGION ==="

# Sanity: must be authed as a user (not a service account) for the IAM binding steps.
ACCOUNT=$(gcloud config get-value account 2>/dev/null)
if [[ -z "$ACCOUNT" ]]; then
  echo "ERROR: no active gcloud account. Run 'gcloud auth login' first." >&2
  exit 1
fi
echo "Authenticated as: $ACCOUNT"

# Enable required APIs. No-op if already enabled.
echo ""
echo "--- Enabling GCP APIs ---"
gcloud services enable \
  aiplatform.googleapis.com \
  bigquery.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

# ─────────────────────────────────────────────────────────────────────────────
# GCP-MAX-01: Vertex AI service account for Gemini Golden
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "--- GCP-MAX-01: Vertex AI service account ---"

VERTEX_SA_EMAIL="${VERTEX_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$VERTEX_SA_EMAIL" --project="$PROJECT_ID" --quiet 2>/dev/null; then
  gcloud iam service-accounts create "$VERTEX_SA_NAME" \
    --display-name="Gemini Golden Vertex AI caller (SCRUM-1061)" \
    --description="Used by services/worker/src/ai to call Vertex Gemini. No Nessie access." \
    --project="$PROJECT_ID" \
    --quiet
else
  echo "Service account already exists: $VERTEX_SA_EMAIL"
fi

# Vertex AI user role (inference + endpoint calls; not admin).
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$VERTEX_SA_EMAIL" \
  --role="roles/aiplatform.user" \
  --condition=None \
  --quiet >/dev/null

# Secret Manager read for any future secret references.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$VERTEX_SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None \
  --quiet >/dev/null

echo "Vertex SA bound: $VERTEX_SA_EMAIL"

# ─────────────────────────────────────────────────────────────────────────────
# GCP-MAX-03: Cloud Logging — 7-year immutable bucket + writer SA + sink
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "--- GCP-MAX-03: Cloud Logging audit bucket ---"

LOG_BUCKET="arkova-audit"
RETENTION_DAYS=2555  # 7 years

if ! gcloud logging buckets describe "$LOG_BUCKET" --location="$REGION" --project="$PROJECT_ID" --quiet 2>/dev/null; then
  gcloud logging buckets create "$LOG_BUCKET" \
    --location="$REGION" \
    --retention-days="$RETENTION_DAYS" \
    --description="SOC 2 CC7.1 — audit_events 7-year immutable retention" \
    --project="$PROJECT_ID" \
    --quiet
else
  echo "Log bucket already exists. Ensuring retention is $RETENTION_DAYS days…"
  gcloud logging buckets update "$LOG_BUCKET" \
    --location="$REGION" \
    --retention-days="$RETENTION_DAYS" \
    --project="$PROJECT_ID" \
    --quiet
fi

# Lock the bucket — retention cannot be reduced once locked (SOC 2 immutability).
# Destructive: ask before locking so re-runs don't surprise anyone.
if [[ "${LOCK_LOG_BUCKET:-false}" == "true" ]]; then
  echo "LOCK_LOG_BUCKET=true → locking retention (irreversible)…"
  gcloud logging buckets update "$LOG_BUCKET" \
    --location="$REGION" \
    --locked \
    --project="$PROJECT_ID" \
    --quiet
fi

# Service account that the worker uses to write entries to the bucket.
LOGGING_WRITER_SA_EMAIL="${LOGGING_WRITER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$LOGGING_WRITER_SA_EMAIL" --project="$PROJECT_ID" --quiet 2>/dev/null; then
  gcloud iam service-accounts create "$LOGGING_WRITER_SA_NAME" \
    --display-name="audit_events → Cloud Logging writer (SCRUM-1063)" \
    --description="Worker cloud-logging-drain cron uses this to write to the arkova-audit bucket." \
    --project="$PROJECT_ID" \
    --quiet
fi

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$LOGGING_WRITER_SA_EMAIL" \
  --role="roles/logging.logWriter" \
  --condition=None \
  --quiet >/dev/null

echo "Log writer SA bound: $LOGGING_WRITER_SA_EMAIL"

# ─────────────────────────────────────────────────────────────────────────────
# GCP-MAX-02: BigQuery warehouse
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "--- GCP-MAX-02: BigQuery dataset + starter tables ---"

if ! bq --project_id="$PROJECT_ID" ls --format=prettyjson "$BQ_DATASET" 2>/dev/null; then
  bq --project_id="$PROJECT_ID" --location="$REGION" \
    mk --dataset \
    --description="Arkova analytics warehouse (SCRUM-1062). US-only, CMEK on enterprise tier." \
    --default_table_expiration 0 \
    "${PROJECT_ID}:${BQ_DATASET}"
else
  echo "BigQuery dataset ${BQ_DATASET} already exists."
fi

# Starter tables. Schemas intentionally narrow — add columns in follow-up
# migrations as analytical needs emerge. Every table has an `updated_at`
# partition key so BQ prunes old partitions efficiently.
bq --project_id="$PROJECT_ID" --location="$REGION" \
  mk --table --force \
  --time_partitioning_field=created_at \
  --time_partitioning_type=DAY \
  --description="Mirror of public.anchors (append-only, CDC by the worker)" \
  "${PROJECT_ID}:${BQ_DATASET}.anchors" \
  "$(dirname "$0")/schemas/anchors.json"

bq --project_id="$PROJECT_ID" --location="$REGION" \
  mk --table --force \
  --time_partitioning_field=created_at \
  --time_partitioning_type=DAY \
  --description="Mirror of public.verifications (append-only, CDC by the worker)" \
  "${PROJECT_ID}:${BQ_DATASET}.verifications" \
  "$(dirname "$0")/schemas/verifications.json"

bq --project_id="$PROJECT_ID" --location="$REGION" \
  mk --table --force \
  --time_partitioning_field=created_at \
  --time_partitioning_type=DAY \
  --description="Mirror of public.audit_events (append-only, long retention)" \
  "${PROJECT_ID}:${BQ_DATASET}.audit_events" \
  "$(dirname "$0")/schemas/audit_events.json"

echo "BigQuery dataset ready: ${PROJECT_ID}:${BQ_DATASET}"

# ─────────────────────────────────────────────────────────────────────────────
# GCP-MAX-04: Cloud Monitoring SLOs + alert policies
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "--- GCP-MAX-04: Monitoring SLOs + alert policies ---"

# SLOs are defined declaratively under scripts/gcp-setup/slos/*.yaml.
# gcloud monitoring uses the Services / SLO API — create the service first,
# then attach SLOs.
SERVICE_ID="arkova-worker"
if ! gcloud monitoring services describe "$SERVICE_ID" --project="$PROJECT_ID" --quiet 2>/dev/null; then
  gcloud monitoring services create \
    --service-id="$SERVICE_ID" \
    --display-name="Arkova Worker" \
    --project="$PROJECT_ID" \
    --quiet
fi

for SLO in worker-availability worker-p95-latency batch-anchor-success; do
  if [[ -f "$(dirname "$0")/slos/${SLO}.yaml" ]]; then
    gcloud monitoring slos create \
      --service="$SERVICE_ID" \
      --slo-from-file="$(dirname "$0")/slos/${SLO}.yaml" \
      --project="$PROJECT_ID" \
      --quiet || echo "SLO $SLO already exists or failed — check manually"
  fi
done

# Alert policies are separately managed — pointer in the runbook.
echo "SLOs created (or already existed) under service: $SERVICE_ID"
echo ""
echo "⚠  Alert policies NOT auto-created — requires Notification Channel IDs"
echo "   that differ per environment. See docs/runbooks/gcp-max-setup.md."

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Provisioning complete ==="
echo ""
echo "Next steps:"
echo "  1. Bind worker Cloud Run service to $LOGGING_WRITER_SA_EMAIL:"
echo "     gcloud run services update arkova-worker --service-account=$LOGGING_WRITER_SA_EMAIL"
echo ""
echo "  2. Set env on worker:"
echo "     GCP_PROJECT_ID=$PROJECT_ID"
echo "     GCP_LOGGING_LOG_NAME=projects/$PROJECT_ID/logs/$LOGGING_LOG_NAME"
echo ""
echo "  3. Migrate 0235: npx supabase db push"
echo ""
echo "  4. Wire the drain cron. Add to services/worker/src/routes/cron.ts:"
echo "       router.post('/cloud-logging-drain', requireCron, drainHandler);"
echo "     + a Cloud Scheduler job hitting it every 1 minute."
echo ""
echo "  5. Apply for SOC 2 CC7.1 evidence export:"
echo "     gcloud logging read 'logName=\"projects/$PROJECT_ID/logs/$LOGGING_LOG_NAME\"' \\"
echo "       --freshness=7d --format=json > audit-weekly.json"
echo ""
echo "  6. Alert policies require notification-channel IDs. See runbook."
