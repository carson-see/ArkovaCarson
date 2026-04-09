#!/usr/bin/env bash
# deploy-worker.sh — Safe Cloud Run deploy with env var preservation
#
# SCRUM-544: Prevents the #1 production hazard where `gcloud run deploy`
# resets BITCOIN_UTXO_PROVIDER to getblock (which fails because the
# bitcoin-rpc-url secret in GCP Secret Manager is empty).
#
# Usage:
#   ./scripts/deploy-worker.sh              # deploy from source
#   ./scripts/deploy-worker.sh --dry-run    # show what would happen
#   ./scripts/deploy-worker.sh --rollback   # roll back to previous revision
#
# Requirements:
#   - gcloud CLI authenticated with arkova1 project access
#   - Current directory must be the repo root (or services/worker/)

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────
PROJECT_ID="arkova1"
REGION="us-central1"
SERVICE_NAME="arkova-worker"
GCLOUD="/opt/homebrew/bin/gcloud"

# Critical env vars that MUST be preserved across deploys
CRITICAL_ENV_VARS=(
  "BITCOIN_UTXO_PROVIDER"
  "BITCOIN_NETWORK"
  "BITCOIN_FEE_STRATEGY"
  "KMS_PROVIDER"
  "GCP_KMS_KEY_RESOURCE_NAME"
  "BATCH_ANCHOR_MAX_SIZE"
  "ENABLE_PROD_NETWORK_ANCHORING"
  "AI_PROVIDER"
  "ENABLE_AI_EXTRACTION"
  "ENABLE_VERIFICATION_API"
  "NODE_ENV"
  "FRONTEND_URL"
  "CORS_ALLOWED_ORIGINS"
  "CRON_OIDC_AUDIENCE"
)

# Required values — deploy fails if these don't match
declare -A REQUIRED_VALUES=(
  ["BITCOIN_UTXO_PROVIDER"]="mempool"
  ["BITCOIN_NETWORK"]="mainnet"
  ["ENABLE_PROD_NETWORK_ANCHORING"]="true"
  ["KMS_PROVIDER"]="gcp"
  ["NODE_ENV"]="production"
)

DRY_RUN=false
ROLLBACK=false

# ─── Parse args ──────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --rollback) ROLLBACK=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--rollback]"
      echo ""
      echo "  --dry-run   Show what would happen without deploying"
      echo "  --rollback  Roll back to the previous revision"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ─── Helpers ─────────────────────────────────────────────────────────
info()  { echo -e "\033[0;36m[INFO]\033[0m  $*"; }
warn()  { echo -e "\033[0;33m[WARN]\033[0m  $*"; }
error() { echo -e "\033[0;31m[ERROR]\033[0m $*"; }
ok()    { echo -e "\033[0;32m[OK]\033[0m    $*"; }

# ─── Pre-flight checks ──────────────────────────────────────────────
info "Pre-flight checks..."

if ! command -v "$GCLOUD" &>/dev/null; then
  # Try system gcloud
  GCLOUD="gcloud"
  if ! command -v "$GCLOUD" &>/dev/null; then
    error "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
    exit 1
  fi
fi

# Verify project access
ACTIVE_PROJECT=$($GCLOUD config get-value project 2>/dev/null || true)
if [[ "$ACTIVE_PROJECT" != "$PROJECT_ID" ]]; then
  warn "Active project is '$ACTIVE_PROJECT', switching to '$PROJECT_ID'"
  $GCLOUD config set project "$PROJECT_ID" 2>/dev/null
fi

# ─── Get current revision info ───────────────────────────────────────
info "Fetching current service state..."

CURRENT_REVISION=$($GCLOUD run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.traffic[0].revisionName)' 2>/dev/null || echo "unknown")

SERVICE_URL=$($GCLOUD run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)' 2>/dev/null || echo "unknown")

info "Current revision: $CURRENT_REVISION"
info "Service URL: $SERVICE_URL"

# ─── Rollback mode ──────────────────────────────────────────────────
if [[ "$ROLLBACK" == true ]]; then
  info "Fetching revision list..."
  REVISIONS=$($GCLOUD run revisions list \
    --service="$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format='value(metadata.name)' \
    --sort-by='~metadata.creationTimestamp' \
    --limit=5)

  PREV_REVISION=$(echo "$REVISIONS" | sed -n '2p')
  if [[ -z "$PREV_REVISION" ]]; then
    error "No previous revision found to roll back to"
    exit 1
  fi

  info "Rolling back: $CURRENT_REVISION -> $PREV_REVISION"
  if [[ "$DRY_RUN" == true ]]; then
    info "[DRY RUN] Would route 100% traffic to $PREV_REVISION"
    exit 0
  fi

  $GCLOUD run services update-traffic "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --to-revisions="$PREV_REVISION=100"

  ok "Rolled back to $PREV_REVISION"

  # Health check after rollback
  info "Running health check..."
  if curl -sf "$SERVICE_URL/health" | python3 -m json.tool 2>/dev/null; then
    ok "Health check passed"
  else
    warn "Health check failed — check logs manually"
  fi
  exit 0
fi

# ─── Read current env vars from Cloud Run ────────────────────────────
info "Reading current env vars from Cloud Run..."

declare -A CURRENT_VARS
while IFS= read -r line; do
  # Extract KEY=VALUE pairs from the service description
  if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*name:[[:space:]]*(.+) ]]; then
    CURRENT_KEY="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^[[:space:]]*value:[[:space:]]*(.+) ]]; then
    CURRENT_VARS["$CURRENT_KEY"]="${BASH_REMATCH[1]}"
  fi
done < <($GCLOUD run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(spec.template.spec.containers[0].env)' 2>/dev/null || echo "")

# ─── Validate required values ────────────────────────────────────────
info "Validating critical env vars..."

for var in "${!REQUIRED_VALUES[@]}"; do
  EXPECTED="${REQUIRED_VALUES[$var]}"
  ACTUAL="${CURRENT_VARS[$var]:-NOT_SET}"

  if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    warn "$var: current='$ACTUAL', expected='$EXPECTED' — will be corrected"
    CURRENT_VARS["$var"]="$EXPECTED"
  else
    ok "$var=$ACTUAL"
  fi
done

# ─── Build env var string ────────────────────────────────────────────
# Use the separator trick to handle values with commas
ENV_PAIRS=()
for var in "${CRITICAL_ENV_VARS[@]}"; do
  VAL="${CURRENT_VARS[$var]:-}"
  if [[ -n "$VAL" ]]; then
    ENV_PAIRS+=("${var}=${VAL}")
  fi
done

# Join with || separator (Cloud Run --set-env-vars separator)
ENV_STRING=$(IFS='||'; echo "${ENV_PAIRS[*]}")

info "Env vars to set:"
for var in "${CRITICAL_ENV_VARS[@]}"; do
  VAL="${CURRENT_VARS[$var]:-NOT_SET}"
  # Mask sensitive-looking values
  if [[ "$var" == *KEY* || "$var" == *SECRET* || "$var" == *WIF* ]]; then
    echo "  $var=***"
  else
    echo "  $var=$VAL"
  fi
done

# ─── Deploy ──────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy with:"
  echo "  gcloud run deploy $SERVICE_NAME --source=services/worker/ \\"
  echo "    --region=$REGION --project=$PROJECT_ID \\"
  echo "    --update-env-vars=\"^||^$ENV_STRING\""
  exit 0
fi

info "Deploying from source..."
cd "$(git rev-parse --show-toplevel)"

$GCLOUD run deploy "$SERVICE_NAME" \
  --source="services/worker/" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --port=3001 \
  --cpu=1 \
  --memory=1Gi \
  --min-instances=1 \
  --max-instances=3 \
  --timeout=600 \
  --update-env-vars="^||^$ENV_STRING" \
  --quiet

# ─── Get new revision ───────────────────────────────────────────────
NEW_REVISION=$($GCLOUD run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.traffic[0].revisionName)' 2>/dev/null || echo "unknown")

info "New revision: $NEW_REVISION"

# ─── Post-deploy validation ─────────────────────────────────────────
info "Running post-deploy validation..."

# 1. Health check
info "Health check..."
HEALTH_OK=false
for i in 1 2 3 4 5; do
  if curl -sf "$SERVICE_URL/health" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  info "Health check attempt $i/5 — waiting 10s..."
  sleep 10
done

if [[ "$HEALTH_OK" != true ]]; then
  error "Health check failed after 5 attempts!"
  error "Rolling back to $CURRENT_REVISION..."
  $GCLOUD run services update-traffic "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --to-revisions="$CURRENT_REVISION=100"
  error "Rolled back. Check logs: gcloud run logs read --service=$SERVICE_NAME --region=$REGION --project=$PROJECT_ID --limit=50"
  exit 1
fi
ok "Health check passed"

# 2. Verify env vars on new revision
info "Verifying env vars on new revision..."
VERIFY_FAILED=false

declare -A NEW_VARS
while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*name:[[:space:]]*(.+) ]]; then
    VERIFY_KEY="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^[[:space:]]*value:[[:space:]]*(.+) ]]; then
    NEW_VARS["$VERIFY_KEY"]="${BASH_REMATCH[1]}"
  fi
done < <($GCLOUD run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(spec.template.spec.containers[0].env)' 2>/dev/null || echo "")

for var in "${!REQUIRED_VALUES[@]}"; do
  EXPECTED="${REQUIRED_VALUES[$var]}"
  ACTUAL="${NEW_VARS[$var]:-NOT_SET}"
  if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    error "VERIFICATION FAILED: $var='$ACTUAL' (expected '$EXPECTED')"
    VERIFY_FAILED=true
  else
    ok "Verified: $var=$ACTUAL"
  fi
done

if [[ "$VERIFY_FAILED" == true ]]; then
  error "Env var verification failed! Rolling back..."
  $GCLOUD run services update-traffic "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --to-revisions="$CURRENT_REVISION=100"
  error "Rolled back to $CURRENT_REVISION"
  exit 1
fi

# 3. Check for chain client initialization in logs
info "Checking logs for chain client initialization..."
sleep 5  # Brief wait for logs to propagate

LOGS=$($GCLOUD run logs read \
  --service="$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --limit=30 \
  --format='value(textPayload)' 2>/dev/null || echo "")

if echo "$LOGS" | grep -qi "chain client initialized"; then
  ok "Chain client initialized successfully"
elif echo "$LOGS" | grep -qi "failed to initialize chain client"; then
  error "Chain client FAILED to initialize!"
  error "This means anchoring is broken. Consider rolling back:"
  error "  $0 --rollback"
  exit 1
else
  warn "Could not confirm chain client status from logs (may need more time)"
fi

# ─── Summary ─────────────────────────────────────────────────────────
echo ""
echo "============================================"
ok "Deploy complete!"
echo "  Previous: $CURRENT_REVISION"
echo "  Current:  $NEW_REVISION"
echo "  URL:      $SERVICE_URL"
echo "  Health:   $SERVICE_URL/health"
echo "============================================"
