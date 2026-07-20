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
#   # RIG-G1-A and RIG-G1-B are separate physical projects, services, runtime
#   # identities, and generated secret pairs. Reclaim each exact arm separately:
#   ./scripts/staging/teardown-isolated-rig.sh \
#       --project-ref abcd1234efgh5678ijkl --rig-name s33-g1-a --rig-id RIG-G1-A \
#       --service arkova-worker-s33-g1-a-staging \
#       --runtime-sa s33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com
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

# Ownership and residual decisions must not be delegated to a PATH-substituted
# JSON parser. The macOS system jq is root-owned and is also the parser used by
# the provisioning admission boundary.
jq() { /usr/bin/jq "$@"; }

# ---------------------------------------------------------------------------
# Hard-deny constants — NEVER tear these down.
# ---------------------------------------------------------------------------
PROD_SUPABASE_REF="vzwyaatejekddvltxyye"
SHARED_STAGING_SUPABASE_REF="ujtlwnoqfhtitcmsnrpq"
DENIED_CLOUD_RUN_SERVICES=("arkova-worker" "arkova-worker-staging")
RIG_R_NAME="s33-r"
RIG_R_SERVICE="arkova-worker-s33-r-staging"
RIG_R_RUNTIME_SA="s33-rig-r-runtime@arkova1.iam.gserviceaccount.com"
RIG_R_OPERATOR_SA="270018525501-compute@developer.gserviceaccount.com"
RIG_R_RUNTIME_IMPERSONATION_ROLE="roles/iam.serviceAccountTokenCreator"
RIG_R_RUNTIME_IMPERSONATION_MEMBER="serviceAccount:${RIG_R_OPERATOR_SA}"
RIG_R_PROTECTED_V6_MODEL="projects/270018525501/locations/us-central1/models/6611494259700793344"
RIG_G1_A_NAME="s33-g1-a"
RIG_G1_A_SERVICE="arkova-worker-s33-g1-a-staging"
RIG_G1_A_RUNTIME_SA="s33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com"
RIG_G1_B_NAME="s33-g1-b"
RIG_G1_B_SERVICE="arkova-worker-s33-g1-b-staging"
RIG_G1_B_RUNTIME_SA="s33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com"
RIG_G1_B_ENDPOINT="projects/arkova1/locations/us-central1/endpoints/733002"
RIG_G1_B_ENDPOINT_ID="733002"
RIG_G1_B_DEPLOYED_MODEL_ID="7330021"
RIG_R_LEASE_BUCKET="arkova1-s33-immutable-authority-ledger"
RIG_R_LEASE_PREFIX="s33/rig-leases"
RIG_R_LEASE_OBJECT_NAME="${RIG_R_LEASE_PREFIX}/RIG-R.singleton.json"
RIG_B1_NAME="s33-rig-b1"
RIG_B1_SERVICE="arkova-worker-s33-rig-b1-staging"
RIG_B1_GCP_PROJECT="arkova1"
RIG_B1_GCP_REGION="us-central1"
RIG_B1_LEDGER_BUCKET="arkova1-s33-immutable-authority-ledger"
RIG_B1_APPROVAL_CLAIM_PREFIX="s33/rig-b1/node-approval-claims"
RIG_B1_TOPOLOGY_PREFIX="s33/rig-b1/topology-ownership"
RIG_B1_APPROVAL_VERIFIER="scripts/staging/s33-b1-node-approval.mjs"
# This is the bootstrap trust for the verifier that authenticates the signed
# source HEAD/tree (and this teardown script's own digest). Update only in the
# same reviewed candidate that changes the verifier.
RIG_B1_APPROVAL_VERIFIER_SHA256="3b019febc8fcc3ef60f09fb52afa0ab599d4297e467ee1827050a05047844920"
RIG_B1_TRUSTED_NODE_PATH="/opt/homebrew/Cellar/node/25.6.1/bin/node"
RIG_B1_TRUSTED_NODE_SHA256="8b6a6d43e16ddc3cddaf1217fb75dbe7151e342e36317491bf3ef4a1ec5d4202"
RIG_B1_TRUSTED_NODE_VERSION="v25.6.1"
RIG_B1_NODE_ZONE="us-central1-a"
RIG_B1_ARTIFACT_REPOSITORY_LOCATION="us-central1"
RIG_B1_ARTIFACT_REPOSITORY="arkova-worker-images"
RIG_B1_EXPECTED_SCHEDULER_SUFFIXES=(
  "batch-anchors"
  "batch-anchors-forced-flush"
  "check-confirmations"
  "org-queue-scheduler"
  "populate-confirmation-proofs"
  "recover-broadcasts"
)
RIG_B1_EXPECTED_SCHEDULER_PATHS=(
  "/jobs/batch-anchors"
  "/jobs/batch-anchors?force=true"
  "/jobs/check-confirmations"
  "/jobs/org-queue-scheduler"
  "/jobs/populate-confirmation-proofs"
  "/jobs/recover-broadcasts"
)

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
B1_APPROVAL_ARTIFACT=""
APPLY=0
FLAG_ONLY=0

usage() {
  sed -n '2,44p' "$0"
  echo
  echo "Usage: $0 --project-ref <ref> --service <arkova-worker-*-staging> [--service <second-service>]"
  echo "          [--rig-name <rig-name>] [--rig-id RIG-G1-A|RIG-G1-B|RIG-B1|RIG-R] [--apply] [--flag-only]"
  echo "          [--vertex-endpoint <resource>] [--vertex-model <resource>]"
  echo "          [--deployed-model-id <id>] [--runtime-sa <email>] [--lease-id <id>]"
  echo "          [--b1-approval-artifact <founder-cto-signed-envelope.json>]"
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
    --b1-approval-artifact) B1_APPROVAL_ARTIFACT="${2:?}"; shift 2 ;;
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

IS_RIG_B1=0
IS_RIG_R=0
IS_RIG_G1_A=0
IS_RIG_G1_B=0
if [[ "$RIG_ID" == "RIG-B1" ]]; then
  IS_RIG_B1=1
  if [[ "$RIG_NAME" != "$RIG_B1_NAME" || ${#SERVICES[@]} -ne 1 \
    || "${SERVICES[0]}" != "$RIG_B1_SERVICE" ]]; then
    echo "ERROR: RIG-B1 teardown requires exact rig '$RIG_B1_NAME' and sole service '$RIG_B1_SERVICE'." >&2
    exit 2
  fi
  if [[ $FLAG_ONLY -eq 1 ]]; then
    echo "ERROR: RIG-B1 teardown cannot --flag-only; every recurring resource must be proven absent." >&2
    exit 2
  fi
  if [[ "$GCP_PROJECT" != "$RIG_B1_GCP_PROJECT" \
    || "$CLOUD_RUN_REGION" != "$RIG_B1_GCP_REGION" ]]; then
    echo "ERROR: RIG-B1 teardown requires exact project arkova1 / region us-central1." >&2
    exit 2
  fi
  if [[ -z "$B1_APPROVAL_ARTIFACT" ]]; then
    echo "ERROR: RIG-B1 teardown requires --b1-approval-artifact for cryptographic ownership binding." >&2
    exit 2
  fi
  if [[ -n "$VERTEX_ENDPOINT" || -n "$VERTEX_MODEL" \
    || -n "$DEPLOYED_MODEL_ID" || -n "$RUNTIME_SA" || -n "$LEASE_ID" ]]; then
    echo "ERROR: RIG-R-only teardown inputs are forbidden for RIG-B1." >&2
    exit 2
  fi
elif [[ "$RIG_ID" == "RIG-G1-A" || "$RIG_ID" == "RIG-G1-B" ]]; then
  [[ "$RIG_ID" == "RIG-G1-A" ]] && IS_RIG_G1_A=1 || IS_RIG_G1_B=1
  expected_name="$RIG_G1_A_NAME"
  expected_service="$RIG_G1_A_SERVICE"
  expected_runtime_sa="$RIG_G1_A_RUNTIME_SA"
  if [[ $IS_RIG_G1_B -eq 1 ]]; then
    expected_name="$RIG_G1_B_NAME"
    expected_service="$RIG_G1_B_SERVICE"
    expected_runtime_sa="$RIG_G1_B_RUNTIME_SA"
  fi
  if [[ "$RIG_NAME" != "$expected_name" || ${#SERVICES[@]} -ne 1 \
    || "${SERVICES[0]}" != "$expected_service" ]]; then
    echo "ERROR: $RIG_ID teardown requires exact rig '$expected_name' and sole service '$expected_service'." >&2
    exit 2
  fi
  if [[ $FLAG_ONLY -eq 1 || "$GCP_PROJECT" != "arkova1" || "$CLOUD_RUN_REGION" != "us-central1" ]]; then
    echo "ERROR: $RIG_ID teardown requires exact arkova1/us-central1 and full zero-cost reclaim." >&2
    exit 2
  fi
  if [[ "$RUNTIME_SA" != "$expected_runtime_sa" || -n "$LEASE_ID" || -n "$B1_APPROVAL_ARTIFACT" ]]; then
    echo "ERROR: $RIG_ID teardown runtime/special inputs do not match its exact physical arm." >&2
    exit 2
  fi
  if [[ $IS_RIG_G1_A -eq 1 ]]; then
    if [[ -n "$VERTEX_ENDPOINT" || -n "$VERTEX_MODEL" || -n "$DEPLOYED_MODEL_ID" ]]; then
      echo "ERROR: RIG-G1-A owns no Vertex endpoint or deployed model." >&2
      exit 2
    fi
  elif [[ "$VERTEX_ENDPOINT" != "$RIG_G1_B_ENDPOINT" \
    || "$VERTEX_MODEL" != "$RIG_R_PROTECTED_V6_MODEL" \
    || "$DEPLOYED_MODEL_ID" != "$RIG_G1_B_DEPLOYED_MODEL_ID" ]]; then
    echo "ERROR: RIG-G1-B teardown requires exact endpoint 733002/deployment 7330021 and preserves the canonical v6 model." >&2
    exit 2
  fi
elif [[ "$RIG_ID" == "RIG-R" ]]; then
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
  || -n "$DEPLOYED_MODEL_ID" || -n "$RUNTIME_SA" || -n "$LEASE_ID" \
  || -n "$B1_APPROVAL_ARTIFACT" ]]; then
  echo "ERROR: special teardown inputs require the complete exact RIG-B1 or RIG-R tuple." >&2
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

delete_cloud_run_service_if_present() {
  local service="$1"
  local inventory service_count

  if [[ $APPLY -ne 1 ]]; then
    print_cmd gcloud run services delete "$service" \
      --project="$GCP_PROJECT" \
      --region="$CLOUD_RUN_REGION" \
      --quiet
    return 0
  fi
  inventory="$(gcloud run services list \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --format=json)" || {
    echo "ERROR: cannot enumerate Cloud Run services before exact teardown." >&2
    return 1
  }
  service_count="$(jq -r --arg service "$service" \
    '[.[] | select(.metadata.name == $service)] | length' <<<"$inventory")" || return 1
  case "$service_count" in
    0)
      echo "# Cloud Run service '$service' is already absent; continuing exact partial teardown."
      ;;
    1)
      run_cmd gcloud run services delete "$service" \
        --project="$GCP_PROJECT" \
        --region="$CLOUD_RUN_REGION" \
        --quiet
      ;;
    *)
      echo "ERROR: Cloud Run inventory returned non-unique service '$service'." >&2
      return 1
      ;;
  esac
}

rig_r_runtime_impersonation_members() {
  local policy_json
  policy_json="$(gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" \
    --project="$GCP_PROJECT" --format=json)" || return 1
  jq -cer --arg role "$RIG_R_RUNTIME_IMPERSONATION_ROLE" \
    '[.bindings[]? | select(.role == $role) | .members[]?] | sort | unique' \
    <<<"$policy_json"
}

assert_rig_r_runtime_impersonation_exact() {
  local observed
  observed="$(rig_r_runtime_impersonation_members)" || {
    echo "ERROR: cannot observe RIG-R temporary runtime impersonation IAM." >&2
    return 1
  }
  if [[ "$observed" != "[\"${RIG_R_RUNTIME_IMPERSONATION_MEMBER}\"]" ]]; then
    echo "ERROR: RIG-R temporary runtime impersonation IAM differs from the one authority-bound operator." >&2
    return 1
  fi
}

remove_rig_r_runtime_impersonation() {
  if [[ $APPLY -ne 1 ]]; then
    print_cmd gcloud iam service-accounts remove-iam-policy-binding "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --member="$RIG_R_RUNTIME_IMPERSONATION_MEMBER" \
      --role="$RIG_R_RUNTIME_IMPERSONATION_ROLE" --condition=None --quiet
    print_cmd gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json
    return 0
  fi
  run_cmd gcloud iam service-accounts remove-iam-policy-binding "$RUNTIME_SA" \
    --project="$GCP_PROJECT" --member="$RIG_R_RUNTIME_IMPERSONATION_MEMBER" \
    --role="$RIG_R_RUNTIME_IMPERSONATION_ROLE" --condition=None --quiet
  local observed
  observed="$(rig_r_runtime_impersonation_members)" || {
    echo "ERROR: cannot verify RIG-R runtime impersonation removal." >&2
    return 1
  }
  if [[ "$observed" != "[]" ]]; then
    echo "ERROR: RIG-R runtime impersonation IAM remains after exact removal." >&2
    return 1
  fi
  echo "# RIG-R runtime impersonation removed and proved absent before service-account deletion."
}

trusted_b1_sha256_file() {
  local path="$1" output digest
  if [[ "$path" != /* || ! -f "$path" || -L "$path" ]]; then
    echo "ERROR: RIG-B1 trust input must be a non-symlink regular file: $path" >&2
    return 1
  fi
  output="$(/usr/bin/env -i TZ=UTC LC_ALL=C LANG=C \
    /usr/bin/shasum -a 256 -- "$path")" || return 1
  digest="${output%%[[:space:]]*}"
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: RIG-B1 trust input digest was not canonical SHA-256." >&2
    return 1
  fi
  printf '%s\n' "$digest"
}

verify_b1_teardown_authority() {
  [[ $IS_RIG_B1 -eq 1 ]] || return 0
  local script_input_dir script_dir verifier_path teardown_path
  local node_digest node_version verifier_digest teardown_digest verified_json
  case "$0" in */*) script_input_dir="${0%/*}" ;; *) script_input_dir="." ;; esac
  script_dir="$(cd -P -- "$script_input_dir" 2>/dev/null && pwd -P)" || {
    echo "ERROR: cannot resolve the RIG-B1 teardown source directory." >&2
    exit 2
  }
  verifier_path="${script_dir}/${RIG_B1_APPROVAL_VERIFIER##*/}"
  teardown_path="${script_dir}/${0##*/}"

  if [[ "$RIG_B1_TRUSTED_NODE_PATH" != /* \
    || ! -f "$RIG_B1_TRUSTED_NODE_PATH" || -L "$RIG_B1_TRUSTED_NODE_PATH" \
    || ! -x "$RIG_B1_TRUSTED_NODE_PATH" ]]; then
    echo "ERROR: RIG-B1 teardown cannot resolve its code-bound Node verifier launcher." >&2
    exit 2
  fi
  node_digest="$(trusted_b1_sha256_file "$RIG_B1_TRUSTED_NODE_PATH")" || exit 2
  node_version="$(/usr/bin/env -i TZ=UTC "$RIG_B1_TRUSTED_NODE_PATH" --version 2>/dev/null || true)"
  if [[ "$node_digest" != "$RIG_B1_TRUSTED_NODE_SHA256" \
    || "$node_version" != "$RIG_B1_TRUSTED_NODE_VERSION" ]]; then
    echo "ERROR: RIG-B1 teardown Node launcher differs from the code-bound trust tuple." >&2
    exit 2
  fi
  verifier_digest="$(trusted_b1_sha256_file "$verifier_path")" || exit 2
  if [[ "$verifier_digest" != "$RIG_B1_APPROVAL_VERIFIER_SHA256" ]]; then
    echo "ERROR: RIG-B1 approval verifier differs from the code-bound bootstrap digest." >&2
    exit 2
  fi
  if ! verified_json="$(/usr/bin/env -i TZ=UTC \
    "$RIG_B1_TRUSTED_NODE_PATH" --no-addons --no-global-search-paths \
    "$verifier_path" --artifact "$B1_APPROVAL_ARTIFACT" \
    --allow-expired-for-teardown)"; then
    echo "ERROR: RIG-B1 founder/CTO approval signature verification failed." >&2
    exit 2
  fi
  teardown_digest="sha256:$(trusted_b1_sha256_file "$teardown_path")" || exit 2
  if ! B1_VERIFIED_APPROVAL_JSON="$(jq -ce \
    --arg rig_name "$RIG_B1_NAME" \
    --arg service "$RIG_B1_SERVICE" \
    --arg teardown_digest "$teardown_digest" '
      select(
        type == "object"
        and .status == "VERIFIED"
        and .keyId == "arkova.s33.b1-evidence.ed25519.v1"
        and .verifierIdentity == "arkova.s33.verifier.public-ed25519.v1"
        and .payload.authority.approverIdentity == "arkova.s33.approver.founder-cto.v1"
        and .payload.authority.purpose == "RIG_B1_BITCOIN_CORE_PROVISION"
        and .payload.run.rigId == "RIG-B1"
        and .payload.run.rigName == $rig_name
        and .payload.run.workerService == $service
        and .payload.candidate.teardownScriptSha256 == $teardown_digest
        and .payload.topology.provider == {
          workerProvider: "rpc",
          primary: "bitcoin-core-signet-rpc",
          secondary: "mempool-space-signet",
          secondaryApiUrl: "https://mempool.space/signet/api"
        }
        and .payload.topology.nodeSecretEnvs == ["BITCOIN_RPC_AUTH"]
        and .payload.topology.forbiddenNodeSecretEnvs == ["BITCOIN_TREASURY_WIF"]
        and .payload.topology.treasuryWatchOnly.wifOnNode == false
        and .payload.teardown.projectedMonthlyRecurringUsd == 0
      )
    ' <<<"$verified_json" 2>/dev/null)"; then
    echo "ERROR: RIG-B1 signed authority does not bind this teardown/run/provider contract." >&2
    exit 2
  fi

  B1_APPROVAL_ID="$(jq -r '.payload.approvalId' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_APPROVAL_ENVELOPE_SHA256="$(jq -r '.envelopeSha256' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_APPROVAL_PAYLOAD_SHA256="$(jq -r '.signedPayloadSha256' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_APPROVAL_EXPIRES_AT="$(jq -r '.payload.expiresAt' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SOURCE_HEAD="$(jq -r '.payload.candidate.sourceHeadSha' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SOURCE_TREE="$(jq -r '.payload.candidate.sourceTreeSha' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_CORPUS_DIGEST="$(jq -r '.payload.candidate.corpusDigest' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_RELEASE_CANDIDATE_ID="$(jq -r '.payload.candidate.releaseCandidateId' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SOAK_ID="$(jq -r '.payload.run.soakId' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_LEASE_ID="$(jq -r '.payload.run.leaseId' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_RUNTIME_SA="$(jq -r '.payload.run.workerRuntimeServiceAccount' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SCHEDULER_SA="$(jq -r '.payload.run.schedulerOidcServiceAccount' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SIGNED_RESOURCES_JSON="$(jq -c '.payload.topology.resources' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SIGNED_SECRETS_JSON="$(jq -c '.payload.topology.secretReferences' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SPEND_CAP_USD="$(jq -r '.payload.budget.spendCapUsd' <<<"$B1_VERIFIED_APPROVAL_JSON")"
  if [[ "$B1_RUNTIME_SA" == "$B1_SCHEDULER_SA" \
    || "$B1_RUNTIME_SA" == *bitcoin-core* \
    || "$B1_SCHEDULER_SA" == *bitcoin-core* \
    || "$B1_RUNTIME_SA" != *rig-b1* \
    || "$B1_SCHEDULER_SA" != *rig-b1* ]]; then
    echo "ERROR: RIG-B1 worker runtime, Scheduler OIDC, and Bitcoin Core identities must be dedicated and distinct." >&2
    exit 2
  fi
  B1_NODE_RPC_AUTH_SECRET="$(jq -r \
    '.payload.topology.secretReferences[] | select(.env == "BITCOIN_RPC_AUTH") | .secretName' \
    <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_RPC_URL_SECRET="$(jq -r \
    '.payload.topology.secretReferences[] | select(.env == "BITCOIN_RPC_URL") | .secretName' \
    <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_BITCOIN_CORE_IMAGE="$(jq -r '.payload.candidate.bitcoinCoreImage' \
    <<<"$B1_VERIFIED_APPROVAL_JSON")"
  if [[ ! "$B1_BITCOIN_CORE_IMAGE" =~ ^us-central1-docker[.]pkg[.]dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: RIG-B1 signed Bitcoin Core image is outside the exact arkova1 Artifact Registry boundary." >&2
    exit 2
  fi
  B1_ARTIFACT_REPOSITORY_LOCATION="$RIG_B1_ARTIFACT_REPOSITORY_LOCATION"
  B1_ARTIFACT_REPOSITORY="$RIG_B1_ARTIFACT_REPOSITORY"
  B1_SUPABASE_URL_SECRET="$(jq -r \
    '.payload.topology.secretReferences[] | select(.env == "SUPABASE_URL") | .secretName' \
    <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_SUPABASE_ROLE_SECRET="$(jq -r \
    '.payload.topology.secretReferences[] | select(.env == "SUPABASE_SERVICE_ROLE_KEY") | .secretName' \
    <<<"$B1_VERIFIED_APPROVAL_JSON")"
  B1_WORKER_SECRET_NAMES=()
  while IFS= read -r secret_name; do
    [[ -n "$secret_name" ]] && B1_WORKER_SECRET_NAMES+=("$secret_name")
  done < <(jq -r '.payload.topology.secretReferences[].secretName' <<<"$B1_VERIFIED_APPROVAL_JSON")
  if [[ ${#B1_WORKER_SECRET_NAMES[@]} -ne 9 \
    || -z "$B1_NODE_RPC_AUTH_SECRET" || -z "$B1_RPC_URL_SECRET" \
    || "$B1_SUPABASE_URL_SECRET" != "supabase-url-s33-rig-b1-staging" \
    || "$B1_SUPABASE_ROLE_SECRET" != "supabase-service-role-key-s33-rig-b1-staging" ]]; then
    echo "ERROR: RIG-B1 signed secret inventory is incomplete or outside the exact rig boundary." >&2
    exit 2
  fi

  B1_APPROVAL_CLAIM_OBJECT_NAME="${RIG_B1_APPROVAL_CLAIM_PREFIX}/${B1_APPROVAL_ID}.json"
  B1_APPROVAL_CLAIM_URI="gs://${RIG_B1_LEDGER_BUCKET}/${B1_APPROVAL_CLAIM_OBJECT_NAME}"
  B1_TOPOLOGY_OBJECT_NAME="${RIG_B1_TOPOLOGY_PREFIX}/${B1_APPROVAL_ID}.json"
  B1_TOPOLOGY_URI="gs://${RIG_B1_LEDGER_BUCKET}/${B1_TOPOLOGY_OBJECT_NAME}"
  B1_EXPECTED_SCHEDULER_NAMES_JSON='[]'
  local suffix expected_name
  for suffix in "${RIG_B1_EXPECTED_SCHEDULER_SUFFIXES[@]}"; do
    expected_name="${RIG_B1_SERVICE}-${suffix}"
    B1_EXPECTED_SCHEDULER_NAMES_JSON="$(jq -c --arg name "$expected_name" '. + [$name]' \
      <<<"$B1_EXPECTED_SCHEDULER_NAMES_JSON")"
  done
}

load_b1_locked_ownership() {
  local claim_metadata claim_generation claim_generation_uri claim_json
  local topology_metadata topology_generation topology_generation_uri topology_json
  claim_metadata="$(gcloud storage objects describe "$B1_APPROVAL_CLAIM_URI" \
    --project="$GCP_PROJECT" --raw --format=json)" || {
    echo "ERROR: cannot observe the immutable RIG-B1 approval claim." >&2
    exit 1
  }
  claim_generation="$(jq -r '.generation | tostring' <<<"$claim_metadata")"
  if ! jq -e \
    --arg bucket "$RIG_B1_LEDGER_BUCKET" \
    --arg name "$B1_APPROVAL_CLAIM_OBJECT_NAME" \
    --arg expires_at "$B1_APPROVAL_EXPIRES_AT" '
      type == "object"
      and .bucket == $bucket
      and .name == $name
      and (.generation | tostring | test("^[1-9][0-9]*$"))
      and .retention.mode == "Locked"
      and .retention.retainUntilTime >= $expires_at
    ' >/dev/null 2>&1 <<<"$claim_metadata"; then
    echo "ERROR: RIG-B1 approval claim is not the exact generation-bound Locked audit object." >&2
    exit 1
  fi
  claim_generation_uri="${B1_APPROVAL_CLAIM_URI}#${claim_generation}"
  claim_json="$(gcloud storage cat "$claim_generation_uri" --project="$GCP_PROJECT")" || {
    echo "ERROR: cannot read the immutable RIG-B1 approval claim generation." >&2
    exit 1
  }
  if ! jq -e \
    --arg approval_id "$B1_APPROVAL_ID" \
    --arg envelope_sha "$B1_APPROVAL_ENVELOPE_SHA256" \
    --arg payload_sha "$B1_APPROVAL_PAYLOAD_SHA256" \
    --arg source_head "$B1_SOURCE_HEAD" \
    --arg source_tree "$B1_SOURCE_TREE" \
    --arg corpus "$B1_CORPUS_DIGEST" \
    --arg rc_id "$B1_RELEASE_CANDIDATE_ID" \
    --arg soak_id "$B1_SOAK_ID" \
    --arg lease_id "$B1_LEASE_ID" \
    --argjson spend_cap "$B1_SPEND_CAP_USD" '
      type == "object"
      and ((keys | sort) == ([
        "schemaVersion", "approvalId", "envelopeSha256", "signedPayloadSha256",
        "sourceHeadSha", "sourceTreeSha", "corpusDigest", "releaseCandidateId",
        "soakId", "leaseId", "spendCapUsd", "claimedAt"
      ] | sort))
      and .schemaVersion == "arkova.s33.rig-b1.node-approval-claim/v1"
      and .approvalId == $approval_id
      and .envelopeSha256 == $envelope_sha
      and .signedPayloadSha256 == $payload_sha
      and .sourceHeadSha == $source_head
      and .sourceTreeSha == $source_tree
      and .corpusDigest == $corpus
      and .releaseCandidateId == $rc_id
      and .soakId == $soak_id
      and .leaseId == $lease_id
      and .spendCapUsd == $spend_cap
      and (.claimedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
    ' >/dev/null 2>&1 <<<"$claim_json"; then
    echo "ERROR: immutable RIG-B1 claim content does not bind the verified approval/run." >&2
    exit 1
  fi

  topology_metadata="$(gcloud storage objects describe "$B1_TOPOLOGY_URI" \
    --project="$GCP_PROJECT" --raw --format=json)" || {
    echo "ERROR: cannot observe the immutable RIG-B1 topology ownership object." >&2
    exit 1
  }
  topology_generation="$(jq -r '.generation | tostring' <<<"$topology_metadata")"
  if ! jq -e \
    --arg bucket "$RIG_B1_LEDGER_BUCKET" \
    --arg name "$B1_TOPOLOGY_OBJECT_NAME" \
    --arg expires_at "$B1_APPROVAL_EXPIRES_AT" '
      type == "object"
      and .bucket == $bucket
      and .name == $name
      and (.generation | tostring | test("^[1-9][0-9]*$"))
      and .retention.mode == "Locked"
      and .retention.retainUntilTime >= $expires_at
    ' >/dev/null 2>&1 <<<"$topology_metadata"; then
    echo "ERROR: RIG-B1 topology ownership is not the exact generation-bound Locked audit object." >&2
    exit 1
  fi
  topology_generation_uri="${B1_TOPOLOGY_URI}#${topology_generation}"
  topology_json="$(gcloud storage cat "$topology_generation_uri" --project="$GCP_PROJECT")" || {
    echo "ERROR: cannot read the immutable RIG-B1 topology ownership generation." >&2
    exit 1
  }
  if ! B1_TOPOLOGY_JSON="$(jq -ce \
    --arg approval_id "$B1_APPROVAL_ID" \
    --arg envelope_sha "$B1_APPROVAL_ENVELOPE_SHA256" \
    --arg payload_sha "$B1_APPROVAL_PAYLOAD_SHA256" \
    --arg source_head "$B1_SOURCE_HEAD" \
    --arg source_tree "$B1_SOURCE_TREE" \
    --arg corpus "$B1_CORPUS_DIGEST" \
    --arg rc_id "$B1_RELEASE_CANDIDATE_ID" \
    --arg rig_name "$RIG_B1_NAME" \
    --arg soak_id "$B1_SOAK_ID" \
    --arg lease_id "$B1_LEASE_ID" \
    --arg project_ref "$PROJECT_REF" \
    --arg service "$RIG_B1_SERVICE" \
    --arg runtime_sa "$B1_RUNTIME_SA" \
    --arg scheduler_sa "$B1_SCHEDULER_SA" \
    --arg claim_uri "$B1_APPROVAL_CLAIM_URI" \
    --arg claim_generation "$claim_generation" \
    --arg supabase_url_secret "$B1_SUPABASE_URL_SECRET" \
    --arg supabase_role_secret "$B1_SUPABASE_ROLE_SECRET" \
    --arg rpc_url_secret "$B1_RPC_URL_SECRET" \
    --arg rpc_auth_secret "$B1_NODE_RPC_AUTH_SECRET" \
    --arg bitcoin_core_image "$B1_BITCOIN_CORE_IMAGE" \
    --arg treasury_split_plan_digest "$(jq -r \
      '.payload.topology.treasuryWatchOnly.preSplitPlanDigest' \
      <<<"$B1_VERIFIED_APPROVAL_JSON")" \
    --arg treasury_split_txid "$(jq -r \
      '.payload.topology.treasuryWatchOnly.splitTransactionId' \
      <<<"$B1_VERIFIED_APPROVAL_JSON")" \
    --argjson treasury_total_sats "$(jq -c \
      '.payload.topology.treasuryWatchOnly.expectedTotalSats' \
      <<<"$B1_VERIFIED_APPROVAL_JSON")" \
    --argjson resources "$B1_SIGNED_RESOURCES_JSON" \
    --argjson secrets "$B1_SIGNED_SECRETS_JSON" \
    --argjson scheduler_names "$B1_EXPECTED_SCHEDULER_NAMES_JSON" '
      select(
        type == "object"
        and ((keys | sort) == ([
          "schemaVersion", "approvalId", "envelopeSha256", "signedPayloadSha256",
          "sourceHeadSha", "sourceTreeSha", "corpusDigest", "releaseCandidateId",
          "rigId", "rigName", "soakId", "leaseId", "gcpProjectId", "gcpRegion",
          "supabaseProjectRef", "supabaseProjectName", "workerService",
          "workerRuntimeServiceAccount", "schedulerOidcServiceAccount",
          "cloudRunServiceUrl", "resources", "secretReferences", "schedulerJobNames",
          "generatedSecretNames", "nodeReadiness", "resourceIdentities", "approvalClaim",
          "projectedMonthlyRecurringUsd"
        ] | sort))
        and .schemaVersion == "arkova.s33.rig-b1.topology-ownership/v1"
        and .approvalId == $approval_id
        and .envelopeSha256 == $envelope_sha
        and .signedPayloadSha256 == $payload_sha
        and .sourceHeadSha == $source_head
        and .sourceTreeSha == $source_tree
        and .corpusDigest == $corpus
        and .releaseCandidateId == $rc_id
        and .rigId == "RIG-B1"
        and .rigName == $rig_name
        and .soakId == $soak_id
        and .leaseId == $lease_id
        and .gcpProjectId == "arkova1"
        and .gcpRegion == "us-central1"
        and .supabaseProjectRef == $project_ref
        and .supabaseProjectName == "arkova-soak-s33-rig-b1"
        and .workerService == $service
        and .workerRuntimeServiceAccount == $runtime_sa
        and .schedulerOidcServiceAccount == $scheduler_sa
        and (.cloudRunServiceUrl | type == "string" and test("^https://[A-Za-z0-9.-]+$") )
        and .resources == $resources
        and .secretReferences == $secrets
        and .schedulerJobNames == $scheduler_names
        and (.generatedSecretNames | type == "array" and length >= 2 and length <= 4)
        and ((.generatedSecretNames | unique | length) == (.generatedSecretNames | length))
        and (.generatedSecretNames | index($supabase_url_secret) != null)
        and (.generatedSecretNames | index($supabase_role_secret) != null)
        and all(.generatedSecretNames[];
          . == $supabase_url_secret or . == $supabase_role_secret
          or . == $rpc_url_secret or . == $rpc_auth_secret)
        and (.nodeReadiness | type == "object")
        and ((.nodeReadiness | keys | sort) == ([
          "schemaVersion", "bitcoinCoreVersion", "bitcoinCoreImage",
          "sourceTarballSha256", "chain", "initialBlockDownload", "blocks",
          "headers", "genesisHash", "txindexSynced", "txindexBestBlockHeight",
          "treasurySplitPlanDigest", "splitTransactionId", "confirmedOutputCount",
          "confirmedTotalSats", "splitBlockHash", "splitBlockHeader", "txOutProof"
        ] | sort))
        and .nodeReadiness.schemaVersion == "arkova.s33.rig-b1.node-readiness/v1"
        and .nodeReadiness.bitcoinCoreVersion == "31.1"
        and .nodeReadiness.bitcoinCoreImage == $bitcoin_core_image
        and .nodeReadiness.sourceTarballSha256 ==
          "b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"
        and .nodeReadiness.chain == "signet"
        and .nodeReadiness.initialBlockDownload == false
        and (.nodeReadiness.blocks | type == "number" and floor == . and . >= 0)
        and (.nodeReadiness.headers | type == "number" and floor == . and . >= 0)
        and (.nodeReadiness.headers >= .nodeReadiness.blocks)
        and .nodeReadiness.genesisHash ==
          "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6"
        and .nodeReadiness.txindexSynced == true
        and .nodeReadiness.txindexBestBlockHeight == .nodeReadiness.blocks
        and .nodeReadiness.treasurySplitPlanDigest == $treasury_split_plan_digest
        and .nodeReadiness.splitTransactionId == $treasury_split_txid
        and .nodeReadiness.confirmedOutputCount == 32
        and .nodeReadiness.confirmedTotalSats == $treasury_total_sats
        and (.nodeReadiness.splitBlockHash | type == "string" and test("^[0-9a-f]{64}$"))
        and (.nodeReadiness.splitBlockHeader | type == "string" and test("^[0-9a-f]{160}$"))
        and (.nodeReadiness.txOutProof | type == "string" and test("^([0-9a-f]{2})+$"))
        and (.resourceIdentities | type == "object")
        and ((.resourceIdentities | keys | sort) == ([
          "cloudRunServiceUid", "vmId", "bootDiskName", "bootDiskId", "dataDiskId",
          "internalAddressId", "externalAddressId", "rpcFirewallId", "vpcConnectorName",
          "subnetId", "networkId", "nodeServiceAccountUniqueId",
          "workerRuntimeServiceAccountUniqueId", "schedulerOidcServiceAccountUniqueId"
        ] | sort))
        and (.resourceIdentities.cloudRunServiceUid | test("^[A-Za-z0-9-]{8,}$"))
        and (.resourceIdentities.bootDiskName == .resources.bootDisk)
        and all([
          .resourceIdentities.vmId, .resourceIdentities.bootDiskId,
          .resourceIdentities.dataDiskId, .resourceIdentities.internalAddressId,
          .resourceIdentities.externalAddressId, .resourceIdentities.rpcFirewallId,
          .resourceIdentities.subnetId, .resourceIdentities.networkId,
          .resourceIdentities.nodeServiceAccountUniqueId,
          .resourceIdentities.workerRuntimeServiceAccountUniqueId,
          .resourceIdentities.schedulerOidcServiceAccountUniqueId
        ][]; type == "string" and test("^[1-9][0-9]*$"))
        and .resourceIdentities.vpcConnectorName ==
          "projects/arkova1/locations/us-central1/connectors/\(.resources.vpcConnector)"
        and .approvalClaim == {objectUri: $claim_uri, generation: $claim_generation}
        and .projectedMonthlyRecurringUsd == 0
      )
    ' <<<"$topology_json" 2>/dev/null)"; then
    echo "ERROR: Locked RIG-B1 topology does not exactly bind the verified approval and teardown targets." >&2
    exit 1
  fi

  B1_APPROVAL_CLAIM_GENERATION="$claim_generation"
  B1_TOPOLOGY_GENERATION="$topology_generation"
  B1_CLOUD_RUN_URL="$(jq -r '.cloudRunServiceUrl' <<<"$B1_TOPOLOGY_JSON")"
  B1_GENERATED_SECRET_NAMES=()
  while IFS= read -r secret_name; do
    [[ -n "$secret_name" ]] && B1_GENERATED_SECRET_NAMES+=("$secret_name")
  done < <(jq -r '.generatedSecretNames[]' <<<"$B1_TOPOLOGY_JSON")
}

b1_observe_json() {
  local label="$1"
  shift
  local observed
  observed="$("$@")" || {
    echo "ERROR: cannot observe RIG-B1 $label before teardown." >&2
    exit 1
  }
  if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$observed"; then
    echo "ERROR: RIG-B1 $label observation was not a JSON object." >&2
    exit 1
  fi
  printf '%s\n' "$observed"
}

b1_require_secret_member() {
  local secret_name="$1" member="$2" label="$3" policy_json
  policy_json="$(gcloud secrets get-iam-policy "$secret_name" \
    --project="$GCP_PROJECT" --format=json)" || {
    echo "ERROR: cannot observe $label Secret Manager IAM on '$secret_name'." >&2
    exit 1
  }
  if ! jq -e --arg member "serviceAccount:${member}" '
    any(.bindings[]?; .role == "roles/secretmanager.secretAccessor"
      and any(.members[]?; . == $member))
  ' >/dev/null 2>&1 <<<"$policy_json"; then
    echo "ERROR: $label secret grant is absent; ownership topology is not live-exact." >&2
    exit 1
  fi
}

preflight_b1_owned_resources() {
  local resources identities service_json scheduler_json scheduler_name scheduler_uri
  local scheduler_path scheduler_index all_scheduler observed_scheduler='[]' job job_base
  local vm_json boot_disk_json data_disk_json internal_address_json external_address_json
  local firewall_json connector_json subnet_json network_json node_sa_json
  local worker_sa_json scheduler_sa_json projects_json
  local repo_policy secret_name
  resources="$(jq -c '.resources' <<<"$B1_TOPOLOGY_JSON")"
  identities="$(jq -c '.resourceIdentities' <<<"$B1_TOPOLOGY_JSON")"

  service_json="$(b1_observe_json "Cloud Run service" gcloud run services describe \
    "$RIG_B1_SERVICE" --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json)"
  if ! jq -e \
    --arg name "$RIG_B1_SERVICE" \
    --arg uid "$(jq -r '.cloudRunServiceUid' <<<"$identities")" \
    --arg url "$B1_CLOUD_RUN_URL" '
      .metadata.name == $name and .metadata.uid == $uid and .status.url == $url
    ' >/dev/null 2>&1 <<<"$service_json"; then
    echo "ERROR: Cloud Run UID/URL does not match immutable RIG-B1 ownership." >&2
    exit 1
  fi

  all_scheduler="$(gcloud scheduler jobs list --project="$GCP_PROJECT" \
    --location="$CLOUD_RUN_REGION" --format='value(name)')" || {
    echo "ERROR: cannot enumerate the RIG-B1 Scheduler boundary." >&2
    exit 1
  }
  while IFS= read -r job; do
    [[ -n "$job" ]] || continue
    job_base="${job##*/}"
    if [[ "$job_base" == "${RIG_B1_SERVICE}-"* ]]; then
      observed_scheduler="$(jq -c --arg name "$job_base" '. + [$name]' <<<"$observed_scheduler")"
    fi
  done <<<"$all_scheduler"
  if ! jq -e --argjson expected "$B1_EXPECTED_SCHEDULER_NAMES_JSON" \
    'sort == ($expected | sort)' >/dev/null 2>&1 <<<"$observed_scheduler"; then
    echo "ERROR: RIG-B1 must own exactly six Scheduler jobs; inventory differs." >&2
    exit 1
  fi
  scheduler_index=0
  while [[ $scheduler_index -lt ${#RIG_B1_EXPECTED_SCHEDULER_SUFFIXES[@]} ]]; do
    scheduler_name="${RIG_B1_SERVICE}-${RIG_B1_EXPECTED_SCHEDULER_SUFFIXES[$scheduler_index]}"
    scheduler_path="${RIG_B1_EXPECTED_SCHEDULER_PATHS[$scheduler_index]}"
    scheduler_uri="${B1_CLOUD_RUN_URL}${scheduler_path}"
    scheduler_json="$(b1_observe_json "Scheduler job '$scheduler_name'" \
      gcloud scheduler jobs describe "$scheduler_name" --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" --format=json)"
    if ! jq -e \
      --arg name "$scheduler_name" \
      --arg uri "$scheduler_uri" \
      --arg scheduler_sa "$B1_SCHEDULER_SA" '
        (.name == $name or (.name | endswith("/jobs/\($name)")))
        and .httpTarget.httpMethod == "POST"
        and .httpTarget.uri == $uri
        and .httpTarget.oidcToken.serviceAccountEmail == $scheduler_sa
      ' >/dev/null 2>&1 <<<"$scheduler_json"; then
      echo "ERROR: Scheduler job '$scheduler_name' is not bound to the signed service/OIDC target." >&2
      exit 1
    fi
    scheduler_index=$((scheduler_index + 1))
  done

  vm_json="$(b1_observe_json "Bitcoin Core VM" gcloud compute instances describe \
    "$(jq -r '.vm' <<<"$resources")" --project="$GCP_PROJECT" \
    --zone="$RIG_B1_NODE_ZONE" --format=json)"
  if ! jq -e \
    --arg vm "$(jq -r '.vm' <<<"$resources")" \
    --arg vm_id "$(jq -r '.vmId' <<<"$identities")" \
    --arg boot "$(jq -r '.bootDiskName' <<<"$identities")" \
    --arg data "$(jq -r '.dataDisk' <<<"$resources")" \
    --arg internal_ip "$(jq -r '.payload.topology.network.rpcBind' <<<"$B1_VERIFIED_APPROVAL_JSON")" \
    --arg network "$(jq -r '.network' <<<"$resources")" \
    --arg subnet "$(jq -r '.subnet' <<<"$resources")" \
    --arg node_sa "$(jq -r '.nodeServiceAccount' <<<"$resources")" '
      .name == $vm
      and (.id | tostring) == $vm_id
      and (.networkInterfaces | length) == 1
      and .networkInterfaces[0].networkIP == $internal_ip
      and (.networkInterfaces[0].network | endswith("/networks/\($network)"))
      and (.networkInterfaces[0].subnetwork | endswith("/subnetworks/\($subnet)"))
      and any(.serviceAccounts[]?; .email == $node_sa)
      and any(.disks[]?; .boot == true and .autoDelete == false and (.source | endswith("/disks/\($boot)")))
      and any(.disks[]?; .boot == false and (.source | endswith("/disks/\($data)")))
    ' >/dev/null 2>&1 <<<"$vm_json"; then
    echo "ERROR: Bitcoin Core VM identity/network/disks differ from immutable ownership." >&2
    exit 1
  fi

  boot_disk_json="$(b1_observe_json "boot disk" gcloud compute disks describe \
    "$(jq -r '.bootDiskName' <<<"$identities")" --project="$GCP_PROJECT" \
    --zone="$RIG_B1_NODE_ZONE" --format=json)"
  data_disk_json="$(b1_observe_json "data disk" gcloud compute disks describe \
    "$(jq -r '.dataDisk' <<<"$resources")" --project="$GCP_PROJECT" \
    --zone="$RIG_B1_NODE_ZONE" --format=json)"
  if ! jq -e --arg id "$(jq -r '.bootDiskId' <<<"$identities")" \
    '(.id | tostring) == $id' >/dev/null 2>&1 <<<"$boot_disk_json" \
    || ! jq -e --arg id "$(jq -r '.dataDiskId' <<<"$identities")" \
      '(.id | tostring) == $id' >/dev/null 2>&1 <<<"$data_disk_json"; then
    echo "ERROR: RIG-B1 boot/data disk IDs differ from immutable ownership." >&2
    exit 1
  fi

  internal_address_json="$(b1_observe_json "internal address" gcloud compute addresses describe \
    "$(jq -r '.internalAddress' <<<"$resources")" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)"
  external_address_json="$(b1_observe_json "external address" gcloud compute addresses describe \
    "$(jq -r '.externalAddress' <<<"$resources")" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)"
  if ! jq -e \
    --arg id "$(jq -r '.internalAddressId' <<<"$identities")" \
    --arg address "$(jq -r '.payload.topology.network.rpcBind' <<<"$B1_VERIFIED_APPROVAL_JSON")" \
    --arg subnet "$(jq -r '.subnet' <<<"$resources")" '
      (.id | tostring) == $id and .address == $address
      and (.subnetwork | endswith("/subnetworks/\($subnet)"))
    ' >/dev/null 2>&1 <<<"$internal_address_json" \
    || ! jq -e --arg id "$(jq -r '.externalAddressId' <<<"$identities")" \
      '(.id | tostring) == $id and (.address | type == "string" and length > 0)' \
      >/dev/null 2>&1 <<<"$external_address_json"; then
    echo "ERROR: RIG-B1 address identities differ from immutable ownership." >&2
    exit 1
  fi

  firewall_json="$(b1_observe_json "RPC firewall" gcloud compute firewall-rules describe \
    "$(jq -r '.rpcFirewall' <<<"$resources")" --project="$GCP_PROJECT" --format=json)"
  if ! jq -e \
    --arg id "$(jq -r '.rpcFirewallId' <<<"$identities")" \
    --arg network "$(jq -r '.network' <<<"$resources")" \
    --arg cidr "$(jq -r '.payload.topology.network.rpcAllowCidr' <<<"$B1_VERIFIED_APPROVAL_JSON")" \
    --arg node_sa "$(jq -r '.nodeServiceAccount' <<<"$resources")" '
      (.id | tostring) == $id
      and (.network | endswith("/networks/\($network)"))
      and .sourceRanges == [$cidr]
      and .targetServiceAccounts == [$node_sa]
      and any(.allowed[]?; .IPProtocol == "tcp" and any(.ports[]?; . == "38332"))
    ' >/dev/null 2>&1 <<<"$firewall_json"; then
    echo "ERROR: RIG-B1 RPC firewall differs from immutable signed topology." >&2
    exit 1
  fi

  connector_json="$(b1_observe_json "VPC connector" \
    gcloud compute networks vpc-access connectors describe \
    "$(jq -r '.vpcConnector' <<<"$resources")" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)"
  if ! jq -e \
    --arg name "$(jq -r '.vpcConnectorName' <<<"$identities")" \
    --arg network "$(jq -r '.network' <<<"$resources")" \
    --arg cidr "$(jq -r '.payload.topology.network.rpcAllowCidr' <<<"$B1_VERIFIED_APPROVAL_JSON")" '
      .name == $name
      and (.network == $network or (.network | endswith("/networks/\($network)")))
      and .ipCidrRange == $cidr
    ' >/dev/null 2>&1 <<<"$connector_json"; then
    echo "ERROR: RIG-B1 VPC connector differs from immutable ownership." >&2
    exit 1
  fi

  subnet_json="$(b1_observe_json "subnet" gcloud compute networks subnets describe \
    "$(jq -r '.subnet' <<<"$resources")" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)"
  network_json="$(b1_observe_json "VPC network" gcloud compute networks describe \
    "$(jq -r '.network' <<<"$resources")" --project="$GCP_PROJECT" --format=json)"
  if ! jq -e \
    --arg id "$(jq -r '.subnetId' <<<"$identities")" \
    --arg network "$(jq -r '.network' <<<"$resources")" \
    --arg cidr "$(jq -r '.payload.topology.network.subnetCidr' <<<"$B1_VERIFIED_APPROVAL_JSON")" '
      (.id | tostring) == $id and .ipCidrRange == $cidr
      and (.network | endswith("/networks/\($network)"))
    ' >/dev/null 2>&1 <<<"$subnet_json" \
    || ! jq -e --arg id "$(jq -r '.networkId' <<<"$identities")" \
      '(.id | tostring) == $id' >/dev/null 2>&1 <<<"$network_json"; then
    echo "ERROR: RIG-B1 subnet/network IDs differ from immutable ownership." >&2
    exit 1
  fi

  node_sa_json="$(b1_observe_json "node service account" gcloud iam service-accounts describe \
    "$(jq -r '.nodeServiceAccount' <<<"$resources")" --project="$GCP_PROJECT" --format=json)"
  if ! jq -e \
    --arg email "$(jq -r '.nodeServiceAccount' <<<"$resources")" \
    --arg id "$(jq -r '.nodeServiceAccountUniqueId' <<<"$identities")" '
      .email == $email and (.uniqueId | tostring) == $id
    ' >/dev/null 2>&1 <<<"$node_sa_json"; then
    echo "ERROR: RIG-B1 node service-account unique ID differs from immutable ownership." >&2
    exit 1
  fi

  worker_sa_json="$(b1_observe_json "worker runtime service account" \
    gcloud iam service-accounts describe "$B1_RUNTIME_SA" \
    --project="$GCP_PROJECT" --format=json)"
  scheduler_sa_json="$(b1_observe_json "Scheduler OIDC service account" \
    gcloud iam service-accounts describe "$B1_SCHEDULER_SA" \
    --project="$GCP_PROJECT" --format=json)"
  if ! jq -e \
    --arg email "$B1_RUNTIME_SA" \
    --arg id "$(jq -r '.workerRuntimeServiceAccountUniqueId' <<<"$identities")" '
      .email == $email and (.uniqueId | tostring) == $id
    ' >/dev/null 2>&1 <<<"$worker_sa_json" \
    || ! jq -e \
      --arg email "$B1_SCHEDULER_SA" \
      --arg id "$(jq -r '.schedulerOidcServiceAccountUniqueId' <<<"$identities")" '
        .email == $email and (.uniqueId | tostring) == $id
      ' >/dev/null 2>&1 <<<"$scheduler_sa_json"; then
    echo "ERROR: RIG-B1 worker/Scheduler service-account unique IDs differ from immutable ownership." >&2
    exit 1
  fi

  repo_policy="$(gcloud artifacts repositories get-iam-policy "$B1_ARTIFACT_REPOSITORY" \
    --project="$GCP_PROJECT" --location="$B1_ARTIFACT_REPOSITORY_LOCATION" --format=json)" || {
    echo "ERROR: cannot observe the exact RIG-B1 Artifact Registry reader grant." >&2
    exit 1
  }
  if ! jq -e --arg member "serviceAccount:$(jq -r '.nodeServiceAccount' <<<"$resources")" '
    any(.bindings[]?; .role == "roles/artifactregistry.reader"
      and any(.members[]?; . == $member))
  ' >/dev/null 2>&1 <<<"$repo_policy"; then
    echo "ERROR: RIG-B1 node Artifact Registry reader grant is absent or unbound." >&2
    exit 1
  fi
  b1_require_secret_member "$B1_NODE_RPC_AUTH_SECRET" \
    "$(jq -r '.nodeServiceAccount' <<<"$resources")" "node"
  for secret_name in "${B1_WORKER_SECRET_NAMES[@]}"; do
    b1_require_secret_member "$secret_name" "$B1_RUNTIME_SA" "worker"
  done

  projects_json="$(npx supabase projects list --output json)" || {
    echo "ERROR: cannot observe the RIG-B1 Supabase project before teardown." >&2
    exit 1
  }
  if ! jq -e --arg ref "$PROJECT_REF" '
    [ .[] | select((.id // .ref) == $ref and .name == "arkova-soak-s33-rig-b1") ] | length == 1
  ' >/dev/null 2>&1 <<<"$projects_json"; then
    echo "ERROR: Supabase ref is not the sole exact immutable RIG-B1 project target." >&2
    exit 1
  fi
}

delete_b1_owned_resources() {
  local resources scheduler_index scheduler_name secret_name node_sa
  resources="$(jq -c '.resources' <<<"$B1_TOPOLOGY_JSON")"
  node_sa="$(jq -r '.nodeServiceAccount' <<<"$resources")"

  echo "# RIG-B1 1/18 — delete the exact six approval-bound Scheduler jobs"
  scheduler_index=0
  while [[ $scheduler_index -lt ${#RIG_B1_EXPECTED_SCHEDULER_SUFFIXES[@]} ]]; do
    scheduler_name="${RIG_B1_SERVICE}-${RIG_B1_EXPECTED_SCHEDULER_SUFFIXES[$scheduler_index]}"
    run_cmd gcloud scheduler jobs delete "$scheduler_name" \
      --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" --quiet
    scheduler_index=$((scheduler_index + 1))
  done
  echo

  echo "# RIG-B1 2/18 — delete the immutable-UID-bound Cloud Run service"
  run_cmd gcloud run services delete "$RIG_B1_SERVICE" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
  echo

  echo "# RIG-B1 3/18 — delete the Bitcoin Core VM while retaining its two identity-bound disks"
  run_cmd gcloud compute instances delete "$(jq -r '.vm' <<<"$resources")" \
    --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --keep-disks=all --quiet
  echo

  echo "# RIG-B1 4/18 — delete the exact retained Bitcoin Core boot disk"
  run_cmd gcloud compute disks delete "$(jq -r '.bootDisk' <<<"$resources")" \
    --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --quiet
  echo

  echo "# RIG-B1 5/18 — delete the separately retained Bitcoin Core data disk"
  run_cmd gcloud compute disks delete "$(jq -r '.dataDisk' <<<"$resources")" \
    --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --quiet
  echo

  echo "# RIG-B1 6/18 — release the external Signet P2P address"
  run_cmd gcloud compute addresses delete "$(jq -r '.externalAddress' <<<"$resources")" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
  echo

  echo "# RIG-B1 7/18 — release the private RPC address"
  run_cmd gcloud compute addresses delete "$(jq -r '.internalAddress' <<<"$resources")" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
  echo

  echo "# RIG-B1 8/18 — delete the private RPC firewall rule"
  run_cmd gcloud compute firewall-rules delete "$(jq -r '.rpcFirewall' <<<"$resources")" \
    --project="$GCP_PROJECT" --quiet
  echo

  echo "# RIG-B1 9/18 — delete the Serverless VPC connector"
  run_cmd gcloud compute networks vpc-access connectors delete \
    "$(jq -r '.vpcConnector' <<<"$resources")" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
  echo

  echo "# RIG-B1 10/18 — delete the isolated subnet"
  run_cmd gcloud compute networks subnets delete "$(jq -r '.subnet' <<<"$resources")" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
  echo

  echo "# RIG-B1 11/18 — delete the isolated VPC network"
  run_cmd gcloud compute networks delete "$(jq -r '.network' <<<"$resources")" \
    --project="$GCP_PROJECT" --quiet
  echo

  echo "# RIG-B1 12/18 — remove the exact repo-scoped Artifact Registry reader grant"
  run_cmd gcloud artifacts repositories remove-iam-policy-binding \
    "$B1_ARTIFACT_REPOSITORY" --project="$GCP_PROJECT" \
    --location="$B1_ARTIFACT_REPOSITORY_LOCATION" \
    --member="serviceAccount:${node_sa}" --role=roles/artifactregistry.reader \
    --condition=None --quiet
  echo

  echo "# RIG-B1 13/18 — remove the node's sole RPC-auth secret grant"
  run_cmd gcloud secrets remove-iam-policy-binding "$B1_NODE_RPC_AUTH_SECRET" \
    --project="$GCP_PROJECT" --member="serviceAccount:${node_sa}" \
    --role=roles/secretmanager.secretAccessor --condition=None --quiet
  echo

  echo "# RIG-B1 14/18 — delete the temporary node service account"
  run_cmd gcloud iam service-accounts delete "$node_sa" --project="$GCP_PROJECT" --quiet
  echo

  echo "# RIG-B1 15/18 — remove worker secret grants and delete only topology-owned secrets"
  for secret_name in "${B1_WORKER_SECRET_NAMES[@]}"; do
    run_cmd gcloud secrets remove-iam-policy-binding "$secret_name" \
      --project="$GCP_PROJECT" --member="serviceAccount:${B1_RUNTIME_SA}" \
      --role=roles/secretmanager.secretAccessor --condition=None --quiet
  done
  for secret_name in "${B1_GENERATED_SECRET_NAMES[@]}"; do
    run_cmd gcloud secrets delete "$secret_name" --project="$GCP_PROJECT" --quiet
  done
  echo

  echo "# RIG-B1 16/18 — delete the dedicated worker runtime service account"
  run_cmd gcloud iam service-accounts delete "$B1_RUNTIME_SA" \
    --project="$GCP_PROJECT" --quiet
  echo

  echo "# RIG-B1 17/18 — delete the dedicated Scheduler OIDC service account"
  run_cmd gcloud iam service-accounts delete "$B1_SCHEDULER_SA" \
    --project="$GCP_PROJECT" --quiet
  echo

  echo "# RIG-B1 18/18 — delete the isolated Supabase project"
  run_cmd npx supabase projects delete "$PROJECT_REF" --yes
  echo
}

b1_assert_empty() {
  local label="$1"
  shift
  local observed
  observed="$("$@")" || {
    echo "ERROR: residual check could not observe RIG-B1 $label." >&2
    exit 1
  }
  if [[ -n "$observed" ]]; then
    echo "ERROR: residual RIG-B1 $label remains after teardown." >&2
    exit 1
  fi
}

b1_is_generated_secret() {
  local candidate="$1" generated
  for generated in "${B1_GENERATED_SECRET_NAMES[@]}"; do
    [[ "$candidate" == "$generated" ]] && return 0
  done
  return 1
}

b1_assert_secret_member_absent() {
  local secret_name="$1" member="$2" label="$3" policy_json
  if b1_is_generated_secret "$secret_name"; then
    return 0
  fi
  policy_json="$(gcloud secrets get-iam-policy "$secret_name" \
    --project="$GCP_PROJECT" --format=json)" || {
    echo "ERROR: cannot verify residual $label IAM on secret '$secret_name'." >&2
    exit 1
  }
  if jq -e --arg member "serviceAccount:${member}" '
    any(.bindings[]?; any(.members[]?; . == $member))
  ' >/dev/null 2>&1 <<<"$policy_json"; then
    echo "ERROR: residual $label IAM remains on secret '$secret_name'." >&2
    exit 1
  fi
}

assert_b1_zero_residual() {
  local resources identities scheduler_name secret_name node_sa repo_policy projects_after
  local claim_after topology_after
  resources="$(jq -c '.resources' <<<"$B1_TOPOLOGY_JSON")"
  identities="$(jq -c '.resourceIdentities' <<<"$B1_TOPOLOGY_JSON")"
  node_sa="$(jq -r '.nodeServiceAccount' <<<"$resources")"

  for scheduler_name in $(jq -r '.[]' <<<"$B1_EXPECTED_SCHEDULER_NAMES_JSON"); do
    b1_assert_empty "Scheduler job '$scheduler_name'" gcloud scheduler jobs list \
      --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:${scheduler_name}" --format='value(name)'
  done
  b1_assert_empty "Cloud Run service" gcloud run services list \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
    --filter="metadata.name:${RIG_B1_SERVICE}" --format='value(metadata.name)'
  b1_assert_empty "Bitcoin Core VM" gcloud compute instances list \
    --project="$GCP_PROJECT" --zones="$RIG_B1_NODE_ZONE" \
    --filter="name:$(jq -r '.vm' <<<"$resources")" --format='value(name)'
  b1_assert_empty "boot disk" gcloud compute disks list \
    --project="$GCP_PROJECT" --zones="$RIG_B1_NODE_ZONE" \
    --filter="name:$(jq -r '.bootDiskName' <<<"$identities")" --format='value(name)'
  b1_assert_empty "data disk" gcloud compute disks list \
    --project="$GCP_PROJECT" --zones="$RIG_B1_NODE_ZONE" \
    --filter="name:$(jq -r '.dataDisk' <<<"$resources")" --format='value(name)'
  b1_assert_empty "external address" gcloud compute addresses list \
    --project="$GCP_PROJECT" --regions="$CLOUD_RUN_REGION" \
    --filter="name:$(jq -r '.externalAddress' <<<"$resources")" --format='value(name)'
  b1_assert_empty "internal address" gcloud compute addresses list \
    --project="$GCP_PROJECT" --regions="$CLOUD_RUN_REGION" \
    --filter="name:$(jq -r '.internalAddress' <<<"$resources")" --format='value(name)'
  b1_assert_empty "RPC firewall" gcloud compute firewall-rules list \
    --project="$GCP_PROJECT" --filter="name:$(jq -r '.rpcFirewall' <<<"$resources")" \
    --format='value(name)'
  b1_assert_empty "VPC connector" gcloud compute networks vpc-access connectors list \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
    --filter="name:$(jq -r '.vpcConnector' <<<"$resources")" --format='value(name)'
  b1_assert_empty "subnet" gcloud compute networks subnets list \
    --project="$GCP_PROJECT" --regions="$CLOUD_RUN_REGION" \
    --filter="name:$(jq -r '.subnet' <<<"$resources")" --format='value(name)'
  b1_assert_empty "VPC network" gcloud compute networks list \
    --project="$GCP_PROJECT" --filter="name:$(jq -r '.network' <<<"$resources")" \
    --format='value(name)'
  b1_assert_empty "node service account" gcloud iam service-accounts list \
    --project="$GCP_PROJECT" --filter="email:${node_sa}" --format='value(email)'
  b1_assert_empty "worker runtime service account" gcloud iam service-accounts list \
    --project="$GCP_PROJECT" --filter="email:${B1_RUNTIME_SA}" --format='value(email)'
  b1_assert_empty "Scheduler OIDC service account" gcloud iam service-accounts list \
    --project="$GCP_PROJECT" --filter="email:${B1_SCHEDULER_SA}" --format='value(email)'

  repo_policy="$(gcloud artifacts repositories get-iam-policy "$B1_ARTIFACT_REPOSITORY" \
    --project="$GCP_PROJECT" --location="$B1_ARTIFACT_REPOSITORY_LOCATION" --format=json)" || {
    echo "ERROR: cannot verify residual RIG-B1 Artifact Registry IAM." >&2
    exit 1
  }
  if jq -e --arg member "serviceAccount:${node_sa}" '
    any(.bindings[]?; any(.members[]?; . == $member))
  ' >/dev/null 2>&1 <<<"$repo_policy"; then
    echo "ERROR: residual RIG-B1 Artifact Registry reader grant remains." >&2
    exit 1
  fi
  b1_assert_secret_member_absent "$B1_NODE_RPC_AUTH_SECRET" "$node_sa" "node"
  for secret_name in "${B1_WORKER_SECRET_NAMES[@]}"; do
    b1_assert_secret_member_absent "$secret_name" "$B1_RUNTIME_SA" "worker"
  done
  for secret_name in "${B1_GENERATED_SECRET_NAMES[@]}"; do
    b1_assert_empty "generated secret '$secret_name'" gcloud secrets list \
      --project="$GCP_PROJECT" --filter="name:${secret_name}" --format='value(name)'
  done

  projects_after="$(npx supabase projects list --output json)" || {
    echo "ERROR: cannot verify RIG-B1 Supabase project deletion." >&2
    exit 1
  }
  if jq -e --arg ref "$PROJECT_REF" '[.[] | select((.id // .ref) == $ref)] | length != 0' \
    >/dev/null 2>&1 <<<"$projects_after"; then
    echo "ERROR: RIG-B1 Supabase project remains after teardown." >&2
    exit 1
  fi

  claim_after="$(gcloud storage objects describe "$B1_APPROVAL_CLAIM_URI" \
    --project="$GCP_PROJECT" --raw --format=json)" || {
    echo "ERROR: retained RIG-B1 approval claim is no longer observable." >&2
    exit 1
  }
  topology_after="$(gcloud storage objects describe "$B1_TOPOLOGY_URI" \
    --project="$GCP_PROJECT" --raw --format=json)" || {
    echo "ERROR: retained RIG-B1 topology audit object is no longer observable." >&2
    exit 1
  }
  if ! jq -e --arg generation "$B1_APPROVAL_CLAIM_GENERATION" '
      (.generation | tostring) == $generation and .retention.mode == "Locked"
    ' >/dev/null 2>&1 <<<"$claim_after" \
    || ! jq -e --arg generation "$B1_TOPOLOGY_GENERATION" '
      (.generation | tostring) == $generation and .retention.mode == "Locked"
    ' >/dev/null 2>&1 <<<"$topology_after"; then
    echo "ERROR: RIG-B1 approval/topology audit objects were not retained generation-exact and Locked." >&2
    exit 1
  fi

  B1_TEARDOWN_PROJECTION_JSON="$(jq -nc \
    --arg approval_id "$B1_APPROVAL_ID" \
    --arg claim_uri "$B1_APPROVAL_CLAIM_URI" \
    --arg claim_generation "$B1_APPROVAL_CLAIM_GENERATION" \
    --arg topology_uri "$B1_TOPOLOGY_URI" \
    --arg topology_generation "$B1_TOPOLOGY_GENERATION" '
      {
        schema_version: "arkova.s33.rig-b1.teardown-projection/v1",
        rig_id: "RIG-B1",
        approval_id: $approval_id,
        projected_monthly_recurring_usd: 0,
        scheduler_jobs_removed: 6,
        bitcoin_core_node_removed: true,
        worker_and_node_secret_iam_removed: true,
        dedicated_worker_runtime_identity_removed: true,
        dedicated_scheduler_oidc_identity_removed: true,
        artifact_registry_reader_removed: true,
        supabase_project_removed: true,
        retained_locked_audit_objects: [
          {object_uri: $claim_uri, generation: $claim_generation},
          {object_uri: $topology_uri, generation: $topology_generation}
        ]
      }
    ')"
  echo "TEARDOWN_PROJECTION_JSON=$B1_TEARDOWN_PROJECTION_JSON"
  echo "# RIG-B1 teardown complete; every recurring target is absent and projected recurring cost is \$0."
}

RECLAIM_LABEL="delete Supabase project"
if [[ $FLAG_ONLY -eq 1 ]]; then
  RECLAIM_LABEL="FLAG for Carson dashboard action (no delete)"
fi

# B1 never derives destructive authority from CLI names. Authenticate the
# founder/CTO envelope and this exact teardown script before printing or running
# any B1 resource command.
verify_b1_teardown_authority

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

if [[ $IS_RIG_B1 -eq 1 ]]; then
  B1_RESOURCES_JSON="$B1_SIGNED_RESOURCES_JSON"
  echo "verified approval: $B1_APPROVAL_ID"
  echo "signed source:      $B1_SOURCE_HEAD / $B1_SOURCE_TREE"
  echo "approval claim:     $B1_APPROVAL_CLAIM_URI (retained Locked)"
  echo "topology ownership: $B1_TOPOLOGY_URI (retained Locked)"
  echo "node image repo:    projects/$GCP_PROJECT/locations/$B1_ARTIFACT_REPOSITORY_LOCATION/repositories/$B1_ARTIFACT_REPOSITORY"
  echo

  if [[ $APPLY -eq 1 ]]; then
    # Every read and identity assertion completes before the first delete.
    load_b1_locked_ownership
    preflight_b1_owned_resources
    delete_b1_owned_resources
    assert_b1_zero_residual
  else
    echo "# RIG-B1 ownership preflight (apply mode reads generation-specific Locked objects)"
    print_cmd gcloud storage objects describe "$B1_APPROVAL_CLAIM_URI" \
      --project="$GCP_PROJECT" --raw --format=json
    print_cmd gcloud storage cat "${B1_APPROVAL_CLAIM_URI}#<observed-generation>" \
      --project="$GCP_PROJECT"
    print_cmd gcloud storage objects describe "$B1_TOPOLOGY_URI" \
      --project="$GCP_PROJECT" --raw --format=json
    print_cmd gcloud storage cat "${B1_TOPOLOGY_URI}#<observed-generation>" \
      --project="$GCP_PROJECT"
    echo "#   then compare immutable resource IDs, service UID/URL, all six Scheduler"
    echo "#   targets, IAM members, and the exact Supabase ref before the first delete."
    echo

    scheduler_index=0
    while [[ $scheduler_index -lt ${#RIG_B1_EXPECTED_SCHEDULER_SUFFIXES[@]} ]]; do
      scheduler_name="${RIG_B1_SERVICE}-${RIG_B1_EXPECTED_SCHEDULER_SUFFIXES[$scheduler_index]}"
      print_cmd gcloud scheduler jobs delete "$scheduler_name" \
        --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" --quiet
      scheduler_index=$((scheduler_index + 1))
    done
    print_cmd gcloud run services delete "$RIG_B1_SERVICE" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
    print_cmd gcloud compute instances delete "$(jq -r '.vm' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --keep-disks=all --quiet
    print_cmd gcloud compute disks delete "$(jq -r '.bootDisk' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --quiet
    print_cmd gcloud compute disks delete "$(jq -r '.dataDisk' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --quiet
    print_cmd gcloud compute addresses delete "$(jq -r '.externalAddress' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
    print_cmd gcloud compute addresses delete "$(jq -r '.internalAddress' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
    print_cmd gcloud compute firewall-rules delete "$(jq -r '.rpcFirewall' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --quiet
    print_cmd gcloud compute networks vpc-access connectors delete \
      "$(jq -r '.vpcConnector' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
    print_cmd gcloud compute networks subnets delete "$(jq -r '.subnet' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
    print_cmd gcloud compute networks delete "$(jq -r '.network' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --quiet
    print_cmd gcloud artifacts repositories remove-iam-policy-binding \
      "$B1_ARTIFACT_REPOSITORY" --project="$GCP_PROJECT" \
      --location="$B1_ARTIFACT_REPOSITORY_LOCATION" \
      --member="serviceAccount:$(jq -r '.nodeServiceAccount' <<<"$B1_RESOURCES_JSON")" \
      --role=roles/artifactregistry.reader --condition=None --quiet
    print_cmd gcloud secrets remove-iam-policy-binding "$B1_NODE_RPC_AUTH_SECRET" \
      --project="$GCP_PROJECT" \
      --member="serviceAccount:$(jq -r '.nodeServiceAccount' <<<"$B1_RESOURCES_JSON")" \
      --role=roles/secretmanager.secretAccessor --condition=None --quiet
    print_cmd gcloud iam service-accounts delete \
      "$(jq -r '.nodeServiceAccount' <<<"$B1_RESOURCES_JSON")" \
      --project="$GCP_PROJECT" --quiet
    for secret_name in "${B1_WORKER_SECRET_NAMES[@]}"; do
      print_cmd gcloud secrets remove-iam-policy-binding "$secret_name" \
        --project="$GCP_PROJECT" --member="serviceAccount:${B1_RUNTIME_SA}" \
        --role=roles/secretmanager.secretAccessor --condition=None --quiet
    done
    print_cmd gcloud secrets delete "$B1_SUPABASE_URL_SECRET" --project="$GCP_PROJECT" --quiet
    print_cmd gcloud secrets delete "$B1_SUPABASE_ROLE_SECRET" --project="$GCP_PROJECT" --quiet
    echo "#   RPC URL/auth secrets are deleted only when the Locked topology marks them generated."
    print_cmd gcloud iam service-accounts delete "$B1_RUNTIME_SA" \
      --project="$GCP_PROJECT" --quiet
    print_cmd gcloud iam service-accounts delete "$B1_SCHEDULER_SA" \
      --project="$GCP_PROJECT" --quiet
    print_cmd npx supabase projects delete "$PROJECT_REF" --yes
    echo
    echo "# DRY-RUN ONLY: no zero-cost result is reported until apply-mode residual assertions pass."
  fi
  exit 0
fi

if [[ $IS_RIG_G1_A -eq 1 || $IS_RIG_G1_B -eq 1 ]]; then
  G1_RUNTIME_MEMBER="serviceAccount:${RUNTIME_SA}"
  G1_SUPABASE_URL_SECRET="supabase-url-${RIG_NAME}-staging"
  G1_SUPABASE_ROLE_SECRET="supabase-service-role-key-${RIG_NAME}-staging"
  G1_SECRET_REFERENCES=(
    "$G1_SUPABASE_URL_SECRET"
    "$G1_SUPABASE_ROLE_SECRET"
    "stripe-secret-key-staging"
    "stripe-webhook-secret-staging"
    "api-key-hmac-secret-staging"
    "cron-secret"
    "gemini-api-key"
  )
  G1_RUNTIME_ROLES=("roles/logging.logWriter")
  echo "physical arm:      $RIG_ID"
  echo "runtime identity:  $RUNTIME_SA"
  if [[ $IS_RIG_G1_B -eq 1 ]]; then
    echo "Vertex endpoint:   $VERTEX_ENDPOINT"
    echo "Vertex model:      $VERTEX_MODEL (preserved; never a delete target)"
    echo "deployed model id: $DEPLOYED_MODEL_ID"
  fi
  echo

  if [[ $APPLY -eq 1 ]]; then
    G1_PROJECT_JSON="$(npx supabase projects list --output json)" || {
      echo "ERROR: cannot observe Supabase project inventory before $RIG_ID teardown." >&2
      exit 1
    }
    if ! jq -e --arg ref "$PROJECT_REF" --arg name "arkova-soak-${RIG_NAME}" '
      type == "array"
      and ([.[] | select((.id // .ref) == $ref and .name == $name)] | length == 1)
    ' >/dev/null 2>&1 <<<"$G1_PROJECT_JSON"; then
      echo "ERROR: $RIG_ID project ref/name is not one exact owned physical target." >&2
      exit 1
    fi
    G1_SERVICE_JSON="$(gcloud run services describe "${SERVICES[0]}" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json)" || {
      echo "ERROR: cannot observe exact $RIG_ID Cloud Run service before teardown." >&2
      exit 1
    }
    if ! jq -e --arg service "${SERVICES[0]}" --arg runtime_sa "$RUNTIME_SA" '
      .metadata.name == $service
      and .spec.template.spec.serviceAccountName == $runtime_sa
    ' >/dev/null 2>&1 <<<"$G1_SERVICE_JSON"; then
      echo "ERROR: $RIG_ID service/runtime ownership changed; refusing teardown ambiguity." >&2
      exit 1
    fi
    G1_RUNTIME_JSON="$(gcloud iam service-accounts describe "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json)" || {
      echo "ERROR: cannot observe exact $RIG_ID runtime service account." >&2
      exit 1
    }
    if ! jq -e --arg email "$RUNTIME_SA" '
      .email == $email and (.uniqueId | tostring | test("^[1-9][0-9]+$"))
    ' >/dev/null 2>&1 <<<"$G1_RUNTIME_JSON"; then
      echo "ERROR: $RIG_ID runtime identity is not one exact canonical service account." >&2
      exit 1
    fi
    for secret in "$G1_SUPABASE_URL_SECRET" "$G1_SUPABASE_ROLE_SECRET"; do
      gcloud secrets describe "$secret" --project="$GCP_PROJECT" >/dev/null || {
        echo "ERROR: cannot observe exact $RIG_ID generated secret '$secret'." >&2
        exit 1
      }
    done
    G1_SCHEDULER_BEFORE="$(gcloud scheduler jobs list \
      --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
      --filter="name:${SERVICES[0]}" --format="value(name)")" || {
      echo "ERROR: cannot prove $RIG_ID Scheduler inventory is empty." >&2
      exit 1
    }
    if [[ -n "$G1_SCHEDULER_BEFORE" ]]; then
      echo "ERROR: $RIG_ID contract permits no Scheduler jobs." >&2
      exit 1
    fi
    if [[ $IS_RIG_G1_B -eq 1 ]]; then
      G1_ENDPOINT_JSON="$(gcloud ai endpoints describe "$RIG_G1_B_ENDPOINT_ID" \
        --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json)" || {
        echo "ERROR: cannot observe the exact RIG-G1-B endpoint before teardown." >&2
        exit 1
      }
      if ! jq -e \
        --arg endpoint_display "arkova-s33-rig-g1-b-tuned-v6" \
        --arg model "$VERTEX_MODEL" \
        --arg deployed_id "$DEPLOYED_MODEL_ID" \
        --arg deployed_display "arkova-s33-rig-g1-b-tuned-v6" '
          .displayName == $endpoint_display
          and (.deployedModels | type == "array" and length == 1)
          and .deployedModels[0].model == $model
          and .deployedModels[0].modelVersionId == "1"
          and .deployedModels[0].checkpointId == "6"
          and .deployedModels[0].id == $deployed_id
          and .deployedModels[0].displayName == $deployed_display
          and .deployedModels[0].automaticResources.minReplicaCount == 1
          and .deployedModels[0].automaticResources.maxReplicaCount == 1
          and (.deployedModels[0] | has("dedicatedResources") | not)
          and .trafficSplit == {($deployed_id): 100}
        ' >/dev/null 2>&1 <<<"$G1_ENDPOINT_JSON"; then
        echo "ERROR: RIG-G1-B endpoint/model@1/checkpoint-6/automatic-1x1 binding changed." >&2
        exit 1
      fi
      G1_OPERATOR_TOKEN="$(gcloud auth print-access-token)" || exit 1
      G1_ENDPOINT_POLICY="$(/usr/bin/curl --silent --show-error --fail-with-body \
        --request POST \
        "https://${CLOUD_RUN_REGION}-aiplatform.googleapis.com/v1beta1/projects/270018525501/locations/${CLOUD_RUN_REGION}/endpoints/${RIG_G1_B_ENDPOINT_ID}:getIamPolicy" \
        --header "Authorization: Bearer ${G1_OPERATOR_TOKEN}" \
        --header 'Content-Type: application/json' --data-binary '{}' 2>/dev/null)" || {
        unset G1_OPERATOR_TOKEN
        echo "ERROR: cannot observe RIG-G1-B endpoint IAM before teardown." >&2
        exit 1
      }
      unset G1_OPERATOR_TOKEN
      if ! jq -e --arg expected "$G1_RUNTIME_MEMBER" '
        [.bindings[]? | select(.role == "roles/aiplatform.endpointUser") | .members[]?]
        | (sort | unique) == [$expected]
      ' >/dev/null 2>&1 <<<"$G1_ENDPOINT_POLICY"; then
        echo "ERROR: RIG-G1-B endpoint IAM is not bound only to its exact runtime." >&2
        exit 1
      fi
    fi
  else
    print_cmd npx supabase projects list --output json
    print_cmd gcloud run services describe "${SERVICES[0]}" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json
    print_cmd gcloud iam service-accounts describe "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json
    if [[ $IS_RIG_G1_B -eq 1 ]]; then
      print_cmd gcloud ai endpoints describe "$RIG_G1_B_ENDPOINT_ID" \
        --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json
      echo "+ /usr/bin/curl POST <RIG-G1-B-endpoint:getIamPolicy> # exact endpointUser member preflight"
    fi
  fi

  if [[ $IS_RIG_G1_B -eq 1 ]]; then
    echo "# $RIG_ID 1/7 — undeploy and delete exact temporary endpoint; preserve v6 model"
    run_cmd gcloud ai endpoints undeploy-model "$RIG_G1_B_ENDPOINT_ID" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
      --deployed-model-id="$DEPLOYED_MODEL_ID" --quiet
    run_cmd gcloud ai endpoints delete "$RIG_G1_B_ENDPOINT_ID" \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
  else
    echo "# $RIG_ID 1/7 — no Vertex resource belongs to the public control arm"
  fi
  echo

  echo "# $RIG_ID 2/7 — delete the exact physical Cloud Run service"
  run_cmd gcloud run services delete "${SERVICES[0]}" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --quiet
  echo

  echo "# $RIG_ID 3/7 — remove exact runtime secret grants and generated secret pair"
  for secret in "${G1_SECRET_REFERENCES[@]}"; do
    run_cmd gcloud secrets remove-iam-policy-binding "$secret" \
      --project="$GCP_PROJECT" --member="$G1_RUNTIME_MEMBER" \
      --role=roles/secretmanager.secretAccessor --condition=None --quiet
  done
  run_cmd gcloud secrets delete "$G1_SUPABASE_URL_SECRET" --project="$GCP_PROJECT" --quiet
  run_cmd gcloud secrets delete "$G1_SUPABASE_ROLE_SECRET" --project="$GCP_PROJECT" --quiet
  echo

  echo "# $RIG_ID 4/7 — delete the exact isolated Supabase physical project"
  run_cmd npx supabase projects delete "$PROJECT_REF" --yes
  echo

  echo "# $RIG_ID 5/7 — remove observed project IAM and delete exact runtime identity"
  if [[ $APPLY -eq 1 ]]; then
    G1_RUNTIME_ROLE_LIST="$(gcloud projects get-iam-policy "$GCP_PROJECT" \
      --flatten="bindings[].members" --filter="bindings.members:${G1_RUNTIME_MEMBER}" \
      --format="value(bindings.role)")" || exit 1
    while IFS= read -r runtime_role; do
      [[ -n "$runtime_role" ]] || continue
      if [[ ! "$runtime_role" =~ ^roles/[A-Za-z0-9_.]+$ ]]; then
        echo "ERROR: refusing malformed observed $RIG_ID IAM role '$runtime_role'." >&2
        exit 1
      fi
      run_cmd gcloud projects remove-iam-policy-binding "$GCP_PROJECT" \
        --member="$G1_RUNTIME_MEMBER" --role="$runtime_role" --condition=None --quiet
    done <<<"$G1_RUNTIME_ROLE_LIST"
  else
    for runtime_role in "${G1_RUNTIME_ROLES[@]}"; do
      print_cmd gcloud projects remove-iam-policy-binding "$GCP_PROJECT" \
        --member="$G1_RUNTIME_MEMBER" --role="$runtime_role" --condition=None --quiet
    done
  fi
  run_cmd gcloud iam service-accounts delete "$RUNTIME_SA" --project="$GCP_PROJECT" --quiet
  echo

  echo "# $RIG_ID 6/7 — preserve immutable approval evidence and protected v6 model"
  echo "# retained: gs://arkova1-s33-immutable-authority-ledger/s33/g1/approval-claims/*"
  echo "# retained: $RIG_R_PROTECTED_V6_MODEL"
  echo

  echo "# $RIG_ID 7/7 — prove zero residual recurring arm topology"
  if [[ $APPLY -eq 1 ]]; then
    g1_assert_empty() {
      local label="$1"
      shift
      local observed
      observed="$("$@")" || {
        echo "ERROR: residual check failed to observe $label." >&2
        exit 1
      }
      if [[ -n "$observed" ]]; then
        echo "ERROR: residual $label remains after $RIG_ID teardown." >&2
        exit 1
      fi
    }
    g1_assert_empty "Cloud Run service" gcloud run services list \
      --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
      --filter="metadata.name:${SERVICES[0]}" --format="value(metadata.name)"
    g1_assert_empty "generated secret pair" gcloud secrets list \
      --project="$GCP_PROJECT" \
      --filter="name:(${G1_SUPABASE_URL_SECRET} OR ${G1_SUPABASE_ROLE_SECRET})" \
      --format="value(name)"
    g1_assert_empty "runtime identity" gcloud iam service-accounts list \
      --project="$GCP_PROJECT" --filter="email:${RUNTIME_SA}" --format="value(email)"
    g1_assert_empty "runtime project IAM" gcloud projects get-iam-policy "$GCP_PROJECT" \
      --flatten="bindings[].members" --filter="bindings.members:${G1_RUNTIME_MEMBER}" \
      --format="value(bindings.role)"
    if [[ $IS_RIG_G1_B -eq 1 ]]; then
      g1_assert_empty "Vertex endpoint" gcloud ai endpoints list \
        --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
        --filter="name:${RIG_G1_B_ENDPOINT_ID}" --format="value(name)"
    fi
    G1_PROJECTS_AFTER="$(npx supabase projects list --output json)" || exit 1
    if jq -e --arg ref "$PROJECT_REF" '[.[] | select((.id // .ref) == $ref)] | length != 0' \
      >/dev/null 2>&1 <<<"$G1_PROJECTS_AFTER"; then
      echo "ERROR: $RIG_ID Supabase project remains after teardown." >&2
      exit 1
    fi
    for secret in "stripe-secret-key-staging" "stripe-webhook-secret-staging" \
      "api-key-hmac-secret-staging" "cron-secret" "gemini-api-key"; do
      G1_SECRET_POLICY="$(gcloud secrets get-iam-policy "$secret" \
        --project="$GCP_PROJECT" --format=json)" || exit 1
      if jq -e --arg member "$G1_RUNTIME_MEMBER" \
        'any(.bindings[]?.members[]?; . == $member)' >/dev/null 2>&1 <<<"$G1_SECRET_POLICY"; then
        echo "ERROR: residual $RIG_ID shared-secret IAM remains on '$secret'." >&2
        exit 1
      fi
    done
  fi
  G1_TEARDOWN_PROJECTION_JSON="$(jq -nc --arg rig_id "$RIG_ID" '
    {
      schema_version: "arkova.s33.rig-g1.physical-arm-teardown-projection/v1",
      rig_id: $rig_id,
      projected_monthly_recurring_usd: 0,
      physical_project_removed: true,
      physical_service_removed: true,
      physical_runtime_identity_removed: true,
      physical_generated_secrets_removed: true,
      endpoint_removed_if_owned: ($rig_id == "RIG-G1-B"),
      protected_v6_model_preserved: true,
      locked_approval_evidence_preserved: true
    }
  ')"
  echo "TEARDOWN_PROJECTION_JSON=$G1_TEARDOWN_PROJECTION_JSON"
  echo "# $RIG_ID teardown complete; projected recurring cost is \$0."
  exit 0
fi

if [[ $IS_RIG_R -eq 1 ]]; then
  RIG_R_LEASE_URI="gs://${RIG_R_LEASE_BUCKET}/${RIG_R_LEASE_OBJECT_NAME}"
  RIG_R_RUNTIME_ROLES=(
    "roles/logging.logWriter"
  )
  RIG_R_SECRET_REFERENCES=(
    "supabase-url-s33-r-staging"
    "supabase-service-role-key-s33-r-staging"
    "stripe-secret-key-staging"
    "stripe-webhook-secret-staging"
    "api-key-hmac-secret-staging"
    "cron-secret"
    "gemini-api-key"
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
    if ! jq -e \
      --arg endpoint_display "arkova-s33-rig-r-release-v6" \
      --arg model "$VERTEX_MODEL" \
      --arg deployed_id "$DEPLOYED_MODEL_ID" \
      --arg deployed_display "arkova-s33-rig-r-release-v6" '
      type == "object"
      and .displayName == $endpoint_display
      and (.deployedModels | type == "array" and length == 1)
      and .deployedModels[0].model == $model
      and .deployedModels[0].modelVersionId == "1"
      and .deployedModels[0].checkpointId == "6"
      and .deployedModels[0].id == $deployed_id
      and .deployedModels[0].displayName == $deployed_display
      and .deployedModels[0].automaticResources.minReplicaCount == 1
      and .deployedModels[0].automaticResources.maxReplicaCount == 1
      and (.deployedModels[0] | has("dedicatedResources") | not)
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
    RIG_R_LEASE_METADATA="$(gcloud storage objects describe "$RIG_R_LEASE_URI" \
      --project="$GCP_PROJECT" --raw --format=json)" || {
      echo "ERROR: cannot observe the exact RIG-R singleton mutex before teardown." >&2
      exit 1
    }
    RIG_R_LEASE_GENERATION="$(jq -r '.generation | tostring' <<<"$RIG_R_LEASE_METADATA")"
    if [[ ! "$RIG_R_LEASE_GENERATION" =~ ^[1-9][0-9]*$ \
      || "$(jq -r '.name' <<<"$RIG_R_LEASE_METADATA")" != "$RIG_R_LEASE_OBJECT_NAME" ]]; then
      echo "ERROR: RIG-R singleton mutex metadata is not generation-bound to the code-fixed object." >&2
      exit 1
    fi
    RIG_R_LEASE_GENERATION_URI="${RIG_R_LEASE_URI}#${RIG_R_LEASE_GENERATION}"
    RIG_R_LEASE_JSON="$(gcloud storage cat "$RIG_R_LEASE_GENERATION_URI" --project="$GCP_PROJECT")" || {
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
    assert_rig_r_runtime_impersonation_exact
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
    print_cmd gcloud storage objects describe "$RIG_R_LEASE_URI" --project="$GCP_PROJECT" --raw --format=json
    print_cmd gcloud storage cat "${RIG_R_LEASE_URI}#<observed-generation>" --project="$GCP_PROJECT"
    print_cmd gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json
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
  delete_cloud_run_service_if_present "$RIG_R_SERVICE"
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
  run_cmd npx supabase projects delete "$PROJECT_REF" --yes
  echo

  echo "# RIG-R 6/8 — remove runtime IAM bindings and delete the temporary service account"
  remove_rig_r_runtime_impersonation
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
  if [[ $APPLY -eq 1 ]]; then
    run_cmd gcloud storage rm "$RIG_R_LEASE_GENERATION_URI" --project="$GCP_PROJECT" \
      --if-generation-match="$RIG_R_LEASE_GENERATION"
  else
    print_cmd gcloud storage rm "${RIG_R_LEASE_URI}#<ownership-verified-generation>" --project="$GCP_PROJECT" \
      --if-generation-match='<ownership-verified-generation>'
  fi
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
  echo "# RIG-R teardown complete; projected recurring cost is \$0."
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
  run_cmd npx supabase projects delete "$PROJECT_REF" --yes
fi
echo

echo "# Teardown plan complete."
if [[ $APPLY -eq 1 ]]; then
  echo "# Update the rig inventory: mark $PROJECT_REF reclaimed (or flagged-for-Carson),"
  echo "# and run the end-of-sprint infra sweep (CLAUDE.md §7) to confirm no orphans remain."
else
  echo "# (dry-run — nothing was deleted)"
fi
