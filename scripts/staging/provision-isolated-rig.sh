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
CLOUD_RUN_REGION="${STAGING_CLOUD_RUN_REGION:-us-central1}"
SUPABASE_REGION="${STAGING_SUPABASE_REGION:-us-east-2}"
SUPABASE_PG_MAJOR="${STAGING_SUPABASE_PG_MAJOR:-17}"
SUPABASE_ORG="${STAGING_SUPABASE_ORG:-byhkazrpmivhcsuqjtva}"
PINNED_IMAGE="${STAGING_PINNED_IMAGE:-us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:30e56792d1b1cdb8b2d658782d1e7d88994eaaa5}"
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
GEMINI_TUNED_MODEL_VALUE="${STAGING_GEMINI_TUNED_MODEL:-nessie-golden-v6}"
GEMINI_V6_PROMPT_VALUE="${STAGING_GEMINI_V6_PROMPT:-v6}"
FRONTEND_URL_VALUE="${STAGING_FRONTEND_URL:-https://app.arkova.ai}"
CRON_OIDC_SA="${STAGING_CRON_OIDC_SA:-$RUNTIME_SA}"

NAME=""
APPLY=0
ADMISSION_SCHEMA_VERSION=1

usage() {
  sed -n '2,38p' "$0"
  echo
  echo "Usage: $0 --name <rig-name> [--profile mock|chain|gemini] [--apply]"
  echo "          [--region us-east-2] [--gcp-region us-central1]"
  echo "          [--image <ref>] [--org <supabase-org>] [--gcp-project arkova1]"
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
    --image) PINNED_IMAGE="${2:?}"; shift 2 ;;
    --org) SUPABASE_ORG="${2:?}"; shift 2 ;;
    --gcp-project) GCP_PROJECT="${2:?}"; shift 2 ;;
    --pg-major) SUPABASE_PG_MAJOR="${2:?}"; shift 2 ;;
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

case "$PROFILE" in
  mock)
    # Safe default: no real chain, no real model.
    ENV_VARS+=("USE_MOCKS=true" "ENABLE_PROD_NETWORK_ANCHORING=false")
    ;;
  chain)
    # Real anchoring. USE_MOCKS off + prod-network on + KMS_PROVIDER + signer +
    # GetBlock RPC. config.ts superRefine requires KMS_PROVIDER + a signer when
    # mainnet anchoring is on, or the worker fails closed at boot (by design).
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

# Cloud Scheduler is required for non-mock profiles: node-cron does NOT fire on a
# throttled (min-instances=0) Cloud Run service, so the behavioral cron paths
# (batch-anchors, check-confirmations, classify-proof-backcatalog, …) never run
# without an external Scheduler POST. mock rigs have no behavioral cron to drive.
SCHEDULER_JOBS=()
if [[ $IS_MOCK_PROFILE -ne 1 ]]; then
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

resolve_head_sha() {
  if [[ -n "${GITHUB_SHA:-}" ]]; then
    printf '%s\n' "$GITHUB_SHA"
  else
    git rev-parse HEAD 2>/dev/null || printf 'unknown\n'
  fi
}

resolve_base_sha() {
  if [[ -n "${BASE_SHA:-}" ]]; then
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
  if [[ -n "${STAGING_IMAGE_DIGEST:-}" ]]; then
    printf '%s\n' "$STAGING_IMAGE_DIGEST"
    return 0
  fi

  if image_digest_from_ref "$PINNED_IMAGE"; then
    return 0
  fi

  if [[ $APPLY -eq 1 ]]; then
    local resolved digest
    resolved="$(gcloud artifacts docker images describe "$PINNED_IMAGE" \
      --project="$GCP_PROJECT" \
      --format="value(image_summary.fully_qualified_digest)")"
    digest="${resolved##*@}"
    if [[ -z "$digest" || "$digest" == "$resolved" || "$digest" != sha256:* ]]; then
      echo "ERROR: could not resolve image digest for $PINNED_IMAGE." >&2
      exit 1
    fi
    printf '%s\n' "$digest"
    return 0
  fi

  printf '<resolve-in-apply:%s>\n' "$PINNED_IMAGE"
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
  local owner="${11}"
  local generated_at
  generated_at="${ADMISSION_GENERATED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

  jq -nc \
    --argjson schema_version "$schema_version" \
    --arg kind "isolated_rig_admission" \
    --arg generated_at "$generated_at" \
    --arg rig_name "$rig_name" \
    --arg cloud_run_service "$cloud_run_service" \
    --arg sha "$head_sha" \
    --arg base_sha "$base_sha" \
    --arg image "$image" \
    --arg image_digest "$image_digest" \
    --arg tag_url "$tag_url" \
    --arg supabase_project_ref "$supabase_project_ref" \
    --arg preflight_result "$preflight_result" \
    --arg harness_version "scripts/staging/load-harness.ts@$(short_sha "$head_sha")" \
    --arg tool_version "scripts/staging/provision-isolated-rig.sh@$(short_sha "$head_sha")" \
    --arg owner "$owner" \
    '{
      schema_version: $schema_version,
      kind: $kind,
      generated_at: $generated_at,
      rig_name: $rig_name,
      cloud_run_service: $cloud_run_service,
      sha: $sha,
      base_sha: $base_sha,
      image: $image,
      image_digest: $image_digest,
      tag_url: $tag_url,
      supabase_project_ref: $supabase_project_ref,
      preflight_result: $preflight_result,
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
echo "Runtime SA:        $RUNTIME_SA"
echo "mode:              $MODE_LABEL"
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
print_cmd "${CREATE_CMD[@]}"
if [[ $APPLY -eq 1 ]]; then
  echo "executing: ${CREATE_CMD[*]} --output json" >&2
  # Capture the new ref so links/pushes/preflight target the validated project,
  # never whatever happens to be linked on disk (review #1). Fail loudly if the
  # ref can't be captured — better to abort than orphan + push blind (review #2).
  NEW_PROJECT_REF="$("${CREATE_CMD[@]}" --output json 2>/dev/null | jq -r '.id // .ref // empty')"
  if [[ -z "$NEW_PROJECT_REF" ]]; then
    echo "ERROR: could not capture the new project ref from 'supabase projects create'." >&2
    echo "       Capture it manually, verify it is NOT prod/shared, then run the remaining steps." >&2
    exit 1
  fi
  # Re-validate the freshly created ref against the deny list BEFORE any schema push.
  if [[ "$NEW_PROJECT_REF" == "$PROD_SUPABASE_REF" || "$NEW_PROJECT_REF" == "$SHARED_STAGING_SUPABASE_REF" ]]; then
    deny "created/resolved ref '$NEW_PROJECT_REF' is prod/shared — aborting before any schema push."
  fi
  echo "captured NEW_PROJECT_REF=$NEW_PROJECT_REF" >&2
else
  echo "#   -> (apply mode captures the returned ref into NEW_PROJECT_REF and re-validates it"
  echo "#       against $PROD_SUPABASE_REF / $SHARED_STAGING_SUPABASE_REF before any push)."
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
  --service-account="$RUNTIME_SA" \
  --no-allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=1Gi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="$WORKER_ENV_VARS" \
  --set-secrets="$WORKER_SECRETS"
echo "#   NOTE: create the supabase-url-${NAME}-staging + supabase-service-role-key-${NAME}-staging"
echo "#         secrets from the NEW project's keys (MCP get_publishable_keys) FIRST."
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
    run_cmd_cron_redacted gcloud scheduler jobs create http "${CLOUD_RUN_SERVICE}-${job}" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" \
      --schedule="*/5 * * * *" \
      --uri="${WORKER_URL}/jobs/${job}" \
      --http-method=POST \
      --headers="X-Cron-Secret=${CRON_SECRET_VALUE}" \
      --oidc-service-account-email="$CRON_OIDC_SA" \
      --oidc-token-audience="$WORKER_URL"
  done
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
  printf '%s\n' "$PREFLIGHT_JSON"
  PREFLIGHT_ENVIRONMENT="$(jq -r '.environment_type // empty' <<<"$PREFLIGHT_JSON")"
  if [[ -z "$PREFLIGHT_ENVIRONMENT" ]]; then
    echo "ERROR: staging preflight JSON did not include environment_type; refusing to emit admission JSON." >&2
    exit 1
  fi
  PREFLIGHT_RESULT="environment_type=${PREFLIGHT_ENVIRONMENT}"
else
  run_cmd npx tsx scripts/ci/staging-honesty-preflight.ts \
    --project-ref "$NEW_PROJECT_REF" \
    --format json
fi
echo
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
ADMISSION_SUPABASE_PROJECT_REF="${ADMISSION_SUPABASE_PROJECT_REF:-$NEW_PROJECT_REF}"
OWNER="$(resolve_owner)"

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
  "$OWNER")"
echo "ADMISSION_JSON=$ADMISSION_JSON"
