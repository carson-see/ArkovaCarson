#!/usr/bin/env bash
# scripts/staging/provision-isolated-rig.sh — S0-4.1 (epic S0-E4).
#
# One-command provision of a CLEAN, ISOLATED soak rig for a parallel T3 soak:
#   1. Create a standalone Supabase project (region us-east-2, PG 17.x) — NOT a
#      preview branch off prod (the lettered-suffix builder bug; see
#      docs/reference/STAGING_RIG.md "Why a standalone project").
#   2. Replay the repo schema onto it via `npx supabase db push --linked`.
#   3. Deploy a wired `arkova-worker-<name>-staging` Cloud Run service on the
#      prod-pinned image with a PROFILE-SELECTED env/secret overlay:
#        * mock   (DEFAULT, safe): USE_MOCKS=true, ENABLE_PROD_NETWORK_ANCHORING=false
#                 — zero real Bitcoin exposure. Health/synthetic soaks only.
#        * chain  (REAL anchoring): USE_MOCKS=false, ENABLE_PROD_NETWORK_ANCHORING=true,
#                 real GetBlock RPC + WIF signer + KMS_PROVIDER (from Secret Manager)
#                 — for anchoring / chain-resilience / batch-anchor behavioral soaks.
#        * gemini (REAL model): GEMINI_TUNED_MODEL + GEMINI_V6_PROMPT + GEMINI_API_KEY
#                 — for classifier / proof-backcatalog census soaks. Chain stays mocked.
#      EVERY profile also wires the boot-critical secrets (Stripe / API-key HMAC /
#      cron / FRONTEND_URL) so config.ts's Zod superRefine does not crash-loop the
#      worker (a rig missing these never boots → the soak is a no-op).
#      Non-mock profiles ALSO create Cloud Scheduler jobs POSTing to the worker's
#      /jobs/* endpoints, because node-cron does NOT fire on a throttled
#      (min-instances=0) Cloud Run service — without Scheduler the "behavioral"
#      cron paths never run and the soak degenerates to health-only.
#   4. Seed the baseline fixture (scripts/staging/seed-baseline-fixture.sql) so
#      the rig has >=1 SUBMITTED anchor — required for the preflight's Check 5
#      (submitted_anchors). Without it a fresh rig is `fixture_seeded` and its
#      soak is HOLLOW. Data-only insert; touches NO migration ledger (§1.11A).
#   5. Run scripts/ci/staging-honesty-preflight.ts and require `clean_mirror`.
#
# SAFETY MODEL (CLAUDE.md §1.11A — the whole point of this script):
#   * --dry-run is the DEFAULT. With no flags the script PRINTS the plan and
#     mutates NOTHING (no gcloud/supabase/MCP create calls run).
#   * A real run requires BOTH:
#       --apply
#       CONFIRM_PROVISION=<project-name>   (must match --name exactly)
#   * A real run of a NON-MOCK profile (chain/gemini) additionally requires
#       CONFIRM_REAL_CONFIG=<profile>      (must match --profile exactly)
#     so a rig with real credentials / real Bitcoin exposure is never provisioned
#     by a bare CONFIRM_PROVISION alone. Dry-run (the default) needs neither.
#   * The prod Supabase ref (vzwyaatejekddvltxyye) and the shared staging
#     services (arkova-worker, arkova-worker-staging) are HARD-DENIED — the
#     script exits 1 rather than touch prod or shared staging.
#
# Usage:
#   ./scripts/staging/provision-isolated-rig.sh --name s0e4-lane-a            # dry-run plan
#   CONFIRM_PROVISION=s0e4-lane-a \
#     ./scripts/staging/provision-isolated-rig.sh --name s0e4-lane-a --apply  # live (Carson-gated)
#
# This script is intentionally idempotent-ish in dry-run and fails loudly in
# --apply: every infra call is emitted as the exact command it WOULD run, and
# only executed when --apply + matching CONFIRM_PROVISION are present.

set -euo pipefail

# ---------------------------------------------------------------------------
# Hard-deny constants — NEVER provision against these.
# ---------------------------------------------------------------------------
PROD_SUPABASE_REF="vzwyaatejekddvltxyye"
SHARED_STAGING_SUPABASE_REF="ujtlwnoqfhtitcmsnrpq"
DENIED_CLOUD_RUN_SERVICES=("arkova-worker" "arkova-worker-staging")

# ---------------------------------------------------------------------------
# Defaults (overridable via flags / env).
# ---------------------------------------------------------------------------
GCP_PROJECT="${STAGING_GCP_PROJECT:-arkova1}"
APPROVED_GCP_PROJECT="${STAGING_APPROVED_GCP_PROJECT:-arkova1}"
CLOUD_RUN_REGION="${STAGING_CLOUD_RUN_REGION:-us-central1}"
SUPABASE_REGION="${STAGING_SUPABASE_REGION:-us-east-2}"
SUPABASE_PG_MAJOR="${STAGING_SUPABASE_PG_MAJOR:-17}"
SUPABASE_ORG="${STAGING_SUPABASE_ORG:-byhkazrpmivhcsuqjtva}"
SUPABASE_DB_PASSWORD="${STAGING_NEW_SUPABASE_DB_PASSWORD:-}"
IMAGE_WAS_EXPLICIT=0
if [[ -n "${STAGING_PINNED_IMAGE:-}" ]]; then
  PINNED_IMAGE="$STAGING_PINNED_IMAGE"
  IMAGE_WAS_EXPLICIT=1
else
  PINNED_IMAGE="<required-in-apply:--image-or-STAGING_PINNED_IMAGE@sha256>"
fi
RUNTIME_SA="${STAGING_RUNTIME_SA_EMAIL:-270018525501-compute@developer.gserviceaccount.com}"

# Profile selects the env/secret overlay for the worker deploy.
#   mock   — safe default; USE_MOCKS=true, anchoring off, no Scheduler.
#   chain  — real anchoring (GetBlock RPC + WIF signer + KMS), Scheduler-driven.
#   gemini — real tuned model + prompt; chain stays mocked, Scheduler-driven.
PROFILE="${STAGING_RIG_PROFILE:-mock}"

# Secret Manager secret NAMES (not values — values never touch this script).
# Overridable so the chain/gemini profiles can point at the operator-provisioned
# real-config secrets. Defaults are the shared staging real-config secrets; the
# operator confirms these hold the intended (test-tier) credentials before an
# --apply. NOTHING here is a credential literal — only Secret Manager references.
GETBLOCK_RPC_URL_SECRET="${STAGING_GETBLOCK_RPC_URL_SECRET:-bitcoin-rpc-url-staging}"
GETBLOCK_RPC_AUTH_SECRET="${STAGING_GETBLOCK_RPC_AUTH_SECRET:-bitcoin-rpc-auth-staging}"
TREASURY_WIF_SECRET="${STAGING_TREASURY_WIF_SECRET:-bitcoin-treasury-wif-staging}"
STRIPE_SECRET_KEY_SECRET="${STAGING_STRIPE_SECRET_KEY_SECRET:-stripe-secret-key-staging}"
STRIPE_WEBHOOK_SECRET_SECRET="${STAGING_STRIPE_WEBHOOK_SECRET_SECRET:-stripe-webhook-secret-staging}"
API_KEY_HMAC_SECRET_SECRET="${STAGING_API_KEY_HMAC_SECRET_SECRET:-api-key-hmac-secret-staging}"
CRON_SECRET_SECRET="${STAGING_CRON_SECRET_SECRET:-cron-secret}"
GEMINI_API_KEY_SECRET="${STAGING_GEMINI_API_KEY_SECRET:-gemini-api-key-staging}"

# Non-secret env values for the real profiles (safe to inline — model names,
# flags, a public frontend URL). These are NOT credentials.
KMS_PROVIDER_VALUE="${STAGING_KMS_PROVIDER:-gcp}"
BITCOIN_NETWORK_VALUE="${STAGING_BITCOIN_NETWORK:-mainnet}"
BITCOIN_UTXO_PROVIDER_VALUE="${STAGING_BITCOIN_UTXO_PROVIDER:-getblock}"
GEMINI_TUNED_MODEL_VALUE="${STAGING_GEMINI_TUNED_MODEL:-<required-in-gemini-apply:projects/<approved-project>/locations/us-central1/endpoints/<numeric-id>>}"
GEMINI_V6_PROMPT_VALUE="${STAGING_GEMINI_V6_PROMPT:-true}"
FRONTEND_URL_VALUE="${STAGING_FRONTEND_URL:-https://app.arkova.ai}"
CRON_OIDC_SA="${STAGING_CRON_OIDC_SA:-$RUNTIME_SA}"

NAME=""
APPLY=0
ADMISSION_SCHEMA_VERSION=2
SOURCE_HEAD_WAS_EXPLICIT=0
if [[ -n "${STAGING_SOURCE_HEAD_SHA:-}" ]]; then
  DECLARED_SOURCE_HEAD="$STAGING_SOURCE_HEAD_SHA"
  SOURCE_HEAD_WAS_EXPLICIT=1
else
  DECLARED_SOURCE_HEAD="${GITHUB_SHA:-<required-in-apply:--source-head-or-STAGING_SOURCE_HEAD_SHA>}"
fi
SOAK_ID="${STAGING_SOAK_ID:-<required-in-apply:--soak-id-or-STAGING_SOAK_ID>}"
DRIVER_PATH="${STAGING_DRIVER_PATH:-services/worker/scripts/pr1408-chain-resilience-driver.ts}"
TIER="${STAGING_TIER:-T3}"
DURATION_MIN="${STAGING_DURATION_MIN:-2880}"
CHANGED_BEHAVIOR="${STAGING_CHANGED_BEHAVIOR:-}"
VALIDATED_BASE_SHA=""

usage() {
  sed -n '2,38p' "$0"
  echo
  echo "Usage: $0 --name <rig-name> [--profile mock|chain|gemini] [--apply]"
  echo "          [--region us-east-2] [--gcp-region us-central1]"
  echo "          [--image <ref@sha256:digest>] [--source-head <40-char-sha>]"
  echo "          [--soak-id <exclusive-soak-id>] [--org <supabase-org>] [--gcp-project arkova1]"
  echo "          [--artifact-dir docs/staging/<pr-or-rig>]"
  echo
  echo "  --profile mock   (default) safe: USE_MOCKS=true, anchoring off, no Scheduler."
  echo "  --profile chain  real anchoring: GetBlock RPC + WIF signer + KMS, Scheduler-driven."
  echo "  --profile gemini real tuned model + prompt; chain mocked, Scheduler-driven."
  echo
  echo "Live run also requires: CONFIRM_PROVISION=<rig-name> matching --name."
  echo "Live run of a NON-MOCK profile ALSO requires: CONFIRM_REAL_CONFIG=<profile>."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:?}"; shift 2 ;;
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --region) SUPABASE_REGION="${2:?}"; shift 2 ;;
    --gcp-region) CLOUD_RUN_REGION="${2:?}"; shift 2 ;;
    --image) PINNED_IMAGE="${2:?}"; IMAGE_WAS_EXPLICIT=1; shift 2 ;;
    --source-head) DECLARED_SOURCE_HEAD="${2:?}"; SOURCE_HEAD_WAS_EXPLICIT=1; shift 2 ;;
    --soak-id) SOAK_ID="${2:?}"; shift 2 ;;
    --org) SUPABASE_ORG="${2:?}"; shift 2 ;;
    --gcp-project) GCP_PROJECT="${2:?}"; shift 2 ;;
    --pg-major) SUPABASE_PG_MAJOR="${2:?}"; shift 2 ;;
    --artifact-dir) STAGING_ADMISSION_DIR="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate inputs.
# ---------------------------------------------------------------------------
if [[ -z "$NAME" ]]; then
  echo "ERROR: --name <rig-name> is required." >&2
  usage >&2
  exit 2
fi

# Rig names must be DNS-safe lowercase (used to derive the Supabase project
# name + the Cloud Run service name). Refuse anything that could collide with
# prod/shared-staging naming or break a service name.
if [[ ! "$NAME" =~ ^[a-z][a-z0-9-]{1,28}[a-z0-9]$ ]]; then
  echo "ERROR: --name must be lowercase DNS-safe (3-30 chars, a-z 0-9 -): got '$NAME'." >&2
  exit 2
fi

# Reserved names that derive confusing/colliding service names — refuse them so
# an isolated rig can never masquerade as the shared/prod tier.
case "$NAME" in
  staging|worker|prod|production|main|shared|arkova-worker|arkova-worker-staging)
    echo "ERROR: --name '$NAME' is reserved; pick a lane-specific name (e.g. s0e4-lane-a)." >&2
    exit 2
    ;;
esac

PROJECT_NAME="arkova-soak-${NAME}"
CLOUD_RUN_SERVICE="arkova-worker-${NAME}-staging"

case "$SUPABASE_PG_MAJOR" in
  17) ;;
  *) echo "ERROR: --pg-major must be 17 (prod-parity); got '$SUPABASE_PG_MAJOR'." >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Validate the profile. Only mock/chain/gemini are supported; anything else is
# a typo that would silently deploy the wrong overlay — refuse it.
# ---------------------------------------------------------------------------
IS_MOCK_PROFILE=0
case "$PROFILE" in
  mock)          IS_MOCK_PROFILE=1 ;;
  chain|gemini)  IS_MOCK_PROFILE=0 ;;
  *)
    echo "ERROR: --profile must be one of: mock, chain, gemini; got '$PROFILE'." >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Hard-deny prod / shared staging. Belt-and-suspenders: check both the derived
# Cloud Run service name AND that no override smuggled in a prod/shared ref.
# ---------------------------------------------------------------------------
deny() { echo "REFUSING: $*" >&2; exit 1; }

for denied in "${DENIED_CLOUD_RUN_SERVICES[@]}"; do
  if [[ "$CLOUD_RUN_SERVICE" == "$denied" ]]; then
    deny "derived Cloud Run service '$CLOUD_RUN_SERVICE' is a shared/prod service."
  fi
done

# The provision path creates a brand-new project, so we never *target* a known
# ref — but guard against any env override or accidental name that resolves to
# the prod or shared-staging refs.
if [[ "$PROJECT_NAME" == *"$PROD_SUPABASE_REF"* || "$NAME" == *"$PROD_SUPABASE_REF"* ]]; then
  deny "rig name resolves toward the prod Supabase ref ($PROD_SUPABASE_REF)."
fi
if [[ "$NAME" == *"$SHARED_STAGING_SUPABASE_REF"* ]]; then
  deny "rig name resolves toward the shared staging ref ($SHARED_STAGING_SUPABASE_REF)."
fi
# (The shared-service exact-match deny is the loop above; $NAME is already
# regex-locked to lowercase DNS-safe, so there are no other "case variants".)

# ---------------------------------------------------------------------------
# Apply-mode confirmation gate.
# ---------------------------------------------------------------------------
MODE_LABEL="dry-run"
if [[ $APPLY -eq 1 ]]; then
  MODE_LABEL="apply"
  if [[ "${CONFIRM_PROVISION:-}" != "$NAME" ]]; then
    echo "ERROR: live provision requires CONFIRM_PROVISION=<rig-name> matching --name." >&2
    echo "       Expected CONFIRM_PROVISION='$NAME', got CONFIRM_PROVISION='${CONFIRM_PROVISION:-<unset>}'." >&2
    exit 2
  fi
  # A non-mock profile wires REAL credentials (chain: real Bitcoin exposure via
  # ENABLE_PROD_NETWORK_ANCHORING=true + WIF signer). Require a SECOND explicit
  # ack so a real-money / real-model rig is never provisioned by a bare
  # CONFIRM_PROVISION alone.
  if [[ $IS_MOCK_PROFILE -ne 1 && "${CONFIRM_REAL_CONFIG:-}" != "$PROFILE" ]]; then
    echo "ERROR: live provision of the '$PROFILE' profile is a REAL-config rig and requires" >&2
    echo "       CONFIRM_REAL_CONFIG=<profile> matching --profile (extra ack for real credentials)." >&2
    echo "       Expected CONFIRM_REAL_CONFIG='$PROFILE', got CONFIRM_REAL_CONFIG='${CONFIRM_REAL_CONFIG:-<unset>}'." >&2
    exit 2
  fi
  if [[ -z "$SUPABASE_DB_PASSWORD" ]]; then
    echo "ERROR: live provision requires STAGING_NEW_SUPABASE_DB_PASSWORD to create the Supabase project." >&2
    echo "       Generate/provide it through the operator secret path; it is never printed by this script." >&2
    exit 2
  fi
  if [[ -z "$CHANGED_BEHAVIOR" ]]; then
    echo "ERROR: live provision requires STAGING_CHANGED_BEHAVIOR naming the PR-specific behavior under soak." >&2
    exit 2
  fi
  if [[ ! -f "$DRIVER_PATH" ]]; then
    echo "ERROR: live provision requires STAGING_DRIVER_PATH to exist; got '$DRIVER_PATH'." >&2
    exit 2
  fi
  # Admission foundations fail before any cloud/database mutation. A tag is a
  # mutable pointer, even when its text happens to contain a Git SHA; live rigs
  # accept only a fully qualified digest reference supplied by the operator.
  if [[ $IMAGE_WAS_EXPLICIT -ne 1 || ! "$PINNED_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: live provision requires an explicitly supplied immutable image ref" >&2
    echo "       (--image or STAGING_PINNED_IMAGE) in registry/path@sha256:<64-hex> form; mutable tags are refused." >&2
    exit 2
  fi
  if [[ $SOURCE_HEAD_WAS_EXPLICIT -ne 1 || ! "$DECLARED_SOURCE_HEAD" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: live provision requires an explicit 40-char declared source HEAD via" >&2
    echo "       --source-head or STAGING_SOURCE_HEAD_SHA." >&2
    exit 2
  fi
  LOCAL_HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ "$DECLARED_SOURCE_HEAD" != "$LOCAL_HEAD_SHA" ]]; then
    echo "ERROR: declared source HEAD mismatch: declared=$DECLARED_SOURCE_HEAD git_HEAD=${LOCAL_HEAD_SHA:-<unresolved>}." >&2
    exit 2
  fi
  if [[ -n "${GITHUB_SHA:-}" && "$DECLARED_SOURCE_HEAD" != "$GITHUB_SHA" ]]; then
    echo "ERROR: declared source HEAD mismatch: declared=$DECLARED_SOURCE_HEAD GITHUB_SHA=$GITHUB_SHA." >&2
    exit 2
  fi
  if [[ "$SOAK_ID" == \<required-in-apply:* || ! "$SOAK_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
    echo "ERROR: live provision requires an explicit soak_id via --soak-id or STAGING_SOAK_ID" >&2
    echo "       (3-128 characters: letters, digits, dot, underscore, colon, or hyphen)." >&2
    exit 2
  fi
  if [[ "$PROFILE" == "gemini" ]]; then
    if [[ ! "$APPROVED_GCP_PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
      echo "ERROR: live gemini provision requires a valid approved GCP project identity; got '$APPROVED_GCP_PROJECT'." >&2
      exit 2
    fi
    if [[ "$GCP_PROJECT" != "$APPROVED_GCP_PROJECT" ]]; then
      echo "ERROR: live gemini provision only supports approved GCP project '$APPROVED_GCP_PROJECT'; got '$GCP_PROJECT'." >&2
      exit 2
    fi
    if [[ ! "$GEMINI_TUNED_MODEL_VALUE" =~ ^projects/([^/]+)/locations/us-central1/endpoints/([1-9][0-9]*)$ ]]; then
      echo "ERROR: live gemini provision requires STAGING_GEMINI_TUNED_MODEL as the exact canonical resource" >&2
      echo "       projects/<approved-project>/locations/us-central1/endpoints/<numeric-id>." >&2
      exit 2
    fi
    GEMINI_RESOURCE_PROJECT="${BASH_REMATCH[1]}"
    if [[ "$GEMINI_RESOURCE_PROJECT" != "$APPROVED_GCP_PROJECT" ]]; then
      echo "ERROR: live gemini provision endpoint project must equal approved GCP project '$APPROVED_GCP_PROJECT';" >&2
      echo "       got '$GEMINI_RESOURCE_PROJECT'." >&2
      exit 2
    fi
  fi
  if [[ "$PROFILE" == "gemini" && "$GEMINI_V6_PROMPT_VALUE" != "true" ]]; then
    echo "ERROR: live gemini provision requires GEMINI_V6_PROMPT to be the exact activation value 'true'." >&2
    exit 2
  fi

  # A paid/live rig cannot truthfully identify as T0. The duration floor is the
  # canonical staging-evidence floor (T1=2h, T2=12h, T3=48h).
  case "$TIER" in
    T1) MIN_DURATION_MIN=120 ;;
    T2) MIN_DURATION_MIN=720 ;;
    T3) MIN_DURATION_MIN=2880 ;;
    *)
      echo "ERROR: live rig tier must be one of T1, T2, or T3; T0/unknown tiers cannot provision a soak rig." >&2
      exit 2
      ;;
  esac
  if [[ ! "$DURATION_MIN" =~ ^[1-9][0-9]*$ || ${#DURATION_MIN} -gt 16 ]]; then
    echo "ERROR: live $TIER duration must be a canonical positive integer >= ${MIN_DURATION_MIN} minutes; got '$DURATION_MIN'." >&2
    exit 2
  fi
  DURATION_MIN_VALUE=$((10#$DURATION_MIN))
  if (( DURATION_MIN_VALUE > 9007199254740991 || DURATION_MIN_VALUE < MIN_DURATION_MIN )); then
    echo "ERROR: live $TIER duration must be a safe integer >= ${MIN_DURATION_MIN} minutes; got '$DURATION_MIN'." >&2
    exit 2
  fi

  # Admission base provenance is derived from this exact checkout. Caller
  # metadata may repeat it, but cannot replace it with an arbitrary 40-hex
  # string or a different ancestor.
  EXPECTED_BASE_SHA="$(git merge-base "$DECLARED_SOURCE_HEAD" origin/main 2>/dev/null || true)"
  CANDIDATE_BASE_SHA="${BASE_SHA:-${GITHUB_BASE_SHA:-$EXPECTED_BASE_SHA}}"
  if [[ ! "$EXPECTED_BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: could not resolve the HEAD/origin-main merge-base for live admission." >&2
    exit 2
  fi
  if [[ ! "$CANDIDATE_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || ! git cat-file -e "${CANDIDATE_BASE_SHA}^{commit}" 2>/dev/null \
    || ! git merge-base --is-ancestor "$CANDIDATE_BASE_SHA" "$DECLARED_SOURCE_HEAD" 2>/dev/null; then
    echo "ERROR: live admission BASE_SHA must be an existing 40-hex commit that is an ancestor of declared HEAD." >&2
    exit 2
  fi
  if [[ "$CANDIDATE_BASE_SHA" != "$EXPECTED_BASE_SHA" ]]; then
    echo "ERROR: live admission BASE_SHA must equal the HEAD/origin-main merge-base." >&2
    exit 2
  fi
  VALIDATED_BASE_SHA="$EXPECTED_BASE_SHA"
fi

# ---------------------------------------------------------------------------
# Build the profile-selected worker env/secret overlay.
#
# WORKER_ENV_VARS — comma-joined KEY=VALUE for --set-env-vars (non-secrets only:
#                   flags, model names, a public URL — never credentials).
# WORKER_SECRETS  — comma-joined KEY=secret-name:latest for --set-secrets.
#
# EVERY profile wires the boot-critical secrets so config.ts's Zod superRefine
# (STRIPE_*, API_KEY_HMAC_SECRET, CRON_SECRET, FRONTEND_URL) does not crash-loop
# the worker. The chain profile additionally flips anchoring ON and wires the
# real signer/RPC; gemini wires the tuned model + prompt + key. mock stays safe.
# ---------------------------------------------------------------------------

# Base env every rig gets. FRONTEND_URL is a non-secret public URL (config.ts
# only requires it to be *set* in production, not secret).
BASE_ENV_VARS=(
  "NODE_ENV=production"
  "ENABLE_AI_FRAUD=false"
  "ENABLE_AI_REPORTS=false"
  "CORS_ALLOWED_ORIGINS=https://app.arkova.ai"
  "FRONTEND_URL=${FRONTEND_URL_VALUE}"
)

# Base secrets every rig gets: the NEW project's own Supabase creds PLUS the
# boot-critical Stripe / HMAC / cron secrets (config.ts fails closed without them
# in production, regardless of USE_MOCKS).
BASE_SECRETS=(
  "SUPABASE_URL=supabase-url-${NAME}-staging:latest"
  "SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key-${NAME}-staging:latest"
  "STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY_SECRET}:latest"
  "STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET_SECRET}:latest"
  "API_KEY_HMAC_SECRET=${API_KEY_HMAC_SECRET_SECRET}:latest"
  "CRON_SECRET=${CRON_SECRET_SECRET}:latest"
)

ENV_VARS=("${BASE_ENV_VARS[@]}")
SECRETS=("${BASE_SECRETS[@]}")
USE_MOCKS_VALUE=""
ENABLE_PROD_NETWORK_ANCHORING_VALUE=""
ADMISSION_BITCOIN_NETWORK=""
ADMISSION_BITCOIN_UTXO_PROVIDER=""
ADMISSION_KMS_PROVIDER=""
ADMISSION_GEMINI_TUNED_MODEL=""
ADMISSION_GEMINI_V6_PROMPT=""
ADMISSION_GEMINI_TUNED_RESPONSE_SCHEMA="<unset>"
ADMISSION_NODE_ENV="production"
ADMISSION_ENABLE_AI_FRAUD="false"
ADMISSION_ENABLE_AI_REPORTS="false"
ADMISSION_FRONTEND_URL="$FRONTEND_URL_VALUE"

case "$PROFILE" in
  mock)
    # Safe default: no real chain, no real model.
    USE_MOCKS_VALUE="true"
    ENABLE_PROD_NETWORK_ANCHORING_VALUE="false"
    ENV_VARS+=("USE_MOCKS=true" "ENABLE_PROD_NETWORK_ANCHORING=false")
    ;;
  chain)
    # Real anchoring. USE_MOCKS off + prod-network on + KMS_PROVIDER + signer +
    # GetBlock RPC. config.ts superRefine requires KMS_PROVIDER + a signer when
    # mainnet anchoring is on, or the worker fails closed at boot (by design).
    USE_MOCKS_VALUE="false"
    ENABLE_PROD_NETWORK_ANCHORING_VALUE="true"
    ADMISSION_BITCOIN_NETWORK="$BITCOIN_NETWORK_VALUE"
    ADMISSION_BITCOIN_UTXO_PROVIDER="$BITCOIN_UTXO_PROVIDER_VALUE"
    ADMISSION_KMS_PROVIDER="$KMS_PROVIDER_VALUE"
    ENV_VARS+=(
      "USE_MOCKS=false"
      "ENABLE_PROD_NETWORK_ANCHORING=true"
      "KMS_PROVIDER=${KMS_PROVIDER_VALUE}"
      "BITCOIN_NETWORK=${BITCOIN_NETWORK_VALUE}"
      "BITCOIN_UTXO_PROVIDER=${BITCOIN_UTXO_PROVIDER_VALUE}"
    )
    SECRETS+=(
      "BITCOIN_RPC_URL=${GETBLOCK_RPC_URL_SECRET}:latest"
      "BITCOIN_RPC_AUTH=${GETBLOCK_RPC_AUTH_SECRET}:latest"
      "BITCOIN_TREASURY_WIF=${TREASURY_WIF_SECRET}:latest"
    )
    ;;
  gemini)
    # Real tuned model + prompt. Chain stays mocked (no Bitcoin exposure for an
    # AI-behavior soak). Tuned model + prompt are non-secret selectors; the key
    # is a secret.
    USE_MOCKS_VALUE="true"
    ENABLE_PROD_NETWORK_ANCHORING_VALUE="false"
    ADMISSION_GEMINI_TUNED_MODEL="$GEMINI_TUNED_MODEL_VALUE"
    ADMISSION_GEMINI_V6_PROMPT="$GEMINI_V6_PROMPT_VALUE"
    ENV_VARS+=(
      "USE_MOCKS=true"
      "ENABLE_PROD_NETWORK_ANCHORING=false"
      "GEMINI_TUNED_MODEL=${GEMINI_TUNED_MODEL_VALUE}"
      "GEMINI_V6_PROMPT=${GEMINI_V6_PROMPT_VALUE}"
    )
    SECRETS+=("GEMINI_API_KEY=${GEMINI_API_KEY_SECRET}:latest")
    ;;
esac

# Join arrays into the comma-delimited forms gcloud expects.
join_by_comma() {
  local IFS=','
  echo "$*"
}
WORKER_ENV_VARS="$(join_by_comma "${ENV_VARS[@]}")"
WORKER_SECRETS="$(join_by_comma "${SECRETS[@]}")"

# gcloud's mapping flags use comma as their default entry delimiter. Reject
# delimiter/control injection rather than allowing one operator-controlled value
# to create a second undeclared environment variable or secret binding.
validate_gcloud_mapping_entries() {
  local mapping_kind="$1"
  shift
  local entry key value
  for entry in "$@"; do
    key="${entry%%=*}"
    value="${entry#*=}"
    if [[ ! "$key" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      echo "ERROR: invalid gcloud $mapping_kind mapping key '$key'." >&2
      exit 2
    fi
    if [[ "$value" == *','* || "$value" == *$'\n'* || "$value" == *$'\r'* ]] \
      || printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
      echo "ERROR: gcloud $mapping_kind value for '$key' contains a forbidden delimiter or control character." >&2
      exit 2
    fi
  done
}

if [[ $APPLY -eq 1 ]]; then
  validate_gcloud_mapping_entries "environment" "${ENV_VARS[@]}"
  validate_gcloud_mapping_entries "secret" "${SECRETS[@]}"
fi
SUPABASE_URL_SECRET_NAME="supabase-url-${NAME}-staging"
SUPABASE_SERVICE_ROLE_SECRET_NAME="supabase-service-role-key-${NAME}-staging"
STAGING_ADMISSION_DIR="${STAGING_ADMISSION_DIR:-docs/staging/${NAME}}"
PROVISION_STATE_PATH="${STAGING_ADMISSION_DIR%/}/isolated-rig-provision-${NAME}.json"
CREATED_PROJECT_REF=""
CREATED_CLOUD_RUN_SERVICE=0
CREATED_SUPABASE_SECRETS=0
PREFLIGHT_JSON=""
PREFLIGHT_ARTIFACT_PATH="${STAGING_ADMISSION_DIR%/}/clean-mirror-preflight-${NAME}.json"
PREFLIGHT_VERIFIED_AT="<captured-after-clean_mirror>"
DEPLOYED_REVISION="<captured-after-deploy>"
DEPLOYED_IMAGE_REF="$PINNED_IMAGE"
case "$PINNED_IMAGE" in
  *@sha256:*) DEPLOYED_IMAGE_DIGEST="sha256:${PINNED_IMAGE##*@sha256:}" ;;
  *) DEPLOYED_IMAGE_DIGEST="<verified-after-deploy>" ;;
esac
DEPLOYED_SOURCE_HEAD="$DECLARED_SOURCE_HEAD"
SCHEDULER_APPLICABLE_JSON=false
SCHEDULER_PAUSED_THROUGH_CLEAN_MIRROR_JSON=false
SCHEDULER_STATE="not_applicable"
SCHEDULER_CREATION_GUARD="not_applicable"

# Cloud Scheduler is required for non-mock profiles: node-cron does NOT fire on a
# throttled (min-instances=0) Cloud Run service, so the behavioral cron paths
# (batch-anchors, check-confirmations, classify-proof-backcatalog, …) never run
# without an external Scheduler POST. mock rigs have no behavioral cron to drive.
# Bash 3.2 treats an expanded empty array as unset under `set -u`; retain one
# empty sentinel for mock admission JSON, filtered out by the jq encoder below.
SCHEDULER_JOBS=("")
SCHEDULER_CONFIGURED_SCHEDULE="*/5 * * * *"
# create-http has no atomic --paused flag. Create against a syntactically valid
# non-firing hold schedule, pause + verify, then restore the pre-existing cadence
# while still paused after clean_mirror. This changes no job/matrix semantics.
SCHEDULER_HOLD_SCHEDULE="0 0 31 2 *"
if [[ $IS_MOCK_PROFILE -ne 1 ]]; then
  SCHEDULER_APPLICABLE_JSON=true
  SCHEDULER_STATE="planned_paused_until_clean_mirror_then_resume"
  SCHEDULER_CREATION_GUARD="non-firing hold schedule; create then immediate pause + PAUSED verification"
  case "$PROFILE" in
    chain)  SCHEDULER_JOBS=("batch-anchors" "check-confirmations" "populate-confirmation-proofs" "org-queue-scheduler") ;;
    gemini) SCHEDULER_JOBS=("classify-proof-backcatalog") ;;
  esac
fi

# ---------------------------------------------------------------------------
# Command emitter — print always; execute only under --apply.
# ---------------------------------------------------------------------------
print_cmd() {
  printf '+'
  for arg in "$@"; do
    case "$arg" in
      \<*\>) printf ' %s' "$arg" ;;
      *) printf ' %q' "$arg" ;;
    esac
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

# Like run_cmd, but redacts the X-Cron-Secret header value in everything it
# prints/logs. The real value (fetched from Secret Manager in apply mode) is
# passed only to the executed command — never to stdout/stderr.
run_cmd_cron_redacted() {
  local display=() arg
  for arg in "$@"; do
    if [[ "$arg" == --headers=X-Cron-Secret=* ]]; then
      display+=("--headers=X-Cron-Secret=<redacted:${CRON_SECRET_SECRET}>")
    else
      display+=("$arg")
    fi
  done
  print_cmd "${display[@]}"
  if [[ $APPLY -eq 1 ]]; then
    echo "executing: ${display[*]}" >&2
    "$@"
  fi
}

require_gcloud_secret() {
  local secret_name="$1"
  if ! gcloud secrets describe "$secret_name" --project="$GCP_PROJECT" >/dev/null 2>&1; then
    echo "ERROR: required Secret Manager secret '$secret_name' is missing in project '$GCP_PROJECT'." >&2
    exit 1
  fi
}

if [[ $APPLY -eq 1 ]]; then
  # Fail closed before creating infra if any pre-existing Secret Manager
  # dependency is absent. The NEW project's Supabase URL/service-role secrets
  # are created after Step 1, once the project ref and API keys exist.
  require_gcloud_secret "$STRIPE_SECRET_KEY_SECRET"
  require_gcloud_secret "$STRIPE_WEBHOOK_SECRET_SECRET"
  require_gcloud_secret "$API_KEY_HMAC_SECRET_SECRET"
  require_gcloud_secret "$CRON_SECRET_SECRET"
  case "$PROFILE" in
    chain)
      require_gcloud_secret "$GETBLOCK_RPC_URL_SECRET"
      require_gcloud_secret "$GETBLOCK_RPC_AUTH_SECRET"
      require_gcloud_secret "$TREASURY_WIF_SECRET"
      ;;
    gemini)
      require_gcloud_secret "$GEMINI_API_KEY_SECRET"
      ;;
  esac
fi

write_provision_state() {
  local status="$1"
  local reason="${2:-}"
  local generated_at
  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  mkdir -p "$STAGING_ADMISSION_DIR"
  jq -nc \
    --arg status "$status" \
    --arg reason "$reason" \
    --arg generated_at "$generated_at" \
    --arg rig_name "$NAME" \
    --arg profile "$PROFILE" \
    --arg cloud_run_service "$CLOUD_RUN_SERVICE" \
    --arg cloud_run_region "$CLOUD_RUN_REGION" \
    --arg gcp_project "$GCP_PROJECT" \
    --arg supabase_project_name "$PROJECT_NAME" \
    --arg supabase_project_ref "${CREATED_PROJECT_REF:-$NEW_PROJECT_REF}" \
    --arg supabase_url_secret "$SUPABASE_URL_SECRET_NAME" \
    --arg supabase_service_role_secret "$SUPABASE_SERVICE_ROLE_SECRET_NAME" \
    --arg image "$PINNED_IMAGE" \
    --arg declared_source_head "$DECLARED_SOURCE_HEAD" \
    --arg soak_id "$SOAK_ID" \
    --arg deployed_revision "$DEPLOYED_REVISION" \
    --arg deployed_image_digest "$DEPLOYED_IMAGE_DIGEST" \
    --arg deployed_source_head "$DEPLOYED_SOURCE_HEAD" \
    --arg scheduler_state "$SCHEDULER_STATE" \
    --arg scheduler_creation_guard "$SCHEDULER_CREATION_GUARD" \
    --arg preflight_artifact "$PREFLIGHT_ARTIFACT_PATH" \
    --arg preflight_verified_at "$PREFLIGHT_VERIFIED_AT" \
    --arg state_path "$PROVISION_STATE_PATH" \
    --argjson created_cloud_run_service "$CREATED_CLOUD_RUN_SERVICE" \
    --argjson created_supabase_secrets "$CREATED_SUPABASE_SECRETS" \
    '{
      status: $status,
      reason: $reason,
      generated_at: $generated_at,
      rig_name: $rig_name,
      profile: $profile,
      cloud_run_service: $cloud_run_service,
      cloud_run_region: $cloud_run_region,
      gcp_project: $gcp_project,
      supabase_project_name: $supabase_project_name,
      supabase_project_ref: $supabase_project_ref,
      secrets: {
        supabase_url: $supabase_url_secret,
        supabase_service_role_key: $supabase_service_role_secret
      },
      image: $image,
      declared_source_head: $declared_source_head,
      soak_id: $soak_id,
      deployed_revision: $deployed_revision,
      deployed_image_digest: $deployed_image_digest,
      deployed_source_head: $deployed_source_head,
      scheduler_state: $scheduler_state,
      scheduler_creation_guard: $scheduler_creation_guard,
      clean_mirror: {
        artifact: $preflight_artifact,
        verified_at: $preflight_verified_at
      },
      created_cloud_run_service: $created_cloud_run_service,
      created_supabase_secrets: $created_supabase_secrets,
      state_path: $state_path,
      cleanup_hint: "If status is blocked_after_project_create, either resume with the same rig name/ref and verify these secrets, or run scripts/staging/teardown-isolated-rig.sh against the recorded service/ref."
    }' >"$PROVISION_STATE_PATH"
  echo "# provision state: $PROVISION_STATE_PATH"
}

on_apply_error() {
  local rc=$?
  if [[ $APPLY -eq 1 && -n "${CREATED_PROJECT_REF:-}" ]]; then
    write_provision_state "blocked_after_project_create" "provisioner exited non-zero before clean_mirror admission"
  fi
  exit "$rc"
}

if [[ $APPLY -eq 1 ]]; then
  trap on_apply_error ERR
fi

ensure_secret_with_value() {
  local secret_name="$1"
  local secret_value="$2"
  if [[ -z "$secret_value" ]]; then
    echo "ERROR: refusing to create empty Secret Manager secret '$secret_name'." >&2
    exit 1
  fi

  if gcloud secrets describe "$secret_name" --project="$GCP_PROJECT" >/dev/null 2>&1; then
    printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" \
      --project="$GCP_PROJECT" \
      --data-file=-
  else
    printf '%s' "$secret_value" | gcloud secrets create "$secret_name" \
      --project="$GCP_PROJECT" \
      --replication-policy=automatic \
      --data-file=-
  fi
  gcloud secrets versions access latest --secret="$secret_name" --project="$GCP_PROJECT" >/dev/null
}

extract_service_role_key() {
  local api_keys_json="$1"
  jq -r '
    if type == "array" then
      (.[] | select((.name // .type // .key_type // .role // "" | ascii_downcase) | test("service")) | .api_key // .key // .value // empty) // empty
    else
      (.service_role_key // .service_role // .serviceRoleKey // .service_role_api_key // empty)
    end
  ' <<<"$api_keys_json" | head -n 1
}

create_supabase_runtime_secrets() {
  local project_ref="$1"
  local supabase_url
  local service_role_key
  local api_keys_json
  supabase_url="https://${project_ref}.supabase.co"

  if [[ -n "${STAGING_NEW_SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    service_role_key="$STAGING_NEW_SUPABASE_SERVICE_ROLE_KEY"
  else
    api_keys_json="$(npx supabase projects api-keys --project-ref "$project_ref" --output json)"
    service_role_key="$(extract_service_role_key "$api_keys_json")"
  fi

  if [[ -z "$service_role_key" ]]; then
    echo "ERROR: could not resolve service-role key for Supabase project '$project_ref'." >&2
    echo "       No Cloud Run deploy was attempted; create/verify the key, then resume." >&2
    exit 1
  fi

  echo "# creating/verifying per-rig Secret Manager secrets before Cloud Run deploy"
  print_cmd gcloud secrets create "$SUPABASE_URL_SECRET_NAME" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
  print_cmd gcloud secrets create "$SUPABASE_SERVICE_ROLE_SECRET_NAME" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
  ensure_secret_with_value "$SUPABASE_URL_SECRET_NAME" "$supabase_url"
  ensure_secret_with_value "$SUPABASE_SERVICE_ROLE_SECRET_NAME" "$service_role_key"
  CREATED_SUPABASE_SECRETS=1
  write_provision_state "supabase_secrets_recorded" ""
}

resolve_head_sha() {
  if [[ "$DECLARED_SOURCE_HEAD" != \<required-in-apply:* ]]; then
    printf '%s\n' "$DECLARED_SOURCE_HEAD"
  elif [[ -n "${GITHUB_SHA:-}" ]]; then
    printf '%s\n' "$GITHUB_SHA"
  else
    git rev-parse HEAD 2>/dev/null || printf 'unknown\n'
  fi
}

resolve_base_sha() {
  if [[ -n "$VALIDATED_BASE_SHA" ]]; then
    printf '%s\n' "$VALIDATED_BASE_SHA"
  elif [[ -n "${BASE_SHA:-}" ]]; then
    printf '%s\n' "$BASE_SHA"
  elif [[ -n "${GITHUB_BASE_SHA:-}" ]]; then
    printf '%s\n' "$GITHUB_BASE_SHA"
  else
    git merge-base HEAD origin/main 2>/dev/null || printf 'unknown\n'
  fi
}

short_sha() {
  local sha="$1"
  if [[ "$sha" == "unknown" ]]; then
    printf 'unknown\n'
  else
    printf '%.12s\n' "$sha"
  fi
}

resolve_owner() {
  printf '%s@%s\n' "${USER:-unknown}" "$(hostname -s 2>/dev/null || echo host)"
}

image_digest_from_ref() {
  local image_ref="$1"
  case "$image_ref" in
    *@sha256:*) printf 'sha256:%s\n' "${image_ref##*@sha256:}" ;;
    sha256:*) printf '%s\n' "$image_ref" ;;
    *) return 1 ;;
  esac
}

resolve_image_digest() {
  if image_digest_from_ref "$PINNED_IMAGE"; then
    return 0
  fi
  printf '<required-immutable-image-digest>\n'
}

verify_deployed_revision_provenance() {
  DEPLOYED_REVISION="$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
    --region="$CLOUD_RUN_REGION" \
    --project="$GCP_PROJECT" \
    --format="value(status.latestReadyRevisionName)")"
  if [[ -z "$DEPLOYED_REVISION" ]]; then
    echo "ERROR: could not resolve latest ready revision for '$CLOUD_RUN_SERVICE'." >&2
    exit 1
  fi

  local revision_json expected_digest resolved_digest
  revision_json="$(gcloud run revisions describe "$DEPLOYED_REVISION" \
    --region="$CLOUD_RUN_REGION" \
    --project="$GCP_PROJECT" \
    --format=json)"
  if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$revision_json"; then
    echo "ERROR: Cloud Run revision describe did not return a valid JSON object." >&2
    exit 1
  fi

  DEPLOYED_IMAGE_REF="$(jq -r '.spec.containers[0].image // empty' <<<"$revision_json")"
  resolved_digest="$(jq -r '.status.imageDigest // empty' <<<"$revision_json")"
  DEPLOYED_SOURCE_HEAD="$(jq -r '.metadata.labels["arkova-source-head"] // empty' <<<"$revision_json")"

  expected_digest="$(image_digest_from_ref "$PINNED_IMAGE")"
  # Cloud Run RevisionStatus.imageDigest is controller-observed and is populated
  # with the resolved digest even when spec.containers[0].image retains a tag.
  DEPLOYED_IMAGE_DIGEST="$(image_digest_from_ref "$resolved_digest" 2>/dev/null || true)"
  if [[ -z "$DEPLOYED_IMAGE_DIGEST" || "$DEPLOYED_IMAGE_DIGEST" != "$expected_digest" ]]; then
    echo "ERROR: deployed revision image digest mismatch: expected=$expected_digest got=${DEPLOYED_IMAGE_DIGEST:-<missing>}." >&2
    exit 1
  fi
  if [[ "$DEPLOYED_SOURCE_HEAD" != "$DECLARED_SOURCE_HEAD" ]]; then
    echo "ERROR: deployed revision source HEAD mismatch: expected=$DECLARED_SOURCE_HEAD got=${DEPLOYED_SOURCE_HEAD:-<missing>}." >&2
    exit 1
  fi

  verify_deployed_revision_env "$revision_json"
}

observed_revision_env_value() {
  local revision_json="$1"
  local env_name="$2"
  jq -r --arg name "$env_name" '
    [.spec.containers[0].env[]? | select(.name == $name and (.value | type == "string"))]
    | if length == 1 then .[0].value else empty end
  ' <<<"$revision_json"
}

verify_deployed_revision_env() {
  local revision_json="$1"
  local entry key expected observed count
  for entry in "${ENV_VARS[@]}"; do
    key="${entry%%=*}"
    expected="${entry#*=}"
    count="$(jq -r --arg name "$key" '[.spec.containers[0].env[]? | select(.name == $name)] | length' <<<"$revision_json")"
    observed="$(observed_revision_env_value "$revision_json" "$key")"
    if [[ "$count" != "1" || "$observed" != "$expected" ]]; then
      echo "ERROR: deployed revision environment '$key' does not exactly match the declared non-secret value." >&2
      exit 1
    fi
  done

  count="$(jq -r '[.spec.containers[0].env[]? | select(.name == "GEMINI_TUNED_RESPONSE_SCHEMA")] | length' <<<"$revision_json")"
  if [[ "$count" != "0" ]]; then
    echo "ERROR: deployed revision environment contains forbidden GEMINI_TUNED_RESPONSE_SCHEMA flag bleed." >&2
    exit 1
  fi

  # Admission values come from the immutable deployed revision, not the caller's
  # requested overlay. --set-env-vars replaces the old set, and this observation
  # proves the schema selector was actively absent from the resulting revision.
  ADMISSION_NODE_ENV="$(observed_revision_env_value "$revision_json" "NODE_ENV")"
  ADMISSION_ENABLE_AI_FRAUD="$(observed_revision_env_value "$revision_json" "ENABLE_AI_FRAUD")"
  ADMISSION_ENABLE_AI_REPORTS="$(observed_revision_env_value "$revision_json" "ENABLE_AI_REPORTS")"
  ADMISSION_FRONTEND_URL="$(observed_revision_env_value "$revision_json" "FRONTEND_URL")"
  USE_MOCKS_VALUE="$(observed_revision_env_value "$revision_json" "USE_MOCKS")"
  ENABLE_PROD_NETWORK_ANCHORING_VALUE="$(observed_revision_env_value "$revision_json" "ENABLE_PROD_NETWORK_ANCHORING")"
  if [[ "$PROFILE" == "chain" ]]; then
    ADMISSION_KMS_PROVIDER="$(observed_revision_env_value "$revision_json" "KMS_PROVIDER")"
    ADMISSION_BITCOIN_NETWORK="$(observed_revision_env_value "$revision_json" "BITCOIN_NETWORK")"
    ADMISSION_BITCOIN_UTXO_PROVIDER="$(observed_revision_env_value "$revision_json" "BITCOIN_UTXO_PROVIDER")"
  elif [[ "$PROFILE" == "gemini" ]]; then
    ADMISSION_GEMINI_TUNED_MODEL="$(observed_revision_env_value "$revision_json" "GEMINI_TUNED_MODEL")"
    ADMISSION_GEMINI_V6_PROMPT="$(observed_revision_env_value "$revision_json" "GEMINI_V6_PROMPT")"
  fi
  ADMISSION_GEMINI_TUNED_RESPONSE_SCHEMA="<unset>"
}

verify_scheduler_job_state() {
  local job_name="$1"
  local expected_state="$2"
  local actual_state
  if ! actual_state="$(gcloud scheduler jobs describe "$job_name" \
    --project="$GCP_PROJECT" \
    --location="$CLOUD_RUN_REGION" \
    --format="value(state)")"; then
    echo "ERROR: Scheduler job '$job_name' could not be described while verifying state=$expected_state." >&2
    exit 1
  fi
  if [[ "$actual_state" != "$expected_state" ]]; then
    echo "ERROR: Scheduler job '$job_name' state mismatch: expected=$expected_state got=${actual_state:-<missing>}." >&2
    exit 1
  fi
}

resolve_driver_sha256() {
  if [[ ! -f "$DRIVER_PATH" ]]; then
    echo "ERROR: required staging driver '$DRIVER_PATH' does not exist." >&2
    exit 1
  fi
  shasum -a 256 "$DRIVER_PATH" | awk '{print $1}'
}

resolve_cloud_run_url() {
  if [[ $APPLY -eq 1 ]]; then
    local url
    url="$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
      --region="$CLOUD_RUN_REGION" \
      --project="$GCP_PROJECT" \
      --format="value(status.url)")"
    if [[ -z "$url" ]]; then
      echo "ERROR: could not resolve Cloud Run service URL for $CLOUD_RUN_SERVICE." >&2
      exit 1
    fi
    printf '%s\n' "$url"
    return 0
  fi

  printf '%s\n' "${STAGING_RIG_TAG_URL:-<captured-cloud-run-url-for-${CLOUD_RUN_SERVICE}>}"
}

emit_admission_json() {
  local schema_version="$1"
  local rig_name="$2"
  local cloud_run_service="$3"
  local image="$4"
  local head_sha="$5"
  local base_sha="$6"
  local image_digest="$7"
  local tag_url="$8"
  local supabase_project_ref="$9"
  local preflight_result="${10}"
  local driver_path="${11}"
  local driver_sha256="${12}"
  local changed_behavior="${13}"
  local owner="${14}"
  local generated_at
  if [[ $APPLY -eq 1 ]]; then
    generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  else
    generated_at="${ADMISSION_GENERATED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
  fi

  jq -nc \
    --argjson schema_version "$schema_version" \
    --arg kind "isolated_rig_admission" \
    --arg generated_at "$generated_at" \
    --arg rig_name "$rig_name" \
    --arg profile "$PROFILE" \
    --arg soak_id "$SOAK_ID" \
    --arg cloud_run_service "$cloud_run_service" \
    --arg tier "$TIER" \
    --argjson duration_min "$DURATION_MIN" \
    --arg sha "$head_sha" \
    --arg declared_source_head "$DECLARED_SOURCE_HEAD" \
    --arg base_sha "$base_sha" \
    --arg image "$image" \
    --arg image_digest "$image_digest" \
    --arg deployed_revision "$DEPLOYED_REVISION" \
    --arg deployed_image_ref "$DEPLOYED_IMAGE_REF" \
    --arg deployed_image_digest "$DEPLOYED_IMAGE_DIGEST" \
    --arg deployed_source_head "$DEPLOYED_SOURCE_HEAD" \
    --arg tag_url "$tag_url" \
    --arg supabase_project_ref "$supabase_project_ref" \
    --arg preflight_result "$preflight_result" \
    --arg preflight_artifact "$PREFLIGHT_ARTIFACT_PATH" \
    --arg preflight_verified_at "$PREFLIGHT_VERIFIED_AT" \
    --arg node_env "$ADMISSION_NODE_ENV" \
    --arg enable_ai_fraud "$ADMISSION_ENABLE_AI_FRAUD" \
    --arg enable_ai_reports "$ADMISSION_ENABLE_AI_REPORTS" \
    --arg frontend_url "$ADMISSION_FRONTEND_URL" \
    --arg use_mocks "$USE_MOCKS_VALUE" \
    --arg enable_prod_network_anchoring "$ENABLE_PROD_NETWORK_ANCHORING_VALUE" \
    --arg bitcoin_network "$ADMISSION_BITCOIN_NETWORK" \
    --arg bitcoin_utxo_provider "$ADMISSION_BITCOIN_UTXO_PROVIDER" \
    --arg kms_provider "$ADMISSION_KMS_PROVIDER" \
    --arg gemini_tuned_model "$ADMISSION_GEMINI_TUNED_MODEL" \
    --arg gemini_v6_prompt "$ADMISSION_GEMINI_V6_PROMPT" \
    --arg gemini_tuned_response_schema "$ADMISSION_GEMINI_TUNED_RESPONSE_SCHEMA" \
    --argjson scheduler_applicable "$SCHEDULER_APPLICABLE_JSON" \
    --argjson scheduler_paused_through_clean_mirror "$SCHEDULER_PAUSED_THROUGH_CLEAN_MIRROR_JSON" \
    --arg scheduler_state "$SCHEDULER_STATE" \
    --arg scheduler_creation_guard "$SCHEDULER_CREATION_GUARD" \
    --argjson scheduler_jobs "$(printf '%s\n' "${SCHEDULER_JOBS[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
    --arg driver_path "$driver_path" \
    --arg driver_sha256 "$driver_sha256" \
    --arg changed_behavior "$changed_behavior" \
    --arg harness_version "$driver_path@$(short_sha "$head_sha")" \
    --arg tool_version "scripts/staging/provision-isolated-rig.sh@$(short_sha "$head_sha")" \
    --arg owner "$owner" \
    '{
      schema_version: $schema_version,
      kind: $kind,
      generated_at: $generated_at,
      rig_name: $rig_name,
      profile: $profile,
      soak_id: $soak_id,
      cloud_run_service: $cloud_run_service,
      tier: $tier,
      duration_min: $duration_min,
      sha: $sha,
      declared_source_head: $declared_source_head,
      base_sha: $base_sha,
      image: $image,
      image_digest: $image_digest,
      deployed_revision: $deployed_revision,
      deployed_image_ref: $deployed_image_ref,
      deployed_image_digest: $deployed_image_digest,
      deployed_source_head: $deployed_source_head,
      tag_url: $tag_url,
      supabase_project_ref: $supabase_project_ref,
      preflight_result: $preflight_result,
      clean_mirror: {
        result: $preflight_result,
        artifact: $preflight_artifact,
        verified_at: $preflight_verified_at
      },
      critical_config: {
        node_env: $node_env,
        enable_ai_fraud: $enable_ai_fraud,
        enable_ai_reports: $enable_ai_reports,
        frontend_url: $frontend_url,
        use_mocks: $use_mocks,
        enable_prod_network_anchoring: $enable_prod_network_anchoring,
        bitcoin_network: $bitcoin_network,
        bitcoin_utxo_provider: $bitcoin_utxo_provider,
        kms_provider: $kms_provider,
        gemini_tuned_model: $gemini_tuned_model,
        gemini_v6_prompt: $gemini_v6_prompt,
        gemini_tuned_response_schema: $gemini_tuned_response_schema
      },
      scheduler: {
        applicable: $scheduler_applicable,
        jobs: $scheduler_jobs,
        creation_guard: $scheduler_creation_guard,
        paused_through_clean_mirror: $scheduler_paused_through_clean_mirror,
        state: $scheduler_state
      },
      driver_path: $driver_path,
      driver_sha256: $driver_sha256,
      changed_behavior: $changed_behavior,
      harness_version: $harness_version,
      tool_version: $tool_version,
      owner: $owner,
      stop_conditions: [
        "SHA mismatch between admission JSON and PR head",
        "base SHA drift with runtime/schema/staging/deploy impact",
        "image digest mismatch against deployed Cloud Run revision",
        "dirty preflight (environment_type != clean_mirror)",
        "Supabase project ref resolves to prod or shared staging",
        "Cloud Run service/tag URL points at shared/main staging",
        "driver_path or driver_sha256 mismatch",
        "soak harness exits non-zero or fails required duration"
      ]
    }'
}

# ---------------------------------------------------------------------------
# Plan header.
# ---------------------------------------------------------------------------
echo "S0-4.1 isolated soak-rig provision"
echo "rig name:          $NAME"
echo "profile:           $PROFILE"
echo "Supabase project:  $PROJECT_NAME (NEW standalone project, NOT a preview branch)"
echo "Supabase region:   $SUPABASE_REGION (PG ${SUPABASE_PG_MAJOR}.x)"
echo "Supabase org:      $SUPABASE_ORG"
echo "Cloud Run service: $CLOUD_RUN_SERVICE"
echo "Cloud Run region:  $CLOUD_RUN_REGION"
echo "GCP project:       $GCP_PROJECT"
echo "Pinned image:      $PINNED_IMAGE"
echo "Declared source:   $DECLARED_SOURCE_HEAD"
echo "Soak id:           $SOAK_ID"
echo "Runtime SA:        $RUNTIME_SA"
echo "mode:              $MODE_LABEL"
echo "artifact dir:      $STAGING_ADMISSION_DIR"
echo "prod ref (denied): $PROD_SUPABASE_REF"
echo "shared staging:    $SHARED_STAGING_SUPABASE_REF (denied as a target)"
echo

if [[ $APPLY -ne 1 ]]; then
  echo "DRY-RUN: no infrastructure will be created. Re-run with --apply and"
  echo "         CONFIRM_PROVISION=$NAME to execute (Carson-gated; see runbook)."
  echo
fi

# ---------------------------------------------------------------------------
# Step 1 — create the standalone Supabase project.
#
# In a real environment this is the Supabase Management API / MCP create_project
# (after get_cost + confirm_cost). We emit the CLI-equivalent command; a session
# with the Supabase MCP wired should call create_project instead and capture the
# returned project ref. Either way the result is a NEW ref — never prod/shared.
# ---------------------------------------------------------------------------
echo "# Step 1/6 — create standalone Supabase project (cost-gated; \$10/mo Pro)"
echo "#   MCP-equivalent: get_cost -> confirm_cost -> create_project"
echo "#   region=$SUPABASE_REGION, postgres major=$SUPABASE_PG_MAJOR, org=$SUPABASE_ORG"
# Define the create command once (no triple copy-paste, no drift). The apply
# path appends --output json so the new ref can be captured + re-validated.
CREATE_CMD=(npx supabase projects create "$PROJECT_NAME" --org-id "$SUPABASE_ORG" --region "$SUPABASE_REGION")
NEW_PROJECT_REF='<captured-from-step-1>'
print_cmd "${CREATE_CMD[@]}" --db-password '<redacted:STAGING_NEW_SUPABASE_DB_PASSWORD>'
if [[ $APPLY -eq 1 ]]; then
  echo "executing: ${CREATE_CMD[*]} --db-password <redacted> --output json" >&2
  # Capture the new ref so links/pushes/preflight target the validated project,
  # never whatever happens to be linked on disk (review #1). Fail loudly if the
  # ref can't be captured — better to abort than orphan + push blind (review #2).
  NEW_PROJECT_REF="$("${CREATE_CMD[@]}" --db-password "$SUPABASE_DB_PASSWORD" --output json 2>/dev/null | jq -r '.id // .ref // empty')"
  if [[ -z "$NEW_PROJECT_REF" ]]; then
    echo "ERROR: could not capture the new project ref from 'supabase projects create'." >&2
    echo "       Capture it manually, verify it is NOT prod/shared, then run the remaining steps." >&2
    exit 1
  fi
  # Re-validate the freshly created ref against the deny list BEFORE any schema push.
  if [[ "$NEW_PROJECT_REF" == "$PROD_SUPABASE_REF" || "$NEW_PROJECT_REF" == "$SHARED_STAGING_SUPABASE_REF" ]]; then
    deny "created/resolved ref '$NEW_PROJECT_REF' is prod/shared — aborting before any schema push."
  fi
  CREATED_PROJECT_REF="$NEW_PROJECT_REF"
  echo "captured NEW_PROJECT_REF=$NEW_PROJECT_REF" >&2
  write_provision_state "project_created" ""
else
  echo "#   -> (apply mode captures the returned ref into NEW_PROJECT_REF and re-validates it"
  echo "#       against $PROD_SUPABASE_REF / $SHARED_STAGING_SUPABASE_REF before any push)."
  echo "#   -> (apply mode creates $SUPABASE_URL_SECRET_NAME and"
  echo "#       $SUPABASE_SERVICE_ROLE_SECRET_NAME from the NEW project's API keys in Step 2b)."
fi
echo

# ---------------------------------------------------------------------------
# Step 2 — replay repo schema onto the new project.
#
# Link to the CAPTURED ref (not the on-disk link, review #1), then push. The
# CLI parser recognises lettered-suffix files like 0055b_* (unlike the
# preview-branch builder). Bootstrap extensions + enum pre-adds per
# docs/reference/STAGING_RIG.md "How to populate".
# ---------------------------------------------------------------------------
echo "# Step 2/6 — link to the captured ref + replay repo schema (CLI parser, lettered-suffix safe)"
run_cmd npx supabase link --project-ref "$NEW_PROJECT_REF"
echo "#   bootstrap extensions + enum pre-adds (see STAGING_RIG.md) via MCP execute_sql / Mgmt API"
echo "#   db push --linked now targets the just-linked $NEW_PROJECT_REF (validated above)."
run_cmd npx supabase db push --linked
echo

echo "# Step 2b/6 — create/record per-rig Supabase Secret Manager secrets"
if [[ $APPLY -eq 1 ]]; then
  create_supabase_runtime_secrets "$NEW_PROJECT_REF"
else
  print_cmd npx supabase projects api-keys --project-ref "$NEW_PROJECT_REF" --output json
  print_cmd gcloud secrets create "$SUPABASE_URL_SECRET_NAME" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
  print_cmd gcloud secrets create "$SUPABASE_SERVICE_ROLE_SECRET_NAME" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
  echo "#   apply mode derives https://<captured-ref>.supabase.co, fetches the service-role key,"
  echo "#   writes both per-rig secrets, verifies latest versions are readable, and records"
  echo "#   the secret names in $PROVISION_STATE_PATH before Cloud Run deploy."
fi
echo

# ---------------------------------------------------------------------------
# Step 3 — deploy the wired isolated Cloud Run worker on the pinned image.
#
# Env/secret overlay is PROFILE-SELECTED (WORKER_ENV_VARS / WORKER_SECRETS built
# above). NODE_ENV=production (Zod rejects 'staging'), IAM-protected, min=0/max=2.
# The worker points at the NEW project's own Supabase secrets — never prod, never
# shared staging. For chain/gemini the overlay also carries the real anchoring /
# tuned-model config; for every profile it carries the boot-critical Stripe / HMAC
# / cron secrets so config.ts's production superRefine does not crash-loop.
# ---------------------------------------------------------------------------
echo "# Step 3/6 — deploy isolated worker '$CLOUD_RUN_SERVICE' on pinned image (profile=$PROFILE)"
echo "#   env-vars: $WORKER_ENV_VARS"
run_cmd gcloud run deploy "$CLOUD_RUN_SERVICE" \
  --project="$GCP_PROJECT" \
  --region="$CLOUD_RUN_REGION" \
  --image="$PINNED_IMAGE" \
  --labels="arkova-source-head=${DECLARED_SOURCE_HEAD}" \
  --service-account="$RUNTIME_SA" \
  --no-allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=1Gi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="$WORKER_ENV_VARS" \
  --set-secrets="$WORKER_SECRETS"
if [[ $APPLY -eq 1 ]]; then
  CREATED_CLOUD_RUN_SERVICE=1
  verify_deployed_revision_provenance
  write_provision_state "cloud_run_provenance_verified" ""
fi
if [[ $IS_MOCK_PROFILE -ne 1 ]]; then
  echo "#   NOTE (profile=$PROFILE): the real-config secrets referenced above must already"
  echo "#         exist in Secret Manager (project $GCP_PROJECT) and hold the intended"
  echo "#         test-tier credentials — the operator verifies this before --apply."
fi
echo

# ---------------------------------------------------------------------------
# Step 4 — Cloud Scheduler wiring for the behavioral cron paths (non-mock only).
#
# node-cron does NOT fire on a throttled (min-instances=0) Cloud Run service:
# the in-process scheduler is suspended between requests, so the periodic jobs
# never run. A real behavioral soak of the anchoring / classifier / batch-drain
# paths therefore requires Cloud Scheduler to POST to the worker's /jobs/*
# endpoints on a cadence. The jobs authenticate with the same cron secret
# (X-Cron-Secret) AND an OIDC token (the service is --no-allow-unauthenticated).
# mock rigs skip this entirely (no behavioral cron to drive).
# ---------------------------------------------------------------------------
echo "# Step 4/6 — Cloud Scheduler -> /jobs/* wiring (node-cron does not fire on throttled Cloud Run)"
if [[ $IS_MOCK_PROFILE -eq 1 ]]; then
  echo "#   profile=mock — no behavioral cron to drive; skipping Scheduler job creation."
else
  # WORKER_URL: apply mode resolves the REAL URL from the service deployed in
  # Step 3 (gcloud run services describe); dry-run keeps the clearly-labeled
  # <captured-cloud-run-url-…> placeholder. Both paths live in
  # resolve_cloud_run_url() — no hand-built URL, no stale placeholder.
  WORKER_URL="$(resolve_cloud_run_url)"
  if [[ $APPLY -eq 1 ]]; then
    # Fetch the cron secret VALUE from Secret Manager at apply time so the
    # Scheduler POST passes the worker's cronAuth. The value stays in memory:
    # every printed/logged command form is redacted (run_cmd_cron_redacted).
    CRON_SECRET_VALUE="$(gcloud secrets versions access latest \
      --secret="$CRON_SECRET_SECRET" \
      --project="$GCP_PROJECT")"
    if [[ -z "$CRON_SECRET_VALUE" ]]; then
      echo "ERROR: could not fetch cron secret '$CRON_SECRET_SECRET' from Secret Manager." >&2
      exit 1
    fi
  else
    CRON_SECRET_VALUE="<redacted:${CRON_SECRET_SECRET}>"
    echo "#   (dry-run: WORKER_URL + X-Cron-Secret shown as labeled placeholders; apply mode"
    echo "#    resolves them via 'gcloud run services describe' + Secret Manager access —"
    echo "#    the secret value is never printed in either mode.)"
  fi
  for job in "${SCHEDULER_JOBS[@]}"; do
    scheduler_job_name="${CLOUD_RUN_SERVICE}-${job}"
    run_cmd_cron_redacted gcloud scheduler jobs create http "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" \
      --schedule="$SCHEDULER_HOLD_SCHEDULE" \
      --uri="${WORKER_URL}/jobs/${job}" \
      --http-method=POST \
      --headers="X-Cron-Secret=${CRON_SECRET_VALUE}" \
      --oidc-service-account-email="$CRON_OIDC_SA" \
      --oidc-token-audience="$WORKER_URL"
    # Cloud Scheduler's create-http command has no create-paused flag. The hold
    # schedule cannot fire; pause immediately, verify PAUSED, and do not execute
    # seed/preflight until every job is confirmed paused.
    run_cmd gcloud scheduler jobs pause "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION"
    if [[ $APPLY -eq 1 ]]; then
      verify_scheduler_job_state "$scheduler_job_name" "PAUSED"
    else
      print_cmd gcloud scheduler jobs describe "$scheduler_job_name" \
        --project="$GCP_PROJECT" \
        --location="$CLOUD_RUN_REGION" \
        --format="value(state)"
    fi
  done
  SCHEDULER_STATE="paused_before_seed"
fi
echo

# ---------------------------------------------------------------------------
# Step 5 — seed the baseline fixture so the preflight's Check 5 passes.
#
# Inserts the minimal valid fixture chain (auth.users -> profiles -> anchors,
# plus one org) to produce exactly one status='SUBMITTED' anchor. Without this a
# fresh rig has zero SUBMITTED anchors -> preflight classifies it `fixture_seeded`
# and the Staging Soak Evidence Gate rejects the soak as HOLLOW.
#
# §1.11A: DATA-ONLY. The seed writes NOTHING to supabase_migrations and runs no
# migration repair; it is idempotent (ON CONFLICT DO NOTHING on stable
# `seed-fixture` ids) so re-provisioning is safe. The seed sets a
# transaction-local service_role JWT claim so protect_anchor_status_transition()
# permits the SUBMITTED insert. `supabase db query --linked --file` is used (not
# the Management API read-write query endpoint, which a Cloudflare integrity rule
# (error 1010) blocks for automated clients) — the CLI reaches the DB directly.
# ---------------------------------------------------------------------------
echo "# Step 5/6 — seed baseline fixture (>=1 SUBMITTED anchor; data-only, §1.11A)"
run_cmd npx supabase db query --linked --file scripts/staging/seed-baseline-fixture.sql

# ---------------------------------------------------------------------------
# Step 6 — clean_mirror preflight against the NEW project.
#
# This MUST report environment_type=clean_mirror before the rig is declared
# soak-ready (CLAUDE.md §1.11A). Exit non-zero from the preflight aborts here
# under set -e in --apply mode.
# ---------------------------------------------------------------------------
echo "# Step 6/6 — clean_mirror preflight (CLAUDE.md §1.11A)"
PREFLIGHT_RESULT="${STAGING_PREFLIGHT_RESULT:-environment_type=<from-step-6>}"
if [[ $APPLY -eq 1 ]]; then
  print_cmd npx tsx scripts/ci/staging-honesty-preflight.ts \
    --project-ref "$NEW_PROJECT_REF" \
    --format json
  echo "executing: npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref $NEW_PROJECT_REF --format json" >&2
  PREFLIGHT_JSON="$(npx tsx scripts/ci/staging-honesty-preflight.ts \
    --project-ref "$NEW_PROJECT_REF" \
    --format json)"
  # Accept only the report contract emitted by staging-honesty-preflight.ts.
  # Unknown keys (including secret-bearing additions), mismatched refs, malformed
  # timestamps, failed checks, and malformed nested rows all fail closed. Raw
  # preflight JSON is never echoed or persisted.
  if ! PREFLIGHT_ARTIFACT_JSON="$(jq -ce --arg project_ref "$NEW_PROJECT_REF" '
    . as $report |
    (type == "object") and
    ((keys | sort) == (["artifact_rows", "checks", "environment_type", "extra_vs_prod", "missing_from_staging", "staging_project_ref", "timestamp"] | sort)) and
    (.environment_type == "clean_mirror") and
    (.staging_project_ref == $project_ref) and
    (.timestamp | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$")) and
    (.checks | type == "array") and
    (all(.checks[];
      (type == "object") and
      ((keys | sort) == (["details", "name", "passed"] | sort)) and
      (.name | type == "string" and length > 0) and
      (.passed | type == "boolean") and
      (.passed == true) and
      (.details | type == "string")
    )) and
    ([.checks[].name] as $check_names |
      ($check_names | length) == ($check_names | unique | length) and
      all($check_names[];
        . == "staging_only_rows" or
        . == "duplicate_names" or
        . == "duplicate_versions" or
        . == "known_artifacts" or
        . == "submitted_anchors" or
        . == "prod_divergence" or
        . == "org_topology" or
        . == "prod_facts"
      ) and
      all([
        "staging_only_rows",
        "duplicate_names",
        "duplicate_versions",
        "known_artifacts",
        "submitted_anchors",
        "prod_divergence"
      ][]; . as $required | $check_names | index($required) != null)
    ) and
    (.artifact_rows | type == "array") and
    (all(.artifact_rows[];
      (type == "object") and
      ((keys | sort) == (["name", "version"] | sort)) and
      (.name | type == "string") and
      (.version | type == "string")
    )) and
    (.missing_from_staging | type == "array" and all(.[]; type == "string")) and
    (.extra_vs_prod | type == "array" and all(.[]; type == "string"))
    | select(.)
    | {
        environment_type: "clean_mirror",
        staging_project_ref: $project_ref,
        timestamp: $report.timestamp,
        checks: ($report.checks | map({name, passed})),
        artifact_rows: $report.artifact_rows,
        missing_from_staging: $report.missing_from_staging,
        extra_vs_prod: $report.extra_vs_prod
      }
  ' <<<"$PREFLIGHT_JSON" 2>/dev/null)"; then
    echo "ERROR: staging preflight failed strict environment_type=clean_mirror schema/project/timestamp validation." >&2
    exit 1
  fi
  PREFLIGHT_RESULT="environment_type=clean_mirror"
  PREFLIGHT_VERIFIED_AT="$(jq -r '.timestamp' <<<"$PREFLIGHT_ARTIFACT_JSON")"
  mkdir -p "$STAGING_ADMISSION_DIR"
  printf '%s\n' "$PREFLIGHT_ARTIFACT_JSON" | jq . >"$PREFLIGHT_ARTIFACT_PATH"

  # Re-observe every declared trigger after both seed and clean_mirror. The
  # initial pause check cannot prove this interval; an enabled, missing, or
  # partially-created job fails before any cadence update or resume.
  if [[ $SCHEDULER_APPLICABLE_JSON == true ]]; then
    SCHEDULER_STATE="post_clean_mirror_pause_verification_pending"
    for job in "${SCHEDULER_JOBS[@]}"; do
      scheduler_job_name="${CLOUD_RUN_SERVICE}-${job}"
      verify_scheduler_job_state "$scheduler_job_name" "PAUSED"
    done
    SCHEDULER_PAUSED_THROUGH_CLEAN_MIRROR_JSON=true
    SCHEDULER_STATE="clean_mirror_admitted_scheduler_paused"
  fi
  write_provision_state "clean_mirror_admitted_scheduler_paused" ""
else
  run_cmd npx tsx scripts/ci/staging-honesty-preflight.ts \
    --project-ref "$NEW_PROJECT_REF" \
    --format json
fi
echo

# Restore the pre-existing job cadence and resume only after clean_mirror was
# admitted, its allowlisted evidence artifact was written, and every declared
# trigger was re-observed PAUSED. Any failure exits before cadence update/resume.
if [[ $IS_MOCK_PROFILE -ne 1 ]]; then
  echo "# Post-admission — restore Scheduler cadence, resume, verify ENABLED"
  for job in "${SCHEDULER_JOBS[@]}"; do
    scheduler_job_name="${CLOUD_RUN_SERVICE}-${job}"
    run_cmd gcloud scheduler jobs update http "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" \
      --schedule="$SCHEDULER_CONFIGURED_SCHEDULE"
    run_cmd gcloud scheduler jobs resume "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION"
    if [[ $APPLY -eq 1 ]]; then
      verify_scheduler_job_state "$scheduler_job_name" "ENABLED"
    else
      print_cmd gcloud scheduler jobs describe "$scheduler_job_name" \
        --project="$GCP_PROJECT" \
        --location="$CLOUD_RUN_REGION" \
        --format="value(state)"
    fi
  done
  if [[ $APPLY -eq 1 ]]; then
    SCHEDULER_STATE="resumed_after_clean_mirror"
  else
    SCHEDULER_STATE="planned_resume_after_clean_mirror"
  fi
fi

echo "# Provision plan complete."
if [[ $APPLY -eq 1 ]]; then
  echo "# Admission JSON below is the rig inventory seed (see the 'Isolated Soak-Rig Automation Runbook'"
  echo "# Google Doc in Drive ARKOVA PI-1-S0:"
  echo "#   https://docs.google.com/document/d/1c0F_9NSy9ldfeR28xlY7s7zFFwKpS8cmTzvhI9dI__E/edit )."
else
  echo "# (dry-run — nothing was created)"
fi

HEAD_SHA="$(resolve_head_sha)"
BASE_SHA_VALUE="$(resolve_base_sha)"
IMAGE_DIGEST="$(resolve_image_digest)"
TAG_URL="$(resolve_cloud_run_url)"
if [[ $APPLY -eq 1 ]]; then
  ADMISSION_SUPABASE_PROJECT_REF="$NEW_PROJECT_REF"
else
  ADMISSION_SUPABASE_PROJECT_REF="${ADMISSION_SUPABASE_PROJECT_REF:-$NEW_PROJECT_REF}"
fi
OWNER="$(resolve_owner)"
DRIVER_SHA256="$(resolve_driver_sha256)"
if [[ -z "$CHANGED_BEHAVIOR" ]]; then
  CHANGED_BEHAVIOR="PR #1408 chain resilience: bounded retry/backoff, RPC/GetBlock/Mempool duplicate and retry classification, and confirmation-proof transient-to-pending vs definitive-to-stale behavior"
fi

ADMISSION_JSON="$(emit_admission_json \
  "$ADMISSION_SCHEMA_VERSION" \
  "$NAME" \
  "$CLOUD_RUN_SERVICE" \
  "$PINNED_IMAGE" \
  "$HEAD_SHA" \
  "$BASE_SHA_VALUE" \
  "$IMAGE_DIGEST" \
  "$TAG_URL" \
  "$ADMISSION_SUPABASE_PROJECT_REF" \
  "$PREFLIGHT_RESULT" \
  "$DRIVER_PATH" \
  "$DRIVER_SHA256" \
  "$CHANGED_BEHAVIOR" \
  "$OWNER")"
echo "ADMISSION_JSON=$ADMISSION_JSON"
if [[ $APPLY -eq 1 ]]; then
  printf '%s\n' "$ADMISSION_JSON" | jq . >"${STAGING_ADMISSION_DIR%/}/isolated-rig-admission-${NAME}.json"
  write_provision_state "clean_mirror_admitted" ""
fi
