#!/usr/bin/env bash
# scripts/staging/teardown-isolated-rig.sh — S0-4.1 (epic S0-E4).
#
# Reclaims an isolated soak rig provisioned by provision-isolated-rig.sh:
#   1. Delete the isolated Cloud Run worker service(s).
#   2. Delete any Cloud Scheduler jobs wired to that worker (cron triggers).
#   3. Reclaim the isolated Supabase project. Paid Supabase projects CANNOT be
#      MCP-paused (pause_project needs a free-tier downgrade first — CLAUDE.md
#      §7), so this script either DELETES the project (default reclaim) or, when
#      --flag-only is set, prints a clear Carson dashboard action instead of
#      deleting (for projects Carson wants to keep/downgrade by hand).
#
# SAFETY MODEL (CLAUDE.md §1.11A — the whole point of this script):
#   * --dry-run is the DEFAULT. With no flags the script PRINTS the plan and
#     mutates NOTHING.
#   * A real run requires BOTH:
#       --apply
#       CONFIRM_TEARDOWN=<project-ref>   (must match --project-ref exactly)
#   * The prod Supabase ref (vzwyaatejekddvltxyye) and the shared staging ref
#     (ujtlwnoqfhtitcmsnrpq) + shared Cloud Run services (arkova-worker,
#     arkova-worker-staging) are HARD-DENIED — the script exits 1 rather than
#     delete prod or shared staging.
#
# Usage:
#   ./scripts/staging/teardown-isolated-rig.sh \
#       --project-ref abcd1234efgh5678ijkl --service arkova-worker-s0e4-lane-a-staging   # dry-run
#
#   # Paired RIG-G1 services share one project + secret pair and are reclaimed
#   # atomically by declaring both services and the common rig name:
#   ./scripts/staging/teardown-isolated-rig.sh \
#       --project-ref abcd1234efgh5678ijkl --rig-name s33-g1 \
#       --service arkova-worker-s33-g1-public-staging \
#       --service arkova-worker-s33-g1-tuned-staging
#
#   CONFIRM_TEARDOWN=abcd1234efgh5678ijkl \
#     ./scripts/staging/teardown-isolated-rig.sh \
#       --project-ref abcd1234efgh5678ijkl --service arkova-worker-s0e4-lane-a-staging --apply
#
#   # Keep the Supabase project for Carson to downgrade/pause by hand:
#   CONFIRM_TEARDOWN=abcd1234efgh5678ijkl \
#     ./scripts/staging/teardown-isolated-rig.sh \
#       --project-ref abcd1234efgh5678ijkl --service ... --flag-only --apply

set -euo pipefail

# ---------------------------------------------------------------------------
# Hard-deny constants — NEVER tear these down.
# ---------------------------------------------------------------------------
PROD_SUPABASE_REF="vzwyaatejekddvltxyye"
SHARED_STAGING_SUPABASE_REF="ujtlwnoqfhtitcmsnrpq"
DENIED_CLOUD_RUN_SERVICES=("arkova-worker" "arkova-worker-staging")
RIG_R_NAME="s33-r"
RIG_R_SERVICE="arkova-worker-s33-r-staging"
RIG_R_RUNTIME_SA="s33-rig-r-runtime@arkova1.iam.gserviceaccount.com"
RIG_R_PROTECTED_V6_ENDPOINT="projects/arkova1/locations/us-central1/endpoints/6611494259700793344"
RIG_R_PROTECTED_V6_MODEL="projects/arkova1/locations/us-central1/models/6611494259700793344"
RIG_R_LEASE_BUCKET="arkova1-s33-immutable-authority-ledger"
RIG_R_LEASE_PREFIX="s33/rig-leases"

# ---------------------------------------------------------------------------
# Defaults (overridable via flags / env).
# ---------------------------------------------------------------------------
GCP_PROJECT="${STAGING_GCP_PROJECT:-arkova1}"
CLOUD_RUN_REGION="${STAGING_CLOUD_RUN_REGION:-us-central1}"

PROJECT_REF=""
SERVICES=()
RIG_NAME=""
RIG_ID=""
VERTEX_ENDPOINT=""
VERTEX_MODEL=""
DEPLOYED_MODEL_ID=""
RUNTIME_SA=""
LEASE_ID=""
APPLY=0
FLAG_ONLY=0

usage() {
  sed -n '2,44p' "$0"
  echo
  echo "Usage: $0 --project-ref <ref> --service <arkova-worker-*-staging> [--service <second-service>]"
  echo "          [--rig-name <rig-name>] [--rig-id RIG-R] [--apply] [--flag-only]"
  echo "          [--vertex-endpoint <resource>] [--vertex-model <resource>]"
  echo "          [--deployed-model-id <id>] [--runtime-sa <email>] [--lease-id <id>]"
  echo "          [--gcp-project arkova1] [--gcp-region us-central1]"
  echo
  echo "Live run also requires: CONFIRM_TEARDOWN=<ref> matching --project-ref."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-ref) PROJECT_REF="${2:?}"; shift 2 ;;
    --service) SERVICES+=("${2:?}"); shift 2 ;;
    --rig-name) RIG_NAME="${2:?}"; shift 2 ;;
    --rig-id) RIG_ID="${2:?}"; shift 2 ;;
    --vertex-endpoint) VERTEX_ENDPOINT="${2:?}"; shift 2 ;;
    --vertex-model) VERTEX_MODEL="${2:?}"; shift 2 ;;
    --deployed-model-id) DEPLOYED_MODEL_ID="${2:?}"; shift 2 ;;
    --runtime-sa) RUNTIME_SA="${2:?}"; shift 2 ;;
    --lease-id) LEASE_ID="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --flag-only) FLAG_ONLY=1; shift ;;
    --gcp-project) GCP_PROJECT="${2:?}"; shift 2 ;;
    --gcp-region) CLOUD_RUN_REGION="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate inputs.
# ---------------------------------------------------------------------------
if [[ -z "$PROJECT_REF" || ${#SERVICES[@]} -eq 0 ]]; then
  echo "ERROR: both --project-ref and --service are required." >&2
  usage >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Hard-deny prod / shared staging. This is the safety-critical gate.
# ---------------------------------------------------------------------------
deny() { echo "REFUSING: $*" >&2; exit 1; }

if [[ "$PROJECT_REF" == "$PROD_SUPABASE_REF" ]]; then
  deny "--project-ref is the PROD Supabase project ($PROD_SUPABASE_REF). Never tear down prod."
fi
if [[ "$PROJECT_REF" == "$SHARED_STAGING_SUPABASE_REF" ]]; then
  deny "--project-ref is the SHARED staging project ($SHARED_STAGING_SUPABASE_REF). Use teardown-and-reset.sh to reset shared staging, not this script."
fi
SEEN_SERVICES="|"
for service in "${SERVICES[@]}"; do
  case "$SEEN_SERVICES" in
    *"|$service|"*)
      echo "ERROR: duplicate --service '$service' is not allowed." >&2
      exit 2
      ;;
  esac
  SEEN_SERVICES="${SEEN_SERVICES}${service}|"
  for denied in "${DENIED_CLOUD_RUN_SERVICES[@]}"; do
    if [[ "$service" == "$denied" ]]; then
      deny "--service '$service' is a shared/prod Cloud Run service."
    fi
  done
  if [[ ! "$service" =~ ^arkova-worker-[a-z0-9][a-z0-9-]*-staging$ ]]; then
    echo "ERROR: --service must match arkova-worker-<name>-staging; got '$service'." >&2
    exit 2
  fi
done

IS_RIG_R=0
if [[ "$RIG_ID" == "RIG-R" ]]; then
  IS_RIG_R=1
  if [[ "$RIG_NAME" != "$RIG_R_NAME" || ${#SERVICES[@]} -ne 1 \
    || "${SERVICES[0]}" != "$RIG_R_SERVICE" ]]; then
    echo "ERROR: RIG-R teardown requires exact rig '$RIG_R_NAME' and sole service '$RIG_R_SERVICE'." >&2
    exit 2
  fi
  if [[ $FLAG_ONLY -eq 1 ]]; then
    echo "ERROR: RIG-R teardown cannot --flag-only; projected recurring cost must reach zero." >&2
    exit 2
  fi
  if [[ "$GCP_PROJECT" != "arkova1" || "$CLOUD_RUN_REGION" != "us-central1" ]]; then
    echo "ERROR: RIG-R teardown requires exact project arkova1 / region us-central1." >&2
    exit 2
  fi
  if [[ ! "$VERTEX_ENDPOINT" =~ ^projects/arkova1/locations/us-central1/endpoints/([1-9][0-9]*)$ ]]; then
    echo "ERROR: RIG-R teardown requires one exact temporary us-central1 Vertex endpoint." >&2
    exit 2
  fi
  RIG_R_ENDPOINT_ID="${BASH_REMATCH[1]}"
  if [[ "$VERTEX_ENDPOINT" == "$RIG_R_PROTECTED_V6_ENDPOINT" ]]; then
    echo "REFUSING: RIG-R target is the protected v6 rollback endpoint." >&2
    exit 1
  fi
  if [[ "$VERTEX_MODEL" != "$RIG_R_PROTECTED_V6_MODEL" ]]; then
    echo "ERROR: RIG-R teardown requires the exact protected v6 rollback model binding; the model itself is preserved." >&2
    exit 2
  fi
  if [[ ! "$DEPLOYED_MODEL_ID" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: RIG-R teardown requires one exact numeric deployed-model ID." >&2
    exit 2
  fi
  if [[ "$RUNTIME_SA" != "$RIG_R_RUNTIME_SA" ]]; then
    echo "ERROR: RIG-R teardown requires exact temporary runtime identity '$RIG_R_RUNTIME_SA'." >&2
    exit 2
  fi
  if [[ ! "$LEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
    echo "ERROR: RIG-R teardown requires one exact exclusive lease identity." >&2
    exit 2
  fi
elif [[ -n "$RIG_ID" || -n "$VERTEX_ENDPOINT" || -n "$VERTEX_MODEL" \
  || -n "$DEPLOYED_MODEL_ID" || -n "$RUNTIME_SA" || -n "$LEASE_ID" ]]; then
  echo "ERROR: RIG-R teardown inputs are accepted only as the complete exact RIG_ID=RIG-R tuple." >&2
  exit 2
fi

if [[ ${#SERVICES[@]} -gt 1 && -z "$RIG_NAME" ]]; then
  echo "ERROR: multi-service teardown requires --rig-name so shared secrets are reclaimed exactly once." >&2
  exit 2
fi
if [[ -z "$RIG_NAME" ]]; then
  RIG_NAME="${SERVICES[0]#arkova-worker-}"
  RIG_NAME="${RIG_NAME%-staging}"
fi
if [[ ! "$RIG_NAME" =~ ^[a-z][a-z0-9-]{1,28}[a-z0-9]$ ]]; then
  echo "ERROR: --rig-name must be lowercase DNS-safe (3-30 chars); got '$RIG_NAME'." >&2
  exit 2
fi
for service in "${SERVICES[@]}"; do
  if [[ "$service" != "arkova-worker-${RIG_NAME}-staging" \
    && ! "$service" =~ ^arkova-worker-${RIG_NAME}-[a-z0-9][a-z0-9-]*-staging$ ]]; then
    echo "ERROR: service '$service' does not belong to declared rig '$RIG_NAME'." >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Apply-mode confirmation gate.
# ---------------------------------------------------------------------------
MODE_LABEL="dry-run"
if [[ $APPLY -eq 1 ]]; then
  MODE_LABEL="apply"
  if [[ "${CONFIRM_TEARDOWN:-}" != "$PROJECT_REF" ]]; then
    echo "ERROR: live teardown requires CONFIRM_TEARDOWN=<project-ref> matching --project-ref." >&2
    echo "       Expected CONFIRM_TEARDOWN='$PROJECT_REF', got CONFIRM_TEARDOWN='${CONFIRM_TEARDOWN:-<unset>}'." >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# Command emitter — print always; execute only under --apply.
# ---------------------------------------------------------------------------
print_cmd() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

run_cmd() {
  print_cmd "$@"
  if [[ $APPLY -eq 1 ]]; then
    echo "executing: $*" >&2
    "$@"
  fi
}

RECLAIM_LABEL="delete Supabase project"
if [[ $FLAG_ONLY -eq 1 ]]; then
  RECLAIM_LABEL="FLAG for Carson dashboard action (no delete)"
fi

# ---------------------------------------------------------------------------
# Plan header.
# ---------------------------------------------------------------------------
echo "S0-4.1 isolated soak-rig teardown"
echo "Supabase project:  $PROJECT_REF"
echo "rig name:          $RIG_NAME"
for service in "${SERVICES[@]}"; do
  echo "Cloud Run service: $service"
done
echo "Cloud Run region:  $CLOUD_RUN_REGION"
echo "GCP project:       $GCP_PROJECT"
echo "Supabase reclaim:  $RECLAIM_LABEL"
echo "mode:              $MODE_LABEL"
echo "prod ref (denied): $PROD_SUPABASE_REF"
echo "shared staging:    $SHARED_STAGING_SUPABASE_REF (denied)"
echo

if [[ $APPLY -ne 1 ]]; then
  echo "DRY-RUN: no infrastructure will be deleted. Re-run with --apply and"
  echo "         CONFIRM_TEARDOWN=$PROJECT_REF to execute (Carson-gated; see runbook)."
  echo
fi

if [[ $IS_RIG_R -eq 1 ]]; then
  RIG_R_LEASE_URI="gs://${RIG_R_LEASE_BUCKET}/${RIG_R_LEASE_PREFIX}/${LEASE_ID}.json"
  RIG_R_RUNTIME_ROLES=(
    "roles/aiplatform.user"
    "roles/logging.logWriter"
  )
  RIG_R_SECRET_REFERENCES=(
    "supabase-url-s33-r-staging"
    "supabase-service-role-key-s33-r-staging"
    "stripe-secret-key-staging"
    "stripe-webhook-secret-staging"
    "api-key-hmac-secret-staging"
    "cron-secret"
    "gemini-api-key-staging"
  )
  echo "Vertex endpoint:   $VERTEX_ENDPOINT"
  echo "Vertex model:      $VERTEX_MODEL (preserved; never a delete target)"
  echo "deployed model id: $DEPLOYED_MODEL_ID"
  echo "runtime identity:  $RUNTIME_SA"
  echo "exclusive lease:   $RIG_R_LEASE_URI"
  echo "contained queues:  ai-rollback, chain-fault (removed with Supabase project)"
  echo "managed topology:  Scheduler=0, managed-queue=0, OIDC=0"
  echo

  # Apply preflight proves that every destructive target is the exact RIG-R
  # resource and that the forbidden managed topology never existed.
  if [[ $APPLY -eq 1 ]]; then
    RIG_R_ENDPOINT_JSON="$(gcloud ai endpoints describe "$RIG_R_ENDPOINT_ID" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json)" || {
      echo "ERROR: cannot observe the exact RIG-R endpoint before teardown." >&2
      exit 1
    }
    if ! jq -e --arg model "$VERTEX_MODEL" --arg deployed_id "$DEPLOYED_MODEL_ID" '
      type == "object"
      and (.deployedModels | type == "array" and length == 1)
      and .deployedModels[0].model == $model
      and .deployedModels[0].id == $deployed_id
      and (.trafficSplit | type == "object")
      and ((.trafficSplit | keys) == [$deployed_id])
      and .trafficSplit[$deployed_id] == 100
    ' >/dev/null 2>&1 <<<"$RIG_R_ENDPOINT_JSON"; then
      echo "ERROR: RIG-R endpoint/deployed-model binding changed; refusing teardown ambiguity." >&2
      exit 1
    fi
    RIG_R_PROJECT_JSON="$(npx supabase projects list --output json)" || {
      echo "ERROR: cannot observe Supabase project inventory before RIG-R teardown." >&2
      exit 1
    }
    if ! jq -e --arg ref "$PROJECT_REF" '
      [ .[] | select((.id // .ref) == $ref and .name == "arkova-soak-s33-r") ] | length == 1
    ' >/dev/null 2>&1 <<<"$RIG_R_PROJECT_JSON"; then
      echo "ERROR: project ref is not the sole exact arkova-soak-s33-r target." >&2
      exit 1
    fi
    RIG_R_LEASE_JSON="$(gcloud storage cat "$RIG_R_LEASE_URI" --project="$GCP_PROJECT")" || {
      echo "ERROR: cannot observe the exact RIG-R exclusive lease before teardown." >&2
      exit 1
    }
    if ! jq -e \
      --arg lease_id "$LEASE_ID" \
      --arg endpoint "$VERTEX_ENDPOINT" \
      --arg vertex_model "$VERTEX_MODEL" \
      --arg deployed_model_id "$DEPLOYED_MODEL_ID" '
        type == "object"
        and .schemaVersion == "arkova.s33.rig-r.exclusive-lease/v1"
        and .leaseId == $lease_id
        and .rigId == "RIG-R"
        and .rigName == "s33-r"
        and .profile == "gemini-release"
        and .vertexEndpoint == $endpoint
        and .vertexModel == $vertex_model
        and .deployedModelId == $deployed_model_id
      ' >/dev/null 2>&1 <<<"$RIG_R_LEASE_JSON"; then
      echo "ERROR: RIG-R lease content does not bind the exact teardown target." >&2
      exit 1
    fi
    RIG_R_SCHEDULER_BEFORE="$(gcloud scheduler jobs list \
      --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:${RIG_R_SERVICE}" --format="value(name)")" || {
      echo "ERROR: cannot prove the RIG-R Scheduler inventory is empty." >&2
      exit 1
    }
    RIG_R_QUEUES_BEFORE="$(gcloud tasks queues list \
      --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:s33-r" --format="value(name)")" || {
      echo "ERROR: cannot prove the RIG-R managed-queue inventory is empty." >&2
      exit 1
    }
    if [[ -n "$RIG_R_SCHEDULER_BEFORE" || -n "$RIG_R_QUEUES_BEFORE" ]]; then
      echo "ERROR: RIG-R contract permits zero Scheduler jobs and zero managed queues." >&2
      exit 1
    fi
  else
    print_cmd gcloud ai endpoints describe "$RIG_R_ENDPOINT_ID" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json
    print_cmd npx supabase projects list --output json
    print_cmd gcloud storage cat "$RIG_R_LEASE_URI" --project="$GCP_PROJECT"
    print_cmd gcloud scheduler jobs list --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" --filter="name:${RIG_R_SERVICE}" --format="value(name)"
    print_cmd gcloud tasks queues list --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" --filter="name:s33-r" --format="value(name)"
  fi
  echo

  echo "# RIG-R 1/8 — undeploy the exact temporary deployed model"
  run_cmd gcloud ai endpoints undeploy-model "$RIG_R_ENDPOINT_ID" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --deployed-model-id="$DEPLOYED_MODEL_ID" \
    --quiet
  echo

  echo "# RIG-R 2/8 — delete the now-empty temporary endpoint (preserve model artifacts)"
  run_cmd gcloud ai endpoints delete "$RIG_R_ENDPOINT_ID" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --quiet
  echo

  echo "# RIG-R 3/8 — delete the sole isolated Cloud Run service"
  run_cmd gcloud run services delete "$RIG_R_SERVICE" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --quiet
  echo

  echo "# RIG-R 4/8 — remove exact per-secret runtime grants, then delete the generated pair"
  for secret in "${RIG_R_SECRET_REFERENCES[@]}"; do
    run_cmd gcloud secrets remove-iam-policy-binding "$secret" \
      --project="$GCP_PROJECT" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --condition=None \
      --quiet
  done
  for secret in "supabase-url-s33-r-staging" "supabase-service-role-key-s33-r-staging"; do
    run_cmd gcloud secrets delete "$secret" --project="$GCP_PROJECT" --quiet
  done
  echo

  echo "# RIG-R 5/8 — delete the isolated Supabase project (contains ai-rollback + chain-fault)"
  run_cmd npx supabase projects delete "$PROJECT_REF"
  echo

  echo "# RIG-R 6/8 — remove runtime IAM bindings and delete the temporary service account"
  if [[ $APPLY -eq 1 ]]; then
    RIG_R_RUNTIME_ROLE_LIST="$(gcloud projects get-iam-policy "$GCP_PROJECT" \
      --flatten="bindings[].members" \
      --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
      --format="value(bindings.role)")" || {
      echo "ERROR: cannot enumerate RIG-R runtime IAM bindings." >&2
      exit 1
    }
    while IFS= read -r runtime_role; do
      [[ -n "$runtime_role" ]] || continue
      if [[ ! "$runtime_role" =~ ^(roles/[A-Za-z0-9_.]+|projects/[a-z][a-z0-9-]+/roles/[A-Za-z0-9_.]+)$ ]]; then
        echo "ERROR: refusing malformed observed RIG-R IAM role '$runtime_role'." >&2
        exit 1
      fi
      run_cmd gcloud projects remove-iam-policy-binding "$GCP_PROJECT" \
        --member="serviceAccount:${RUNTIME_SA}" --role="$runtime_role" --condition=None --quiet
    done <<<"$RIG_R_RUNTIME_ROLE_LIST"
  else
    for runtime_role in "${RIG_R_RUNTIME_ROLES[@]}"; do
      print_cmd gcloud projects remove-iam-policy-binding "$GCP_PROJECT" \
        --member="serviceAccount:${RUNTIME_SA}" --role="$runtime_role" --condition=None --quiet
    done
  fi
  run_cmd gcloud iam service-accounts delete "$RUNTIME_SA" --project="$GCP_PROJECT" --quiet
  echo

  echo "# RIG-R 7/8 — release the sole exclusive lease"
  run_cmd gcloud storage rm "$RIG_R_LEASE_URI" --project="$GCP_PROJECT"
  echo

  echo "# RIG-R 8/8 — observe zero residual recurring topology"
  if [[ $APPLY -eq 1 ]]; then
    assert_empty() {
      local label="$1"
      shift
      local observed
      if ! observed="$("$@")"; then
        echo "ERROR: residual check failed to observe $label." >&2
        exit 1
      fi
      if [[ -n "$observed" ]]; then
        echo "ERROR: residual $label remains after RIG-R teardown." >&2
        exit 1
      fi
    }
    assert_empty "Vertex endpoint" gcloud ai endpoints list \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
      --filter="name:${RIG_R_ENDPOINT_ID}" --format="value(name)"
    assert_empty "Cloud Run service" gcloud run services list \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
      --filter="metadata.name:${RIG_R_SERVICE}" --format="value(metadata.name)"
    assert_empty "generated secret pair" gcloud secrets list \
      --project="$GCP_PROJECT" \
      --filter="name:(supabase-url-s33-r-staging OR supabase-service-role-key-s33-r-staging)" \
      --format="value(name)"
    assert_empty "Scheduler" gcloud scheduler jobs list \
      --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:${RIG_R_SERVICE}" --format="value(name)"
    assert_empty "managed queue" gcloud tasks queues list \
      --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:s33-r" --format="value(name)"
    assert_empty "runtime service account" gcloud iam service-accounts list \
      --project="$GCP_PROJECT" --filter="email:${RUNTIME_SA}" --format="value(email)"
    assert_empty "runtime IAM binding" gcloud projects get-iam-policy "$GCP_PROJECT" \
      --flatten="bindings[].members" \
      --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
      --format="value(bindings.role)"
    RIG_R_PROJECTS_AFTER="$(npx supabase projects list --output json)" || {
      echo "ERROR: cannot verify isolated Supabase project deletion." >&2
      exit 1
    }
    if jq -e --arg ref "$PROJECT_REF" '[.[] | select((.id // .ref) == $ref)] | length != 0' \
      >/dev/null 2>&1 <<<"$RIG_R_PROJECTS_AFTER"; then
      echo "ERROR: isolated Supabase project remains after teardown." >&2
      exit 1
    fi
    if ! gcloud storage buckets describe "gs://${RIG_R_LEASE_BUCKET}" \
      --project="$GCP_PROJECT" >/dev/null; then
      echo "ERROR: cannot authenticate the RIG-R lease bucket for residual verification." >&2
      exit 1
    fi
    if gcloud storage objects describe "$RIG_R_LEASE_URI" \
      --project="$GCP_PROJECT" >/dev/null 2>&1; then
      echo "ERROR: exclusive RIG-R lease remains after teardown." >&2
      exit 1
    fi
  else
    print_cmd gcloud ai endpoints list --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
      --filter="name:${RIG_R_ENDPOINT_ID}" --format="value(name)"
    print_cmd gcloud run services list --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
      --filter="metadata.name:${RIG_R_SERVICE}" --format="value(metadata.name)"
    print_cmd gcloud scheduler jobs list --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:${RIG_R_SERVICE}" --format="value(name)"
    print_cmd gcloud tasks queues list --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:s33-r" --format="value(name)"
  fi
  TEARDOWN_PROJECTION_JSON="$(jq -nc '
    {
      schema_version: "arkova.s33.rig-r.teardown-projection/v1",
      rig_id: "RIG-R",
      projected_monthly_recurring_usd: 0,
      zero_residual_scheduler: true,
      zero_residual_managed_queue: true,
      zero_residual_oidc: true,
      contained_database_queues_removed_with_project: ["ai-rollback", "chain-fault"],
      protected_v6_rollback_assets_preserved: true
    }
  ')"
  echo "TEARDOWN_PROJECTION_JSON=$TEARDOWN_PROJECTION_JSON"
  echo "# RIG-R teardown complete; projected recurring cost is $0."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1 — delete the isolated Cloud Run worker service.
# ---------------------------------------------------------------------------
echo "# Step 1/3 — delete ${#SERVICES[@]} Cloud Run worker service(s)"
for service in "${SERVICES[@]}"; do
  run_cmd gcloud run services delete "$service" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --quiet
done
echo

# ---------------------------------------------------------------------------
# Step 2 — delete Cloud Scheduler jobs wired to this worker.
#
# Isolated rigs name their cron jobs after the worker for discoverability.
# In dry-run we emit the discover-then-delete plan; in --apply we enumerate
# matching jobs and delete each. Failures to find jobs are non-fatal.
# ---------------------------------------------------------------------------
echo "# Step 2/3 — delete Cloud Scheduler cron jobs for declared service boundaries"
# gcloud's `name ~ X` is a substring REGEX — `lane-a` would also match
# `lane-a-2`, deleting a sibling rig's triggers mid-soak (review #4). List all
# jobs, then keep only those whose short name exactly matches a declared service
# or starts with "<declared-service>-" (boundary-anchored) — no regex surprises.
print_cmd gcloud scheduler jobs list \
  --project="$GCP_PROJECT" \
  --location="$CLOUD_RUN_REGION" \
  --format="value(name)"
if [[ $APPLY -eq 1 ]]; then
  echo "executing: gcloud scheduler jobs list (exact-boundary match on declared services)" >&2
  all_jobs="$(gcloud scheduler jobs list \
    --project="$GCP_PROJECT" \
    --location="$CLOUD_RUN_REGION" \
    --format="value(name)" || true)"
  matched=0
  while IFS= read -r job; do
    [[ -n "$job" ]] || continue
    job_base="${job##*/}" # strip projects/.../jobs/ prefix if present
    for service in "${SERVICES[@]}"; do
      if [[ "$job_base" == "$service" || "$job_base" == "$service-"* ]]; then
        matched=1
        run_cmd gcloud scheduler jobs delete "$job" \
          --project="$GCP_PROJECT" \
          --location="$CLOUD_RUN_REGION" \
          --quiet
        break
      fi
    done
  done <<<"$all_jobs"
  [[ $matched -eq 1 ]] || echo "No scheduler jobs matched the declared services; continuing." >&2
else
  for service in "${SERVICES[@]}"; do
    echo "#   then delete only jobs whose name == '$service' or starts with '$service-'"
  done
  echo "#   (exact-boundary matching never touches an undeclared sibling rig)."
fi
echo

# ---------------------------------------------------------------------------
# Step 2b — delete the per-rig Secret Manager secrets the provision step wired
# (the now-dead service-role key + url). Otherwise the deleted project's
# service-role key lingers in Secret Manager (review #3). RIG_NAME was either
# derived from the one service or supplied explicitly for a multi-service rig.
# ---------------------------------------------------------------------------
echo "# Step 2b/3 — delete per-rig secrets for '$RIG_NAME'"
for secret in "supabase-url-${RIG_NAME}-staging" "supabase-service-role-key-${RIG_NAME}-staging"; do
  run_cmd gcloud secrets delete "$secret" --project="$GCP_PROJECT" --quiet
done
echo

# ---------------------------------------------------------------------------
# Step 3 — reclaim the isolated Supabase project.
#
# Paid Pro projects cannot be MCP-paused (needs free-tier downgrade first —
# CLAUDE.md §7). Default behaviour is to DELETE the project. --flag-only skips
# the delete and prints an explicit Carson dashboard action instead.
# ---------------------------------------------------------------------------
echo "# Step 3/3 — reclaim isolated Supabase project '$PROJECT_REF'"
if [[ $FLAG_ONLY -eq 1 ]]; then
  echo "#   --flag-only: NOT deleting. Carson action required (paid project cannot be MCP-paused):"
  echo
  echo "  >>> CARSON ACTION REQUIRED <<<"
  echo "      Project ref: $PROJECT_REF"
  echo "      In the Supabase dashboard, EITHER:"
  echo "        (a) downgrade this project to the free tier, then pause it; or"
  echo "        (b) delete it once you've confirmed no soak evidence still depends on it."
  echo "      Reason: MCP pause_project requires a free-tier downgrade first (CLAUDE.md §7)."
  echo
else
  echo "#   default reclaim: delete the project (MCP-equivalent: delete project)."
  echo "#   MCP pause_project will NOT work on a paid project (CLAUDE.md §7) — delete or use --flag-only."
  run_cmd npx supabase projects delete "$PROJECT_REF"
fi
echo

echo "# Teardown plan complete."
if [[ $APPLY -eq 1 ]]; then
  echo "# Update the rig inventory: mark $PROJECT_REF reclaimed (or flagged-for-Carson),"
  echo "# and run the end-of-sprint infra sweep (CLAUDE.md §7) to confirm no orphans remain."
else
  echo "# (dry-run — nothing was deleted)"
fi
