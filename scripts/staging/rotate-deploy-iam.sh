#!/usr/bin/env bash
# SCRUM-1821 item 8: rotate staging deploy privileges to a deploy-only SA.
#
# Default mode is dry-run. Live IAM changes require:
#   ./scripts/staging/rotate-deploy-iam.sh --apply --confirm SCRUM-1821
#
# Rollback:
#   ./scripts/staging/rotate-deploy-iam.sh --rollback --apply --confirm SCRUM-1821

set -euo pipefail

PROJECT="${STAGING_GCP_PROJECT:-arkova1}"
REGION="${STAGING_CLOUD_RUN_REGION:-us-central1}"
SERVICE="${STAGING_CLOUD_RUN_SERVICE:-arkova-worker-staging}"
DEPLOY_SA_ID="${STAGING_DEPLOY_SA_ID:-arkova-staging-deployer}"
DEPLOY_SA_EMAIL_OVERRIDE="${STAGING_DEPLOY_SA_EMAIL:-}"
COMPUTE_SA="${STAGING_COMPUTE_SA_EMAIL:-270018525501-compute@developer.gserviceaccount.com}"
RUNTIME_SA="${STAGING_RUNTIME_SA_EMAIL:-$COMPUTE_SA}"
CONFIRM=""
APPLY=0
ROLLBACK=0

usage() {
  sed -n '2,16p' "$0"
  echo
  echo "Usage: $0 [--apply --confirm SCRUM-1821] [--rollback] [--project arkova1] [--region us-central1] [--service arkova-worker-staging]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --confirm) CONFIRM="${2:?}"; shift 2 ;;
    --project) PROJECT="${2:?}"; shift 2 ;;
    --region) REGION="${2:?}"; shift 2 ;;
    --service) SERVICE="${2:?}"; shift 2 ;;
    --deploy-sa-id) DEPLOY_SA_ID="${2:?}"; shift 2 ;;
    --compute-sa) COMPUTE_SA="${2:?}"; shift 2 ;;
    --runtime-sa) RUNTIME_SA="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$DEPLOY_SA_EMAIL_OVERRIDE" ]; then
  DEPLOY_SA="$DEPLOY_SA_EMAIL_OVERRIDE"
else
  DEPLOY_SA="${DEPLOY_SA_ID}@${PROJECT}.iam.gserviceaccount.com"
fi

if [ $APPLY -eq 1 ] && [ "$CONFIRM" != "SCRUM-1821" ]; then
  echo "ERROR: live IAM changes require --confirm SCRUM-1821" >&2
  exit 2
fi

RUN_CONDITION_TITLE="${STAGING_DEPLOY_CONDITION_TITLE:-arkova_staging_deploy_only}"
RUN_CONDITION_EXPR="${STAGING_DEPLOY_CONDITION_EXPR:-resource.name == \"projects/${PROJECT}/locations/${REGION}/services/${SERVICE}\"}"
RUN_CONDITION_DESC="${STAGING_DEPLOY_CONDITION_DESC:-SCRUM-1821 deploy-only access to ${SERVICE}}"
RUN_CONDITION="title=${RUN_CONDITION_TITLE},expression=${RUN_CONDITION_EXPR},description=${RUN_CONDITION_DESC}"

print_cmd() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

run_cmd() {
  print_cmd "$@"
  if [ $APPLY -eq 1 ]; then
    echo "executing: $*" >&2
    "$@"
  fi
}

ensure_deploy_sa() {
  if [ -n "$DEPLOY_SA_EMAIL_OVERRIDE" ]; then
    echo "Custom deploy SA email supplied; assuming service account already exists."
    return
  fi

  print_cmd gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT"
  if [ $APPLY -eq 1 ] && gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT" >/dev/null 2>&1; then
    echo "Deploy SA already exists; skipping create."
    return
  fi

  run_cmd gcloud iam service-accounts create "$DEPLOY_SA_ID" \
    --project="$PROJECT" \
    --display-name="Arkova staging deploy-only service account"
}

echo "SCRUM-1821 staging deploy IAM rotation"
echo "project:       $PROJECT"
echo "region:        $REGION"
echo "service:       $SERVICE"
echo "deploy SA:     $DEPLOY_SA"
echo "compute SA:    $COMPUTE_SA"
echo "runtime SA:    $RUNTIME_SA"
echo "run condition: $RUN_CONDITION_EXPR"
echo "mode:          $([ $APPLY -eq 1 ] && echo apply || echo dry-run)"
echo "direction:     $([ $ROLLBACK -eq 1 ] && echo rollback || echo rotate)"
echo

if [ $ROLLBACK -eq 1 ]; then
  echo "Rollback plan: restore run.developer to compute SA and remove deploy-only SA deploy roles."
  run_cmd gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role=roles/run.developer
  run_cmd gcloud projects remove-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role=roles/run.developer \
    --condition="$RUN_CONDITION"
  run_cmd gcloud iam service-accounts remove-iam-policy-binding "$RUNTIME_SA" \
    --project="$PROJECT" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role=roles/iam.serviceAccountUser
  exit 0
fi

echo "Forward plan: create deploy-only SA, grant conditioned staging deploy rights, then revoke deploy rights from compute SA."
ensure_deploy_sa
run_cmd gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/run.developer \
  --condition="$RUN_CONDITION"
run_cmd gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$PROJECT" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/iam.serviceAccountUser
run_cmd gcloud projects remove-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role=roles/run.developer

echo
echo "Rollback if staging deploys fail:"
echo "  ./scripts/staging/rotate-deploy-iam.sh --rollback --apply --confirm SCRUM-1821"
