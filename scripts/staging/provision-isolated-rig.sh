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
#                 real RPC + WIF signer + KMS_PROVIDER (from Secret Manager)
#                 — for anchoring / chain-resilience / batch-anchor behavioral soaks.
#        * gemini (REAL model): GEMINI_TUNED_MODEL + GEMINI_V6_PROMPT + GEMINI_API_KEY
#                 — for classifier / proof-backcatalog census soaks. Chain stays mocked.
#        * gemini-release (RIG-R only): exact temporary release endpoint with the
#                 protected v6 model; chain mocked; zero Scheduler/OIDC/in-process jobs.
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
#   * A real run of a NON-MOCK profile (chain/gemini/gemini-release) additionally requires
#       CONFIRM_REAL_CONFIG=<profile>      (must match --profile exactly)
#     so a rig with real credentials / real Bitcoin exposure is never provisioned
#     by a bare CONFIRM_PROVISION alone. Dry-run (the default) needs neither.
#   * RIG-R apply additionally requires an immutable Ed25519 provision approval
#     verified by the code-bound founder/CTO authority before cloud observation.
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
RIG_B1_SUPABASE_ORG="byhkazrpmivhcsuqjtva"
RIG_B1_BITCOIN_CORE_VERSION="31.1"
RIG_B1_BITCOIN_CORE_SOURCE_URL="https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz"
RIG_B1_BITCOIN_CORE_SOURCE_SHA256="b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"
RIG_B1_MEMPOOL_SIGNET_API_URL="https://mempool.space/signet/api"
RIG_B1_NODE_ZONE="us-central1-a"
RIG_B1_NODE_VM="arkova-s33-rig-b1-bitcoin-core-signet"
RIG_B1_NODE_BOOT_DISK="arkova-s33-rig-b1-bitcoin-core-signet-boot"
RIG_B1_NODE_DATA_DISK="arkova-s33-rig-b1-bitcoin-core-signet-data"
RIG_B1_NODE_INTERNAL_ADDRESS="arkova-s33-rig-b1-bitcoin-core-signet-rpc-ip"
RIG_B1_NODE_EXTERNAL_ADDRESS="arkova-s33-rig-b1-bitcoin-core-signet-p2p-ip"
RIG_B1_NODE_NETWORK="arkova-s33-rig-b1-bitcoin-core-signet-vpc"
RIG_B1_NODE_SUBNET="arkova-s33-rig-b1-bitcoin-core-signet-subnet"
RIG_B1_NODE_RPC_FIREWALL="arkova-s33-rig-b1-bitcoin-core-signet-rpc"
RIG_B1_NODE_VPC_CONNECTOR="arkova-s33-rig-b1-bitcoin-core-signet-connector"
RIG_B1_NODE_SERVICE_ACCOUNT="s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com"
RIG_B1_ARTIFACT_REPOSITORY="arkova-worker-images"
RIG_B1_EXPECTED_BITCOIN_CORE_IMAGE="us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8"
RIG_B1_BITCOIN_CORE_RECIPE_COMMIT="b9a54856c9bee87d958cc4b070776828b5c17b32"
RIG_B1_BITCOIN_CORE_AMD64_RUNTIME_DIGEST="sha256:684e80900f124890c45ad9b691d7f76456c1042385bce4ab92725b1979b55888"
RIG_B1_TREASURY_SPLIT_TXID="1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941"
RIG_B1_TREASURY_TOTAL_SATS="169639"
RIG_B1_NODE_RPC_ENDPOINT="http://10.33.10.10:38332"
RIG_B1_NODE_RPC_BIND="10.33.10.10"
RIG_B1_NODE_SUBNET_CIDR="10.33.10.0/28"
RIG_B1_NODE_CONNECTOR_CIDR="10.33.11.0/28"
RIG_B1_NODE_STARTUP_SCRIPT="scripts/staging/start-rig-b1-bitcoin-core.sh"
RIG_B1_NODE_APPROVAL_VERIFIER="scripts/staging/s33-b1-node-approval.mjs"
RIG_B1_APPROVAL_LEDGER_PREFIX="s33/rig-b1/node-approval-claims"
RIG_G1_SUPABASE_ORG="byhkazrpmivhcsuqjtva"
RIG_G1_PUBLIC_MODEL="gemini-2.5-flash"
RIG_G1_CANDIDATE_MODEL_RESOURCE="projects/270018525501/locations/us-central1/models/6611494259700793344"
RIG_G1_CANDIDATE_MODEL_VERSION_RESOURCE="${RIG_G1_CANDIDATE_MODEL_RESOURCE}@1"
RIG_G1_CHECKPOINT_ID="6"
RIG_G1_ENDPOINT_ID="733001"
RIG_G1_DEPLOYED_MODEL_ID="7330011"
RIG_G1_ENDPOINT_DISPLAY_NAME="arkova-s33-rig-g1-b-tuned-v6"
RIG_G1_DEPLOYED_MODEL_DISPLAY_NAME="arkova-s33-rig-g1-b-tuned-v6"
RIG_G1_DEPLOYMENT_RESOURCES_MODE="TUNED_GEMINI_AUTOMATIC_RESOURCES"
RIG_G1_MIN_REPLICA_COUNT="1"
RIG_G1_MAX_REPLICA_COUNT="1"
RIG_G1_SPEND_APPROVAL_VERIFIER="scripts/staging/s33-g1-spend-approval.mjs"
# The built-ins-only verifier is launched only through this exact audited Node
# binary tuple; PATH substitution cannot forge its stdout.
RIG_G1_TRUSTED_NODE_PATH="/opt/homebrew/Cellar/node/25.6.1/bin/node"
RIG_G1_TRUSTED_NODE_SHA256="8b6a6d43e16ddc3cddaf1217fb75dbe7151e342e36317491bf3ef4a1ec5d4202"
RIG_G1_TRUSTED_NODE_VERSION="v25.6.1"
IMMUTABLE_AUTHORITY_LEDGER_BUCKET="arkova1-s33-immutable-authority-ledger"
IMMUTABLE_AUTHORITY_LEDGER_BACKEND="gcs-if-generation-match-0-locked-retention"
IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER="270018525501"
RIG_G1_APPROVAL_LEDGER_BUCKET="$IMMUTABLE_AUTHORITY_LEDGER_BUCKET"
RIG_G1_APPROVAL_LEDGER_PREFIX="s33/g1/approval-claims"
RIG_B1_TOPOLOGY_LEDGER_PREFIX="s33/rig-b1/topology-ownership"
RIG_R_PROVISION_APPROVAL_VERIFIER="scripts/staging/s33-rig-r-provision-approval.mjs"
RIG_R_TRUSTED_NODE_PATH="/opt/homebrew/Cellar/node/25.6.1/bin/node"
RIG_R_TRUSTED_NODE_SHA256="8b6a6d43e16ddc3cddaf1217fb75dbe7151e342e36317491bf3ef4a1ec5d4202"
RIG_R_TRUSTED_NODE_VERSION="v25.6.1"
RIG_R_APPROVAL_LEDGER_BUCKET="$IMMUTABLE_AUTHORITY_LEDGER_BUCKET"
RIG_R_APPROVAL_LEDGER_PREFIX="s33/rig-r/provision-approval-claims"
RIG_R_LEASE_BUCKET="$IMMUTABLE_AUTHORITY_LEDGER_BUCKET"
RIG_R_LEASE_PREFIX="s33/rig-leases"
RIG_R_LEASE_OBJECT_NAME="${RIG_R_LEASE_PREFIX}/RIG-R.singleton.json"
RIG_R_SUPABASE_ORG="byhkazrpmivhcsuqjtva"
RIG_R_NAME="s33-r"
RIG_R_PROJECT_NAME="arkova-soak-s33-r"
RIG_R_SERVICE="arkova-worker-s33-r-staging"
RIG_R_RUNTIME_SA="s33-rig-r-runtime@arkova1.iam.gserviceaccount.com"
RIG_R_OPERATOR_SA="270018525501-compute@developer.gserviceaccount.com"
RIG_R_RUNTIME_IMPERSONATION_ROLE="roles/iam.serviceAccountTokenCreator"
RIG_R_RUNTIME_IMPERSONATION_MEMBER="serviceAccount:${RIG_R_OPERATOR_SA}"
RIG_R_PROTECTED_V6_MODEL="projects/270018525501/locations/us-central1/models/6611494259700793344"
RIG_R_PROTECTED_V6_MODEL_VERSION="${RIG_R_PROTECTED_V6_MODEL}@1"
RIG_R_CHECKPOINT_ID="6"
RIG_R_ENDPOINT_ID="733017"
RIG_R_EXPECTED_ENDPOINT="projects/arkova1/locations/us-central1/endpoints/${RIG_R_ENDPOINT_ID}"
RIG_R_EXPECTED_DEPLOYED_MODEL_ID="7330171"
RIG_R_ENDPOINT_DISPLAY_NAME="arkova-s33-rig-r-release-v6"
RIG_R_DEPLOYED_MODEL_DISPLAY_NAME="arkova-s33-rig-r-release-v6"
RIG_R_DEPLOYMENT_RESOURCES_MODE="TUNED_GEMINI_AUTOMATIC_RESOURCES"
RIG_R_MIN_REPLICA_COUNT="1"
RIG_R_MAX_REPLICA_COUNT="1"
RIG_R_TEARDOWN_PATH="scripts/staging/teardown-isolated-rig.sh"
RIG_R_RUNTIME_ROLES=(
  "roles/logging.logWriter"
)
RIG_R_SCHEMA_QUIET_SECONDS="20"
# Live admission is intentionally bound to the audited Git shipped on the
# release operator host. An OS/toolchain update changes this tuple and fails
# closed until the reviewed authority input is refreshed in code.
TRUSTED_GIT_PATH="/usr/bin/git"
TRUSTED_GIT_SHA256="a961f78075d8e7621ef4f5d764c64ef8a41bf66c0a98ab5cb6ca39b85ce31c93"
TRUSTED_GIT_VERSION="git version 2.50.1 (Apple Git-155)"
TRUSTED_GIT_ORIGIN_URL="https://github.com/carson-see/ArkovaCarson.git"
S33_ISOLATED_SUPABASE_PROJECT_COUNT=4
S33_ISOLATED_SUPABASE_PROJECT_MONTHLY_EACH_USD=10
S33_ISOLATED_SUPABASE_PROJECTS_MONTHLY_TOTAL_USD=40
APPROVED_SOURCE_IMAGE_REPOSITORY="us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker"
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
G1_CONTROL_DB_PASSWORD="${STAGING_G1_A_SUPABASE_DB_PASSWORD:-}"
G1_TUNED_DB_PASSWORD="${STAGING_G1_B_SUPABASE_DB_PASSWORD:-}"
SUPABASE_PROJECT_READY_TIMEOUT_SECONDS="${STAGING_SUPABASE_PROJECT_READY_TIMEOUT_SECONDS:-900}"
SUPABASE_PROJECT_READY_POLL_SECONDS="${STAGING_SUPABASE_PROJECT_READY_POLL_SECONDS:-10}"
IMAGE_WAS_EXPLICIT=0
if [[ -n "${STAGING_PINNED_IMAGE:-}" ]]; then
  PINNED_IMAGE="$STAGING_PINNED_IMAGE"
  IMAGE_WAS_EXPLICIT=1
else
  PINNED_IMAGE="<required-in-apply:--image-or-STAGING_PINNED_IMAGE@sha256>"
fi
RUNTIME_SA_WAS_EXPLICIT=0
if [[ ${STAGING_RUNTIME_SA_EMAIL+x} ]]; then
  RUNTIME_SA="$STAGING_RUNTIME_SA_EMAIL"
  RUNTIME_SA_WAS_EXPLICIT=1
else
  RUNTIME_SA="270018525501-compute@developer.gserviceaccount.com"
fi

# Profile selects the env/secret overlay for the worker deploy.
#   mock   — safe default; USE_MOCKS=true, anchoring off, no Scheduler.
#   chain  — real anchoring (RPC + WIF signer + KMS), Scheduler-driven.
#   gemini — real tuned model + prompt; chain stays mocked, Scheduler-driven.
#   gemini-release — exact RIG-R release model; no Scheduler/OIDC/background jobs.
PROFILE="${STAGING_RIG_PROFILE:-mock}"

# Secret Manager secret NAMES (not values — values never touch this script).
# Overridable so the chain/gemini profiles can point at the operator-provisioned
# real-config secrets. Defaults are the shared staging real-config secrets; the
# operator confirms these hold the intended (test-tier) credentials before an
# --apply. NOTHING here is a credential literal — only Secret Manager references.
BITCOIN_CORE_RPC_URL_SECRET_WAS_EXPLICIT=0
BITCOIN_CORE_RPC_AUTH_SECRET_WAS_EXPLICIT=0
TREASURY_WIF_SECRET_WAS_EXPLICIT=0
STRIPE_SECRET_KEY_SECRET_WAS_EXPLICIT=0
STRIPE_WEBHOOK_SECRET_SECRET_WAS_EXPLICIT=0
API_KEY_HMAC_SECRET_SECRET_WAS_EXPLICIT=0
CRON_SECRET_SECRET_WAS_EXPLICIT=0
if [[ ${STAGING_BITCOIN_CORE_SIGNET_RPC_URL_SECRET+x} ]]; then
  BITCOIN_CORE_RPC_URL_SECRET="$STAGING_BITCOIN_CORE_SIGNET_RPC_URL_SECRET"
  BITCOIN_CORE_RPC_URL_SECRET_WAS_EXPLICIT=1
else
  BITCOIN_CORE_RPC_URL_SECRET="bitcoin-rpc-url-staging"
fi
if [[ ${STAGING_BITCOIN_CORE_SIGNET_RPC_AUTH_SECRET+x} ]]; then
  BITCOIN_CORE_RPC_AUTH_SECRET="$STAGING_BITCOIN_CORE_SIGNET_RPC_AUTH_SECRET"
  BITCOIN_CORE_RPC_AUTH_SECRET_WAS_EXPLICIT=1
else
  BITCOIN_CORE_RPC_AUTH_SECRET="bitcoin-rpc-auth-staging"
fi
if [[ ${STAGING_TREASURY_WIF_SECRET+x} ]]; then
  TREASURY_WIF_SECRET="$STAGING_TREASURY_WIF_SECRET"
  TREASURY_WIF_SECRET_WAS_EXPLICIT=1
else
  TREASURY_WIF_SECRET="bitcoin-treasury-wif-staging"
fi
if [[ ${STAGING_STRIPE_SECRET_KEY_SECRET+x} ]]; then
  STRIPE_SECRET_KEY_SECRET="$STAGING_STRIPE_SECRET_KEY_SECRET"
  STRIPE_SECRET_KEY_SECRET_WAS_EXPLICIT=1
else
  STRIPE_SECRET_KEY_SECRET="stripe-secret-key-staging"
fi
if [[ ${STAGING_STRIPE_WEBHOOK_SECRET_SECRET+x} ]]; then
  STRIPE_WEBHOOK_SECRET_SECRET="$STAGING_STRIPE_WEBHOOK_SECRET_SECRET"
  STRIPE_WEBHOOK_SECRET_SECRET_WAS_EXPLICIT=1
else
  STRIPE_WEBHOOK_SECRET_SECRET="stripe-webhook-secret-staging"
fi
if [[ ${STAGING_API_KEY_HMAC_SECRET_SECRET+x} ]]; then
  API_KEY_HMAC_SECRET_SECRET="$STAGING_API_KEY_HMAC_SECRET_SECRET"
  API_KEY_HMAC_SECRET_SECRET_WAS_EXPLICIT=1
else
  API_KEY_HMAC_SECRET_SECRET="api-key-hmac-secret-staging"
fi
if [[ ${STAGING_CRON_SECRET_SECRET+x} ]]; then
  CRON_SECRET_SECRET="$STAGING_CRON_SECRET_SECRET"
  CRON_SECRET_SECRET_WAS_EXPLICIT=1
else
  CRON_SECRET_SECRET="cron-secret"
fi
GEMINI_API_KEY_SECRET="${STAGING_GEMINI_API_KEY_SECRET:-gemini-api-key}"
GEMINI_API_KEY_SECRET_VERSION="${STAGING_GEMINI_API_KEY_SECRET_VERSION:-2}"
SHARED_STRIPE_SECRET_VERSION="${STAGING_STRIPE_SECRET_KEY_VERSION:-1}"
SHARED_STRIPE_WEBHOOK_VERSION="${STAGING_STRIPE_WEBHOOK_SECRET_VERSION:-1}"
SHARED_API_KEY_HMAC_VERSION="${STAGING_API_KEY_HMAC_SECRET_VERSION:-1}"
SHARED_CRON_SECRET_VERSION="${STAGING_CRON_SECRET_VERSION:-1}"

# Non-secret env values for the real profiles (safe to inline — model names,
# flags, a public frontend URL). These are NOT credentials.
KMS_PROVIDER_VALUE="${STAGING_KMS_PROVIDER:-gcp}"
BITCOIN_NETWORK_VALUE="${STAGING_BITCOIN_NETWORK:-mainnet}"
BITCOIN_UTXO_PROVIDER_VALUE="${STAGING_BITCOIN_UTXO_PROVIDER:-getblock}"
RIG_B1_BITCOIN_CORE_IMAGE="${STAGING_B1_BITCOIN_CORE_IMAGE:-$RIG_B1_EXPECTED_BITCOIN_CORE_IMAGE}"
RIG_B1_NODE_APPROVAL_ARTIFACT="${STAGING_B1_NODE_APPROVAL_ARTIFACT:-}"
RIG_B1_CORPUS_DIGEST="${STAGING_B1_CORPUS_DIGEST:-}"
RIG_B1_RELEASE_CANDIDATE_ID="${STAGING_B1_RELEASE_CANDIDATE_ID:-}"
RIG_B1_TREASURY_ADDRESS="${STAGING_B1_TREASURY_ADDRESS:-}"
RIG_B1_TREASURY_DESCRIPTOR="${STAGING_B1_TREASURY_DESCRIPTOR:-}"
RIG_B1_TREASURY_SPLIT_PLAN_DIGEST="${STAGING_B1_TREASURY_SPLIT_PLAN_DIGEST:-}"
RIG_B1_TREASURY_EXPECTED_TOTAL_SATS="${STAGING_B1_TREASURY_EXPECTED_TOTAL_SATS:-}"
RIG_B1_APPROVAL_ENVELOPE_SHA256="<from-verified-b1-approval>"
RIG_B1_APPROVAL_PAYLOAD_SHA256="<from-verified-b1-approval>"
RIG_B1_APPROVAL_ID="<from-verified-b1-approval>"
RIG_B1_APPROVAL_EXPIRES_AT="<from-verified-b1-approval>"
RIG_B1_SPEND_CAP_USD="0"
RIG_B1_NODE_APPROVAL_JSON='{"status":"UNVERIFIED"}'
RIG_B1_APPROVAL_CLAIM_JSON='null'
RIG_B1_APPROVAL_CLAIMED=0
RIG_B1_TOPOLOGY_OWNERSHIP_JSON='null'
RIG_B1_TOPOLOGY_OWNERSHIP_URI=""
RIG_B1_TOPOLOGY_OWNERSHIP_GENERATION=""
RIG_B1_NODE_READINESS_JSON='null'
RIG_B1_TRUSTED_NODE_LAUNCHER=""
RIG_B1_CANDIDATE_TREE_SHA=""
DECLARED_RIG_B1_TEARDOWN_SHA256=""
RIG_B1_RPC_URL_SECRET_VERSION="${STAGING_B1_RPC_URL_SECRET_VERSION:-}"
RIG_B1_RPC_AUTH_SECRET_VERSION="${STAGING_B1_RPC_AUTH_SECRET_VERSION:-}"
RIG_B1_TREASURY_WIF_SECRET_VERSION="${STAGING_B1_TREASURY_WIF_SECRET_VERSION:-}"
RIG_B1_STRIPE_SECRET_KEY_VERSION="${STAGING_B1_STRIPE_SECRET_KEY_VERSION:-}"
RIG_B1_STRIPE_WEBHOOK_SECRET_VERSION="${STAGING_B1_STRIPE_WEBHOOK_SECRET_VERSION:-}"
RIG_B1_API_KEY_HMAC_SECRET_VERSION="${STAGING_B1_API_KEY_HMAC_SECRET_VERSION:-}"
RIG_B1_CRON_SECRET_VERSION="${STAGING_B1_CRON_SECRET_VERSION:-}"
GEMINI_TUNED_MODEL_VALUE="${STAGING_GEMINI_TUNED_MODEL:-projects/arkova1/locations/us-central1/endpoints/${RIG_G1_ENDPOINT_ID}}"
GEMINI_V6_PROMPT_VALUE="${STAGING_GEMINI_V6_PROMPT:-true}"
FRONTEND_URL_VALUE="${STAGING_FRONTEND_URL:-https://app.arkova.ai}"
CRON_OIDC_SA_WAS_EXPLICIT=0
if [[ ${STAGING_CRON_OIDC_SA+x} ]]; then
  CRON_OIDC_SA="$STAGING_CRON_OIDC_SA"
  CRON_OIDC_SA_WAS_EXPLICIT=1
else
  CRON_OIDC_SA="$RUNTIME_SA"
fi
SCHEDULER_ACTIVATION_MODE="${STAGING_SCHEDULER_ACTIVATION_MODE:-PAUSED}"

# RIG-G1 is the paired Gemini experiment approved in the S3.3 plan. These are
# control-plane identities only: the external A/B harness owns the distinct run
# and queue routing, while both workers remain PAUSED with background execution
# disabled until a separately authorized post-Wave-3 start.
G1_CORPUS_DIGEST="${STAGING_G1_CORPUS_DIGEST:-}"
G1_CONTROL_RUN_ID="${STAGING_G1_CONTROL_RUN_ID:-}"
G1_TUNED_RUN_ID="${STAGING_G1_TUNED_RUN_ID:-}"
G1_CONTROL_QUEUE="${STAGING_G1_CONTROL_QUEUE:-}"
G1_TUNED_QUEUE="${STAGING_G1_TUNED_QUEUE:-}"
G1_PAIRED_CADENCE_MIN="${STAGING_G1_PAIRED_CADENCE_MIN:-}"
G1_STOP_AUTHORITY="<from-verified-approval-approver>"
G1_TEARDOWN_OWNER="<from-verified-approval-owner>"
G1_SPEND_APPROVAL_ARTIFACT="${STAGING_G1_SPEND_APPROVAL_ARTIFACT:-}"
# These admission values are populated only from the authenticated approval
# verifier in apply mode. Caller-supplied owner/TTL/cap/authority strings are
# deliberately ignored and cannot authorize spend.
G1_OWNER="<from-verified-approval-record>"
G1_EXPIRES_AT="<from-verified-approval-record>"
S33_COST_CAP_USD_JSON="null"
G1_COMPUTE_MODEL_CAP_USD_JSON="null"
G1_SPEND_APPROVAL_JSON='{"status":"UNVERIFIED","reason":"immutable approval artifact not verified"}'
G1_APPROVAL_CLAIM_JSON='null'
G1_AUTHORITY_JSON='null'
G1_TRUSTED_NODE_LAUNCHER=""
RIG_R_VERTEX_ENDPOINT="${STAGING_RIG_R_VERTEX_ENDPOINT:-$RIG_R_EXPECTED_ENDPOINT}"
RIG_R_VERTEX_MODEL="${STAGING_RIG_R_VERTEX_MODEL:-$RIG_R_PROTECTED_V6_MODEL}"
RIG_R_DEPLOYED_MODEL_ID="${STAGING_RIG_R_DEPLOYED_MODEL_ID:-$RIG_R_EXPECTED_DEPLOYED_MODEL_ID}"
RIG_R_CANDIDATE_TREE_SHA="${STAGING_RIG_R_CANDIDATE_TREE_SHA:-}"
RIG_R_PROVISION_APPROVAL_ARTIFACT="${STAGING_RIG_R_PROVISION_APPROVAL_ARTIFACT:-}"
RIG_R_PROVISION_ARTIFACT_SHA256="${STAGING_RIG_R_PROVISION_ARTIFACT_SHA256:-}"
RIG_R_PROVISION_STARTED_AT="${STAGING_RIG_R_PROVISION_STARTED_AT:-}"
RIG_R_EXPIRES_AT="${STAGING_RIG_R_EXPIRES_AT:-}"
RIG_R_LEASE_URI=""
RIG_R_LEASE_CLAIMED=0
RIG_R_LEASE_GENERATION=""
RIG_R_PROVISION_APPROVAL_JSON='{"status":"UNVERIFIED"}'
RIG_R_PROVISION_APPROVAL_CLAIM_JSON='null'
RIG_R_PROVISION_APPROVAL_CLAIMED=0
RIG_R_RUNTIME_SA_UNIQUE_ID="<captured-rig-r-runtime-unique-id>"
RIG_R_TRUSTED_NODE_LAUNCHER=""
RIG_B1_NODE_STARTUP_SCRIPT_SHA256=""
TRUSTED_GIT_VALIDATED=0
TRUSTED_REPO_ROOT=""
TRUSTED_LOCAL_HEAD_SHA=""
DECLARED_DRIVER_SHA256=""
DECLARED_RIG_R_TEARDOWN_SHA256=""
IMMUTABLE_LEDGER_CAPABILITY_JSON='null'

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
RIG_ID="${STAGING_RIG_ID:-<required-in-apply:--rig-id-or-STAGING_RIG_ID>}"
LEASE_ID="${STAGING_LEASE_ID:-<required-in-apply:--lease-id-or-STAGING_LEASE_ID>}"
if [[ -n "${STAGING_DRIVER_PATH:-}" ]]; then
  DRIVER_PATH="$STAGING_DRIVER_PATH"
elif [[ "$RIG_ID" == "RIG-R" ]]; then
  DRIVER_PATH="scripts/staging/s33-rig-r-release-driver.ts"
else
  DRIVER_PATH="services/worker/scripts/pr1408-chain-resilience-driver.ts"
fi
TIER="${STAGING_TIER:-T3}"
REQUIRED_UPTIME_MIN="${STAGING_REQUIRED_UPTIME_MIN:-${STAGING_DURATION_MIN:-2880}}"
REQUIRED_WALL_MIN="${STAGING_REQUIRED_WALL_MIN:-}"
DURATION_MIN="$REQUIRED_UPTIME_MIN"
CHANGED_BEHAVIOR="${STAGING_CHANGED_BEHAVIOR:-}"
VALIDATED_BASE_SHA=""
SOURCE_HEAD_IMAGE_REF="<verified-full-sha-image-tag-in-apply>"
SOURCE_HEAD_IMAGE_DIGEST="<verified-full-sha-image-digest-in-apply>"

usage() {
  sed -n '2,38p' "$0"
  echo
  echo "Usage: $0 --name <rig-name> [--profile mock|chain|gemini|gemini-release] [--apply]"
  echo "          [--region us-east-2] [--gcp-region us-central1]"
  echo "          [--image <ref@sha256:digest>] [--source-head <40-char-sha>]"
  echo "          [--soak-id <exclusive-soak-id>] [--rig-id <rig-id>] [--lease-id <lease-id>]"
  echo "          [--required-uptime-min <minutes>] [--required-wall-min <minutes>]"
  echo "          [--org <supabase-org>] [--gcp-project arkova1]"
  echo "          [--scheduler-activation PAUSED]"
  echo "          [--runtime-sa <per-rig-service-account>] [--cron-oidc-sa <per-rig-service-account>]"
  echo "          [--artifact-dir docs/staging/<pr-or-rig>]"
  echo
  echo "  --profile mock   (default) safe: USE_MOCKS=true, anchoring off, no Scheduler."
  echo "  --profile chain  real anchoring: RPC + WIF signer + KMS, Scheduler-driven."
  echo "  --profile gemini real tuned model + prompt; chain mocked, Scheduler-driven."
  echo "  --profile gemini-release  RIG-R only; chain mocked, no Scheduler/OIDC/in-process cron."
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
    --rig-id) RIG_ID="${2:?}"; shift 2 ;;
    --lease-id) LEASE_ID="${2:?}"; shift 2 ;;
    --required-uptime-min|--duration-min) REQUIRED_UPTIME_MIN="${2:?}"; shift 2 ;;
    --required-wall-min) REQUIRED_WALL_MIN="${2:?}"; shift 2 ;;
    --org) SUPABASE_ORG="${2:?}"; shift 2 ;;
    --gcp-project) GCP_PROJECT="${2:?}"; shift 2 ;;
    --scheduler-activation) SCHEDULER_ACTIVATION_MODE="${2:?}"; shift 2 ;;
    --runtime-sa) RUNTIME_SA="${2:?}"; RUNTIME_SA_WAS_EXPLICIT=1; shift 2 ;;
    --cron-oidc-sa) CRON_OIDC_SA="${2:?}"; CRON_OIDC_SA_WAS_EXPLICIT=1; shift 2 ;;
    --bitcoin-core-signet-rpc-url-secret) BITCOIN_CORE_RPC_URL_SECRET="${2:?}"; BITCOIN_CORE_RPC_URL_SECRET_WAS_EXPLICIT=1; shift 2 ;;
    --bitcoin-core-signet-rpc-auth-secret) BITCOIN_CORE_RPC_AUTH_SECRET="${2:?}"; BITCOIN_CORE_RPC_AUTH_SECRET_WAS_EXPLICIT=1; shift 2 ;;
    --treasury-wif-secret) TREASURY_WIF_SECRET="${2:?}"; TREASURY_WIF_SECRET_WAS_EXPLICIT=1; shift 2 ;;
    --stripe-secret-key-secret) STRIPE_SECRET_KEY_SECRET="${2:?}"; STRIPE_SECRET_KEY_SECRET_WAS_EXPLICIT=1; shift 2 ;;
    --stripe-webhook-secret) STRIPE_WEBHOOK_SECRET_SECRET="${2:?}"; STRIPE_WEBHOOK_SECRET_SECRET_WAS_EXPLICIT=1; shift 2 ;;
    --api-key-hmac-secret) API_KEY_HMAC_SECRET_SECRET="${2:?}"; API_KEY_HMAC_SECRET_SECRET_WAS_EXPLICIT=1; shift 2 ;;
    --cron-secret) CRON_SECRET_SECRET="${2:?}"; CRON_SECRET_SECRET_WAS_EXPLICIT=1; shift 2 ;;
    --pg-major) SUPABASE_PG_MAJOR="${2:?}"; shift 2 ;;
    --artifact-dir) STAGING_ADMISSION_DIR="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Preserve the historical duration input as a compatibility alias while making
# worker uptime and wall-clock floor separate, explicit admission identities.
DURATION_MIN="$REQUIRED_UPTIME_MIN"
if [[ -z "$REQUIRED_WALL_MIN" ]]; then
  if [[ "$REQUIRED_UPTIME_MIN" =~ ^[1-9][0-9]*$ && ${#REQUIRED_UPTIME_MIN} -le 16 ]]; then
    REQUIRED_WALL_MIN=$((10#$REQUIRED_UPTIME_MIN + 30))
  else
    # Apply-mode validation below emits the actionable uptime error before this
    # sentinel could ever enter a paid operation or an admission artifact.
    REQUIRED_WALL_MIN="0"
  fi
fi

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
SUPABASE_URL_SECRET_NAME="supabase-url-${NAME}-staging"
SUPABASE_SERVICE_ROLE_SECRET_NAME="supabase-service-role-key-${NAME}-staging"
IS_G1_RIG=0
IS_RIG_R=0
G1_CONTROL_SERVICE=""
G1_TUNED_SERVICE=""
G1_CONTROL_PROJECT_NAME=""
G1_TUNED_PROJECT_NAME=""
G1_CONTROL_PROJECT_REF="<captured-rig-g1-a-project-ref>"
G1_TUNED_PROJECT_REF="<captured-rig-g1-b-project-ref>"
G1_CONTROL_SUPABASE_URL_SECRET=""
G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET=""
G1_TUNED_SUPABASE_URL_SECRET=""
G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET=""
G1_CONTROL_RUNTIME_SA=""
G1_TUNED_RUNTIME_SA=""
G1_ENDPOINT_ID=""

case "$RIG_ID" in
  RIG-G1)
    IS_G1_RIG=1
    G1_CONTROL_SERVICE="arkova-worker-${NAME}-a-staging"
    G1_TUNED_SERVICE="arkova-worker-${NAME}-b-staging"
    G1_CONTROL_PROJECT_NAME="arkova-soak-${NAME}-a"
    G1_TUNED_PROJECT_NAME="arkova-soak-${NAME}-b"
    G1_CONTROL_SUPABASE_URL_SECRET="supabase-url-${NAME}-a-staging"
    G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET="supabase-service-role-key-${NAME}-a-staging"
    G1_TUNED_SUPABASE_URL_SECRET="supabase-url-${NAME}-b-staging"
    G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET="supabase-service-role-key-${NAME}-b-staging"
    G1_CONTROL_RUNTIME_SA="s33-rig-g1-a-runtime@${GCP_PROJECT}.iam.gserviceaccount.com"
    G1_TUNED_RUNTIME_SA="s33-rig-g1-b-runtime@${GCP_PROJECT}.iam.gserviceaccount.com"
    PROJECT_NAME="$G1_CONTROL_PROJECT_NAME"
    SUPABASE_URL_SECRET_NAME="$G1_CONTROL_SUPABASE_URL_SECRET"
    SUPABASE_SERVICE_ROLE_SECRET_NAME="$G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET"
    # Keep the legacy top-level admission identity pointed at the public/control
    # arm; the complete two-arm binding is emitted under admission.g1.
    CLOUD_RUN_SERVICE="$G1_CONTROL_SERVICE"
    ;;
  RIG-R)
    IS_RIG_R=1
    if [[ "$NAME" != "$RIG_R_NAME" ]]; then
      echo "ERROR: RIG-R requires exact rig name '$RIG_R_NAME'; got '$NAME'." >&2
      exit 2
    fi
    PROJECT_NAME="$RIG_R_PROJECT_NAME"
    CLOUD_RUN_SERVICE="$RIG_R_SERVICE"
    ;;
esac

case "$SUPABASE_PG_MAJOR" in
  17) ;;
  *) echo "ERROR: --pg-major must be 17 (prod-parity); got '$SUPABASE_PG_MAJOR'." >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Validate the profile. Only the declared profiles are supported; anything else is
# a typo that would silently deploy the wrong overlay — refuse it.
# ---------------------------------------------------------------------------
IS_MOCK_PROFILE=0
case "$PROFILE" in
  mock)          IS_MOCK_PROFILE=1 ;;
  chain|gemini|gemini-release)  IS_MOCK_PROFILE=0 ;;
  *)
    echo "ERROR: --profile must be one of: mock, chain, gemini, gemini-release; got '$PROFILE'." >&2
    exit 2
    ;;
esac

if [[ $IS_RIG_R -eq 1 && "$PROFILE" != "gemini-release" ]]; then
  echo "ERROR: RIG-R CTO profile binding accepts only profile=gemini-release; got '$PROFILE'." >&2
  exit 2
fi
if [[ $IS_RIG_R -ne 1 && "$PROFILE" == "gemini-release" ]]; then
  echo "ERROR: profile=gemini-release is accepted only with exact RIG_ID=RIG-R." >&2
  exit 2
fi

case "$SCHEDULER_ACTIVATION_MODE" in
  PAUSED|FORCE_ACCELERATED_RIG_ONLY) ;;
  *)
    echo "ERROR: Scheduler activation must be PAUSED or FORCE_ACCELERATED_RIG_ONLY; got '$SCHEDULER_ACTIVATION_MODE'." >&2
    exit 2
    ;;
esac
if [[ "$SCHEDULER_ACTIVATION_MODE" == "FORCE_ACCELERATED_RIG_ONLY" ]]; then
  echo "ERROR: provisioning never activates Scheduler traffic; FORCE_ACCELERATED_RIG_ONLY is forbidden here." >&2
  echo "       Provision RIG-B1 with PAUSED, then use scripts/staging/s33-b1-scheduler-start.ts." >&2
  exit 2
fi

# RIG-G1 has a frozen two-arm identity. Validate its complete declarative
# packet even in dry-run so the printed plan cannot look executable while
# omitting a budget, TTL, owner, immutable corpus, or independent route.
if [[ $IS_G1_RIG -eq 1 ]]; then
  if [[ "$PROFILE" != "gemini" ]]; then
    echo "ERROR: RIG-G1 requires profile=gemini; got '$PROFILE'." >&2
    exit 2
  fi
  if [[ "$SUPABASE_ORG" != "$RIG_G1_SUPABASE_ORG" ]]; then
    echo "ERROR: RIG-G1 requires exact Supabase org '$RIG_G1_SUPABASE_ORG'; got '$SUPABASE_ORG'." >&2
    exit 2
  fi
  if [[ "$SUPABASE_REGION" != "us-east-2" || "$SUPABASE_PG_MAJOR" != "17" ]]; then
    echo "ERROR: RIG-G1 requires a standalone Supabase us-east-2 / PG17 project." >&2
    exit 2
  fi
  if [[ "$CLOUD_RUN_REGION" != "us-central1" || "$GCP_PROJECT" != "$APPROVED_GCP_PROJECT" ]]; then
    echo "ERROR: RIG-G1 requires approved GCP project '$APPROVED_GCP_PROJECT' in us-central1." >&2
    exit 2
  fi
  if [[ $RUNTIME_SA_WAS_EXPLICIT -eq 1 ]]; then
    echo "ERROR: RIG-G1 forbids the generic runtime identity override; its A/B runtime service accounts are code-fixed and approval-bound." >&2
    exit 2
  fi
  if [[ ! "$G1_CORPUS_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: RIG-G1 requires STAGING_G1_CORPUS_DIGEST=sha256:<64-hex>." >&2
    exit 2
  fi
  for g1_identity_var in \
    STAGING_G1_CONTROL_RUN_ID STAGING_G1_TUNED_RUN_ID \
    STAGING_G1_CONTROL_QUEUE STAGING_G1_TUNED_QUEUE; do
    case "$g1_identity_var" in
      STAGING_G1_CONTROL_RUN_ID) g1_identity_value="$G1_CONTROL_RUN_ID" ;;
      STAGING_G1_TUNED_RUN_ID) g1_identity_value="$G1_TUNED_RUN_ID" ;;
      STAGING_G1_CONTROL_QUEUE) g1_identity_value="$G1_CONTROL_QUEUE" ;;
      STAGING_G1_TUNED_QUEUE) g1_identity_value="$G1_TUNED_QUEUE" ;;
    esac
    if [[ ! "$g1_identity_value" =~ ^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$ ]]; then
      echo "ERROR: RIG-G1 requires canonical $g1_identity_var (3-128 safe identity characters)." >&2
      exit 2
    fi
  done
  if [[ "$G1_CONTROL_RUN_ID" == "$G1_TUNED_RUN_ID" ]]; then
    echo "ERROR: RIG-G1 control and tuned run IDs must be distinct." >&2
    exit 2
  fi
  if [[ "$G1_CONTROL_QUEUE" == "$G1_TUNED_QUEUE" ]]; then
    echo "ERROR: RIG-G1 control and tuned queue identities must be distinct." >&2
    exit 2
  fi
  if [[ ! "$GEMINI_TUNED_MODEL_VALUE" =~ ^projects/([^/]+)/locations/us-central1/endpoints/([1-9][0-9]*)$ ]]; then
    echo "ERROR: RIG-G1 requires STAGING_GEMINI_TUNED_MODEL as an exact approved-project us-central1 endpoint." >&2
    exit 2
  fi
  G1_ENDPOINT_PROJECT="${BASH_REMATCH[1]}"
  G1_ENDPOINT_ID="${BASH_REMATCH[2]}"
  if [[ "$G1_ENDPOINT_PROJECT" != "$APPROVED_GCP_PROJECT" \
    || "$G1_ENDPOINT_ID" != "$RIG_G1_ENDPOINT_ID" ]]; then
    echo "ERROR: RIG-G1 tuned endpoint must equal its signed deterministic arkova1/us-central1 endpoint '${RIG_G1_ENDPOINT_ID}'." >&2
    exit 2
  fi
  if [[ "$GEMINI_V6_PROMPT_VALUE" != "true" ]]; then
    echo "ERROR: RIG-G1 tuned arm requires STAGING_GEMINI_V6_PROMPT=true." >&2
    exit 2
  fi
  if [[ "$TIER" != "T2" || "$REQUIRED_UPTIME_MIN" != "720" \
    || ! "$REQUIRED_WALL_MIN" =~ ^[1-9][0-9]*$ || 10#$REQUIRED_WALL_MIN -lt 750 \
    || ! "$G1_PAIRED_CADENCE_MIN" =~ ^[1-9][0-9]*$ \
    || 10#$G1_PAIRED_CADENCE_MIN -gt 30 ]]; then
    echo "ERROR: RIG-G1 requires Tier T2, exactly 720 worker-uptime minutes," >&2
    echo "       >=750 wall minutes, and STAGING_G1_PAIRED_CADENCE_MIN in 1..30." >&2
    exit 2
  fi
fi

if [[ $IS_G1_RIG -eq 1 || $IS_RIG_R -eq 1 ]]; then
  if [[ "$STRIPE_SECRET_KEY_SECRET" != "stripe-secret-key-staging" \
    || "$STRIPE_WEBHOOK_SECRET_SECRET" != "stripe-webhook-secret-staging" \
    || "$API_KEY_HMAC_SECRET_SECRET" != "api-key-hmac-secret-staging" \
    || "$CRON_SECRET_SECRET" != "cron-secret" \
    || "$GEMINI_API_KEY_SECRET" != "gemini-api-key" \
    || "$SHARED_STRIPE_SECRET_VERSION" != "1" \
    || "$SHARED_STRIPE_WEBHOOK_VERSION" != "1" \
    || "$SHARED_API_KEY_HMAC_VERSION" != "1" \
    || "$SHARED_CRON_SECRET_VERSION" != "1" \
    || "$GEMINI_API_KEY_SECRET_VERSION" != "2" ]]; then
    echo "ERROR: G1/R require the CTO-approved exact numeric shared-secret references (Stripe/HMAC/cron @1, gemini-api-key @2)." >&2
    exit 2
  fi
fi

# RIG-R is the single release/rollback soak. Its complete identity is fixed so
# the generic provisioner cannot quietly turn it into a Scheduler-driven Gemini
# rig, share an identity, or point teardown at the protected v6 rollback asset.
if [[ $IS_RIG_R -eq 1 ]]; then
  if [[ "$SUPABASE_ORG" != "$RIG_R_SUPABASE_ORG" \
    || "$SUPABASE_REGION" != "us-east-2" || "$SUPABASE_PG_MAJOR" != "17" ]]; then
    echo "ERROR: RIG-R requires one standalone '$RIG_R_PROJECT_NAME' Supabase us-east-2 / PG17 project." >&2
    exit 2
  fi
  if [[ "$GCP_PROJECT" != "$APPROVED_GCP_PROJECT" || "$GCP_PROJECT" != "arkova1" \
    || "$CLOUD_RUN_REGION" != "us-central1" ]]; then
    echo "ERROR: RIG-R requires exact project arkova1 and region us-central1." >&2
    exit 2
  fi
  if [[ $RUNTIME_SA_WAS_EXPLICIT -ne 1 || "$RUNTIME_SA" != "$RIG_R_RUNTIME_SA" ]]; then
    echo "ERROR: RIG-R requires explicit runtime identity '$RIG_R_RUNTIME_SA'." >&2
    exit 2
  fi
  if [[ $CRON_OIDC_SA_WAS_EXPLICIT -eq 1 ]]; then
    echo "ERROR: RIG-R permits zero OIDC identities; --cron-oidc-sa is forbidden." >&2
    exit 2
  fi
  if [[ "$SCHEDULER_ACTIVATION_MODE" != "PAUSED" ]]; then
    echo "ERROR: RIG-R has no Scheduler topology; activation mode must remain PAUSED." >&2
    exit 2
  fi
  if [[ "$RIG_R_VERTEX_ENDPOINT" != "$RIG_R_EXPECTED_ENDPOINT" ]]; then
    echo "ERROR: RIG-R requires exact signed deterministic endpoint '$RIG_R_EXPECTED_ENDPOINT'." >&2
    exit 2
  fi
  if [[ "$RIG_R_VERTEX_MODEL" != "$RIG_R_PROTECTED_V6_MODEL" ]]; then
    echo "ERROR: RIG-R temporary endpoint must deploy the exact protected v6 rollback model; the model itself is never a delete target." >&2
    exit 2
  fi
  if [[ "$RIG_R_DEPLOYED_MODEL_ID" != "$RIG_R_EXPECTED_DEPLOYED_MODEL_ID" ]]; then
    echo "ERROR: RIG-R requires exact signed deployed-model id '$RIG_R_EXPECTED_DEPLOYED_MODEL_ID'." >&2
    exit 2
  fi
  if [[ ! "$DECLARED_SOURCE_HEAD" =~ ^[0-9a-f]{40}$ \
    || ! "$RIG_R_CANDIDATE_TREE_SHA" =~ ^[0-9a-f]{40}$ \
    || ! "$RIG_R_PROVISION_ARTIFACT_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: RIG-R requires exact candidate HEAD/tree and CTO provision-artifact SHA-256 bindings." >&2
    exit 2
  fi
  if [[ ! "$LEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
    echo "ERROR: RIG-R requires one exact exclusive lease identity." >&2
    exit 2
  fi
  if [[ "$TIER" != "T3" || "$REQUIRED_UPTIME_MIN" != "2880" \
    || ! "$REQUIRED_WALL_MIN" =~ ^[1-9][0-9]*$ || 10#$REQUIRED_WALL_MIN -lt 2910 ]]; then
    echo "ERROR: RIG-R requires Tier T3, exactly 2880 worker-up minutes, and wall >=2910 minutes." >&2
    exit 2
  fi
  RIG_R_START_EPOCH="$(jq -nr --arg value "$RIG_R_PROVISION_STARTED_AT" \
    '$value | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' 2>/dev/null || true)"
  RIG_R_EXPIRY_EPOCH="$(jq -nr --arg value "$RIG_R_EXPIRES_AT" \
    '$value | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' 2>/dev/null || true)"
  if [[ ! "$RIG_R_START_EPOCH" =~ ^[0-9]+$ || ! "$RIG_R_EXPIRY_EPOCH" =~ ^[0-9]+$ ]]; then
    echo "ERROR: RIG-R requires canonical UTC provision-start and hard-stop expiry timestamps." >&2
    exit 2
  fi
  RIG_R_MIN_EXPIRY_EPOCH=$((RIG_R_START_EPOCH + (10#$REQUIRED_WALL_MIN + 360) * 60))
  RIG_R_MAX_EXPIRY_EPOCH=$((RIG_R_START_EPOCH + 72 * 60 * 60))
  if (( RIG_R_EXPIRY_EPOCH < RIG_R_MIN_EXPIRY_EPOCH )); then
    echo "ERROR: RIG-R hard-stop expiry must cover required wall plus 360 minutes." >&2
    exit 2
  fi
  if (( RIG_R_EXPIRY_EPOCH > RIG_R_MAX_EXPIRY_EPOCH )); then
    echo "ERROR: RIG-R hard-stop expiry cannot exceed 72 hours from provision start." >&2
    exit 2
  fi
  # The object name is code-fixed. The signed leaseId is payload identity, not
  # namespace: every contender races on this one generation-zero mutex.
  RIG_R_LEASE_URI="gs://${RIG_R_LEASE_BUCKET}/${RIG_R_LEASE_OBJECT_NAME}"
  GEMINI_TUNED_MODEL_VALUE="$RIG_R_VERTEX_ENDPOINT"
fi

# ---------------------------------------------------------------------------
# Hard-deny prod / shared staging. Belt-and-suspenders: check both the derived
# Cloud Run service name AND that no override smuggled in a prod/shared ref.
# ---------------------------------------------------------------------------
deny() { echo "REFUSING: $*" >&2; exit 1; }

image_digest_from_ref() {
  local image_ref="$1"
  case "$image_ref" in
    *@sha256:*) printf 'sha256:%s\n' "${image_ref##*@sha256:}" ;;
    sha256:*) printf '%s\n' "$image_ref" ;;
    *) return 1 ;;
  esac
}

execute_sha256_checksum() {
  local path="$1" utility output digest
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "ERROR: checksum authority requires a regular non-symlink file." >&2
    return 1
  fi
  if [[ -f /usr/bin/shasum && ! -L /usr/bin/shasum && -x /usr/bin/shasum ]]; then
    utility="/usr/bin/shasum"
    if ! output="$(/usr/bin/env -i TZ=UTC LC_ALL=C LANG=C \
      "$utility" -a 256 -- "$path" 2>/dev/null)"; then
      echo "ERROR: absolute SHA-256 utility failed while reading '$path'." >&2
      return 1
    fi
  elif [[ -f /usr/bin/sha256sum && ! -L /usr/bin/sha256sum && -x /usr/bin/sha256sum ]]; then
    utility="/usr/bin/sha256sum"
    if ! output="$(/usr/bin/env -i TZ=UTC LC_ALL=C LANG=C \
      "$utility" -- "$path" 2>/dev/null)"; then
      echo "ERROR: absolute SHA-256 utility failed while reading '$path'." >&2
      return 1
    fi
  else
    echo "ERROR: no supported absolute SHA-256 utility is available." >&2
    return 1
  fi
  if [[ "$output" == *$'\n'* ]]; then
    echo "ERROR: absolute SHA-256 utility returned more than one result." >&2
    return 1
  fi
  digest="${output%% *}"
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: absolute SHA-256 utility returned a malformed digest." >&2
    return 1
  fi
  if [[ "$output" != "$digest  $path" && "$output" != "$digest *$path" ]]; then
    echo "ERROR: absolute SHA-256 utility returned a malformed or unbound result." >&2
    return 1
  fi
  printf '%s\n' "$digest"
}

trusted_sha256_file() {
  execute_sha256_checksum "$1"
}

validate_trusted_git_binding() {
  [[ $TRUSTED_GIT_VALIDATED -eq 0 ]] || return 0
  local observed_digest observed_version
  if [[ "$TRUSTED_GIT_PATH" != /* || ! -f "$TRUSTED_GIT_PATH" \
    || -L "$TRUSTED_GIT_PATH" || ! -x "$TRUSTED_GIT_PATH" ]]; then
    echo "ERROR: live admission requires the code-bound Git path to be a regular absolute executable." >&2
    return 1
  fi
  if [[ ! "$TRUSTED_GIT_SHA256" =~ ^[0-9a-f]{64}$ \
    || ! "$TRUSTED_GIT_VERSION" =~ ^git[[:space:]]version[[:space:]].+ ]]; then
    echo "ERROR: trusted Git digest/version binding is UNCONFIGURED." >&2
    return 1
  fi
  observed_digest="$(trusted_sha256_file "$TRUSTED_GIT_PATH")" || return 1
  if [[ "$observed_digest" != "$TRUSTED_GIT_SHA256" ]]; then
    echo "ERROR: trusted Git binary digest differs from the code-bound release tuple." >&2
    return 1
  fi
  observed_version="$(/usr/bin/env -i TZ=UTC LC_ALL=C LANG=C \
    "$TRUSTED_GIT_PATH" --version 2>/dev/null || true)"
  if [[ "$observed_version" != "$TRUSTED_GIT_VERSION" ]]; then
    echo "ERROR: trusted Git version differs from the code-bound release tuple." >&2
    return 1
  fi
  TRUSTED_GIT_VALIDATED=1
}

trusted_git() {
  validate_trusted_git_binding || return 1
  /usr/bin/env -i \
    TZ=UTC LC_ALL=C LANG=C HOME=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_COUNT=0 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_ATTR_NOSYSTEM=1 \
    GIT_PROTOCOL_FROM_USER=0 \
    GIT_ALLOW_PROTOCOL=https \
    "$TRUSTED_GIT_PATH" --no-replace-objects \
      -c core.hooksPath=/dev/null \
      -c core.fsmonitor=false \
      -c core.attributesFile=/dev/null \
      "$@"
}

verify_checkout_inputs_match_declared_head() {
  local script_input_dir script_name script_dir script_absolute script_relative path
  local repo_root object_type blob_temp worktree_path
  local tracked_inputs=()
  case "$0" in
    */*) script_input_dir="${0%/*}"; script_name="${0##*/}" ;;
    *) script_input_dir="."; script_name="$0" ;;
  esac
  script_dir="$(cd -P -- "$script_input_dir" 2>/dev/null && pwd -P)" || script_dir=""
  script_absolute="${script_dir:+${script_dir}/}${script_name}"
  if ! validate_trusted_git_binding; then
    echo "ERROR: live provision cannot establish its trusted Git/blob reader." >&2
    exit 2
  fi
  repo_root="$(trusted_git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$repo_root" || "$script_absolute" != "$repo_root"/* ]]; then
    echo "ERROR: live provision must run from a Git checkout containing this provisioner." >&2
    exit 2
  fi
  if [[ ! -f "$script_absolute" || -L "$script_absolute" ]]; then
    echo "ERROR: live provision requires this provisioner to be a regular non-symlink checkout file." >&2
    exit 2
  fi
  TRUSTED_REPO_ROOT="$repo_root"
  TRUSTED_LOCAL_HEAD_SHA="$(trusted_git -C "$repo_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
  if [[ ! "$TRUSTED_LOCAL_HEAD_SHA" =~ ^[0-9a-f]{40}$ \
    || "$TRUSTED_LOCAL_HEAD_SHA" != "$DECLARED_SOURCE_HEAD" ]]; then
    echo "ERROR: declared source HEAD mismatch: declared=$DECLARED_SOURCE_HEAD git_HEAD=${TRUSTED_LOCAL_HEAD_SHA:-<unresolved>}." >&2
    exit 2
  fi
  object_type="$(trusted_git -C "$repo_root" cat-file -t "${DECLARED_SOURCE_HEAD}^{commit}" 2>/dev/null || true)"
  if [[ "$object_type" != "commit" ]]; then
    echo "ERROR: declared source HEAD is not an existing commit in the trusted checkout." >&2
    exit 2
  fi
  script_relative="${script_absolute#"$repo_root"/}"

  if [[ "$DRIVER_PATH" == /* || "$DRIVER_PATH" == ".." || "$DRIVER_PATH" == ../* \
    || "$DRIVER_PATH" == */../* || "$DRIVER_PATH" == */.. ]]; then
    echo "ERROR: live provision requires STAGING_DRIVER_PATH to be a repo-relative tracked path." >&2
    exit 2
  fi

  tracked_inputs=("$script_relative" "$DRIVER_PATH")
  if [[ $IS_G1_RIG -eq 1 ]]; then
    tracked_inputs+=("$RIG_G1_SPEND_APPROVAL_VERIFIER")
  fi
  if [[ $IS_RIG_R -eq 1 ]]; then
    tracked_inputs+=("$RIG_R_PROVISION_APPROVAL_VERIFIER" "$RIG_R_TEARDOWN_PATH")
  fi
  if [[ "$RIG_ID" == "RIG-B1" ]]; then
    tracked_inputs+=("$RIG_B1_NODE_STARTUP_SCRIPT" "$RIG_B1_NODE_APPROVAL_VERIFIER" "$RIG_R_TEARDOWN_PATH")
  fi
  for path in "${tracked_inputs[@]}"; do
    if [[ "$path" == /* || "$path" == "." || "$path" == ".." || "$path" == ../* \
      || "$path" == */../* || "$path" == */.. ]]; then
      echo "ERROR: live provision input '$path' is not a canonical repo-relative path." >&2
      exit 2
    fi
    worktree_path="$repo_root/$path"
    if [[ ! -f "$worktree_path" || -L "$worktree_path" ]]; then
      echo "ERROR: live provision input '$path' must be a regular non-symlink checkout file." >&2
      exit 2
    fi
    object_type="$(trusted_git -C "$repo_root" cat-file -t "${DECLARED_SOURCE_HEAD}:${path}" 2>/dev/null || true)"
    if [[ "$object_type" != "blob" ]]; then
      echo "ERROR: live provision input '$path' is not a blob at declared source HEAD." >&2
      exit 2
    fi
    blob_temp="$(/usr/bin/mktemp /tmp/arkova-declared-blob.XXXXXX)" || {
      echo "ERROR: live provision could not allocate trusted blob-comparison storage." >&2
      exit 2
    }
    if ! trusted_git -C "$repo_root" cat-file blob "${DECLARED_SOURCE_HEAD}:${path}" >"$blob_temp"; then
      /bin/rm -f -- "$blob_temp"
      echo "ERROR: live provision could not read declared blob bytes for '$path'." >&2
      exit 2
    fi
    if [[ "$path" == "$DRIVER_PATH" ]]; then
      DECLARED_DRIVER_SHA256="$(trusted_sha256_file "$blob_temp")" || {
        /bin/rm -f -- "$blob_temp"
        exit 2
      }
    fi
    if [[ $IS_RIG_R -eq 1 && "$path" == "$RIG_R_TEARDOWN_PATH" ]]; then
      DECLARED_RIG_R_TEARDOWN_SHA256="sha256:$(trusted_sha256_file "$blob_temp")" || {
        /bin/rm -f -- "$blob_temp"
        exit 2
      }
    fi
    if [[ "$RIG_ID" == "RIG-B1" && "$path" == "$RIG_R_TEARDOWN_PATH" ]]; then
      DECLARED_RIG_B1_TEARDOWN_SHA256="sha256:$(trusted_sha256_file "$blob_temp")" || {
        /bin/rm -f -- "$blob_temp"
        exit 2
      }
    fi
    if [[ "$RIG_ID" == "RIG-B1" && "$path" == "$RIG_B1_NODE_STARTUP_SCRIPT" ]]; then
      RIG_B1_NODE_STARTUP_SCRIPT_SHA256="$(trusted_sha256_file "$blob_temp")" || {
        /bin/rm -f -- "$blob_temp"
        exit 2
      }
    fi
    if ! /usr/bin/cmp -s -- "$worktree_path" "$blob_temp"; then
      /bin/rm -f -- "$blob_temp"
      echo "ERROR: provisioner/driver/verifier working-tree bytes differ byte-for-byte from declared source HEAD; commit or restore them first." >&2
      exit 2
    fi
    /bin/rm -f -- "$blob_temp"
  done
  if [[ ! "$DECLARED_DRIVER_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: live provision could not bind the declared driver blob digest." >&2
    exit 2
  fi
  if [[ $IS_RIG_R -eq 1 \
    && ! "$DECLARED_RIG_R_TEARDOWN_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: live RIG-R provision could not bind the declared teardown blob digest." >&2
    exit 2
  fi
  if [[ "$RIG_ID" == "RIG-B1" \
    && ! "$RIG_B1_NODE_STARTUP_SCRIPT_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: live RIG-B1 provision could not bind the declared Bitcoin Core startup-script digest." >&2
    exit 2
  fi
  if [[ "$RIG_ID" == "RIG-B1" \
    && ! "$DECLARED_RIG_B1_TEARDOWN_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: live RIG-B1 provision could not bind the declared teardown digest." >&2
    exit 2
  fi
}

verify_source_head_image_digest() {
  local image_repository observed_ref observed_digest expected_digest
  image_repository="${PINNED_IMAGE%@sha256:*}"
  SOURCE_HEAD_IMAGE_REF="${image_repository}:${DECLARED_SOURCE_HEAD}"
  expected_digest="$(image_digest_from_ref "$PINNED_IMAGE")"
  if ! observed_ref="$(gcloud artifacts docker images describe "$SOURCE_HEAD_IMAGE_REF" \
    --project="$GCP_PROJECT" \
    --format="value(image_summary.fully_qualified_digest)")"; then
    echo "ERROR: could not resolve the declared source HEAD image tag '$SOURCE_HEAD_IMAGE_REF'." >&2
    echo "       Build and push the exact checkout before provisioning; labels are not build provenance." >&2
    exit 2
  fi
  observed_digest="$(image_digest_from_ref "$observed_ref" 2>/dev/null || true)"
  if [[ -z "$observed_digest" || "$observed_digest" != "$expected_digest" ]]; then
    echo "ERROR: pinned image digest does not match the image built for declared source HEAD." >&2
    echo "       expected=$expected_digest observed=${observed_digest:-<missing>} tag=$SOURCE_HEAD_IMAGE_REF" >&2
    exit 2
  fi
  SOURCE_HEAD_IMAGE_DIGEST="$observed_digest"
}

verify_g1_candidate_endpoint_binding() {
  [[ $IS_G1_RIG -eq 1 ]] || return 0
  local endpoint_json expected_model_resource
  expected_model_resource="$RIG_G1_CANDIDATE_MODEL_RESOURCE"
  if ! endpoint_json="$(gcloud ai endpoints describe "$G1_ENDPOINT_ID" \
    --project="$APPROVED_GCP_PROJECT" \
    --region="us-central1" \
    --format=json)"; then
    echo "ERROR: RIG-G1 could not observe tuned endpoint '$GEMINI_TUNED_MODEL_VALUE'." >&2
    exit 2
  fi
  if ! jq -e \
    --arg endpoint_id "$RIG_G1_ENDPOINT_ID" \
    --arg endpoint_display "$RIG_G1_ENDPOINT_DISPLAY_NAME" \
    --arg expected_model "$expected_model_resource" \
    --arg expected_model_version "1" \
    --arg checkpoint_id "$RIG_G1_CHECKPOINT_ID" \
    --arg deployed_id "$RIG_G1_DEPLOYED_MODEL_ID" \
    --arg deployed_display "$RIG_G1_DEPLOYED_MODEL_DISPLAY_NAME" \
    --arg deployment_mode "$RIG_G1_DEPLOYMENT_RESOURCES_MODE" \
    --argjson min_replicas "$RIG_G1_MIN_REPLICA_COUNT" \
    --argjson max_replicas "$RIG_G1_MAX_REPLICA_COUNT" '
    type == "object"
    and (.name | type == "string" and endswith("/endpoints/\($endpoint_id)"))
    and .displayName == $endpoint_display
    and (.deployedModels | type == "array" and length == 1)
    and .deployedModels[0].model == $expected_model
    and (.deployedModels[0].modelVersionId | tostring) == $expected_model_version
    and (.deployedModels[0].checkpointId | tostring) == $checkpoint_id
    and .deployedModels[0].id == $deployed_id
    and .deployedModels[0].displayName == $deployed_display
    and $deployment_mode == "TUNED_GEMINI_AUTOMATIC_RESOURCES"
    and (.deployedModels[0].dedicatedResources // null) == null
    and .deployedModels[0].automaticResources.minReplicaCount == $min_replicas
    and .deployedModels[0].automaticResources.maxReplicaCount == $max_replicas
    and (.trafficSplit | type == "object")
    and ((.trafficSplit | keys) == [$deployed_id])
    and (.trafficSplit[$deployed_id] == 100)
  ' >/dev/null 2>&1 <<<"$endpoint_json"; then
    echo "ERROR: RIG-G1 tuned endpoint differs from the signed model@1/checkpoint-6/automatic-1x1/traffic contract." >&2
    exit 2
  fi
}

verify_rig_r_candidate_endpoint_binding() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local endpoint_id endpoint_json
  endpoint_id="${RIG_R_VERTEX_ENDPOINT##*/}"
  if ! endpoint_json="$(gcloud ai endpoints describe "$endpoint_id" \
    --project="arkova1" \
    --region="us-central1" \
    --format=json)"; then
    echo "ERROR: RIG-R could not observe temporary endpoint '$RIG_R_VERTEX_ENDPOINT'." >&2
    exit 2
  fi
  if ! jq -e \
    --arg endpoint_id "$RIG_R_ENDPOINT_ID" \
    --arg endpoint_display "$RIG_R_ENDPOINT_DISPLAY_NAME" \
    --arg expected_model "$RIG_R_VERTEX_MODEL" \
    --arg expected_model_version "1" \
    --arg checkpoint_id "$RIG_R_CHECKPOINT_ID" \
    --arg expected_deployed_id "$RIG_R_DEPLOYED_MODEL_ID" \
    --arg deployed_display "$RIG_R_DEPLOYED_MODEL_DISPLAY_NAME" \
    --arg deployment_mode "$RIG_R_DEPLOYMENT_RESOURCES_MODE" \
    --argjson min_replicas "$RIG_R_MIN_REPLICA_COUNT" \
    --argjson max_replicas "$RIG_R_MAX_REPLICA_COUNT" '
      type == "object"
      and (.name | type == "string" and endswith("/endpoints/\($endpoint_id)"))
      and .displayName == $endpoint_display
      and (.deployedModels | type == "array" and length == 1)
      and (.deployedModels[0].model == $expected_model)
      and (.deployedModels[0].modelVersionId | tostring) == $expected_model_version
      and (.deployedModels[0].checkpointId | tostring) == $checkpoint_id
      and (.deployedModels[0].id == $expected_deployed_id)
      and .deployedModels[0].displayName == $deployed_display
      and $deployment_mode == "TUNED_GEMINI_AUTOMATIC_RESOURCES"
      and (.deployedModels[0].dedicatedResources // null) == null
      and .deployedModels[0].automaticResources.minReplicaCount == $min_replicas
      and .deployedModels[0].automaticResources.maxReplicaCount == $max_replicas
      and (.trafficSplit | type == "object")
      and ((.trafficSplit | keys) == [$expected_deployed_id])
      and (.trafficSplit[$expected_deployed_id] == 100)
    ' >/dev/null 2>&1 <<<"$endpoint_json"; then
    echo "ERROR: RIG-R endpoint is not the sole exact deployed-model binding at 100% traffic." >&2
    exit 2
  fi
}

verify_temporary_rig_targets_absent() {
  local observed projects_json target
  if [[ $IS_G1_RIG -eq 1 ]]; then
    observed="$(gcloud ai endpoints list --project="$GCP_PROJECT" \
      --region="$CLOUD_RUN_REGION" --filter="name:${GEMINI_TUNED_MODEL_VALUE}" \
      --format='value(name)')" || {
      echo "ERROR: RIG-G1 cannot prove the deterministic temporary endpoint is absent." >&2
      exit 2
    }
    if [[ -n "$observed" ]]; then
      echo "ERROR: RIG-G1 deterministic endpoint already exists; refusing ownership ambiguity." >&2
      exit 2
    fi
    for target in "$G1_CONTROL_RUNTIME_SA" "$G1_TUNED_RUNTIME_SA"; do
      observed="$(gcloud iam service-accounts list --project="$GCP_PROJECT" \
        --filter="email:${target}" --format='value(email)')" || exit 2
      if [[ -n "$observed" ]]; then
        echo "ERROR: RIG-G1 temporary runtime identity '$target' already exists." >&2
        exit 2
      fi
    done
    for target in "$G1_CONTROL_SERVICE" "$G1_TUNED_SERVICE"; do
      observed="$(gcloud run services list --project="$GCP_PROJECT" \
        --region="$CLOUD_RUN_REGION" --filter="metadata.name:${target}" \
        --format='value(metadata.name)')" || exit 2
      if [[ -n "$observed" ]]; then
        echo "ERROR: RIG-G1 temporary Cloud Run service '$target' already exists." >&2
        exit 2
      fi
    done
    projects_json="$(npx supabase projects list --output json)" || {
      echo "ERROR: RIG-G1 cannot prove its two physical Supabase names are absent." >&2
      exit 2
    }
    if ! jq -e --arg a "$G1_CONTROL_PROJECT_NAME" --arg b "$G1_TUNED_PROJECT_NAME" '
      type == "array"
      and ([.[] | select(.name == $a or .name == $b)] | length == 0)
    ' >/dev/null 2>&1 <<<"$projects_json"; then
      echo "ERROR: RIG-G1 Supabase inventory is malformed or an arm project already exists." >&2
      exit 2
    fi
  elif [[ $IS_RIG_R -eq 1 ]]; then
    observed="$(gcloud ai endpoints list --project="$GCP_PROJECT" \
      --region="$CLOUD_RUN_REGION" --filter="name:${RIG_R_VERTEX_ENDPOINT}" \
      --format='value(name)')" || {
      echo "ERROR: RIG-R cannot prove the deterministic temporary endpoint is absent." >&2
      exit 2
    }
    if [[ -n "$observed" ]]; then
      echo "ERROR: RIG-R deterministic endpoint already exists; refusing ownership ambiguity." >&2
      exit 2
    fi
    observed="$(gcloud iam service-accounts list --project="$GCP_PROJECT" \
      --filter="email:${RUNTIME_SA}" --format='value(email)')" || exit 2
    if [[ -n "$observed" ]]; then
      echo "ERROR: RIG-R temporary runtime identity already exists." >&2
      exit 2
    fi
    observed="$(gcloud run services list --project="$GCP_PROJECT" \
      --region="$CLOUD_RUN_REGION" --filter="metadata.name:${CLOUD_RUN_SERVICE}" \
      --format='value(metadata.name)')" || exit 2
    if [[ -n "$observed" ]]; then
      echo "ERROR: RIG-R temporary Cloud Run service already exists." >&2
      exit 2
    fi
    projects_json="$(npx supabase projects list --output json)" || {
      echo "ERROR: RIG-R cannot prove its physical Supabase name is absent." >&2
      exit 2
    }
    if ! jq -e --arg name "$PROJECT_NAME" '
      type == "array" and ([.[] | select(.name == $name)] | length == 0)
    ' >/dev/null 2>&1 <<<"$projects_json"; then
      echo "ERROR: RIG-R Supabase inventory is malformed or its project already exists." >&2
      exit 2
    fi
  fi
}

resolve_g1_trusted_node_launcher() {
  [[ $IS_G1_RIG -eq 1 ]] || return 0
  local candidate observed_digest observed_version
  if [[ ! "$RIG_G1_TRUSTED_NODE_SHA256" =~ ^[0-9a-f]{64}$ \
    || ! "$RIG_G1_TRUSTED_NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: RIG-G1 trusted Node launcher binding is invalid." >&2
    return 1
  fi
  candidate="$RIG_G1_TRUSTED_NODE_PATH"
  if [[ "$candidate" != /* || ! -f "$candidate" || -L "$candidate" || ! -x "$candidate" ]]; then
    echo "ERROR: RIG-G1 approval verification requires an absolute regular executable Node launcher." >&2
    return 1
  fi
  observed_digest="$(trusted_sha256_file "$candidate")" || return 1
  if [[ "$observed_digest" != "$RIG_G1_TRUSTED_NODE_SHA256" ]]; then
    echo "ERROR: RIG-G1 Node launcher digest differs from the code-bound trust input." >&2
    return 1
  fi
  observed_version="$(/usr/bin/env -i TZ=UTC "$candidate" --version 2>/dev/null || true)"
  if [[ "$observed_version" != "$RIG_G1_TRUSTED_NODE_VERSION" ]]; then
    echo "ERROR: RIG-G1 Node launcher version differs from the code-bound trust input." >&2
    return 1
  fi
  G1_TRUSTED_NODE_LAUNCHER="$candidate"
}

resolve_rig_r_trusted_node_launcher() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local observed_digest observed_version
  if [[ "$RIG_R_TRUSTED_NODE_PATH" != /* \
    || ! -f "$RIG_R_TRUSTED_NODE_PATH" || -L "$RIG_R_TRUSTED_NODE_PATH" \
    || ! -x "$RIG_R_TRUSTED_NODE_PATH" \
    || ! "$RIG_R_TRUSTED_NODE_SHA256" =~ ^[0-9a-f]{64}$ \
    || ! "$RIG_R_TRUSTED_NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: RIG-R trusted Node launcher tuple is invalid." >&2
    return 1
  fi
  observed_digest="$(trusted_sha256_file "$RIG_R_TRUSTED_NODE_PATH")" || return 1
  if [[ "$observed_digest" != "$RIG_R_TRUSTED_NODE_SHA256" ]]; then
    echo "ERROR: RIG-R Node launcher digest differs from the code-bound trust input." >&2
    return 1
  fi
  observed_version="$(/usr/bin/env -i TZ=UTC \
    "$RIG_R_TRUSTED_NODE_PATH" --version 2>/dev/null || true)"
  if [[ "$observed_version" != "$RIG_R_TRUSTED_NODE_VERSION" ]]; then
    echo "ERROR: RIG-R Node launcher version differs from the code-bound trust input." >&2
    return 1
  fi
  RIG_R_TRUSTED_NODE_LAUNCHER="$RIG_R_TRUSTED_NODE_PATH"
}

resolve_b1_trusted_node_launcher() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local observed_digest observed_version
  if [[ "$RIG_G1_TRUSTED_NODE_PATH" != /* \
    || ! -f "$RIG_G1_TRUSTED_NODE_PATH" || -L "$RIG_G1_TRUSTED_NODE_PATH" \
    || ! -x "$RIG_G1_TRUSTED_NODE_PATH" ]]; then
    echo "ERROR: RIG-B1 approval verification requires the code-bound Node launcher." >&2
    return 1
  fi
  observed_digest="$(trusted_sha256_file "$RIG_G1_TRUSTED_NODE_PATH")" || return 1
  observed_version="$(/usr/bin/env -i TZ=UTC "$RIG_G1_TRUSTED_NODE_PATH" --version 2>/dev/null || true)"
  if [[ "$observed_digest" != "$RIG_G1_TRUSTED_NODE_SHA256" \
    || "$observed_version" != "$RIG_G1_TRUSTED_NODE_VERSION" ]]; then
    echo "ERROR: RIG-B1 Node launcher differs from the code-bound trust tuple." >&2
    return 1
  fi
  RIG_B1_TRUSTED_NODE_LAUNCHER="$RIG_G1_TRUSTED_NODE_PATH"
}

verify_b1_node_approval_binding() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local verified_json expected_worker_digest expected_secrets
  expected_worker_digest="$(image_digest_from_ref "$PINNED_IMAGE")"
  expected_secrets="$(jq -nc \
    --arg rig_name "$NAME" \
    --arg stripe "$STRIPE_SECRET_KEY_SECRET" --arg stripe_v "$RIG_B1_STRIPE_SECRET_KEY_VERSION" \
    --arg webhook "$STRIPE_WEBHOOK_SECRET_SECRET" --arg webhook_v "$RIG_B1_STRIPE_WEBHOOK_SECRET_VERSION" \
    --arg hmac "$API_KEY_HMAC_SECRET_SECRET" --arg hmac_v "$RIG_B1_API_KEY_HMAC_SECRET_VERSION" \
    --arg cron "$CRON_SECRET_SECRET" --arg cron_v "$RIG_B1_CRON_SECRET_VERSION" \
    --arg rpc_url "$BITCOIN_CORE_RPC_URL_SECRET" --arg rpc_url_v "$RIG_B1_RPC_URL_SECRET_VERSION" \
    --arg rpc_auth "$BITCOIN_CORE_RPC_AUTH_SECRET" --arg rpc_auth_v "$RIG_B1_RPC_AUTH_SECRET_VERSION" \
    --arg wif "$TREASURY_WIF_SECRET" --arg wif_v "$RIG_B1_TREASURY_WIF_SECRET_VERSION" '
      def ref($env; $name; $version): {
        env: $env, secretName: $name, version: $version,
        resource: "projects/arkova1/secrets/\($name)/versions/\($version)"
      };
      [
        ref("SUPABASE_URL"; "supabase-url-\($rig_name)-staging"; "1"),
        ref("SUPABASE_SERVICE_ROLE_KEY"; "supabase-service-role-key-\($rig_name)-staging"; "1"),
        ref("STRIPE_SECRET_KEY"; $stripe; $stripe_v),
        ref("STRIPE_WEBHOOK_SECRET"; $webhook; $webhook_v),
        ref("API_KEY_HMAC_SECRET"; $hmac; $hmac_v),
        ref("CRON_SECRET"; $cron; $cron_v),
        ref("BITCOIN_RPC_URL"; $rpc_url; $rpc_url_v),
        ref("BITCOIN_RPC_AUTH"; $rpc_auth; $rpc_auth_v),
        ref("BITCOIN_TREASURY_WIF"; $wif; $wif_v)
      ]
    ')" || exit 2
  if [[ -z "$RIG_B1_TRUSTED_NODE_LAUNCHER" ]] && ! resolve_b1_trusted_node_launcher; then
    echo "ERROR: RIG-B1 approval verifier launcher is not trusted." >&2
    exit 2
  fi
  if ! verified_json="$(/usr/bin/env -i TZ=UTC \
    "$RIG_B1_TRUSTED_NODE_LAUNCHER" --no-addons --no-global-search-paths \
    "$TRUSTED_REPO_ROOT/$RIG_B1_NODE_APPROVAL_VERIFIER" \
    --artifact "$RIG_B1_NODE_APPROVAL_ARTIFACT")"; then
    echo "ERROR: RIG-B1 signed node/spend approval verification failed." >&2
    exit 2
  fi
  if ! verified_json="$(jq -ce \
    --arg source_head "$DECLARED_SOURCE_HEAD" \
    --arg source_tree "$RIG_B1_CANDIDATE_TREE_SHA" \
    --arg worker_image "$PINNED_IMAGE" \
    --arg worker_digest "$expected_worker_digest" \
    --arg bitcoin_recipe_commit "$RIG_B1_BITCOIN_CORE_RECIPE_COMMIT" \
    --arg bitcoin_image "$RIG_B1_BITCOIN_CORE_IMAGE" \
    --arg bitcoin_amd64_runtime_digest "$RIG_B1_BITCOIN_CORE_AMD64_RUNTIME_DIGEST" \
    --arg startup_sha "sha256:${RIG_B1_NODE_STARTUP_SCRIPT_SHA256}" \
    --arg teardown_sha "$DECLARED_RIG_B1_TEARDOWN_SHA256" \
    --arg corpus_digest "$RIG_B1_CORPUS_DIGEST" \
    --arg rc_id "$RIG_B1_RELEASE_CANDIDATE_ID" \
    --arg rig_name "$NAME" --arg soak_id "$SOAK_ID" --arg lease_id "$LEASE_ID" \
    --arg service "$CLOUD_RUN_SERVICE" --arg runtime_sa "$RUNTIME_SA" --arg cron_sa "$CRON_OIDC_SA" \
    --arg treasury_address "$RIG_B1_TREASURY_ADDRESS" \
    --arg treasury_descriptor "$RIG_B1_TREASURY_DESCRIPTOR" \
    --arg split_txid "$RIG_B1_TREASURY_SPLIT_TXID" \
    --arg split_plan_digest "$RIG_B1_TREASURY_SPLIT_PLAN_DIGEST" \
    --argjson expected_total_sats "$RIG_B1_TREASURY_EXPECTED_TOTAL_SATS" \
    --argjson expected_secrets "$expected_secrets" '
      select(
        type == "object"
        and ((keys | sort) == (["envelopeId", "envelopeSha256", "keyId", "payload", "signedPayloadSha256", "status", "verifierIdentity"] | sort))
        and .status == "VERIFIED"
        and .keyId == "arkova.s33.b1-evidence.ed25519.v1"
        and .verifierIdentity == "arkova.s33.verifier.public-ed25519.v1"
        and (.envelopeSha256 | test("^sha256:[0-9a-f]{64}$"))
        and (.signedPayloadSha256 | test("^sha256:[0-9a-f]{64}$"))
        and .payload.authority.approverIdentity == "arkova.s33.approver.founder-cto.v1"
        and .payload.authority.purpose == "RIG_B1_BITCOIN_CORE_PROVISION"
        and .payload.candidate.sourceHeadSha == $source_head
        and .payload.candidate.sourceTreeSha == $source_tree
        and .payload.candidate.workerImage == $worker_image
        and .payload.candidate.workerImageDigest == $worker_digest
        and .payload.candidate.bitcoinCoreRecipeCommit == $bitcoin_recipe_commit
        and .payload.candidate.bitcoinCoreImage == $bitcoin_image
        and .payload.candidate.bitcoinCoreAmd64RuntimeDigest == $bitcoin_amd64_runtime_digest
        and .payload.topology.bitcoinCore.recipeCommit == $bitcoin_recipe_commit
        and .payload.topology.bitcoinCore.containerImage == $bitcoin_image
        and .payload.topology.bitcoinCore.amd64RuntimeDigest == $bitcoin_amd64_runtime_digest
        and .payload.topology.bitcoinCore.sourceTarballSha256 == "b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"
        and .payload.candidate.startupScriptSha256 == $startup_sha
        and .payload.candidate.teardownScriptSha256 == $teardown_sha
        and .payload.candidate.corpusDigest == $corpus_digest
        and .payload.candidate.releaseCandidateId == $rc_id
        and .payload.run.rigId == "RIG-B1"
        and .payload.run.rigName == $rig_name
        and .payload.run.soakId == $soak_id
        and .payload.run.leaseId == $lease_id
        and .payload.run.workerService == $service
        and .payload.run.workerRuntimeServiceAccount == $runtime_sa
        and .payload.run.schedulerOidcServiceAccount == $cron_sa
        and .payload.topology.secretReferences == $expected_secrets
        and .payload.topology.treasuryWatchOnly == {
          address: $treasury_address,
          descriptor: $treasury_descriptor,
          splitTransactionId: $split_txid,
          preSplitPlanDigest: $split_plan_digest,
          expectedConfirmedOutputCount: 32,
          expectedTotalSats: $expected_total_sats,
          descriptorPolicy: "addr-checksummed-importdescriptors",
          wifOnNode: false
        }
        and (.payload.budget.spendCapUsd | type == "number" and floor == . and . >= 1 and . <= 200)
        and .payload.teardown.projectedMonthlyRecurringUsd == 0
      )
    ' <<<"$verified_json" 2>/dev/null)"; then
    echo "ERROR: RIG-B1 verified approval does not bind the exact RC/corpus/run/topology/spend/teardown contract." >&2
    exit 2
  fi
  RIG_B1_NODE_APPROVAL_JSON="$verified_json"
  RIG_B1_APPROVAL_ID="$(jq -r '.payload.approvalId' <<<"$verified_json")"
  RIG_B1_APPROVAL_ENVELOPE_SHA256="$(jq -r '.envelopeSha256' <<<"$verified_json")"
  RIG_B1_APPROVAL_PAYLOAD_SHA256="$(jq -r '.signedPayloadSha256' <<<"$verified_json")"
  RIG_B1_APPROVAL_EXPIRES_AT="$(jq -r '.payload.expiresAt' <<<"$verified_json")"
  RIG_B1_SPEND_CAP_USD="$(jq -r '.payload.budget.spendCapUsd' <<<"$verified_json")"
  if ! jq -ne \
    --arg expires_at "$RIG_B1_APPROVAL_EXPIRES_AT" \
    --argjson required_wall_min "$REQUIRED_WALL_MIN" '
      ($expires_at | fromdateiso8601) >= (now + ($required_wall_min * 60))
    ' >/dev/null 2>&1; then
    echo "ERROR: RIG-B1 signed authority expires before the complete required soak wall; refusing paid mutation." >&2
    exit 2
  fi
}

verify_b1_required_apis() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local enabled api
  local required=(
    artifactregistry.googleapis.com
    cloudscheduler.googleapis.com
    compute.googleapis.com
    iam.googleapis.com
    run.googleapis.com
    secretmanager.googleapis.com
    serviceusage.googleapis.com
    vpcaccess.googleapis.com
  )
  if ! enabled="$(gcloud services list --enabled --project="$GCP_PROJECT" \
    --format='value(config.name)')"; then
    echo "ERROR: RIG-B1 could not observe required GCP API enablement." >&2
    exit 2
  fi
  for api in "${required[@]}"; do
    if ! grep -Fx -- "$api" <<<"$enabled" >/dev/null; then
      echo "ERROR: RIG-B1 required API '$api' is disabled; refusing partial topology creation." >&2
      exit 2
    fi
  done
}

verify_rig_r_provision_approval_binding() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local expected_image_digest expected_full_image_ref verified_json
  local supabase_url_ref supabase_role_ref stripe_ref webhook_ref hmac_ref cron_ref gemini_ref
  local endpoint_iam_member
  expected_image_digest="$(image_digest_from_ref "$PINNED_IMAGE")"
  expected_full_image_ref="${APPROVED_SOURCE_IMAGE_REPOSITORY}:${DECLARED_SOURCE_HEAD}@${expected_image_digest}"
  supabase_url_ref="${SUPABASE_URL_SECRET_NAME}@1"
  supabase_role_ref="${SUPABASE_SERVICE_ROLE_SECRET_NAME}@1"
  stripe_ref="${STRIPE_SECRET_KEY_SECRET}@${SHARED_STRIPE_SECRET_VERSION}"
  webhook_ref="${STRIPE_WEBHOOK_SECRET_SECRET}@${SHARED_STRIPE_WEBHOOK_VERSION}"
  hmac_ref="${API_KEY_HMAC_SECRET_SECRET}@${SHARED_API_KEY_HMAC_VERSION}"
  cron_ref="${CRON_SECRET_SECRET}@${SHARED_CRON_SECRET_VERSION}"
  gemini_ref="${GEMINI_API_KEY_SECRET}@${GEMINI_API_KEY_SECRET_VERSION}"
  endpoint_iam_member="serviceAccount:${RUNTIME_SA}"
  if [[ -z "$RIG_R_PROVISION_APPROVAL_ARTIFACT" ]]; then
    echo "ERROR: RIG-R immutable provision approval artifact is required." >&2
    exit 2
  fi
  if [[ -z "$RIG_R_TRUSTED_NODE_LAUNCHER" ]] \
    && ! resolve_rig_r_trusted_node_launcher; then
    echo "ERROR: RIG-R approval verifier launcher is not trusted." >&2
    exit 2
  fi
  if [[ ! "$DECLARED_RIG_R_TEARDOWN_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: RIG-R teardown boundary is not bound to the declared source HEAD." >&2
    exit 2
  fi
  if ! verified_json="$(/usr/bin/env -i TZ=UTC \
    "$RIG_R_TRUSTED_NODE_LAUNCHER" --no-addons --no-global-search-paths \
    "$TRUSTED_REPO_ROOT/$RIG_R_PROVISION_APPROVAL_VERIFIER" \
    --artifact "$RIG_R_PROVISION_APPROVAL_ARTIFACT" \
    --expected-source-head "$DECLARED_SOURCE_HEAD" \
    --expected-source-tree "$RIG_R_CANDIDATE_TREE_SHA" \
    --expected-source-head-image-ref "$expected_full_image_ref" \
    --expected-image-digest "$expected_image_digest" \
    --expected-provision-artifact-sha256 "$RIG_R_PROVISION_ARTIFACT_SHA256" \
    --expected-rig-name "$NAME" \
    --expected-rig-profile "$PROFILE" \
    --expected-soak-id "$SOAK_ID" \
    --expected-lease-id "$LEASE_ID" \
    --expected-required-wall-min "$REQUIRED_WALL_MIN" \
    --expected-vertex-endpoint-id "$RIG_R_ENDPOINT_ID" \
    --expected-vertex-endpoint "$RIG_R_VERTEX_ENDPOINT" \
    --expected-vertex-endpoint-display-name "$RIG_R_ENDPOINT_DISPLAY_NAME" \
    --expected-vertex-model "$RIG_R_VERTEX_MODEL" \
    --expected-vertex-model-version "$RIG_R_PROTECTED_V6_MODEL_VERSION" \
    --expected-checkpoint-id "$RIG_R_CHECKPOINT_ID" \
    --expected-deployed-model-id "$RIG_R_DEPLOYED_MODEL_ID" \
    --expected-deployed-model-display-name "$RIG_R_DEPLOYED_MODEL_DISPLAY_NAME" \
    --expected-deployment-resources-mode "$RIG_R_DEPLOYMENT_RESOURCES_MODE" \
    --expected-min-replica-count "$RIG_R_MIN_REPLICA_COUNT" \
    --expected-max-replica-count "$RIG_R_MAX_REPLICA_COUNT" \
    --expected-endpoint-iam-role "roles/aiplatform.endpointUser" \
    --expected-endpoint-iam-member "$endpoint_iam_member" \
    --expected-runtime-impersonator-service-account "$RIG_R_OPERATOR_SA" \
    --expected-runtime-impersonation-role "$RIG_R_RUNTIME_IMPERSONATION_ROLE" \
    --expected-runtime-impersonation-member "$RIG_R_RUNTIME_IMPERSONATION_MEMBER" \
    --expected-provision-started-at "$RIG_R_PROVISION_STARTED_AT" \
    --expected-expires-at "$RIG_R_EXPIRES_AT" \
    --expected-teardown-script-sha256 "$DECLARED_RIG_R_TEARDOWN_SHA256" \
    --expected-supabase-url-secret "$supabase_url_ref" \
    --expected-supabase-service-role-secret "$supabase_role_ref" \
    --expected-stripe-secret-key-secret "$stripe_ref" \
    --expected-stripe-webhook-secret "$webhook_ref" \
    --expected-api-key-hmac-secret "$hmac_ref" \
    --expected-cron-secret "$cron_ref" \
    --expected-gemini-api-key-secret "$gemini_ref" \
    --expected-immutable-ledger-bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET")"; then
    echo "ERROR: RIG-R immutable provision approval verification failed." >&2
    exit 2
  fi
  if ! verified_json="$(jq -ce \
    --arg source_head "$DECLARED_SOURCE_HEAD" \
    --arg source_tree "$RIG_R_CANDIDATE_TREE_SHA" \
    --arg full_image_ref "$expected_full_image_ref" \
    --arg image_digest "$expected_image_digest" \
    --arg artifact_sha "$RIG_R_PROVISION_ARTIFACT_SHA256" \
    --arg rig_name "$NAME" \
    --arg rig_profile "$PROFILE" \
    --arg soak_id "$SOAK_ID" \
    --arg lease_id "$LEASE_ID" \
    --arg endpoint_id "$RIG_R_ENDPOINT_ID" \
    --arg endpoint "$RIG_R_VERTEX_ENDPOINT" \
    --arg endpoint_display "$RIG_R_ENDPOINT_DISPLAY_NAME" \
    --arg vertex_model "$RIG_R_VERTEX_MODEL" \
    --arg vertex_model_version "$RIG_R_PROTECTED_V6_MODEL_VERSION" \
    --arg checkpoint_id "$RIG_R_CHECKPOINT_ID" \
    --arg deployed_model_id "$RIG_R_DEPLOYED_MODEL_ID" \
    --arg deployed_model_display "$RIG_R_DEPLOYED_MODEL_DISPLAY_NAME" \
    --arg deployment_resources_mode "$RIG_R_DEPLOYMENT_RESOURCES_MODE" \
    --arg endpoint_iam_member "$endpoint_iam_member" \
    --arg runtime_impersonator_sa "$RIG_R_OPERATOR_SA" \
    --arg runtime_impersonation_role "$RIG_R_RUNTIME_IMPERSONATION_ROLE" \
    --arg runtime_impersonation_member "$RIG_R_RUNTIME_IMPERSONATION_MEMBER" \
    --arg provision_started_at "$RIG_R_PROVISION_STARTED_AT" \
    --arg expires_at "$RIG_R_EXPIRES_AT" \
    --arg teardown_sha "$DECLARED_RIG_R_TEARDOWN_SHA256" \
    --arg supabase_url_secret "$supabase_url_ref" \
    --arg supabase_service_role_secret "$supabase_role_ref" \
    --arg stripe_secret_key_secret "$stripe_ref" \
    --arg stripe_webhook_secret "$webhook_ref" \
    --arg api_key_hmac_secret "$hmac_ref" \
    --arg cron_secret "$cron_ref" \
    --arg gemini_api_key_secret "$gemini_ref" \
    --arg immutable_ledger_bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
    --argjson required_wall_min "$REQUIRED_WALL_MIN" \
    --argjson min_replica_count "$RIG_R_MIN_REPLICA_COUNT" \
    --argjson max_replica_count "$RIG_R_MAX_REPLICA_COUNT" '
      . as $approval
      | (type == "object"
      and ((keys | sort) == ([
        "approvalId", "approvalVerifiedAt", "approverIdentity",
        "authorityActivatedAtUtc", "authorityRosterRootSha256", "budget",
        "candidate", "canonicalSha256", "execution", "immutableRevisionId",
        "runtimeVerifiedAt", "sourceReference", "status", "teardown", "topology",
        "trustRootKeyFingerprint", "trustRootKeyId", "verificationMethod",
        "verifierIdentity"
      ] | sort))
      and .status == "VERIFIED"
      and (.approvalId | test("^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$"))
      and (.sourceReference | type == "string" and length > 0)
      and (.immutableRevisionId | type == "string" and length > 0)
      and .canonicalSha256 == $artifact_sha
      and .trustRootKeyId == "arkova.s33.release-corpus.ed25519.v1"
      and .trustRootKeyFingerprint == "b5f6445ae954ac1f29b504fdc890dedefda23beb6300f35d99cd2c9d2eeb9e59" # gitleaks:allow -- public Ed25519 fingerprint
      and .authorityRosterRootSha256 == "sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f"
      and .approverIdentity == "arkova.s33.approver.founder-cto.v1"
      and .verifierIdentity == "arkova.s33.verifier.public-ed25519.v1"
      and .authorityActivatedAtUtc == "2026-07-16T13:52:06Z"
      and .verificationMethod == "ed25519-pinned-authority-roster"
      and (.approvalVerifiedAt | type == "string")
      and (.runtimeVerifiedAt | type == "string")
      and ((.candidate | keys | sort) == ([
        "checkpointId", "deployedModelDisplayName", "deployedModelId",
        "deploymentResourcesMode", "endpointIamMember", "endpointIamRole",
        "runtimeImpersonatorServiceAccount", "runtimeImpersonationRole",
        "runtimeImpersonationMember",
        "expiresAt", "imageDigest", "leaseId", "maxReplicaCount", "minReplicaCount",
        "immutableLedger", "provisionArtifactSha256", "provisionStartedAt", "requiredWallMin",
        "rigName", "rigProfile", "soakId", "sourceHeadImageRef", "sourceHeadSha",
        "sourceTreeSha", "teardownScriptSha256", "vertexEndpoint", "vertexEndpointDisplayName",
        "vertexEndpointId", "vertexModel", "vertexModelVersion",
        "secretReferences"
      ] | sort))
      and .candidate.sourceHeadSha == $source_head
      and .candidate.sourceTreeSha == $source_tree
      and .candidate.sourceHeadImageRef == $full_image_ref
      and .candidate.imageDigest == $image_digest
      and .candidate.provisionArtifactSha256 == $artifact_sha
      and .candidate.rigName == $rig_name
      and .candidate.rigProfile == $rig_profile
      and .candidate.soakId == $soak_id
      and .candidate.leaseId == $lease_id
      and .candidate.requiredWallMin == $required_wall_min
      and .candidate.vertexEndpointId == $endpoint_id
      and .candidate.vertexEndpoint == $endpoint
      and .candidate.vertexEndpointDisplayName == $endpoint_display
      and .candidate.vertexModel == $vertex_model
      and .candidate.vertexModelVersion == $vertex_model_version
      and .candidate.checkpointId == $checkpoint_id
      and .candidate.deployedModelId == $deployed_model_id
      and .candidate.deployedModelDisplayName == $deployed_model_display
      and .candidate.deploymentResourcesMode == $deployment_resources_mode
      and .candidate.minReplicaCount == $min_replica_count
      and .candidate.maxReplicaCount == $max_replica_count
      and .candidate.endpointIamRole == "roles/aiplatform.endpointUser"
      and .candidate.endpointIamMember == $endpoint_iam_member
      and .candidate.runtimeImpersonatorServiceAccount == $runtime_impersonator_sa
      and .candidate.runtimeImpersonationRole == $runtime_impersonation_role
      and .candidate.runtimeImpersonationMember == $runtime_impersonation_member
      and .candidate.provisionStartedAt == $provision_started_at
      and .candidate.expiresAt == $expires_at
      and .candidate.teardownScriptSha256 == $teardown_sha
      and .candidate.secretReferences == {
        supabaseUrl: $supabase_url_secret,
        supabaseServiceRoleKey: $supabase_service_role_secret,
        stripeSecretKey: $stripe_secret_key_secret,
        stripeWebhookSecret: $stripe_webhook_secret,
        apiKeyHmacSecret: $api_key_hmac_secret,
        cronSecret: $cron_secret,
        geminiApiKey: $gemini_api_key_secret
      }
      and .candidate.immutableLedger == {
        backend: "gcs-if-generation-match-0-locked-retention",
        bucket: $immutable_ledger_bucket,
        projectId: "arkova1",
        requiresPerObjectRetention: true
      }
      and .topology.rigId == "RIG-R"
      and .topology.rigName == $rig_name
      and .topology.rigProfile == $rig_profile
      and .topology.tier == "T3"
      and .topology.requiredWorkerUptimeMin == 2880
      and .topology.requiredWallMin == $required_wall_min
      and .topology.gcpProjectId == "arkova1"
      and .topology.gcpRegion == "us-central1"
      and .topology.supabaseOrgId == "byhkazrpmivhcsuqjtva"
      and .topology.supabaseProjectName == "arkova-soak-s33-r"
      and .topology.supabaseRegion == "us-east-2"
      and .topology.supabasePostgresMajor == 17
      and .topology.cloudRunService == "arkova-worker-s33-r-staging"
      and .topology.runtimeServiceAccount == "s33-rig-r-runtime@arkova1.iam.gserviceaccount.com"
      and .topology.runtimeImpersonatorServiceAccount == $runtime_impersonator_sa
      and .topology.runtimeImpersonationRole == $runtime_impersonation_role
      and .topology.runtimeImpersonationMember == $runtime_impersonation_member
      and .topology.generatedSecretNames == ["supabase-url-s33-r-staging", "supabase-service-role-key-s33-r-staging"]
      and .topology.secretReferences == .candidate.secretReferences
      and .topology.immutableLedger == .candidate.immutableLedger
      and .topology.vertexEndpointId == $endpoint_id
      and .topology.vertexEndpoint == $endpoint
      and .topology.vertexEndpointDisplayName == $endpoint_display
      and .topology.vertexModel == $vertex_model
      and .topology.vertexModelVersion == $vertex_model_version
      and .topology.checkpointId == $checkpoint_id
      and .topology.deployedModelId == $deployed_model_id
      and .topology.deployedModelDisplayName == $deployed_model_display
      and .topology.deploymentResourcesMode == $deployment_resources_mode
      and .topology.minReplicaCount == $min_replica_count
      and .topology.maxReplicaCount == $max_replica_count
      and .topology.endpointIamRole == "roles/aiplatform.endpointUser"
      and .topology.endpointIamMember == $endpoint_iam_member
      and .topology.temporaryVertexEndpoint == true
      and .topology.chainMode == "mocked"
      and .topology.inProcessJobs == "disabled"
      and .topology.containedDatabaseQueues == ["ai-rollback", "chain-fault"]
      and .topology.managedSchedulerJobs == []
      and .topology.managedQueues == []
      and .topology.oidcIdentities == []
      and .execution.soakId == $soak_id
      and .execution.leaseId == $lease_id
      and .execution.ownerIdentity == "arkova.s33.operator.key-custodian.v1"
      and .execution.provisionStartedAt == $provision_started_at
      and .execution.expiresAt == $expires_at
      and .execution.hardStopAuthorityIdentity == "arkova.s33.approver.founder-cto.v1"
      and .execution.teardownOnOrAfterExpiry == true
      and .execution.teardownOnDriverFailure == true
      and .budget == {s33TotalCapUsd: 200}
      and .teardown.scriptPath == "scripts/staging/teardown-isolated-rig.sh"
      and .teardown.scriptSha256 == $teardown_sha
      and .teardown.orderedBoundaries == [
        "deployed-model", "vertex-endpoint", "cloud-run-service",
        "supabase-secret-pair", "supabase-project", "runtime-iam-service-account",
        "exclusive-lease"
      ]
      and .teardown.protectedV6Model == "projects/270018525501/locations/us-central1/models/6611494259700793344"
      and .teardown.deleteProtectedV6Model == false
      and .teardown.projectedMonthlyRecurringUsd == 0)
      | select(.)
      | $approval
    ' <<<"$verified_json" 2>/dev/null)"; then
    echo "ERROR: RIG-R verifier output failed the provisioner's exact binding schema." >&2
    exit 2
  fi
  RIG_R_PROVISION_APPROVAL_JSON="$verified_json"
  S33_COST_CAP_USD_JSON="200"
}

verify_g1_spend_approval_binding() {
  [[ $IS_G1_RIG -eq 1 ]] || return 0
  local expected_image_digest verified_json
  local control_url_ref control_role_ref tuned_url_ref tuned_role_ref
  local stripe_ref webhook_ref hmac_ref cron_ref gemini_ref
  expected_image_digest="$(image_digest_from_ref "$PINNED_IMAGE")"
  control_url_ref="${G1_CONTROL_SUPABASE_URL_SECRET}@1"
  control_role_ref="${G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET}@1"
  tuned_url_ref="${G1_TUNED_SUPABASE_URL_SECRET}@1"
  tuned_role_ref="${G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET}@1"
  stripe_ref="${STRIPE_SECRET_KEY_SECRET}@${SHARED_STRIPE_SECRET_VERSION}"
  webhook_ref="${STRIPE_WEBHOOK_SECRET_SECRET}@${SHARED_STRIPE_WEBHOOK_VERSION}"
  hmac_ref="${API_KEY_HMAC_SECRET_SECRET}@${SHARED_API_KEY_HMAC_VERSION}"
  cron_ref="${CRON_SECRET_SECRET}@${SHARED_CRON_SECRET_VERSION}"
  gemini_ref="${GEMINI_API_KEY_SECRET}@${GEMINI_API_KEY_SECRET_VERSION}"
  if [[ -z "$G1_SPEND_APPROVAL_ARTIFACT" ]]; then
    echo "ERROR: live RIG-G1 provision requires STAGING_G1_SPEND_APPROVAL_ARTIFACT" >&2
    echo "       pointing to a verified immutable founder/CTO approval envelope." >&2
    exit 2
  fi
  if [[ -z "$G1_TRUSTED_NODE_LAUNCHER" ]] && ! resolve_g1_trusted_node_launcher; then
    echo "ERROR: RIG-G1 approval verifier launcher is not trusted; approval remains unverified." >&2
    exit 2
  fi
  if ! verified_json="$(/usr/bin/env -i TZ=UTC \
    "$G1_TRUSTED_NODE_LAUNCHER" --no-addons --no-global-search-paths \
    "$RIG_G1_SPEND_APPROVAL_VERIFIER" \
    --artifact "$G1_SPEND_APPROVAL_ARTIFACT" \
    --expected-source-head "$DECLARED_SOURCE_HEAD" \
    --expected-image-digest "$expected_image_digest" \
    --expected-rig-name "$NAME" \
    --expected-rig-profile "$PROFILE" \
    --expected-soak-id "$SOAK_ID" \
    --expected-rig-id "$RIG_ID" \
    --expected-lease-id "$LEASE_ID" \
    --expected-corpus-digest "$G1_CORPUS_DIGEST" \
    --expected-endpoint-id "$RIG_G1_ENDPOINT_ID" \
    --expected-endpoint-resource "$GEMINI_TUNED_MODEL_VALUE" \
    --expected-endpoint-display-name "$RIG_G1_ENDPOINT_DISPLAY_NAME" \
    --expected-vertex-model-resource "$RIG_G1_CANDIDATE_MODEL_VERSION_RESOURCE" \
    --expected-checkpoint-id "$RIG_G1_CHECKPOINT_ID" \
    --expected-deployed-model-id "$RIG_G1_DEPLOYED_MODEL_ID" \
    --expected-deployed-model-display-name "$RIG_G1_DEPLOYED_MODEL_DISPLAY_NAME" \
    --expected-deployment-resources-mode "$RIG_G1_DEPLOYMENT_RESOURCES_MODE" \
    --expected-min-replica-count "$RIG_G1_MIN_REPLICA_COUNT" \
    --expected-max-replica-count "$RIG_G1_MAX_REPLICA_COUNT" \
    --expected-control-runtime-service-account "$G1_CONTROL_RUNTIME_SA" \
    --expected-tuned-runtime-service-account "$G1_TUNED_RUNTIME_SA" \
    --expected-control-service "$G1_CONTROL_SERVICE" \
    --expected-tuned-service "$G1_TUNED_SERVICE" \
    --expected-control-project-name "$G1_CONTROL_PROJECT_NAME" \
    --expected-tuned-project-name "$G1_TUNED_PROJECT_NAME" \
    --expected-control-supabase-url-secret-reference "$control_url_ref" \
    --expected-control-supabase-service-role-secret-reference "$control_role_ref" \
    --expected-tuned-supabase-url-secret-reference "$tuned_url_ref" \
    --expected-tuned-supabase-service-role-secret-reference "$tuned_role_ref" \
    --expected-control-run-id "$G1_CONTROL_RUN_ID" \
    --expected-tuned-run-id "$G1_TUNED_RUN_ID" \
    --expected-control-queue "$G1_CONTROL_QUEUE" \
    --expected-tuned-queue "$G1_TUNED_QUEUE" \
    --expected-paired-cadence-max-min "$G1_PAIRED_CADENCE_MIN" \
    --expected-stripe-secret-key-reference "$stripe_ref" \
    --expected-stripe-webhook-secret-reference "$webhook_ref" \
    --expected-api-key-hmac-secret-reference "$hmac_ref" \
    --expected-cron-secret-reference "$cron_ref" \
    --expected-gemini-api-key-secret-reference "$gemini_ref" \
    --expected-immutable-ledger-bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET")"; then
    echo "ERROR: RIG-G1 immutable spend approval verification failed; approval remains unverified." >&2
    exit 2
  fi
  if ! verified_json="$(jq -ce \
    --arg source_head "$DECLARED_SOURCE_HEAD" \
    --arg image_digest "$expected_image_digest" \
    --arg rig_name "$NAME" \
    --arg rig_profile "$PROFILE" \
    --arg soak_id "$SOAK_ID" \
    --arg rig_id "$RIG_ID" \
    --arg lease_id "$LEASE_ID" \
    --arg corpus_digest "$G1_CORPUS_DIGEST" \
    --arg endpoint_id "$RIG_G1_ENDPOINT_ID" \
    --arg endpoint_resource "$GEMINI_TUNED_MODEL_VALUE" \
    --arg endpoint_display_name "$RIG_G1_ENDPOINT_DISPLAY_NAME" \
    --arg vertex_model_resource "$RIG_G1_CANDIDATE_MODEL_VERSION_RESOURCE" \
    --arg checkpoint_id "$RIG_G1_CHECKPOINT_ID" \
    --arg deployed_model_id "$RIG_G1_DEPLOYED_MODEL_ID" \
    --arg deployed_model_display_name "$RIG_G1_DEPLOYED_MODEL_DISPLAY_NAME" \
    --arg deployment_resources_mode "$RIG_G1_DEPLOYMENT_RESOURCES_MODE" \
    --arg control_runtime_service_account "$G1_CONTROL_RUNTIME_SA" \
    --arg tuned_runtime_service_account "$G1_TUNED_RUNTIME_SA" \
    --arg control_service "$G1_CONTROL_SERVICE" \
    --arg tuned_service "$G1_TUNED_SERVICE" \
    --arg control_project_name "$G1_CONTROL_PROJECT_NAME" \
    --arg tuned_project_name "$G1_TUNED_PROJECT_NAME" \
    --arg control_supabase_url_secret "$control_url_ref" \
    --arg control_supabase_service_role_secret "$control_role_ref" \
    --arg tuned_supabase_url_secret "$tuned_url_ref" \
    --arg tuned_supabase_service_role_secret "$tuned_role_ref" \
    --arg control_run_id "$G1_CONTROL_RUN_ID" \
    --arg tuned_run_id "$G1_TUNED_RUN_ID" \
    --arg control_queue "$G1_CONTROL_QUEUE" \
    --arg tuned_queue "$G1_TUNED_QUEUE" \
    --arg stripe_secret_key_secret "$stripe_ref" \
    --arg stripe_webhook_secret "$webhook_ref" \
    --arg api_key_hmac_secret "$hmac_ref" \
    --arg cron_secret "$cron_ref" \
    --arg gemini_api_key_secret "$gemini_ref" \
    --arg immutable_ledger_bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
    --argjson paired_cadence_max_min "$G1_PAIRED_CADENCE_MIN" \
    --argjson min_replica_count "$RIG_G1_MIN_REPLICA_COUNT" \
    --argjson max_replica_count "$RIG_G1_MAX_REPLICA_COUNT" '
      . as $approval
      | (type == "object"
      and ((keys | sort) == ([
        "approvalId", "approvalVerifiedAt", "approverIdentity", "approverRole",
        "authorityActivatedAtUtc", "authorityRosterRootSha256",
        "candidateImageDigest", "candidateSourceHeadSha",
        "canonicalSha256", "expiresAt", "g1VariableComputeModelCapUsd",
        "immutableRevisionId", "isolatedSupabaseProjectCount",
        "isolatedSupabaseProjectMonthlyEachUsd", "isolatedSupabaseProjectsMonthlyTotalUsd",
        "ownerIdentity", "raci", "runtimeVerifiedAt", "s33TotalCapUsd", "scope",
        "sourceReference", "status", "trustRootKeyFingerprint", "trustRootKeyId",
        "verificationMethod", "verifierIdentity"
      ] | sort))
      and .status == "VERIFIED"
      and (.approvalId | test("^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$"))
      and (.sourceReference | type == "string" and length > 0)
      and (.immutableRevisionId | type == "string" and length > 0)
      and (.canonicalSha256 | test("^sha256:[0-9a-f]{64}$"))
      and (.approverIdentity | type == "string" and length > 0)
      and (.approverRole == "founder" or .approverRole == "cto")
      and .approverIdentity == "arkova.s33.approver.founder-cto.v1"
      and .authorityRosterRootSha256 == "sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f"
      and .authorityActivatedAtUtc == "2026-07-16T13:52:06Z"
      and .candidateSourceHeadSha == $source_head
      and .candidateImageDigest == $image_digest
      and (.scope | type == "object")
      and ((.scope | keys | sort) == ([
        "controlQueue", "controlRunId", "controlRuntimeServiceAccount", "controlService", "corpusDigest",
        "controlProjectName", "controlSupabaseServiceRoleSecret", "controlSupabaseUrlSecret",
        "checkpointId", "deployedModelDisplayName", "deployedModelId", "deploymentResourcesMode", "endpointDisplayName", "endpointId", "endpointResource",
        "immutableLedger", "leaseId", "maxReplicaCount", "minReplicaCount", "pairedCadenceMaxMin",
        "rigClass", "rigId", "rigName", "rigProfile",
        "secretReferences", "soakId", "tunedProjectName", "tunedQueue", "tunedRunId",
        "tunedRuntimeServiceAccount", "tunedService", "tunedSupabaseServiceRoleSecret", "tunedSupabaseUrlSecret",
        "vertexModelResource"
      ] | sort))
      and .scope.rigClass == "RIG-G1"
      and .scope.rigName == $rig_name
      and .scope.rigProfile == $rig_profile
      and .scope.soakId == $soak_id
      and .scope.rigId == $rig_id
      and .scope.leaseId == $lease_id
      and .scope.corpusDigest == $corpus_digest
      and .scope.endpointId == $endpoint_id
      and .scope.endpointResource == $endpoint_resource
      and .scope.endpointDisplayName == $endpoint_display_name
      and .scope.vertexModelResource == $vertex_model_resource
      and .scope.checkpointId == $checkpoint_id
      and .scope.deployedModelId == $deployed_model_id
      and .scope.deployedModelDisplayName == $deployed_model_display_name
      and .scope.deploymentResourcesMode == $deployment_resources_mode
      and .scope.minReplicaCount == $min_replica_count
      and .scope.maxReplicaCount == $max_replica_count
      and .scope.controlRuntimeServiceAccount == $control_runtime_service_account
      and .scope.tunedRuntimeServiceAccount == $tuned_runtime_service_account
      and .scope.controlService == $control_service
      and .scope.tunedService == $tuned_service
      and .scope.controlProjectName == $control_project_name
      and .scope.tunedProjectName == $tuned_project_name
      and .scope.controlSupabaseUrlSecret == $control_supabase_url_secret
      and .scope.controlSupabaseServiceRoleSecret == $control_supabase_service_role_secret
      and .scope.tunedSupabaseUrlSecret == $tuned_supabase_url_secret
      and .scope.tunedSupabaseServiceRoleSecret == $tuned_supabase_service_role_secret
      and .scope.controlRunId == $control_run_id
      and .scope.tunedRunId == $tuned_run_id
      and .scope.controlQueue == $control_queue
      and .scope.tunedQueue == $tuned_queue
      and .scope.pairedCadenceMaxMin == $paired_cadence_max_min
      and .scope.secretReferences == {
        stripeSecretKey: $stripe_secret_key_secret,
        stripeWebhookSecret: $stripe_webhook_secret,
        apiKeyHmacSecret: $api_key_hmac_secret,
        cronSecret: $cron_secret,
        geminiApiKey: $gemini_api_key_secret
      }
      and .scope.immutableLedger == {
        backend: "gcs-if-generation-match-0-locked-retention",
        bucket: $immutable_ledger_bucket,
        projectId: "arkova1",
        requiresPerObjectRetention: true
      }
      and .isolatedSupabaseProjectCount == 4
      and .isolatedSupabaseProjectMonthlyEachUsd == 10
      and .isolatedSupabaseProjectsMonthlyTotalUsd == 40
      and (.g1VariableComputeModelCapUsd | type == "number" and floor == . and . > 0 and . <= 170)
      and .s33TotalCapUsd == 200
      and (.ownerIdentity | type == "string" and length > 0)
      and (.expiresAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
      and (.raci | type == "object")
      and ((.raci | keys | sort) == ([
        "accountableIdentity", "consultedIdentities", "informedIdentities", "responsibleIdentity"
      ] | sort))
      and .raci.responsibleIdentity == .ownerIdentity
      and .raci.accountableIdentity == .approverIdentity
      and (.raci.consultedIdentities | type == "array" and length > 0)
      and (.raci.informedIdentities | type == "array" and length > 0)
      and (.approvalVerifiedAt | type == "string")
      and (.runtimeVerifiedAt | type == "string")
      and .verifierIdentity == "arkova.s33.verifier.public-ed25519.v1"
      and .verificationMethod == "ed25519-pinned-authority-roster"
      and .trustRootKeyId == "arkova.s33.g1-spend.ed25519.v1"
      and .trustRootKeyFingerprint == "6ece5cea2d35423aab35a23f6292fd769c6d839ac03ba7860a973d4febd5d987") # gitleaks:allow -- public Ed25519 fingerprint
      | select(.)
      | $approval
    ' <<<"$verified_json" 2>/dev/null)"; then
    echo "ERROR: RIG-G1 approval verifier output failed the provisioner's exact binding schema." >&2
    exit 2
  fi

  G1_SPEND_APPROVAL_JSON="$verified_json"
  G1_OWNER="$(jq -r '.ownerIdentity' <<<"$verified_json")"
  G1_EXPIRES_AT="$(jq -r '.expiresAt' <<<"$verified_json")"
  G1_STOP_AUTHORITY="$(jq -r '.approverIdentity' <<<"$verified_json")"
  G1_TEARDOWN_OWNER="$(jq -r '.ownerIdentity' <<<"$verified_json")"
  G1_AUTHORITY_JSON="$(jq -nc \
    --arg approval_id "$(jq -r '.approvalId' <<<"$verified_json")" \
    --arg canonical_sha256 "$(jq -r '.canonicalSha256' <<<"$verified_json")" \
    --arg stop_authority "$G1_STOP_AUTHORITY" \
    --arg teardown_owner "$G1_TEARDOWN_OWNER" '
      {
        approval_id: $approval_id,
        canonical_sha256: $canonical_sha256,
        stop_authority: $stop_authority,
        teardown_owner: $teardown_owner
      }
    ')"
  G1_COMPUTE_MODEL_CAP_USD_JSON="$(jq -r '.g1VariableComputeModelCapUsd' <<<"$verified_json")"
  S33_COST_CAP_USD_JSON="$(jq -r '.s33TotalCapUsd' <<<"$verified_json")"
}

verify_immutable_authority_ledger_capability() {
  if [[ $IS_G1_RIG -ne 1 && $IS_RIG_R -ne 1 && "$RIG_ID" != "RIG-B1" ]]; then
    return 0
  fi
  local bucket_uri bucket_metadata
  bucket_uri="gs://${IMMUTABLE_AUTHORITY_LEDGER_BUCKET}"
  if ! bucket_metadata="$(gcloud storage buckets describe "$bucket_uri" \
    --project="$APPROVED_GCP_PROJECT" \
    --raw \
    --format=json)"; then
    echo "ERROR: immutable authority ledger bucket is absent or cannot be observed." >&2
    echo "       Required exact bucket contract: $bucket_uri in project $APPROVED_GCP_PROJECT with per-object retention enabled at creation." >&2
    exit 2
  fi
  if ! bucket_metadata="$(jq -ce \
    --arg bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
    --arg project_number "$IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER" '
      select(
        type == "object"
        and .name == $bucket
        and (.projectNumber | tostring) == $project_number
        and (.objectRetention | type == "object")
        and .objectRetention.mode == "Enabled"
      )
    ' <<<"$bucket_metadata" 2>/dev/null)"; then
    echo "ERROR: immutable authority ledger bucket capability is invalid." >&2
    echo "       Required exact contract: gs://${IMMUTABLE_AUTHORITY_LEDGER_BUCKET} must belong to project number ${IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER} and report objectRetention.mode=Enabled." >&2
    echo "       No bucket creation or irreversible per-object-retention mutation is attempted by this provisioner." >&2
    exit 2
  fi
  IMMUTABLE_LEDGER_CAPABILITY_JSON="$(jq -nc \
    --arg backend "$IMMUTABLE_AUTHORITY_LEDGER_BACKEND" \
    --arg bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
    --arg project_id "$APPROVED_GCP_PROJECT" \
    --arg project_number "$IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER" '
      {
        backend: $backend,
        bucket: $bucket,
        project_id: $project_id,
        project_number: $project_number,
        per_object_retention_verified: true
      }
    ')"
}

claim_b1_node_approval_once() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local object_name object_uri claim_payload claim_temp observed_json
  object_name="${RIG_B1_APPROVAL_LEDGER_PREFIX}/${RIG_B1_APPROVAL_ID}.json"
  object_uri="gs://${IMMUTABLE_AUTHORITY_LEDGER_BUCKET}/${object_name}"
  claim_payload="$(jq -nc \
    --arg approval_id "$RIG_B1_APPROVAL_ID" \
    --arg envelope_sha "$RIG_B1_APPROVAL_ENVELOPE_SHA256" \
    --arg payload_sha "$RIG_B1_APPROVAL_PAYLOAD_SHA256" \
    --arg source_head "$DECLARED_SOURCE_HEAD" \
    --arg source_tree "$RIG_B1_CANDIDATE_TREE_SHA" \
    --arg corpus_digest "$RIG_B1_CORPUS_DIGEST" \
    --arg rc_id "$RIG_B1_RELEASE_CANDIDATE_ID" \
    --arg soak_id "$SOAK_ID" --arg lease_id "$LEASE_ID" \
    --arg claimed_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --argjson spend_cap_usd "$RIG_B1_SPEND_CAP_USD" '
      {
        schemaVersion: "arkova.s33.rig-b1.node-approval-claim/v1",
        approvalId: $approval_id,
        envelopeSha256: $envelope_sha,
        signedPayloadSha256: $payload_sha,
        sourceHeadSha: $source_head,
        sourceTreeSha: $source_tree,
        corpusDigest: $corpus_digest,
        releaseCandidateId: $rc_id,
        soakId: $soak_id,
        leaseId: $lease_id,
        spendCapUsd: $spend_cap_usd,
        claimedAt: $claimed_at
      }
    ')" || {
      echo "ERROR: RIG-B1 could not construct its immutable approval claim." >&2
      exit 2
    }
  umask 077
  claim_temp="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/arkova-b1-approval-claim.XXXXXX")"
  if ! printf '%s\n' "$claim_payload" >"$claim_temp"; then
    rm -f -- "$claim_temp"
    echo "ERROR: RIG-B1 could not stage its immutable approval claim." >&2
    exit 2
  fi
  if ! gcloud storage cp "$claim_temp" "$object_uri" \
    --project="$GCP_PROJECT" --if-generation-match=0 \
    --content-type=application/json \
    --retain-until="$RIG_B1_APPROVAL_EXPIRES_AT" --retention-mode=Locked --quiet; then
    rm -f -- "$claim_temp"
    echo "ERROR: RIG-B1 approval is already claimed; replay and concurrent spend are forbidden." >&2
    exit 2
  fi
  rm -f -- "$claim_temp"
  if ! observed_json="$(gcloud storage objects describe "$object_uri" \
    --project="$GCP_PROJECT" --raw --format=json)" \
    || ! jq -e --arg bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
      --arg name "$object_name" --arg expires_at "$RIG_B1_APPROVAL_EXPIRES_AT" '
        def utc_epoch:
          if type != "string"
            or (test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|\\+00:00)$") | not)
          then error("timestamp is not canonical UTC")
          else
            sub("\\+00:00$"; "Z")
            | sub("\\.[0-9]{1,9}Z$"; "Z")
            | fromdateiso8601
          end;
        type == "object"
        and .bucket == $bucket
        and .name == $name
        and (.generation | tostring | test("^[1-9][0-9]*$"))
        and (.retention | type == "object")
        and .retention.mode == "Locked"
        and (.retention.retainUntilTime | type == "string")
        and ((.retention.retainUntilTime | utc_epoch) >= ($expires_at | utc_epoch))
      ' >/dev/null 2>&1 <<<"$observed_json"; then
    echo "ERROR: RIG-B1 immutable approval claim could not be re-observed exactly." >&2
    exit 2
  fi
  RIG_B1_APPROVAL_CLAIM_JSON="$(jq -nc \
    --arg object_uri "$object_uri" \
    --arg generation "$(jq -r '.generation | tostring' <<<"$observed_json")" \
    --arg approval_id "$RIG_B1_APPROVAL_ID" \
    --arg envelope_sha "$RIG_B1_APPROVAL_ENVELOPE_SHA256" \
    --arg payload_sha "$RIG_B1_APPROVAL_PAYLOAD_SHA256" '
      {
        status: "CLAIMED",
        backend: "gcs-if-generation-match-0-locked-retention",
        object_uri: $object_uri,
        generation: $generation,
        approval_id: $approval_id,
        envelope_sha256: $envelope_sha,
        signed_payload_sha256: $payload_sha
      }
    ')"
  RIG_B1_APPROVAL_CLAIMED=1
}

claim_g1_spend_approval_once() {
  [[ $IS_G1_RIG -eq 1 ]] || return 0
  local approval_id canonical_sha claim_object_name claim_uri requested_at
  local claim_payload claim_temp observed_json observed_generation observed_created_at
  local observed_retention_until

  approval_id="$(jq -r '.approvalId' <<<"$G1_SPEND_APPROVAL_JSON")"
  canonical_sha="$(jq -r '.canonicalSha256' <<<"$G1_SPEND_APPROVAL_JSON")"
  if [[ ! "$approval_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$ \
    || ! "$canonical_sha" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: RIG-G1 verified approval is missing its claim-safe identity." >&2
    exit 2
  fi

  claim_object_name="${RIG_G1_APPROVAL_LEDGER_PREFIX}/${approval_id}.json"
  claim_uri="gs://${RIG_G1_APPROVAL_LEDGER_BUCKET}/${claim_object_name}"
  requested_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if ! claim_payload="$(jq -nc \
    --arg approval_id "$approval_id" \
    --arg canonical_sha256 "$canonical_sha" \
    --arg requested_at "$requested_at" \
    --arg source_head "$DECLARED_SOURCE_HEAD" \
    --arg image_digest "$(image_digest_from_ref "$PINNED_IMAGE")" \
    --argjson scope "$(jq -c '.scope' <<<"$G1_SPEND_APPROVAL_JSON")" '
      {
        schemaVersion: 1,
        approvalId: $approval_id,
        canonicalSha256: $canonical_sha256,
        requestedAt: $requested_at,
        candidate: {
          sourceHeadSha: $source_head,
          imageDigest: $image_digest
        },
        scope: $scope
      }
    ')"; then
    echo "ERROR: RIG-G1 could not construct its immutable approval claim." >&2
    exit 2
  fi

  if [[ ! -x /usr/bin/mktemp ]]; then
    echo "ERROR: RIG-G1 approval claim requires trusted /usr/bin/mktemp." >&2
    exit 2
  fi
  umask 077
  claim_temp="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/arkova-g1-approval-claim.XXXXXX")"
  if ! printf '%s\n' "$claim_payload" >"$claim_temp"; then
    rm -f -- "$claim_temp"
    echo "ERROR: RIG-G1 could not stage its immutable approval claim." >&2
    exit 2
  fi

  # Object generation zero is a server-side compare-and-create: exactly one
  # concurrent claimant can win. Locked retention preserves that winner until
  # the signed approval TTL, after which the signature is no longer valid.
  if ! gcloud storage cp "$claim_temp" "$claim_uri" \
    --project="$APPROVED_GCP_PROJECT" \
    --if-generation-match=0 \
    --content-type=application/json \
    --retain-until="$G1_EXPIRES_AT" \
    --retention-mode=Locked \
    --quiet; then
    rm -f -- "$claim_temp"
    echo "ERROR: RIG-G1 approval '$approval_id' is already claimed, or the durable claim ledger is unavailable." >&2
    echo "       Refusing every paid Supabase create and Cloud Run deploy." >&2
    exit 2
  fi
  rm -f -- "$claim_temp"

  if ! observed_json="$(gcloud storage objects describe "$claim_uri" \
    --project="$APPROVED_GCP_PROJECT" \
    --raw \
    --format=json)"; then
    echo "ERROR: RIG-G1 approval claim was submitted but cannot be re-observed; spend remains blocked." >&2
    exit 2
  fi
  if ! observed_json="$(jq -ce \
    --arg bucket "$RIG_G1_APPROVAL_LEDGER_BUCKET" \
    --arg name "$claim_object_name" \
    --arg expires_at "$G1_EXPIRES_AT" '
      def utc_epoch:
        if type != "string"
          or (test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|\\+00:00)$") | not)
        then error("timestamp is not canonical UTC")
        else
          sub("\\+00:00$"; "Z")
          | sub("\\.[0-9]{1,9}Z$"; "Z")
          | fromdateiso8601
        end;
      select(
        type == "object"
        and .bucket == $bucket
        and .name == $name
        and (.generation | tostring | test("^[1-9][0-9]*$"))
        and (.timeCreated | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
        and (.retention | type == "object")
        and .retention.mode == "Locked"
        and (.retention.retainUntilTime | type == "string")
        and ((.retention.retainUntilTime | utc_epoch) >= ($expires_at | utc_epoch))
      )
    ' <<<"$observed_json" 2>/dev/null)"; then
    echo "ERROR: RIG-G1 approval claim metadata did not re-bind to the exact immutable ledger object." >&2
    exit 2
  fi
  observed_generation="$(jq -r '.generation | tostring' <<<"$observed_json")"
  observed_created_at="$(jq -r '.timeCreated' <<<"$observed_json")"
  observed_retention_until="$(jq -r '.retention.retainUntilTime' <<<"$observed_json")"
  G1_APPROVAL_CLAIM_JSON="$(jq -nc \
    --arg approval_id "$approval_id" \
    --arg canonical_sha256 "$canonical_sha" \
    --arg object_uri "$claim_uri" \
    --arg generation "$observed_generation" \
    --arg claimed_at "$observed_created_at" \
    --arg retention_until "$observed_retention_until" \
    --argjson scope "$(jq -c '.scope' <<<"$G1_SPEND_APPROVAL_JSON")" '
      {
        status: "CLAIMED",
        backend: "gcs-if-generation-match-0-locked-retention",
        approval_id: $approval_id,
        canonical_sha256: $canonical_sha256,
        object_uri: $object_uri,
        generation: $generation,
        claimed_at: $claimed_at,
        retention_until: $retention_until,
        scope: $scope
      }
    ')"
}

claim_rig_r_provision_approval_once() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local approval_id canonical_sha claim_object_name claim_uri requested_at
  local claim_payload claim_temp observed_json observed_generation observed_created_at
  local observed_retention_until
  approval_id="$(jq -r '.approvalId' <<<"$RIG_R_PROVISION_APPROVAL_JSON")"
  canonical_sha="$(jq -r '.canonicalSha256' <<<"$RIG_R_PROVISION_APPROVAL_JSON")"
  if [[ ! "$approval_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$ \
    || "$canonical_sha" != "$RIG_R_PROVISION_ARTIFACT_SHA256" ]]; then
    echo "ERROR: RIG-R verified approval is missing its claim-safe identity." >&2
    exit 2
  fi
  claim_object_name="${RIG_R_APPROVAL_LEDGER_PREFIX}/${approval_id}.json"
  claim_uri="gs://${RIG_R_APPROVAL_LEDGER_BUCKET}/${claim_object_name}"
  requested_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if ! claim_payload="$(jq -nc \
    --arg approval_id "$approval_id" \
    --arg canonical_sha256 "$canonical_sha" \
    --arg requested_at "$requested_at" \
    --arg expires_at "$RIG_R_EXPIRES_AT" \
    --argjson candidate "$(jq -c '.candidate' <<<"$RIG_R_PROVISION_APPROVAL_JSON")" '
      {
        schemaVersion: 1,
        approvalId: $approval_id,
        canonicalSha256: $canonical_sha256,
        requestedAt: $requested_at,
        expiresAt: $expires_at,
        candidate: $candidate
      }
    ')"; then
    echo "ERROR: RIG-R could not construct its immutable provision-approval claim." >&2
    exit 2
  fi
  if [[ ! -x /usr/bin/mktemp ]]; then
    echo "ERROR: RIG-R approval claim requires trusted /usr/bin/mktemp." >&2
    exit 2
  fi
  umask 077
  claim_temp="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/arkova-rig-r-approval-claim.XXXXXX")"
  if ! printf '%s\n' "$claim_payload" >"$claim_temp"; then
    /bin/rm -f -- "$claim_temp"
    echo "ERROR: RIG-R could not stage its immutable approval claim." >&2
    exit 2
  fi
  if ! gcloud storage cp "$claim_temp" "$claim_uri" \
    --project="$GCP_PROJECT" \
    --if-generation-match=0 \
    --content-type=application/json \
    --retain-until="$RIG_R_EXPIRES_AT" \
    --retention-mode=Locked \
    --quiet; then
    /bin/rm -f -- "$claim_temp"
    echo "ERROR: RIG-R provision approval '$approval_id' is already claimed, or its durable ledger is unavailable." >&2
    echo "       Refusing every paid Supabase create and Cloud Run deploy." >&2
    exit 2
  fi
  /bin/rm -f -- "$claim_temp"
  if ! observed_json="$(gcloud storage objects describe "$claim_uri" \
    --project="$GCP_PROJECT" --raw --format=json)"; then
    echo "ERROR: RIG-R approval claim cannot be re-observed; provisioning remains blocked." >&2
    exit 2
  fi
  if ! observed_json="$(jq -ce \
    --arg bucket "$RIG_R_APPROVAL_LEDGER_BUCKET" \
    --arg name "$claim_object_name" \
    --arg expires_at "$RIG_R_EXPIRES_AT" '
      def utc_epoch:
        if type != "string"
          or (test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|\\+00:00)$") | not)
        then error("timestamp is not canonical UTC")
        else
          sub("\\+00:00$"; "Z")
          | sub("\\.[0-9]{1,9}Z$"; "Z")
          | fromdateiso8601
        end;
      select(
        type == "object"
        and .bucket == $bucket
        and .name == $name
        and (.generation | tostring | test("^[1-9][0-9]*$"))
        and (.timeCreated | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
        and (.retention | type == "object")
        and .retention.mode == "Locked"
        and (.retention.retainUntilTime | type == "string")
        and ((.retention.retainUntilTime | utc_epoch) >= ($expires_at | utc_epoch))
      )
    ' <<<"$observed_json" 2>/dev/null)"; then
    echo "ERROR: RIG-R approval claim metadata did not re-bind to the immutable ledger object." >&2
    exit 2
  fi
  observed_generation="$(jq -r '.generation | tostring' <<<"$observed_json")"
  observed_created_at="$(jq -r '.timeCreated' <<<"$observed_json")"
  observed_retention_until="$(jq -r '.retention.retainUntilTime' <<<"$observed_json")"
  RIG_R_PROVISION_APPROVAL_CLAIM_JSON="$(jq -nc \
    --arg approval_id "$approval_id" \
    --arg canonical_sha256 "$canonical_sha" \
    --arg object_uri "$claim_uri" \
    --arg generation "$observed_generation" \
    --arg claimed_at "$observed_created_at" \
    --arg retention_until "$observed_retention_until" '
      {
        status: "CLAIMED",
        backend: "gcs-if-generation-match-0-locked-retention",
        approval_id: $approval_id,
        canonical_sha256: $canonical_sha256,
        object_uri: $object_uri,
        generation: $generation,
        claimed_at: $claimed_at,
        retention_until: $retention_until
      }
    ')"
  RIG_R_PROVISION_APPROVAL_CLAIMED=1
}

claim_rig_r_lease_once() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local lease_payload lease_temp observed_json
  lease_payload="$(jq -nc \
    --arg lease_id "$LEASE_ID" \
    --arg rig_id "$RIG_ID" \
    --arg rig_name "$NAME" \
    --arg profile "$PROFILE" \
    --arg candidate_head "$DECLARED_SOURCE_HEAD" \
    --arg candidate_tree "$RIG_R_CANDIDATE_TREE_SHA" \
    --arg image_digest "$(image_digest_from_ref "$PINNED_IMAGE")" \
    --arg endpoint "$RIG_R_VERTEX_ENDPOINT" \
    --arg vertex_model "$RIG_R_VERTEX_MODEL" \
    --arg deployed_model_id "$RIG_R_DEPLOYED_MODEL_ID" \
    --arg provision_artifact_sha256 "$RIG_R_PROVISION_ARTIFACT_SHA256" \
    --arg provision_started_at "$RIG_R_PROVISION_STARTED_AT" \
    --arg expires_at "$RIG_R_EXPIRES_AT" '
      {
        schemaVersion: "arkova.s33.rig-r.exclusive-lease/v1",
        leaseId: $lease_id,
        rigId: $rig_id,
        rigName: $rig_name,
        profile: $profile,
        candidateHeadSha: $candidate_head,
        candidateTreeSha: $candidate_tree,
        imageDigest: $image_digest,
        vertexEndpoint: $endpoint,
        vertexModel: $vertex_model,
        deployedModelId: $deployed_model_id,
        provisionArtifactSha256: $provision_artifact_sha256,
        provisionStartedAt: $provision_started_at,
        expiresAt: $expires_at
      }
    ')" || {
      echo "ERROR: RIG-R could not construct its exclusive lease claim." >&2
      exit 2
    }
  if [[ ! -x /usr/bin/mktemp ]]; then
    echo "ERROR: RIG-R lease claim requires trusted /usr/bin/mktemp." >&2
    exit 2
  fi
  umask 077
  lease_temp="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/arkova-rig-r-lease.XXXXXX")"
  if ! printf '%s\n' "$lease_payload" >"$lease_temp"; then
    rm -f -- "$lease_temp"
    echo "ERROR: RIG-R could not stage its exclusive lease claim." >&2
    exit 2
  fi
  if ! gcloud storage cp "$lease_temp" "$RIG_R_LEASE_URI" \
    --project="$GCP_PROJECT" \
    --if-generation-match=0 \
    --content-type=application/json \
    --quiet; then
    rm -f -- "$lease_temp"
    echo "ERROR: RIG-R exclusive lease '$LEASE_ID' is already held or its ledger is unavailable." >&2
    exit 2
  fi
  rm -f -- "$lease_temp"
  if ! observed_json="$(gcloud storage objects describe "$RIG_R_LEASE_URI" \
    --project="$GCP_PROJECT" --raw --format=json)" \
    || ! jq -e --arg bucket "$RIG_R_LEASE_BUCKET" --arg name "$RIG_R_LEASE_OBJECT_NAME" '
      type == "object"
      and .bucket == $bucket
      and .name == $name
      and (.generation | tostring | test("^[1-9][0-9]*$"))
    ' >/dev/null 2>&1 <<<"$observed_json"; then
    echo "ERROR: RIG-R exclusive lease could not be re-observed exactly." >&2
    exit 2
  fi
  RIG_R_LEASE_GENERATION="$(jq -r '.generation | tostring' <<<"$observed_json")"
  RIG_R_LEASE_CLAIMED=1
}

wait_for_rig_r_runtime_identity_visibility() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local identity_json observed_unique_id
  local max_attempts=30 interval_seconds=2 attempt
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    if identity_json="$(gcloud iam service-accounts describe "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json 2>/dev/null)" \
      && observed_unique_id="$(jq -er \
        --arg email "$RUNTIME_SA" \
        'select(.email == $email and ((.uniqueId | tostring) | test("^[1-9][0-9]*$"))) | (.uniqueId | tostring)' \
        <<<"$identity_json" 2>/dev/null)"; then
      RIG_R_RUNTIME_SA_UNIQUE_ID="$observed_unique_id"
      echo "# RIG-R runtime identity visible: email=$RUNTIME_SA unique_id=$RIG_R_RUNTIME_SA_UNIQUE_ID"
      return 0
    fi
    if [[ $attempt -lt $max_attempts ]]; then
      sleep "$interval_seconds"
    fi
  done
  echo "ERROR: RIG-R runtime service account did not become exactly visible within $((max_attempts * interval_seconds)) seconds; refusing project IAM binding." >&2
  return 1
}

assert_rig_r_frozen_operator_identity() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local observed_active
  if ! observed_active="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)')"; then
    echo "ERROR: RIG-R could not observe the active provisioning operator." >&2
    return 1
  fi
  if [[ "$observed_active" != "$RIG_R_OPERATOR_SA" ]]; then
    echo "ERROR: RIG-R active operator must be exactly '$RIG_R_OPERATOR_SA'; got '${observed_active:-<none-or-ambiguous>}'." >&2
    return 1
  fi
  echo "# RIG-R frozen operator visible: $observed_active"
}

grant_rig_r_runtime_impersonation() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local policy_json members_json
  assert_rig_r_frozen_operator_identity
  if ! gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
    --project="$GCP_PROJECT" \
    --member="$RIG_R_RUNTIME_IMPERSONATION_MEMBER" \
    --role="$RIG_R_RUNTIME_IMPERSONATION_ROLE" \
    --condition=None \
    --quiet; then
    echo "ERROR: RIG-R could not bind the exact operator to the temporary runtime identity." >&2
    return 1
  fi
  if ! policy_json="$(gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" \
    --project="$GCP_PROJECT" --format=json)"; then
    echo "ERROR: RIG-R could not read back temporary runtime impersonation IAM." >&2
    return 1
  fi
  if ! members_json="$(jq -cer \
    --arg role "$RIG_R_RUNTIME_IMPERSONATION_ROLE" \
    '[.bindings[]? | select(.role == $role) | .members[]?] | sort | unique' \
    <<<"$policy_json")" \
    || [[ "$members_json" != "[\"${RIG_R_RUNTIME_IMPERSONATION_MEMBER}\"]" ]]; then
    echo "ERROR: RIG-R runtime impersonation IAM is not the one exact authority-bound operator." >&2
    return 1
  fi
  echo "# RIG-R runtime impersonation visible: role=$RIG_R_RUNTIME_IMPERSONATION_ROLE member=$RIG_R_RUNTIME_IMPERSONATION_MEMBER"
}

grant_rig_r_runtime_project_role_with_propagation_retry() {
  local runtime_role="$1"
  local member="serviceAccount:${RUNTIME_SA}"
  local grant_output normalized_output policy_json member_count attempt=0
  local remaining_seconds sleep_seconds
  local propagation_hint='ERROR: Policy modification failed. For a binding with condition, run "gcloud alpha iam policies lint-condition" to identify issues in condition.'
  local propagation_error="ERROR: (gcloud.projects.add-iam-policy-binding) INVALID_ARGUMENT: Service account ${RUNTIME_SA} does not exist."
  local deadline_seconds=$((SECONDS + 300))
  while (( SECONDS < deadline_seconds )); do
    attempt=$((attempt + 1))
    if grant_output="$(gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
      --member="$member" \
      --role="$runtime_role" \
      --condition=None \
      --quiet 2>&1)"; then
      while (( SECONDS < deadline_seconds )); do
        if ! policy_json="$(gcloud projects get-iam-policy "$GCP_PROJECT" --format=json 2>&1)"; then
          echo "ERROR: RIG-R could not read project IAM after a successful runtime-role grant." >&2
          printf '%s\n' "$policy_json" >&2
          return 1
        fi
        if ! jq -e 'type == "object" and ((.bindings // []) | type == "array")' \
          <<<"$policy_json" >/dev/null 2>&1; then
          echo "ERROR: RIG-R project IAM readback was not a valid policy object." >&2
          return 1
        fi
        member_count="$(jq -r \
          --arg role "$runtime_role" \
          --arg member "$member" '
            [.bindings[]? | select(.role == $role) | .members[]? | select(. == $member)]
            | length
          ' <<<"$policy_json")"
        if [[ "$member_count" == "1" ]]; then
          echo "# RIG-R project IAM visible: role=$runtime_role member=$member grant_attempts=$attempt"
          return 0
        fi
        if [[ "$member_count" != "0" ]]; then
          echo "ERROR: RIG-R project IAM readback contained non-unique runtime-role membership." >&2
          return 1
        fi
        echo "# RIG-R project IAM grant succeeded; waiting for exact membership readback." >&2
        remaining_seconds=$((deadline_seconds - SECONDS))
        (( remaining_seconds > 0 )) || break
        sleep_seconds=$remaining_seconds
        (( sleep_seconds <= 5 )) || sleep_seconds=5
        sleep "$sleep_seconds"
      done
      break
    else
      normalized_output="${grant_output//$'\r'/}"
      if [[ "$normalized_output" != "$propagation_error" \
        && "$normalized_output" != "$propagation_hint"$'\n'"$propagation_error" ]]; then
        echo "ERROR: RIG-R runtime project-IAM grant failed with a non-propagation error; refusing retry." >&2
        printf '%s\n' "$grant_output" >&2
        return 1
      fi
      echo "# RIG-R project IAM is waiting for service-account propagation (attempt $attempt)." >&2
    fi
    remaining_seconds=$((deadline_seconds - SECONDS))
    (( remaining_seconds > 0 )) || break
    sleep_seconds=$remaining_seconds
    (( sleep_seconds <= 5 )) || sleep_seconds=5
    sleep "$sleep_seconds"
  done
  echo "ERROR: RIG-R runtime project-IAM grant/readback did not become exact within 300 seconds; refusing further provisioning." >&2
  return 1
}

release_owned_rig_r_lease() {
  [[ $RIG_R_LEASE_CLAIMED -eq 1 ]] || return 0
  local lease_payload
  if [[ ! "$RIG_R_LEASE_GENERATION" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: refusing to release RIG-R mutex without its observed generation." >&2
    return 1
  fi
  if ! lease_payload="$(gcloud storage cat "${RIG_R_LEASE_URI}#${RIG_R_LEASE_GENERATION}" \
    --project="$GCP_PROJECT" 2>/dev/null)" \
    || ! jq -e \
      --arg lease_id "$LEASE_ID" \
      --arg candidate_head "$DECLARED_SOURCE_HEAD" \
      --arg candidate_tree "$RIG_R_CANDIDATE_TREE_SHA" \
      --arg endpoint "$RIG_R_VERTEX_ENDPOINT" '
        type == "object"
        and .schemaVersion == "arkova.s33.rig-r.exclusive-lease/v1"
        and .leaseId == $lease_id
        and .rigId == "RIG-R"
        and .rigName == "s33-r"
        and .candidateHeadSha == $candidate_head
        and .candidateTreeSha == $candidate_tree
        and .vertexEndpoint == $endpoint
      ' >/dev/null 2>&1 <<<"$lease_payload"; then
    echo "ERROR: refusing to release a RIG-R mutex not owned by this exact invocation." >&2
    return 1
  fi
  if ! gcloud storage rm "${RIG_R_LEASE_URI}#${RIG_R_LEASE_GENERATION}" \
    --project="$GCP_PROJECT" \
    --if-generation-match="$RIG_R_LEASE_GENERATION"; then
    echo "ERROR: generation-bound RIG-R mutex release failed." >&2
    return 1
  fi
  RIG_R_LEASE_CLAIMED=0
  RIG_R_LEASE_GENERATION=""
}

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
  if [[ $IS_G1_RIG -eq 1 ]]; then
    # Wave 3 itself authorizes no rig or spend. This acknowledgement selects the
    # post-Wave-3 workflow only; spend authority is verified cryptographically
    # from the immutable approval record later in this pre-mutation section.
    if [[ "${CONFIRM_POST_W3_PROVISION:-}" != "RIG-G1" ]]; then
      echo "ERROR: live RIG-G1 provision requires CONFIRM_POST_W3_PROVISION=RIG-G1." >&2
      exit 2
    fi
  fi
  if [[ $IS_RIG_R -eq 1 && "${CONFIRM_POST_W3_PROVISION:-}" != "RIG-R" ]]; then
    echo "ERROR: live RIG-R provision requires CONFIRM_POST_W3_PROVISION=RIG-R." >&2
    exit 2
  fi
  if [[ $IS_RIG_R -eq 1 && -z "$RIG_R_PROVISION_APPROVAL_ARTIFACT" ]]; then
    echo "ERROR: live RIG-R provision requires STAGING_RIG_R_PROVISION_APPROVAL_ARTIFACT" >&2
    echo "       pointing to the immutable founder/CTO Ed25519 approval envelope." >&2
    exit 2
  fi
  if [[ $IS_G1_RIG -eq 1 ]]; then
    if [[ ${#G1_CONTROL_DB_PASSWORD} -lt 16 || ${#G1_TUNED_DB_PASSWORD} -lt 16 \
      || "$G1_CONTROL_DB_PASSWORD" == "$G1_TUNED_DB_PASSWORD" ]]; then
      echo "ERROR: live RIG-G1 requires distinct bounded STAGING_G1_A_SUPABASE_DB_PASSWORD and STAGING_G1_B_SUPABASE_DB_PASSWORD values." >&2
      echo "       The two physical project credentials remain in memory only and are never logged or persisted." >&2
      exit 2
    fi
  elif [[ -z "$SUPABASE_DB_PASSWORD" ]]; then
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
  PINNED_IMAGE_REPOSITORY="${PINNED_IMAGE%@sha256:*}"
  if [[ "$PINNED_IMAGE_REPOSITORY" != "$APPROVED_SOURCE_IMAGE_REPOSITORY" ]]; then
    echo "ERROR: live provision requires the exact approved source image repository" >&2
    echo "       '$APPROVED_SOURCE_IMAGE_REPOSITORY'; got '$PINNED_IMAGE_REPOSITORY'." >&2
    exit 2
  fi
  if [[ $SOURCE_HEAD_WAS_EXPLICIT -ne 1 || ! "$DECLARED_SOURCE_HEAD" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: live provision requires an explicit 40-char declared source HEAD via" >&2
    echo "       --source-head or STAGING_SOURCE_HEAD_SHA." >&2
    exit 2
  fi
  verify_checkout_inputs_match_declared_head
  if [[ -n "${GITHUB_SHA:-}" && "$DECLARED_SOURCE_HEAD" != "$GITHUB_SHA" ]]; then
    echo "ERROR: declared source HEAD mismatch: declared=$DECLARED_SOURCE_HEAD GITHUB_SHA=$GITHUB_SHA." >&2
    exit 2
  fi
  if [[ $IS_G1_RIG -eq 1 ]] && ! resolve_g1_trusted_node_launcher; then
    echo "ERROR: RIG-G1 approval verifier launcher is not trusted; approval remains unverified." >&2
    exit 2
  fi
  if [[ $IS_RIG_R -eq 1 ]] && ! resolve_rig_r_trusted_node_launcher; then
    echo "ERROR: RIG-R approval verifier launcher is not trusted." >&2
    exit 2
  fi
  if [[ "$SOAK_ID" == \<required-in-apply:* || ! "$SOAK_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
    echo "ERROR: live provision requires an explicit soak_id via --soak-id or STAGING_SOAK_ID" >&2
    echo "       (3-128 characters: letters, digits, dot, underscore, colon, or hyphen)." >&2
    exit 2
  fi
  if [[ "$RIG_ID" == \<required-in-apply:* || ! "$RIG_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$ ]]; then
    echo "ERROR: live provision requires an explicit rig_id via --rig-id or STAGING_RIG_ID" >&2
    echo "       (3-64 characters: letters, digits, dot, underscore, colon, or hyphen)." >&2
    exit 2
  fi
  if [[ "$LEASE_ID" == \<required-in-apply:* || ! "$LEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
    echo "ERROR: live provision requires an explicit lease_id via --lease-id or STAGING_LEASE_ID" >&2
    echo "       (3-128 characters: letters, digits, dot, underscore, colon, or hyphen)." >&2
    exit 2
  fi
  if [[ "$PROFILE" == "gemini" || "$PROFILE" == "gemini-release" || "$RIG_ID" == "RIG-B1" ]]; then
    if [[ ! "$APPROVED_GCP_PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
      echo "ERROR: live admission requires a valid approved GCP project identity; got '$APPROVED_GCP_PROJECT'." >&2
      exit 2
    fi
    if [[ "$GCP_PROJECT" != "$APPROVED_GCP_PROJECT" ]]; then
      echo "ERROR: live admission for profile='$PROFILE' rig_id='$RIG_ID' only supports approved GCP project" >&2
      echo "       '$APPROVED_GCP_PROJECT'; got '$GCP_PROJECT'." >&2
      exit 2
    fi
  fi
  if [[ "$PROFILE" == "gemini" || "$PROFILE" == "gemini-release" ]]; then
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
  if [[ ( "$PROFILE" == "gemini" || "$PROFILE" == "gemini-release" ) && "$GEMINI_V6_PROMPT_VALUE" != "true" ]]; then
    echo "ERROR: live gemini provision requires GEMINI_V6_PROMPT to be the exact activation value 'true'." >&2
    exit 2
  fi

  # A paid/live rig cannot truthfully identify as T0. Required worker uptime
  # keeps the canonical staging-evidence floor (T1=2h, T2=12h, T3=48h).
  case "$TIER" in
    T1) MIN_DURATION_MIN=120 ;;
    T2) MIN_DURATION_MIN=720 ;;
    T3) MIN_DURATION_MIN=2880 ;;
    *)
      echo "ERROR: live rig tier must be one of T1, T2, or T3; T0/unknown tiers cannot provision a soak rig." >&2
      exit 2
      ;;
  esac
  if [[ ! "$REQUIRED_UPTIME_MIN" =~ ^[1-9][0-9]*$ || ${#REQUIRED_UPTIME_MIN} -gt 16 ]]; then
    echo "ERROR: live $TIER required uptime must be a canonical positive integer >= ${MIN_DURATION_MIN} minutes; got '$REQUIRED_UPTIME_MIN'." >&2
    exit 2
  fi
  REQUIRED_UPTIME_MIN_VALUE=$((10#$REQUIRED_UPTIME_MIN))
  if (( REQUIRED_UPTIME_MIN_VALUE > 9007199254740991 || REQUIRED_UPTIME_MIN_VALUE < MIN_DURATION_MIN )); then
    echo "ERROR: live $TIER required uptime must be a safe integer >= ${MIN_DURATION_MIN} minutes; got '$REQUIRED_UPTIME_MIN'." >&2
    exit 2
  fi
  if [[ ! "$REQUIRED_WALL_MIN" =~ ^[1-9][0-9]*$ || ${#REQUIRED_WALL_MIN} -gt 16 ]]; then
    echo "ERROR: live required wall floor must be a canonical positive integer; got '$REQUIRED_WALL_MIN'." >&2
    exit 2
  fi
  REQUIRED_WALL_MIN_VALUE=$((10#$REQUIRED_WALL_MIN))
  if (( REQUIRED_WALL_MIN_VALUE > 9007199254740991 || REQUIRED_WALL_MIN_VALUE < REQUIRED_UPTIME_MIN_VALUE )); then
    echo "ERROR: live required wall floor must be a safe integer >= required uptime ($REQUIRED_UPTIME_MIN);" >&2
    echo "       got '$REQUIRED_WALL_MIN'." >&2
    exit 2
  fi
  DURATION_MIN="$REQUIRED_UPTIME_MIN"

  # RIG-B1 is the pre-declared signet broadcast/drain rig. Never let the
  # generic chain defaults silently turn it into a mainnet or under-floor run.
  if [[ "$RIG_ID" == "RIG-B1" ]]; then
    if [[ $BITCOIN_CORE_RPC_URL_SECRET_WAS_EXPLICIT -ne 1 \
      || $BITCOIN_CORE_RPC_AUTH_SECRET_WAS_EXPLICIT -ne 1 \
      || $TREASURY_WIF_SECRET_WAS_EXPLICIT -ne 1 \
      || $STRIPE_SECRET_KEY_SECRET_WAS_EXPLICIT -ne 1 \
      || $STRIPE_WEBHOOK_SECRET_SECRET_WAS_EXPLICIT -ne 1 \
      || $API_KEY_HMAC_SECRET_SECRET_WAS_EXPLICIT -ne 1 \
      || $CRON_SECRET_SECRET_WAS_EXPLICIT -ne 1 \
      || $RUNTIME_SA_WAS_EXPLICIT -ne 1 \
      || $CRON_OIDC_SA_WAS_EXPLICIT -ne 1 ]]; then
      echo "ERROR: RIG-B1 requires explicit per-rig secret names plus runtime and OIDC identities;" >&2
      echo "       shared/default provisioner identities are not accepted." >&2
      exit 2
    fi
    RIG_B1_SECRET_NAMES=(
      "$BITCOIN_CORE_RPC_URL_SECRET"
      "$BITCOIN_CORE_RPC_AUTH_SECRET"
      "$TREASURY_WIF_SECRET"
      "$STRIPE_SECRET_KEY_SECRET"
      "$STRIPE_WEBHOOK_SECRET_SECRET"
      "$API_KEY_HMAC_SECRET_SECRET"
      "$CRON_SECRET_SECRET"
    )
    RIG_B1_SEEN_SECRETS="|"
    for rig_secret_name in "${RIG_B1_SECRET_NAMES[@]}"; do
      if [[ ! "$rig_secret_name" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}$ \
        || "$rig_secret_name" != *rig-b1* ]]; then
        echo "ERROR: RIG-B1 secret '$rig_secret_name' is not an explicit per-rig Secret Manager identity." >&2
        exit 2
      fi
      case "$RIG_B1_SEEN_SECRETS" in
        *"|$rig_secret_name|"*)
          echo "ERROR: RIG-B1 per-rig Secret Manager identities must be unique." >&2
          exit 2
          ;;
      esac
      RIG_B1_SEEN_SECRETS="${RIG_B1_SEEN_SECRETS}${rig_secret_name}|"
    done
    if [[ ! "$RUNTIME_SA" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@${GCP_PROJECT}[.]iam[.]gserviceaccount[.]com$ \
      || "$RUNTIME_SA" != *rig-b1* ]]; then
      echo "ERROR: RIG-B1 runtime identity must be an explicit per-rig service account in '$GCP_PROJECT'." >&2
      exit 2
    fi
    if [[ ! "$CRON_OIDC_SA" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@${GCP_PROJECT}[.]iam[.]gserviceaccount[.]com$ \
      || "$CRON_OIDC_SA" != *rig-b1* || "$CRON_OIDC_SA" == "$RUNTIME_SA" ]]; then
      echo "ERROR: RIG-B1 Scheduler OIDC identity must be an explicit per-rig service account in '$GCP_PROJECT'." >&2
      exit 2
    fi
    if [[ "$SUPABASE_ORG" != "$RIG_B1_SUPABASE_ORG" ]]; then
      echo "ERROR: RIG-B1 requires exact Supabase org '$RIG_B1_SUPABASE_ORG'; got '$SUPABASE_ORG'." >&2
      exit 2
    fi
    if [[ "$PROFILE" != "chain" ]]; then
      echo "ERROR: RIG-B1 requires profile=chain; got '$PROFILE'." >&2
      exit 2
    fi
    if [[ "$BITCOIN_NETWORK_VALUE" != "signet" ]]; then
      echo "ERROR: RIG-B1 requires explicit BITCOIN_NETWORK=signet; got '$BITCOIN_NETWORK_VALUE'." >&2
      exit 2
    fi
    if [[ "$KMS_PROVIDER_VALUE" != "gcp" ]]; then
      echo "ERROR: RIG-B1 requires exact STAGING_KMS_PROVIDER=gcp; got '$KMS_PROVIDER_VALUE'." >&2
      exit 2
    fi
    if [[ "$BITCOIN_UTXO_PROVIDER_VALUE" != "rpc" ]]; then
      echo "ERROR: RIG-B1 requires exact STAGING_BITCOIN_UTXO_PROVIDER=rpc; got '$BITCOIN_UTXO_PROVIDER_VALUE'." >&2
      exit 2
    fi
    if [[ "$BITCOIN_CORE_RPC_URL_SECRET" != "arkova-s33-rig-b1-bitcoin-core-signet-rpc-url" \
      || "$BITCOIN_CORE_RPC_AUTH_SECRET" != "arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth" \
      || "$TREASURY_WIF_SECRET" != "arkova-s33-rig-b1-treasury-wif-signet" ]]; then
      echo "ERROR: RIG-B1 requires the exact Bitcoin-Core-signet URL/auth and worker-only WIF secret identities." >&2
      exit 2
    fi
    if [[ "$RIG_B1_BITCOIN_CORE_IMAGE" != "$RIG_B1_EXPECTED_BITCOIN_CORE_IMAGE" ]]; then
      echo "ERROR: RIG-B1 requires the exact reviewed Bitcoin Core image digest '$RIG_B1_EXPECTED_BITCOIN_CORE_IMAGE'; substitutions are forbidden." >&2
      exit 2
    fi
    if [[ -z "$RIG_B1_NODE_APPROVAL_ARTIFACT" \
      || ! "$RIG_B1_CORPUS_DIGEST" =~ ^sha256:[0-9a-f]{64}$ \
      || ! "$RIG_B1_RELEASE_CANDIDATE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$ \
      || ! "$RIG_B1_TREASURY_ADDRESS" =~ ^tb1[a-z0-9]{20,87}$ \
      || ! "$RIG_B1_TREASURY_DESCRIPTOR" =~ ^addr\(${RIG_B1_TREASURY_ADDRESS}\)#[a-z0-9]{8}$ \
      || "$RIG_B1_TREASURY_SPLIT_PLAN_DIGEST" != "sha256:ab70ac7cf0ef1b371258c86ee4d967fec199b156156fe214238440429df794d8" \
      || "$RIG_B1_TREASURY_EXPECTED_TOTAL_SATS" != "$RIG_B1_TREASURY_TOTAL_SATS" ]]; then
      echo "ERROR: RIG-B1 requires its signed approval plus exact corpus, RC, public descriptor, pre-split digest, and 169639-sat treasury total." >&2
      exit 2
    fi
    for rig_b1_secret_version in \
      "$RIG_B1_RPC_URL_SECRET_VERSION" \
      "$RIG_B1_RPC_AUTH_SECRET_VERSION" \
      "$RIG_B1_TREASURY_WIF_SECRET_VERSION" \
      "$RIG_B1_STRIPE_SECRET_KEY_VERSION" \
      "$RIG_B1_STRIPE_WEBHOOK_SECRET_VERSION" \
      "$RIG_B1_API_KEY_HMAC_SECRET_VERSION" \
      "$RIG_B1_CRON_SECRET_VERSION"; do
      if [[ ! "$rig_b1_secret_version" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: RIG-B1 requires exact numeric Secret Manager versions for every worker/node secret." >&2
        exit 2
      fi
    done
    if [[ "$FRONTEND_URL_VALUE" != "https://app.arkova.ai" ]]; then
      echo "ERROR: RIG-B1 requires exact STAGING_FRONTEND_URL=https://app.arkova.ai; got '$FRONTEND_URL_VALUE'." >&2
      exit 2
    fi
    if [[ "$TIER" != "T3" ]]; then
      echo "ERROR: RIG-B1 requires Tier T3; got '$TIER'." >&2
      exit 2
    fi
    if (( REQUIRED_UPTIME_MIN_VALUE != 2880 )); then
      echo "ERROR: RIG-B1 requires required worker uptime exactly 2880 minutes; got '$REQUIRED_UPTIME_MIN'." >&2
      exit 2
    fi
    if (( REQUIRED_WALL_MIN_VALUE < 2910 )); then
      echo "ERROR: RIG-B1 requires required wall floor >=2910 minutes; got '$REQUIRED_WALL_MIN'." >&2
      exit 2
    fi
  fi

  # Admission base provenance is derived from this exact checkout. Caller
  # metadata may repeat it, but cannot replace it with an arbitrary 40-hex
  # string or a different ancestor.
  REMOTE_MAIN_LINE="$(trusted_git -C / ls-remote --exit-code \
    "$TRUSTED_GIT_ORIGIN_URL" refs/heads/main 2>/dev/null || true)"
  read -r REMOTE_MAIN_SHA REMOTE_MAIN_REF <<<"$REMOTE_MAIN_LINE"
  if [[ ! "$REMOTE_MAIN_SHA" =~ ^[0-9a-f]{40}$ || "$REMOTE_MAIN_REF" != "refs/heads/main" ]]; then
    echo "ERROR: could not observe the code-bound remote main ref; refusing a potentially stale base SHA." >&2
    exit 2
  fi
  if [[ "$(trusted_git -C "$TRUSTED_REPO_ROOT" cat-file -t "${REMOTE_MAIN_SHA}^{commit}" 2>/dev/null || true)" != "commit" ]]; then
    echo "ERROR: code-bound remote main is not present in the local object store; refresh the checkout first." >&2
    exit 2
  fi
  EXPECTED_BASE_SHA="$(trusted_git -C "$TRUSTED_REPO_ROOT" merge-base \
    "$DECLARED_SOURCE_HEAD" "$REMOTE_MAIN_SHA" 2>/dev/null || true)"
  CANDIDATE_BASE_SHA="${BASE_SHA:-${GITHUB_BASE_SHA:-$EXPECTED_BASE_SHA}}"
  if [[ ! "$EXPECTED_BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: could not resolve the HEAD/remote-main merge-base for live admission." >&2
    exit 2
  fi
  if [[ ! "$CANDIDATE_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || [[ "$(trusted_git -C "$TRUSTED_REPO_ROOT" cat-file -t "${CANDIDATE_BASE_SHA}^{commit}" 2>/dev/null || true)" != "commit" ]] \
    || ! trusted_git -C "$TRUSTED_REPO_ROOT" merge-base --is-ancestor \
      "$CANDIDATE_BASE_SHA" "$DECLARED_SOURCE_HEAD" 2>/dev/null; then
    echo "ERROR: live admission BASE_SHA must be an existing 40-hex commit that is an ancestor of declared HEAD." >&2
    exit 2
  fi
  if [[ "$CANDIDATE_BASE_SHA" != "$EXPECTED_BASE_SHA" ]]; then
    echo "ERROR: live admission BASE_SHA must equal the HEAD/origin-main merge-base." >&2
    exit 2
  fi
  VALIDATED_BASE_SHA="$EXPECTED_BASE_SHA"
  if [[ "$RIG_ID" == "RIG-B1" ]]; then
    RIG_B1_CANDIDATE_TREE_SHA="$(trusted_git -C "$TRUSTED_REPO_ROOT" rev-parse \
      "${DECLARED_SOURCE_HEAD}^{tree}" 2>/dev/null || true)"
    if [[ ! "$RIG_B1_CANDIDATE_TREE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo "ERROR: RIG-B1 could not bind the exact candidate source tree." >&2
      exit 2
    fi
  fi
  if [[ $IS_RIG_R -eq 1 ]]; then
    OBSERVED_RIG_R_TREE_SHA="$(trusted_git -C "$TRUSTED_REPO_ROOT" rev-parse \
      "${DECLARED_SOURCE_HEAD}^{tree}" 2>/dev/null || true)"
    if [[ "$OBSERVED_RIG_R_TREE_SHA" != "$RIG_R_CANDIDATE_TREE_SHA" ]]; then
      echo "ERROR: RIG-R candidate tree binding differs from the exact declared source tree." >&2
      exit 2
    fi
    verify_rig_r_provision_approval_binding
  fi
  verify_source_head_image_digest
  verify_b1_node_approval_binding
  verify_b1_required_apis
  verify_g1_spend_approval_binding
  verify_immutable_authority_ledger_capability
  verify_temporary_rig_targets_absent
fi

# ---------------------------------------------------------------------------
# Build the profile-selected worker env/secret overlay.
#
# WORKER_ENV_VARS — comma-joined KEY=VALUE for --set-env-vars (non-secrets only:
#                   flags, model names, a public URL — never credentials).
# WORKER_SECRETS  — comma-joined KEY=secret-name:version for --set-secrets.
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
if [[ "$RIG_ID" == "RIG-B1" ]]; then
  # B1 execution is driven only by the six authenticated Cloud Scheduler jobs.
  # The collector re-observes this exact revision flag before counted start.
  BASE_ENV_VARS+=("DISABLE_ALL_IN_PROCESS_CRON=true")
fi

# Base secrets every rig gets: the NEW project's own Supabase creds PLUS the
# boot-critical Stripe / HMAC / cron secrets (config.ts fails closed without them
# in production, regardless of USE_MOCKS).
SUPABASE_SECRET_VERSION="latest"
STRIPE_SECRET_VERSION="latest"
STRIPE_WEBHOOK_VERSION="latest"
API_KEY_HMAC_VERSION="latest"
CRON_SECRET_VERSION="latest"
if [[ "$RIG_ID" == "RIG-B1" ]]; then
  SUPABASE_SECRET_VERSION="1"
  STRIPE_SECRET_VERSION="$RIG_B1_STRIPE_SECRET_KEY_VERSION"
  STRIPE_WEBHOOK_VERSION="$RIG_B1_STRIPE_WEBHOOK_SECRET_VERSION"
  API_KEY_HMAC_VERSION="$RIG_B1_API_KEY_HMAC_SECRET_VERSION"
  CRON_SECRET_VERSION="$RIG_B1_CRON_SECRET_VERSION"
elif [[ $IS_G1_RIG -eq 1 || $IS_RIG_R -eq 1 ]]; then
  SUPABASE_SECRET_VERSION="1"
  STRIPE_SECRET_VERSION="$SHARED_STRIPE_SECRET_VERSION"
  STRIPE_WEBHOOK_VERSION="$SHARED_STRIPE_WEBHOOK_VERSION"
  API_KEY_HMAC_VERSION="$SHARED_API_KEY_HMAC_VERSION"
  CRON_SECRET_VERSION="$SHARED_CRON_SECRET_VERSION"
fi
BASE_SECRETS=(
  "SUPABASE_URL=${SUPABASE_URL_SECRET_NAME}:${SUPABASE_SECRET_VERSION}"
  "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_SECRET_NAME}:${SUPABASE_SECRET_VERSION}"
  "STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY_SECRET}:${STRIPE_SECRET_VERSION}"
  "STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET_SECRET}:${STRIPE_WEBHOOK_VERSION}"
  "API_KEY_HMAC_SECRET=${API_KEY_HMAC_SECRET_SECRET}:${API_KEY_HMAC_VERSION}"
  "CRON_SECRET=${CRON_SECRET_SECRET}:${CRON_SECRET_VERSION}"
)

ENV_VARS=("${BASE_ENV_VARS[@]}")
SECRETS=("${BASE_SECRETS[@]}")
CLOUD_RUN_NETWORK_ARGS=()
if [[ "$RIG_ID" == "RIG-B1" ]]; then
  CLOUD_RUN_NETWORK_ARGS=(
    "--vpc-connector=${RIG_B1_NODE_VPC_CONNECTOR}"
    "--vpc-egress=private-ranges-only"
  )
fi
G1_CONTROL_ENV_VARS=()
G1_TUNED_ENV_VARS=()
USE_MOCKS_VALUE=""
ENABLE_PROD_NETWORK_ANCHORING_VALUE=""
ADMISSION_BITCOIN_NETWORK=""
ADMISSION_BITCOIN_UTXO_PROVIDER=""
ADMISSION_KMS_PROVIDER=""
ADMISSION_GEMINI_TUNED_MODEL=""
ADMISSION_GEMINI_V6_PROMPT=""
ADMISSION_GEMINI_TUNED_RESPONSE_SCHEMA="<unset>"
ADMISSION_NODE_ENV="production"
ADMISSION_ENABLE_AI_EXTRACTION=""
ADMISSION_ENABLE_VERTEX_AI=""
ADMISSION_DB_ENABLE_VERIFICATION_API=""
ADMISSION_DB_ENABLE_AI_EXTRACTION=""
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
    # Bitcoin Core Signet RPC. config.ts superRefine requires KMS_PROVIDER + a signer when
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
    if [[ "$RIG_ID" == "RIG-B1" ]]; then
      ENV_VARS+=("MEMPOOL_API_URL=${RIG_B1_MEMPOOL_SIGNET_API_URL}")
    fi
    SECRETS+=(
      "BITCOIN_RPC_URL=${BITCOIN_CORE_RPC_URL_SECRET}:${RIG_B1_RPC_URL_SECRET_VERSION:-latest}"
      "BITCOIN_RPC_AUTH=${BITCOIN_CORE_RPC_AUTH_SECRET}:${RIG_B1_RPC_AUTH_SECRET_VERSION:-latest}"
      "BITCOIN_TREASURY_WIF=${TREASURY_WIF_SECRET}:${RIG_B1_TREASURY_WIF_SECRET_VERSION:-latest}"
    )
    ;;
  gemini)
    # Real tuned model + prompt. Chain stays mocked (no Bitcoin exposure for an
    # AI-behavior soak). Tuned model + prompt are non-secret selectors; the key
    # is a secret.
    USE_MOCKS_VALUE="true"
    ENABLE_PROD_NETWORK_ANCHORING_VALUE="false"
    if [[ $IS_G1_RIG -eq 1 ]]; then
      # Both arms share the exact app image, database/corpus, JSON MIME behavior,
      # and collision-safe background flags. Only the declared model/prompt
      # selectors differ. Do not set GEMINI_TUNED_RESPONSE_SCHEMA on either arm.
      ENV_VARS+=(
        "USE_MOCKS=true"
        "ENABLE_PROD_NETWORK_ANCHORING=false"
        "GEMINI_MODEL=${RIG_G1_PUBLIC_MODEL}"
        "DISABLE_ALL_IN_PROCESS_CRON=true"
        "DISABLE_IN_PROCESS_ANCHOR_CRON=true"
        "ENABLE_QUEUE_REMINDERS=false"
        "ENABLE_RULES_ENGINE=false"
        "ENABLE_RULE_ACTION_DISPATCHER=false"
      )
      G1_CONTROL_ENV_VARS=("${ENV_VARS[@]}")
      G1_TUNED_ENV_VARS=(
        "${ENV_VARS[@]}"
        "GEMINI_TUNED_MODEL=${GEMINI_TUNED_MODEL_VALUE}"
        "GEMINI_V6_PROMPT=${GEMINI_V6_PROMPT_VALUE}"
      )
      # The backward-compatible top-level config describes the public/control
      # service; arm-specific values are recorded under admission.g1.arms.
      ADMISSION_GEMINI_TUNED_MODEL=""
      ADMISSION_GEMINI_V6_PROMPT=""
    else
      ADMISSION_GEMINI_TUNED_MODEL="$GEMINI_TUNED_MODEL_VALUE"
      ADMISSION_GEMINI_V6_PROMPT="$GEMINI_V6_PROMPT_VALUE"
      ENV_VARS+=(
        "USE_MOCKS=true"
        "ENABLE_PROD_NETWORK_ANCHORING=false"
        "GEMINI_TUNED_MODEL=${GEMINI_TUNED_MODEL_VALUE}"
        "GEMINI_V6_PROMPT=${GEMINI_V6_PROMPT_VALUE}"
      )
    fi
    SECRETS+=("GEMINI_API_KEY=${GEMINI_API_KEY_SECRET}:${GEMINI_API_KEY_SECRET_VERSION}")
    ;;
  gemini-release)
    # RIG-R invokes the release driver directly. It has no Cloud Scheduler,
    # managed queue, OIDC identity, or in-process cron execution. The two
    # logical evidence queues are rows contained by the isolated Supabase
    # project and disappear with that project at teardown.
    USE_MOCKS_VALUE="true"
    ENABLE_PROD_NETWORK_ANCHORING_VALUE="false"
    ADMISSION_GEMINI_TUNED_MODEL="$RIG_R_VERTEX_ENDPOINT"
    ADMISSION_GEMINI_V6_PROMPT="true"
    ENV_VARS+=(
      "USE_MOCKS=true"
      "ENABLE_PROD_NETWORK_ANCHORING=false"
      "ENABLE_AI_EXTRACTION=true"
      "ENABLE_VERTEX_AI=true"
      "GEMINI_TUNED_MODEL=${RIG_R_VERTEX_ENDPOINT}"
      "GEMINI_V6_PROMPT=true"
      "GEMINI_LITE_MODEL=gemini-2.5-flash"
      "DISABLE_ALL_IN_PROCESS_CRON=true"
      "DISABLE_IN_PROCESS_ANCHOR_CRON=true"
      "ENABLE_QUEUE_REMINDERS=false"
      "ENABLE_RULES_ENGINE=false"
      "ENABLE_RULE_ACTION_DISPATCHER=false"
    )
    SECRETS+=("GEMINI_API_KEY=${GEMINI_API_KEY_SECRET}:${GEMINI_API_KEY_SECRET_VERSION}")
    ;;
esac

EXPECTED_REVISION_SECRETS=("${SECRETS[@]}")

# Join arrays into the comma-delimited forms gcloud expects.
join_by_comma() {
  local IFS=','
  echo "$*"
}
WORKER_ENV_VARS="$(join_by_comma "${ENV_VARS[@]}")"
WORKER_SECRETS="$(join_by_comma "${SECRETS[@]}")"
G1_TUNED_WORKER_ENV_VARS=""
G1_CONTROL_WORKER_SECRETS=""
G1_TUNED_WORKER_SECRETS=""
if [[ $IS_G1_RIG -eq 1 ]]; then
  G1_TUNED_WORKER_ENV_VARS="$(join_by_comma "${G1_TUNED_ENV_VARS[@]}")"
  G1_CONTROL_SECRET_ENTRIES=()
  G1_TUNED_SECRET_ENTRIES=()
  for g1_secret_entry in "${SECRETS[@]}"; do
    case "$g1_secret_entry" in
      SUPABASE_URL=*)
        G1_CONTROL_SECRET_ENTRIES+=("SUPABASE_URL=${G1_CONTROL_SUPABASE_URL_SECRET}:${SUPABASE_SECRET_VERSION}")
        G1_TUNED_SECRET_ENTRIES+=("SUPABASE_URL=${G1_TUNED_SUPABASE_URL_SECRET}:${SUPABASE_SECRET_VERSION}")
        ;;
      SUPABASE_SERVICE_ROLE_KEY=*)
        G1_CONTROL_SECRET_ENTRIES+=("SUPABASE_SERVICE_ROLE_KEY=${G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET}:${SUPABASE_SECRET_VERSION}")
        G1_TUNED_SECRET_ENTRIES+=("SUPABASE_SERVICE_ROLE_KEY=${G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET}:${SUPABASE_SECRET_VERSION}")
        ;;
      *)
        G1_CONTROL_SECRET_ENTRIES+=("$g1_secret_entry")
        G1_TUNED_SECRET_ENTRIES+=("$g1_secret_entry")
        ;;
    esac
  done
  G1_CONTROL_WORKER_SECRETS="$(join_by_comma "${G1_CONTROL_SECRET_ENTRIES[@]}")"
  G1_TUNED_WORKER_SECRETS="$(join_by_comma "${G1_TUNED_SECRET_ENTRIES[@]}")"
fi

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
  if [[ $IS_G1_RIG -eq 1 ]]; then
    validate_gcloud_mapping_entries "tuned-arm environment" "${G1_TUNED_ENV_VARS[@]}"
    validate_gcloud_mapping_entries "control-arm secret" "${G1_CONTROL_SECRET_ENTRIES[@]}"
    validate_gcloud_mapping_entries "tuned-arm secret" "${G1_TUNED_SECRET_ENTRIES[@]}"
  fi
  validate_gcloud_mapping_entries "secret" "${SECRETS[@]}"
fi
STAGING_ADMISSION_DIR="${STAGING_ADMISSION_DIR:-docs/staging/${NAME}}"
PROVISION_STATE_PATH="${STAGING_ADMISSION_DIR%/}/isolated-rig-provision-${NAME}.json"
ADMISSION_ARTIFACT_PATH="${STAGING_ADMISSION_DIR%/}/isolated-rig-admission-${NAME}.json"
ADMISSION_TEMP_PATH="${ADMISSION_ARTIFACT_PATH}.tmp.$$"
NEW_PROJECT_REF="<captured-from-step-1>"
ADMISSION_ARTIFACT_PERSISTED=0
ADMISSION_FINALIZED=0
CREATED_PROJECT_REF=""
CREATED_CLOUD_RUN_SERVICE=0
CREATED_SUPABASE_SECRETS=0
CREATED_RUNTIME_SA=0
CREATED_G1_CONTROL_RUNTIME_SA=0
CREATED_G1_TUNED_RUNTIME_SA=0
CREATED_G1_VERTEX_ENDPOINT=0
CREATED_RIG_R_VERTEX_ENDPOINT=0
G1_CONTROL_RUNTIME_SA_UNIQUE_ID="<captured-rig-g1-a-runtime-unique-id>"
G1_TUNED_RUNTIME_SA_UNIQUE_ID="<captured-rig-g1-b-runtime-unique-id>"
G1_ENDPOINT_RESOURCE="$GEMINI_TUNED_MODEL_VALUE"
G1_OBSERVED_DEPLOYED_MODEL_ID=""
G1_PREDICT_PROBE_AT="<captured-preclock-authenticated-generateContent-probe>"
RIG_R_PREDICT_PROBE_AT="<captured-preclock-authenticated-generateContent-probe>"
EXPECTED_RUNTIME_SA_FOR_REVISION="$RUNTIME_SA"
PREFLIGHT_JSON=""
PREFLIGHT_ARTIFACT_PATH="${STAGING_ADMISSION_DIR%/}/clean-mirror-preflight-${NAME}.json"
G1_CONTROL_PREFLIGHT_ARTIFACT_PATH="${STAGING_ADMISSION_DIR%/}/clean-mirror-preflight-${NAME}-a.json"
G1_TUNED_PREFLIGHT_ARTIFACT_PATH="${STAGING_ADMISSION_DIR%/}/clean-mirror-preflight-${NAME}-b.json"
G1_CONTROL_CLEAN_MIRROR_ATTESTATION_ID="<captured-rig-g1-a-clean-mirror>"
G1_TUNED_CLEAN_MIRROR_ATTESTATION_ID="<captured-rig-g1-b-clean-mirror>"
G1_CONTROL_PREFLIGHT_VERIFIED_AT="<captured-rig-g1-a-clean-mirror-time>"
G1_TUNED_PREFLIGHT_VERIFIED_AT="<captured-rig-g1-b-clean-mirror-time>"
PREFLIGHT_VERIFIED_AT="<captured-after-clean_mirror>"
CLEAN_MIRROR_ATTESTATION_ID="<sha256-of-sanitized-clean_mirror-artifact>"
DEPLOYED_REVISION="<captured-after-deploy>"
DEPLOYED_IMAGE_REF="$PINNED_IMAGE"
case "$PINNED_IMAGE" in
  *@sha256:*) DEPLOYED_IMAGE_DIGEST="sha256:${PINNED_IMAGE##*@sha256:}" ;;
  *) DEPLOYED_IMAGE_DIGEST="<verified-after-deploy>" ;;
esac
DEPLOYED_SOURCE_HEAD="$DECLARED_SOURCE_HEAD"
G1_CONTROL_DEPLOYED_REVISION="<captured-after-public-control-deploy>"
G1_TUNED_DEPLOYED_REVISION="<captured-after-tuned-deploy>"
G1_CONTROL_TAG_URL="<captured-cloud-run-url-for-${G1_CONTROL_SERVICE:-public-control-arm}>"
G1_TUNED_TAG_URL="<captured-cloud-run-url-for-${G1_TUNED_SERVICE:-tuned-arm}>"
G1_CONTROL_DEPLOYED_AT="<captured-after-rig-g1-a-deploy>"
G1_TUNED_DEPLOYED_AT="<captured-after-rig-g1-b-deploy>"
G1_PAIRED_DEPLOY_DELTA_SECONDS="<verified-at-most-1800>"
if [[ $IS_G1_RIG -eq 1 ]]; then
  CLOUD_RUN_SERVICE_CANDIDATES_JSON="$(jq -nc \
    --arg control "$G1_CONTROL_SERVICE" \
    --arg tuned "$G1_TUNED_SERVICE" \
    '[$control, $tuned]')"
  CLOUD_RUN_DELETE_COMMANDS_JSON="$(jq -nc \
    --arg control "gcloud run services delete ${G1_CONTROL_SERVICE} --project=${GCP_PROJECT} --region=${CLOUD_RUN_REGION} --quiet" \
    --arg tuned "gcloud run services delete ${G1_TUNED_SERVICE} --project=${GCP_PROJECT} --region=${CLOUD_RUN_REGION} --quiet" \
    '[$control, $tuned]')"
else
  CLOUD_RUN_SERVICE_CANDIDATES_JSON="$(jq -nc --arg service "$CLOUD_RUN_SERVICE" '[$service]')"
  CLOUD_RUN_DELETE_COMMANDS_JSON="$(jq -nc \
    --arg command "gcloud run services delete ${CLOUD_RUN_SERVICE} --project=${GCP_PROJECT} --region=${CLOUD_RUN_REGION} --quiet" \
    '[$command]')"
fi
SCHEDULER_APPLICABLE_JSON=false
SCHEDULER_PAUSED_THROUGH_CLEAN_MIRROR_JSON=false
SCHEDULER_STATE="not_applicable"
SCHEDULER_CREATION_GUARD="not_applicable"
SCHEDULER_FAILURE_CONTAINMENT_ARMED=0

teardown_command_for_project_ref() {
  local project_ref="$1"
  if [[ $IS_G1_RIG -eq 1 ]]; then
    if [[ "$project_ref" == "$G1_TUNED_PROJECT_REF" ]]; then
      printf '%s\n' "scripts/staging/teardown-isolated-rig.sh --project-ref ${project_ref} --rig-name ${NAME}-b --rig-id RIG-G1-B --service ${G1_TUNED_SERVICE} --vertex-endpoint projects/arkova1/locations/us-central1/endpoints/${RIG_G1_ENDPOINT_ID} --vertex-model ${RIG_G1_CANDIDATE_MODEL_RESOURCE} --deployed-model-id ${RIG_G1_DEPLOYED_MODEL_ID} --runtime-sa ${G1_TUNED_RUNTIME_SA}"
    else
      printf '%s\n' "scripts/staging/teardown-isolated-rig.sh --project-ref ${project_ref} --rig-name ${NAME}-a --rig-id RIG-G1-A --service ${G1_CONTROL_SERVICE} --runtime-sa ${G1_CONTROL_RUNTIME_SA}"
    fi
  elif [[ $IS_RIG_R -eq 1 ]]; then
    printf '%s\n' "scripts/staging/teardown-isolated-rig.sh --project-ref ${project_ref} --rig-name ${NAME} --rig-id RIG-R --service ${CLOUD_RUN_SERVICE} --vertex-endpoint ${RIG_R_VERTEX_ENDPOINT} --vertex-model ${RIG_R_VERTEX_MODEL} --deployed-model-id ${RIG_R_DEPLOYED_MODEL_ID} --runtime-sa ${RUNTIME_SA} --lease-id ${LEASE_ID}"
  elif [[ "$RIG_ID" == "RIG-B1" ]]; then
    printf '%s\n' "scripts/staging/teardown-isolated-rig.sh --project-ref ${project_ref} --rig-name ${NAME} --rig-id RIG-B1 --service ${CLOUD_RUN_SERVICE} --b1-approval-artifact ${RIG_B1_NODE_APPROVAL_ARTIFACT}"
  else
    printf '%s\n' "scripts/staging/teardown-isolated-rig.sh --project-ref ${project_ref} --rig-name ${NAME} --service ${CLOUD_RUN_SERVICE}"
  fi
}

# Cloud Scheduler is required for non-mock profiles: node-cron does NOT fire on a
# throttled (min-instances=0) Cloud Run service, so the behavioral cron paths
# (batch-anchors, check-confirmations, classify-proof-backcatalog, …) never run
# without an external Scheduler POST. mock rigs have no behavioral cron to drive.
# Each spec is an internal, validated `<job-suffix><TAB><exact-request-path>`
# pair. Names and request paths are deliberately independent: forced flush is a
# distinct Scheduler job whose path carries `?force=true`, not a name==path
# guess. Bash 3.2 treats an expanded empty array as unset under `set -u`; retain
# one empty sentinel for mock admission JSON, filtered out by the encoder.
SCHEDULER_JOB_SPECS=("")
SCHEDULER_ACCELERATED_SCHEDULE="*/5 * * * *"
SCHEDULER_RETRY_MIN_BACKOFF="5s"
SCHEDULER_RETRY_MAX_BACKOFF="3600s"
SCHEDULER_RETRY_MAX_DOUBLINGS="5"
# create-http has no atomic --paused flag. Create against a syntactically valid
# non-firing hold schedule, pause + verify, then restore the pre-existing cadence
# while still paused after clean_mirror. This changes no job/matrix semantics.
SCHEDULER_HOLD_SCHEDULE="0 0 31 2 *"
if [[ $IS_MOCK_PROFILE -ne 1 && $IS_G1_RIG -ne 1 && $IS_RIG_R -ne 1 ]]; then
  SCHEDULER_APPLICABLE_JSON=true
  SCHEDULER_STATE="planned_paused_after_clean_mirror"
  SCHEDULER_CREATION_GUARD="non-firing hold schedule; create then immediate pause + PAUSED verification"
  case "$PROFILE" in
    chain)
      SCHEDULER_JOB_SPECS=(
        $'batch-anchors\t/jobs/batch-anchors'
        $'check-confirmations\t/jobs/check-confirmations'
        $'populate-confirmation-proofs\t/jobs/populate-confirmation-proofs'
        $'org-queue-scheduler\t/jobs/org-queue-scheduler'
      )
      if [[ "$RIG_ID" == "RIG-B1" ]]; then
        SCHEDULER_JOB_SPECS+=(
          $'batch-anchors-forced-flush\t/jobs/batch-anchors?force=true'
          $'recover-broadcasts\t/jobs/recover-broadcasts'
        )
      fi
      ;;
    gemini)
      SCHEDULER_JOB_SPECS=($'classify-proof-backcatalog\t/jobs/classify-proof-backcatalog')
      ;;
  esac
fi

scheduler_spec_suffix() { printf '%s\n' "${1%%$'\t'*}"; }
scheduler_spec_path() { printf '%s\n' "${1#*$'\t'}"; }
scheduler_job_name_for_spec() { printf '%s-%s\n' "$CLOUD_RUN_SERVICE" "$(scheduler_spec_suffix "$1")"; }
scheduler_spec_production_schedule() {
  case "$(scheduler_spec_suffix "$1")" in
    batch-anchors|check-confirmations) printf '%s\n' '*/30 * * * *' ;;
    populate-confirmation-proofs|recover-broadcasts|classify-proof-backcatalog)
      printf '%s\n' '*/15 * * * *'
      ;;
    org-queue-scheduler) printf '%s\n' '0 * * * *' ;;
    batch-anchors-forced-flush) printf '%s\n' '0 3 * * *' ;;
    *)
      echo "ERROR: Scheduler production cadence is undefined for spec '$1'." >&2
      exit 2
      ;;
  esac
}

scheduler_spec_time_zone() {
  case "$(scheduler_spec_suffix "$1")" in
    batch-anchors-forced-flush) printf '%s\n' 'America/New_York' ;;
    batch-anchors|check-confirmations|populate-confirmation-proofs|org-queue-scheduler|recover-broadcasts|classify-proof-backcatalog)
      printf '%s\n' 'Etc/UTC'
      ;;
    *)
      echo "ERROR: Scheduler timezone is undefined for spec '$1'." >&2
      exit 2
      ;;
  esac
}

scheduler_spec_attempt_deadline() {
  case "$(scheduler_spec_suffix "$1")" in
    batch-anchors|recover-broadcasts) printf '%s\n' '120s' ;;
    check-confirmations|populate-confirmation-proofs|classify-proof-backcatalog) printf '%s\n' '300s' ;;
    org-queue-scheduler|batch-anchors-forced-flush) printf '%s\n' '600s' ;;
    *)
      echo "ERROR: Scheduler attempt deadline is undefined for spec '$1'." >&2
      exit 2
      ;;
  esac
}

validate_scheduler_job_specs() {
  local spec suffix path seen_names="|" seen_paths="|"
  for spec in "${SCHEDULER_JOB_SPECS[@]}"; do
    [[ -z "$spec" ]] && continue
    if [[ "$spec" != *$'\t'* ]]; then
      echo "ERROR: internal Scheduler spec is missing its name/path delimiter." >&2
      exit 2
    fi
    suffix="$(scheduler_spec_suffix "$spec")"
    path="$(scheduler_spec_path "$spec")"
    if [[ ! "$suffix" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; then
      echo "ERROR: internal Scheduler job suffix is not canonical: '$suffix'." >&2
      exit 2
    fi
    if [[ ! "$path" =~ ^/jobs/[a-z0-9][a-z0-9-]*([?]force=true)?$ ]]; then
      echo "ERROR: internal Scheduler request path is not canonical: '$path'." >&2
      exit 2
    fi
    case "$seen_names" in
      *"|$suffix|"*) echo "ERROR: duplicate Scheduler job suffix '$suffix'." >&2; exit 2 ;;
    esac
    case "$seen_paths" in
      *"|$path|"*) echo "ERROR: duplicate Scheduler request path '$path'." >&2; exit 2 ;;
    esac
    scheduler_spec_production_schedule "$spec" >/dev/null
    scheduler_spec_time_zone "$spec" >/dev/null
    scheduler_spec_attempt_deadline "$spec" >/dev/null
    seen_names="${seen_names}${suffix}|"
    seen_paths="${seen_paths}${path}|"
  done
}

validate_rig_b1_scheduler_topology() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local expected=(
    $'batch-anchors\t/jobs/batch-anchors'
    $'check-confirmations\t/jobs/check-confirmations'
    $'populate-confirmation-proofs\t/jobs/populate-confirmation-proofs'
    $'org-queue-scheduler\t/jobs/org-queue-scheduler'
    $'batch-anchors-forced-flush\t/jobs/batch-anchors?force=true'
    $'recover-broadcasts\t/jobs/recover-broadcasts'
  )
  if [[ ${#SCHEDULER_JOB_SPECS[@]} -ne ${#expected[@]} ]]; then
    echo "ERROR: RIG-B1 requires the frozen exact six-job Scheduler topology." >&2
    exit 2
  fi
  local index
  for ((index = 0; index < ${#expected[@]}; index += 1)); do
    if [[ "${SCHEDULER_JOB_SPECS[$index]}" != "${expected[$index]}" ]]; then
      echo "ERROR: RIG-B1 Scheduler topology differs from its frozen exact six-job contract." >&2
      exit 2
    fi
  done
}

scheduler_jobs_json() {
  local jobs='[]' spec suffix path schedule time_zone attempt_deadline
  for spec in "${SCHEDULER_JOB_SPECS[@]}"; do
    [[ -z "$spec" ]] && continue
    suffix="$(scheduler_spec_suffix "$spec")"
    path="$(scheduler_spec_path "$spec")"
    if [[ "$RIG_ID" == "RIG-B1" ]]; then
      schedule="$SCHEDULER_ACCELERATED_SCHEDULE"
    else
      schedule="$(scheduler_spec_production_schedule "$spec")"
    fi
    time_zone="$(scheduler_spec_time_zone "$spec")"
    attempt_deadline="$(scheduler_spec_attempt_deadline "$spec")"
    jobs="$(jq -c \
      --arg name "${CLOUD_RUN_SERVICE}-${suffix}" \
      --arg path "$path" \
      --arg schedule "$schedule" \
      --arg time_zone "$time_zone" \
      --arg attempt_deadline "$attempt_deadline" \
      --arg min_backoff "$SCHEDULER_RETRY_MIN_BACKOFF" \
      --arg max_backoff "$SCHEDULER_RETRY_MAX_BACKOFF" \
      --argjson max_doublings "$SCHEDULER_RETRY_MAX_DOUBLINGS" \
      '. + [{
        name: $name,
        path: $path,
        schedule: $schedule,
        time_zone: $time_zone,
        attempt_deadline: $attempt_deadline,
        retry: {
          min_backoff: $min_backoff,
          max_backoff: $max_backoff,
          max_doublings: $max_doublings
        }
      }]' <<<"$jobs")"
  done
  printf '%s\n' "$jobs"
}

validate_scheduler_job_specs
validate_rig_b1_scheduler_topology

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

# Supabase 2.109 requires the exact newly-created database password on every
# link/push. Keep the value out of both the printable command and the execution
# log; only the child process receives it.
run_cmd_with_db_password() {
  local password_label="$1"
  local db_password="$2"
  shift 2
  print_cmd "$@" --password "<redacted:${password_label}>"
  if [[ $APPLY -eq 1 ]]; then
    if [[ -z "$db_password" ]]; then
      echo "ERROR: ${password_label} is empty; refusing an interactive/stale Supabase credential fallback." >&2
      exit 1
    fi
    echo "executing: $* --password <redacted:${password_label}>" >&2
    "$@" --password "$db_password"
  fi
}

# The pinned CLI's legacy `--output json` mode emits the raw created-project
# object. Return only its exact ref; never echo the response (it may grow
# secret-bearing fields).
create_supabase_project_ref() {
  local password_label="$1"
  local db_password="$2"
  local expected_name="$3"
  local response
  shift 3
  echo "executing: $* --db-password <redacted:${password_label}> --output json" >&2
  if ! response="$("$@" --db-password "$db_password" --output json 2>/dev/null)"; then
    echo "ERROR: Supabase project creation failed for ${expected_name}." >&2
    return 1
  fi
  jq -er --arg expected_name "$expected_name" '
    select(
      type == "object"
      and .name == $expected_name
      and (.id | type == "string" and test("^[a-z]{20}$"))
    )
    | .id
  ' <<<"$response" 2>/dev/null || {
    echo "ERROR: Supabase 2.109 legacy JSON create response did not match the strict project contract." >&2
    return 1
  }
}

supabase_db_hostname_resolves() {
  local project_ref="$1"
  local hostname="db.${project_ref}.supabase.co"
  local observed
  if command -v getent >/dev/null 2>&1; then
    getent ahosts "$hostname" >/dev/null 2>&1
    return
  fi
  if command -v dscacheutil >/dev/null 2>&1; then
    dscacheutil -q host -a name "$hostname" 2>/dev/null \
      | grep -Eq '^(ip_address|ipv6_address):'
    return
  fi
  if command -v dig >/dev/null 2>&1; then
    observed="$({ dig +time=2 +tries=1 +short A "$hostname"; \
      dig +time=2 +tries=1 +short AAAA "$hostname"; } 2>/dev/null || true)"
    [[ -n "$observed" ]]
    return
  fi
  return 1
}

supabase_db_tcp_accepts() {
  local project_ref="$1"
  local hostname="db.${project_ref}.supabase.co"
  command -v nc >/dev/null 2>&1 \
    && nc -z -w 5 "$hostname" 5432 >/dev/null 2>&1
}

wait_for_supabase_project_ready() {
  local project_ref="$1"
  local expected_name="$2"
  local timeout_seconds="$SUPABASE_PROJECT_READY_TIMEOUT_SECONDS"
  local poll_seconds="$SUPABASE_PROJECT_READY_POLL_SECONDS"
  local max_attempts attempt projects_json status="UNOBSERVED"
  if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]{0,3}$ \
    || ! "$poll_seconds" =~ ^[1-9][0-9]{0,2}$ \
    || $timeout_seconds -gt 900 \
    || $poll_seconds -gt 60 \
    || $poll_seconds -gt $timeout_seconds ]]; then
    echo "ERROR: Supabase readiness timeout/poll must be bounded positive seconds." >&2
    return 1
  fi
  max_attempts=$(((timeout_seconds + poll_seconds - 1) / poll_seconds))
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    status="UNOBSERVED"
    if projects_json="$(npx supabase projects list --output json 2>/dev/null)"; then
      status="$(jq -er --arg ref "$project_ref" --arg name "$expected_name" '
        select(type == "array")
        | [.[] | select(.id == $ref and .name == $name)] as $matches
        | select($matches | length == 1)
        | $matches[0].status
        | select(type == "string")
      ' <<<"$projects_json" 2>/dev/null || printf 'UNOBSERVED')"
    fi
    if [[ "$status" == "ACTIVE" || "$status" == "ACTIVE_HEALTHY" ]]; then
      if supabase_db_hostname_resolves "$project_ref"; then
        if supabase_db_tcp_accepts "$project_ref"; then
          echo "Supabase project '$expected_name' is ${status}; database DNS resolves and TCP 5432 accepts connections." >&2
          return 0
        fi
        status="${status}_TCP_5432_PENDING"
      else
        status="${status}_DNS_PENDING"
      fi
    fi
    if [[ $attempt -lt $max_attempts ]]; then
      /bin/sleep "$poll_seconds"
    fi
  done
  write_provision_state "REQUIRES_IMMEDIATE_TEARDOWN" \
    "Supabase readiness timed out after ${timeout_seconds}s for ${expected_name}/${project_ref}; last_status=${status}; no schema or deploy attempted" || true
  echo "ERROR: Supabase project '$expected_name' did not become ACTIVE with resolvable database DNS and accepting TCP 5432 within ${timeout_seconds}s (last_status=${status}); refusing link, schema push, and deploy." >&2
  return 1
}

# A newly ACTIVE_HEALTHY Supabase project can still be finishing its internal
# bootstrap. RIG-R gives that work one quiet barrier before the baseline push,
# then permits exactly one retry only when PostgreSQL selects our transaction
# as the SQLSTATE 40P01 deadlock victim. Every other failure remains terminal.
run_rig_r_schema_push_with_deadlock_retry() {
  [[ $IS_RIG_R -eq 1 ]] || {
    echo "ERROR: the bounded RIG-R schema-push recovery was called for another rig." >&2
    return 1
  }
  print_cmd /bin/sleep "$RIG_R_SCHEMA_QUIET_SECONDS"
  print_cmd npx supabase db push --linked --password '<redacted:STAGING_NEW_SUPABASE_DB_PASSWORD>'
  if [[ $APPLY -ne 1 ]]; then
    return 0
  fi
  echo "# RIG-R schema quiet barrier: ${RIG_R_SCHEMA_QUIET_SECONDS}s after ACTIVE_HEALTHY." >&2
  /bin/sleep "$RIG_R_SCHEMA_QUIET_SECONDS"

  local attempt output rc
  for attempt in 1 2; do
    echo "executing: npx supabase db push --linked --password <redacted:STAGING_NEW_SUPABASE_DB_PASSWORD> (attempt ${attempt}/2)" >&2
    if output="$(npx supabase db push --linked --password "$SUPABASE_DB_PASSWORD" 2>&1)"; then
      rc=0
    else
      rc=$?
    fi
    printf '%s\n' "$output"
    if [[ $rc -eq 0 ]]; then
      return 0
    fi
    if [[ $attempt -eq 1 && "$output" == *"SQLSTATE 40P01"* ]]; then
      echo "# RIG-R baseline push was the exact SQLSTATE 40P01 deadlock victim; consuming the sole retry." >&2
      continue
    fi
    return "$rc"
  done
  return 1
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

require_gcloud_secret_version() {
  local secret_name="$1"
  local secret_version="$2"
  local project_json project_number version_json expected_id_name expected_number_name
  if ! project_json="$(gcloud projects describe "$GCP_PROJECT" --format=json)" \
    || ! project_number="$(jq -er --arg expected_project "$GCP_PROJECT" '
      (.projectNumber | tostring) as $project_number
      | select(
          type == "object"
          and .projectId == $expected_project
          and ($project_number | test("^[1-9][0-9]{5,29}$"))
        )
      | $project_number
    ' <<<"$project_json" 2>/dev/null)"; then
    echo "ERROR: required Secret Manager project '$GCP_PROJECT' cannot be resolved to its exact numeric identity." >&2
    exit 1
  fi
  expected_id_name="projects/${GCP_PROJECT}/secrets/${secret_name}/versions/${secret_version}"
  expected_number_name="projects/${project_number}/secrets/${secret_name}/versions/${secret_version}"
  if ! version_json="$(gcloud secrets versions describe "$secret_version" \
    --secret="$secret_name" --project="$GCP_PROJECT" --format=json)" \
    || ! jq -e --arg expected_id "$expected_id_name" \
      --arg expected_number "$expected_number_name" \
      '.state == "ENABLED" and (.name == $expected_id or .name == $expected_number)' \
      >/dev/null 2>&1 <<<"$version_json"; then
    echo "ERROR: required numeric Secret Manager version '$secret_name/$secret_version' is missing, disabled, or not exact." >&2
    exit 1
  fi
}

verify_rig_b1_rpc_url_secret() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local rpc_url
  if ! rpc_url="$(gcloud secrets versions access "$RIG_B1_RPC_URL_SECRET_VERSION" \
    --secret="$BITCOIN_CORE_RPC_URL_SECRET" --project="$GCP_PROJECT")" \
    || [[ "$rpc_url" != "$RIG_B1_NODE_RPC_ENDPOINT" ]]; then
    unset rpc_url
    echo "ERROR: RIG-B1 numeric RPC URL secret must equal the exact private Bitcoin Core endpoint." >&2
    exit 1
  fi
  unset rpc_url
}

verify_rig_b1_rpc_auth_secret() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local rpc_auth rpc_user rpc_password
  if ! rpc_auth="$(gcloud secrets versions access "$RIG_B1_RPC_AUTH_SECRET_VERSION" \
    --secret="$BITCOIN_CORE_RPC_AUTH_SECRET" --project="$GCP_PROJECT")" \
    || [[ "$rpc_auth" != *:* || "${rpc_auth#*:}" == *:* ]]; then
    unset rpc_auth rpc_user rpc_password
    echo "ERROR: RIG-B1 numeric RPC auth secret must be one bounded username:password value." >&2
    exit 1
  fi
  rpc_user="${rpc_auth%%:*}"
  rpc_password="${rpc_auth#*:}"
  unset rpc_auth
  if [[ ! "$rpc_user" =~ ^[A-Za-z0-9._-]{1,64}$ \
    || ${#rpc_password} -lt 32 || ${#rpc_password} -gt 256 ]] \
    || printf '%s' "$rpc_password" | LC_ALL=C grep -q '[[:cntrl:][:space:]]'; then
    unset rpc_user rpc_password
    echo "ERROR: RIG-B1 numeric RPC auth secret failed the bounded credential shape." >&2
    exit 1
  fi
  unset rpc_user rpc_password
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
      require_gcloud_secret "$BITCOIN_CORE_RPC_URL_SECRET"
      require_gcloud_secret "$BITCOIN_CORE_RPC_AUTH_SECRET"
      require_gcloud_secret "$TREASURY_WIF_SECRET"
      if [[ "$RIG_ID" == "RIG-B1" ]]; then
        require_gcloud_secret_version "$BITCOIN_CORE_RPC_URL_SECRET" "$RIG_B1_RPC_URL_SECRET_VERSION"
        require_gcloud_secret_version "$BITCOIN_CORE_RPC_AUTH_SECRET" "$RIG_B1_RPC_AUTH_SECRET_VERSION"
        require_gcloud_secret_version "$TREASURY_WIF_SECRET" "$RIG_B1_TREASURY_WIF_SECRET_VERSION"
        require_gcloud_secret_version "$STRIPE_SECRET_KEY_SECRET" "$RIG_B1_STRIPE_SECRET_KEY_VERSION"
        require_gcloud_secret_version "$STRIPE_WEBHOOK_SECRET_SECRET" "$RIG_B1_STRIPE_WEBHOOK_SECRET_VERSION"
        require_gcloud_secret_version "$API_KEY_HMAC_SECRET_SECRET" "$RIG_B1_API_KEY_HMAC_SECRET_VERSION"
        require_gcloud_secret_version "$CRON_SECRET_SECRET" "$RIG_B1_CRON_SECRET_VERSION"
        verify_rig_b1_rpc_url_secret
        verify_rig_b1_rpc_auth_secret
      fi
      ;;
    gemini|gemini-release)
      require_gcloud_secret "$GEMINI_API_KEY_SECRET"
      require_gcloud_secret_version "$STRIPE_SECRET_KEY_SECRET" "$SHARED_STRIPE_SECRET_VERSION"
      require_gcloud_secret_version "$STRIPE_WEBHOOK_SECRET_SECRET" "$SHARED_STRIPE_WEBHOOK_VERSION"
      require_gcloud_secret_version "$API_KEY_HMAC_SECRET_SECRET" "$SHARED_API_KEY_HMAC_VERSION"
      require_gcloud_secret_version "$CRON_SECRET_SECRET" "$SHARED_CRON_SECRET_VERSION"
      require_gcloud_secret_version "$GEMINI_API_KEY_SECRET" "$GEMINI_API_KEY_SECRET_VERSION"
      ;;
  esac
fi

write_provision_state() {
  local status="$1"
  local reason="${2:-}"
  local generated_at approval_claim_json
  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  approval_claim_json="$G1_APPROVAL_CLAIM_JSON"
  if [[ $IS_RIG_R -eq 1 ]]; then
    approval_claim_json="$RIG_R_PROVISION_APPROVAL_CLAIM_JSON"
  fi
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
    --arg supabase_org_id "$SUPABASE_ORG" \
    --arg supabase_project_name "$PROJECT_NAME" \
    --arg supabase_project_ref "${CREATED_PROJECT_REF:-$NEW_PROJECT_REF}" \
    --arg supabase_url_secret "$SUPABASE_URL_SECRET_NAME" \
    --arg supabase_service_role_secret "$SUPABASE_SERVICE_ROLE_SECRET_NAME" \
    --arg g1_control_project_name "$G1_CONTROL_PROJECT_NAME" \
    --arg g1_tuned_project_name "$G1_TUNED_PROJECT_NAME" \
    --arg g1_control_project_ref "$G1_CONTROL_PROJECT_REF" \
    --arg g1_tuned_project_ref "$G1_TUNED_PROJECT_REF" \
    --arg g1_control_service "$G1_CONTROL_SERVICE" \
    --arg g1_tuned_service "$G1_TUNED_SERVICE" \
    --arg g1_control_url_secret "$G1_CONTROL_SUPABASE_URL_SECRET" \
    --arg g1_control_role_secret "$G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET" \
    --arg g1_tuned_url_secret "$G1_TUNED_SUPABASE_URL_SECRET" \
    --arg g1_tuned_role_secret "$G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET" \
    --arg g1_control_runtime_sa "$G1_CONTROL_RUNTIME_SA" \
    --arg g1_tuned_runtime_sa "$G1_TUNED_RUNTIME_SA" \
    --arg g1_control_runtime_unique_id "$G1_CONTROL_RUNTIME_SA_UNIQUE_ID" \
    --arg g1_tuned_runtime_unique_id "$G1_TUNED_RUNTIME_SA_UNIQUE_ID" \
    --arg rig_r_runtime_sa "$RUNTIME_SA" \
    --arg rig_r_runtime_unique_id "$RIG_R_RUNTIME_SA_UNIQUE_ID" \
    --arg g1_endpoint "projects/arkova1/locations/us-central1/endpoints/${RIG_G1_ENDPOINT_ID}" \
    --arg g1_model "$RIG_G1_CANDIDATE_MODEL_RESOURCE" \
    --arg g1_model_version "$RIG_G1_CANDIDATE_MODEL_VERSION_RESOURCE" \
    --arg g1_checkpoint_id "$RIG_G1_CHECKPOINT_ID" \
    --arg g1_deployed_model_id "$RIG_G1_DEPLOYED_MODEL_ID" \
    --arg g1_control_teardown "$(teardown_command_for_project_ref "$G1_CONTROL_PROJECT_REF")" \
    --arg g1_tuned_teardown "$(teardown_command_for_project_ref "$G1_TUNED_PROJECT_REF")" \
    --arg image "$PINNED_IMAGE" \
    --arg declared_source_head "$DECLARED_SOURCE_HEAD" \
    --arg source_head_image_ref "$SOURCE_HEAD_IMAGE_REF" \
    --arg source_head_image_digest "$SOURCE_HEAD_IMAGE_DIGEST" \
    --arg soak_id "$SOAK_ID" \
    --arg rig_id "$RIG_ID" \
    --arg lease_id "$LEASE_ID" \
    --argjson required_uptime_min "$REQUIRED_UPTIME_MIN" \
    --argjson required_wall_min "$REQUIRED_WALL_MIN" \
    --arg deployed_revision "$DEPLOYED_REVISION" \
    --arg deployed_image_digest "$DEPLOYED_IMAGE_DIGEST" \
    --arg deployed_source_head "$DEPLOYED_SOURCE_HEAD" \
    --arg scheduler_state "$SCHEDULER_STATE" \
    --arg scheduler_creation_guard "$SCHEDULER_CREATION_GUARD" \
    --arg preflight_artifact "$PREFLIGHT_ARTIFACT_PATH" \
    --arg preflight_verified_at "$PREFLIGHT_VERIFIED_AT" \
    --arg clean_mirror_attestation_id "$CLEAN_MIRROR_ATTESTATION_ID" \
    --arg state_path "$PROVISION_STATE_PATH" \
    --argjson created_cloud_run_service "$CREATED_CLOUD_RUN_SERVICE" \
    --argjson created_supabase_secrets "$CREATED_SUPABASE_SECRETS" \
    --argjson cloud_run_service_candidates "$CLOUD_RUN_SERVICE_CANDIDATES_JSON" \
    --argjson cloud_run_delete_commands "$CLOUD_RUN_DELETE_COMMANDS_JSON" \
    --argjson approval_claim "$approval_claim_json" \
    --argjson g1_authority "$G1_AUTHORITY_JSON" \
    --argjson rig_r_provision_approval "$RIG_R_PROVISION_APPROVAL_JSON" \
    --argjson rig_b1_node_approval "$RIG_B1_NODE_APPROVAL_JSON" \
    --argjson rig_b1_approval_claim "$RIG_B1_APPROVAL_CLAIM_JSON" \
    --argjson rig_b1_topology_ownership "$RIG_B1_TOPOLOGY_OWNERSHIP_JSON" \
    --arg rig_b1_topology_uri "$RIG_B1_TOPOLOGY_OWNERSHIP_URI" \
    --arg rig_b1_topology_generation "$RIG_B1_TOPOLOGY_OWNERSHIP_GENERATION" \
    --argjson immutable_ledger "$IMMUTABLE_LEDGER_CAPABILITY_JSON" \
    --arg teardown_command "$(teardown_command_for_project_ref "${CREATED_PROJECT_REF:-$NEW_PROJECT_REF}")" \
    '{
      status: $status,
      reason: $reason,
      generated_at: $generated_at,
      rig_name: $rig_name,
      profile: $profile,
      cloud_run_service: $cloud_run_service,
      cloud_run_region: $cloud_run_region,
      gcp_project: $gcp_project,
      supabase_org_id: $supabase_org_id,
      supabase_project_name: $supabase_project_name,
      supabase_project_ref: $supabase_project_ref,
      secrets: {
        supabase_url: $supabase_url_secret,
        supabase_service_role_key: $supabase_service_role_secret
      },
      g1_physical_projects: (if $rig_id == "RIG-G1" then [
        {
          rig_id: "RIG-G1-A",
          project_name: $g1_control_project_name,
          project_ref: $g1_control_project_ref,
          service: $g1_control_service,
          runtime_service_account: $g1_control_runtime_sa,
          runtime_service_account_unique_id: $g1_control_runtime_unique_id,
          supabase_url_secret: $g1_control_url_secret,
          supabase_service_role_secret: $g1_control_role_secret,
          teardown_command: $g1_control_teardown
        },
        {
          rig_id: "RIG-G1-B",
          project_name: $g1_tuned_project_name,
          project_ref: $g1_tuned_project_ref,
          service: $g1_tuned_service,
          runtime_service_account: $g1_tuned_runtime_sa,
          runtime_service_account_unique_id: $g1_tuned_runtime_unique_id,
          supabase_url_secret: $g1_tuned_url_secret,
          supabase_service_role_secret: $g1_tuned_role_secret,
          vertex_endpoint: $g1_endpoint,
          protected_model: $g1_model,
          model_version: $g1_model_version,
          checkpoint_id: $g1_checkpoint_id,
          deployed_model_id: $g1_deployed_model_id,
          endpoint_iam_role: "roles/aiplatform.endpointUser",
          teardown_command: $g1_tuned_teardown
        }
      ] else [] end),
      rig_r_runtime_identity: (if $rig_id == "RIG-R" then {
        email: $rig_r_runtime_sa,
        unique_id: $rig_r_runtime_unique_id
      } else null end),
      image: $image,
      declared_source_head: $declared_source_head,
      source_head_image_ref: $source_head_image_ref,
      source_head_image_digest: $source_head_image_digest,
      soak_id: $soak_id,
      rig_id: $rig_id,
      lease_id: $lease_id,
      required_uptime_min: $required_uptime_min,
      required_wall_min: $required_wall_min,
      deployed_revision: $deployed_revision,
      deployed_image_digest: $deployed_image_digest,
      deployed_source_head: $deployed_source_head,
      scheduler_state: $scheduler_state,
      scheduler_creation_guard: $scheduler_creation_guard,
      clean_mirror: {
        artifact: $preflight_artifact,
        verified_at: $preflight_verified_at,
        attestation_id: $clean_mirror_attestation_id
      },
      created_cloud_run_service: $created_cloud_run_service,
      created_supabase_secrets: $created_supabase_secrets,
      approval_claim: $approval_claim,
      g1_authority: $g1_authority,
      rig_r_provision_approval: $rig_r_provision_approval,
      rig_b1_node_approval: $rig_b1_node_approval,
      rig_b1_approval_claim: $rig_b1_approval_claim,
      rig_b1_topology_ownership: (if $rig_b1_topology_ownership == null then null else {
        object_uri: $rig_b1_topology_uri,
        generation: $rig_b1_topology_generation,
        payload: $rig_b1_topology_ownership
      } end),
      immutable_authority_ledger: $immutable_ledger,
      cleanup: {
        cloud_run_service_candidates: $cloud_run_service_candidates,
        cloud_run_delete_commands: $cloud_run_delete_commands,
        approval_claim: $approval_claim,
        rig_b1_approval_claim: $rig_b1_approval_claim,
        teardown_command: $teardown_command,
        g1_teardown_commands: (if $rig_id == "RIG-G1" then [$g1_control_teardown, $g1_tuned_teardown] else [] end)
      },
      state_path: $state_path,
      cleanup_hint: "If status is blocked_after_project_create, either resume with the same rig name/ref and verify these secrets, or run scripts/staging/teardown-isolated-rig.sh against the recorded service/ref."
    }' >"$PROVISION_STATE_PATH" || return 1
  echo "# provision state: $PROVISION_STATE_PATH"
}

pause_scheduler_jobs_fail_closed() {
  local failures=0 scheduler_spec scheduler_job_name observed_state
  if [[ $SCHEDULER_FAILURE_CONTAINMENT_ARMED -ne 1 ]]; then
    return 0
  fi

  echo "# failure containment: re-pausing every declared Scheduler job" >&2
  for scheduler_spec in "${SCHEDULER_JOB_SPECS[@]}"; do
    [[ -z "$scheduler_spec" ]] && continue
    scheduler_job_name="$(scheduler_job_name_for_spec "$scheduler_spec")"
    if ! gcloud scheduler jobs pause "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" >/dev/null 2>&1; then
      echo "ERROR: failure containment could not pause Scheduler job '$scheduler_job_name'." >&2
      failures=$((failures + 1))
    fi
  done

  # Verification is a separate full pass. A failed pause must not prevent its
  # own observation, and no earlier failure may stop later jobs from being
  # paused or verified.
  for scheduler_spec in "${SCHEDULER_JOB_SPECS[@]}"; do
    [[ -z "$scheduler_spec" ]] && continue
    scheduler_job_name="$(scheduler_job_name_for_spec "$scheduler_spec")"
    if ! observed_state="$(gcloud scheduler jobs describe "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" \
      --format="value(state)" 2>/dev/null)" \
      || [[ "$observed_state" != "PAUSED" ]]; then
      echo "ERROR: failure containment could not verify Scheduler job '$scheduler_job_name' as PAUSED." >&2
      failures=$((failures + 1))
    fi
  done

  if [[ $failures -ne 0 ]]; then
    SCHEDULER_STATE="failure_containment_pause_incomplete"
    return 1
  fi
  SCHEDULER_STATE="failure_contained_scheduler_paused"
  return 0
}

cleanup_rig_r_pre_project_bootstrap() {
  local failures=0 runtime_role runtime_roles
  if [[ $IS_RIG_R -ne 1 || -n "${CREATED_PROJECT_REF:-}" ]]; then
    return 0
  fi

  # RIG-R claims its lease and creates its temporary identity before the paid
  # Supabase create. If that create never returns an owned project ref, reclaim
  # only those resources this invocation positively created. Once a project ref
  # exists, the persisted exact teardown command remains the ownership boundary.
  if [[ $CREATED_RUNTIME_SA -eq 1 ]]; then
    if runtime_roles="$(gcloud projects get-iam-policy "$GCP_PROJECT" \
      --flatten="bindings[].members" \
      --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
      --format="value(bindings.role)" 2>/dev/null)"; then
      while IFS= read -r runtime_role; do
        [[ -n "$runtime_role" ]] || continue
        if ! gcloud projects remove-iam-policy-binding "$GCP_PROJECT" \
          --member="serviceAccount:${RUNTIME_SA}" \
          --role="$runtime_role" \
          --condition=None \
          --quiet >/dev/null 2>&1; then
          failures=$((failures + 1))
        fi
      done <<<"$runtime_roles"
    else
      failures=$((failures + 1))
    fi
    if gcloud iam service-accounts delete "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --quiet >/dev/null 2>&1; then
      CREATED_RUNTIME_SA=0
    else
      failures=$((failures + 1))
    fi
  fi
  if [[ $RIG_R_LEASE_CLAIMED -eq 1 ]]; then
    if ! release_owned_rig_r_lease >/dev/null 2>&1; then
      failures=$((failures + 1))
    fi
  fi
  [[ $failures -eq 0 ]]
}

cleanup_created_temporary_endpoint() {
  local endpoint_id deployed_model_id created_kind
  if [[ $CREATED_G1_VERTEX_ENDPOINT -eq 1 ]]; then
    endpoint_id="$RIG_G1_ENDPOINT_ID"
    deployed_model_id="$RIG_G1_DEPLOYED_MODEL_ID"
    created_kind="RIG-G1-B"
  elif [[ $CREATED_RIG_R_VERTEX_ENDPOINT -eq 1 ]]; then
    endpoint_id="$RIG_R_ENDPOINT_ID"
    deployed_model_id="$RIG_R_DEPLOYED_MODEL_ID"
    created_kind="RIG-R"
  else
    return 0
  fi

  echo "# failure containment: reclaiming positively-created ${created_kind} Vertex endpoint ${endpoint_id}" >&2
  # The deploy request may have failed before creating a deployment. An
  # undeploy miss is therefore non-fatal; endpoint deletion is the ownership-
  # scoped proof that no paid endpoint/deployment remains.
  gcloud ai endpoints undeploy-model "$endpoint_id" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
    --deployed-model-id="$deployed_model_id" --quiet >/dev/null 2>&1 || true
  if ! gcloud ai endpoints delete "$endpoint_id" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
    --quiet >/dev/null 2>&1; then
    echo "ERROR: failure containment could not delete positively-created ${created_kind} endpoint ${endpoint_id}." >&2
    return 1
  fi
  if gcloud ai endpoints describe "$endpoint_id" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" >/dev/null 2>&1; then
    echo "ERROR: positively-created ${created_kind} endpoint ${endpoint_id} remains after cleanup." >&2
    return 1
  fi
  if [[ "$created_kind" == "RIG-G1-B" ]]; then
    CREATED_G1_VERTEX_ENDPOINT=0
  else
    CREATED_RIG_R_VERTEX_ENDPOINT=0
  fi
  return 0
}

on_apply_exit() {
  local rc=$?
  local pause_result="not-required"
  local artifact_result="not-persisted"
  local bootstrap_result="not-required"
  local endpoint_result="not-required"
  local blocked_reason state_rc

  # Cleanup must never recursively re-enter the EXIT trap or replace the
  # triggering command's exit status. Every containment action is best-effort;
  # the original rc remains the process rc even when cleanup itself degrades.
  trap - EXIT ERR
  set +e

  # A zero exit before the final artifact/state handshake is itself unsafe.
  # Successful apply runs remove this trap only after ADMISSION_FINALIZED=1.
  if [[ $rc -eq 0 && $ADMISSION_FINALIZED -ne 1 ]]; then
    rc=1
  fi

  if [[ $SCHEDULER_FAILURE_CONTAINMENT_ARMED -eq 1 ]]; then
    if pause_scheduler_jobs_fail_closed; then
      pause_result="verified-paused"
    else
      pause_result="incomplete"
    fi
  fi

  rm -f -- "$ADMISSION_TEMP_PATH" 2>/dev/null
  if [[ $ADMISSION_ARTIFACT_PERSISTED -eq 1 && $ADMISSION_FINALIZED -ne 1 ]]; then
    if rm -f -- "$ADMISSION_ARTIFACT_PATH"; then
      artifact_result="withdrawn"
      ADMISSION_ARTIFACT_PERSISTED=0
    else
      artifact_result="withdraw-failed"
      echo "ERROR: failure containment could not withdraw incomplete admission artifact '$ADMISSION_ARTIFACT_PATH'." >&2
    fi
  fi

  if [[ $IS_RIG_R -eq 1 && -z "${CREATED_PROJECT_REF:-}" \
    && ( $CREATED_RUNTIME_SA -eq 1 || $RIG_R_LEASE_CLAIMED -eq 1 ) ]]; then
    if cleanup_rig_r_pre_project_bootstrap; then
      bootstrap_result="reclaimed"
    else
      bootstrap_result="incomplete"
      echo "ERROR: failure containment could not fully reclaim the pre-project RIG-R bootstrap." >&2
    fi
  fi

  if [[ $CREATED_G1_VERTEX_ENDPOINT -eq 1 || $CREATED_RIG_R_VERTEX_ENDPOINT -eq 1 ]]; then
    if cleanup_created_temporary_endpoint; then
      endpoint_result="reclaimed-and-absent"
    else
      endpoint_result="incomplete-requires-manual-teardown"
    fi
  fi

  blocked_reason="original_rc=${rc}; scheduler_pause=${pause_result}; admission_artifact=${artifact_result}; temporary_endpoint=${endpoint_result}; rig_r_pre_project_bootstrap=${bootstrap_result}; execute exact persisted teardown commands immediately"
  if [[ $APPLY -eq 1 && ( -n "${CREATED_PROJECT_REF:-}" || $IS_RIG_R -eq 1 ) ]]; then
    if [[ -n "${CREATED_PROJECT_REF:-}" ]]; then
      write_provision_state "REQUIRES_IMMEDIATE_TEARDOWN" "$blocked_reason"
    else
      write_provision_state "blocked_before_project_create" "$blocked_reason"
    fi
    state_rc=$?
    if [[ $state_rc -ne 0 ]]; then
      echo "ERROR: failure containment could not persist blocked provision state (cleanup_rc=$state_rc)." >&2
    fi
  fi
  echo "ERROR: provision failed; fail-closed cleanup completed with original_rc=$rc." >&2
  exit "$rc"
}

if [[ $APPLY -eq 1 ]]; then
  # EXIT covers explicit `exit`, set -e termination inside helper functions,
  # and top-level failures. ERR alone misses several of those paths.
  trap on_apply_exit EXIT
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
  jq -er '
    select(type == "array")
    | [
        .[]
        | select(.name == "service_role" and .type == "legacy")
        | .api_key
        | select(type == "string" and length > 0)
      ]
    | select(length == 1)
    | .[0]
  ' <<<"$api_keys_json" 2>/dev/null
}

create_supabase_runtime_secrets() {
  local project_ref="$1"
  local supabase_url
  local service_role_key
  local api_keys_json
  local temporary_secret
  supabase_url="https://${project_ref}.supabase.co"

  # Signed release rigs claim these exact temporary secret names in their
  # teardown topology. Reusing a pre-existing secret would make ownership and
  # deletion ambiguous, so prove absence before creating either member.
  if [[ "$RIG_ID" == "RIG-B1" || $IS_G1_RIG -eq 1 || $IS_RIG_R -eq 1 ]]; then
    for temporary_secret in "$SUPABASE_URL_SECRET_NAME" "$SUPABASE_SERVICE_ROLE_SECRET_NAME"; do
      if gcloud secrets describe "$temporary_secret" --project="$GCP_PROJECT" >/dev/null 2>&1; then
        echo "ERROR: temporary Supabase secret '$temporary_secret' already exists; refusing ownership ambiguity." >&2
        exit 2
      fi
    done
  fi

  if [[ $IS_G1_RIG -ne 1 && -n "${STAGING_NEW_SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
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
  unset service_role_key
  write_provision_state "supabase_secrets_recorded" ""
}

run_staging_honesty_preflight_with_generated_service_role() {
  local project_ref="$1"
  local service_role_secret_name="$2"
  local service_role_key preflight_output rc
  if ! service_role_key="$(gcloud secrets versions access 1 \
    --secret="$service_role_secret_name" \
    --project="$GCP_PROJECT" 2>/dev/null)"; then
    unset service_role_key
    echo "ERROR: could not read the generated Supabase service-role secret for clean-mirror preflight." >&2
    return 1
  fi
  if [[ -z "$service_role_key" ]]; then
    unset service_role_key
    echo "ERROR: generated Supabase service-role secret was empty for clean-mirror preflight." >&2
    return 1
  fi
  if preflight_output="$(SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
    npx tsx scripts/ci/staging-honesty-preflight.ts \
      --project-ref "$project_ref" \
      --format json 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  unset service_role_key
  if [[ $rc -ne 0 ]]; then
    unset preflight_output
    echo "ERROR: clean-mirror preflight child failed with rc=$rc; child diagnostics suppressed." >&2
    return "$rc"
  fi
  printf '%s\n' "$preflight_output"
  unset preflight_output
}

grant_rig_r_runtime_secret_access() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local secret_name
  for secret_name in \
    "$SUPABASE_URL_SECRET_NAME" \
    "$SUPABASE_SERVICE_ROLE_SECRET_NAME" \
    "$STRIPE_SECRET_KEY_SECRET" \
    "$STRIPE_WEBHOOK_SECRET_SECRET" \
    "$API_KEY_HMAC_SECRET_SECRET" \
    "$CRON_SECRET_SECRET" \
    "$GEMINI_API_KEY_SECRET"; do
    run_cmd gcloud secrets add-iam-policy-binding "$secret_name" \
      --project="$GCP_PROJECT" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --condition=None \
      --quiet
  done
}

provision_g1_runtime_identities() {
  [[ $IS_G1_RIG -eq 1 ]] || return 0
  local identity_json
  echo "# RIG-G1 — create two physically distinct temporary runtime identities"
  run_cmd gcloud iam service-accounts create "${G1_CONTROL_RUNTIME_SA%@*}" \
    --project="$GCP_PROJECT" --display-name="S3.3 RIG-G1-A temporary runtime"
  if [[ $APPLY -eq 1 ]]; then
    CREATED_G1_CONTROL_RUNTIME_SA=1
    identity_json="$(gcloud iam service-accounts describe "$G1_CONTROL_RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json)"
    G1_CONTROL_RUNTIME_SA_UNIQUE_ID="$(jq -er \
      --arg email "$G1_CONTROL_RUNTIME_SA" \
      'select(.email == $email and ((.uniqueId | tostring) | test("^[1-9][0-9]*$"))) | (.uniqueId | tostring)' \
      <<<"$identity_json")" || exit 2
    write_provision_state "g1_a_runtime_identity_created" ""
  fi
  run_cmd gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${G1_CONTROL_RUNTIME_SA}" \
    --role="roles/logging.logWriter" --condition=None --quiet

  run_cmd gcloud iam service-accounts create "${G1_TUNED_RUNTIME_SA%@*}" \
    --project="$GCP_PROJECT" --display-name="S3.3 RIG-G1-B temporary runtime"
  if [[ $APPLY -eq 1 ]]; then
    CREATED_G1_TUNED_RUNTIME_SA=1
    identity_json="$(gcloud iam service-accounts describe "$G1_TUNED_RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json)"
    G1_TUNED_RUNTIME_SA_UNIQUE_ID="$(jq -er \
      --arg email "$G1_TUNED_RUNTIME_SA" \
      'select(.email == $email and ((.uniqueId | tostring) | test("^[1-9][0-9]*$"))) | (.uniqueId | tostring)' \
      <<<"$identity_json")" || exit 2
    write_provision_state "g1_distinct_runtime_identities_created" ""
  fi
  run_cmd gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${G1_TUNED_RUNTIME_SA}" \
    --role="roles/logging.logWriter" --condition=None --quiet
}

grant_g1_runtime_secret_access() {
  [[ $IS_G1_RIG -eq 1 ]] || return 0
  local secret_name runtime_sa
  local shared_secrets=(
    "$STRIPE_SECRET_KEY_SECRET"
    "$STRIPE_WEBHOOK_SECRET_SECRET"
    "$API_KEY_HMAC_SECRET_SECRET"
    "$CRON_SECRET_SECRET"
    "$GEMINI_API_KEY_SECRET"
  )
  for secret_name in "$G1_CONTROL_SUPABASE_URL_SECRET" "$G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET"; do
    run_cmd gcloud secrets add-iam-policy-binding "$secret_name" \
      --project="$GCP_PROJECT" --member="serviceAccount:${G1_CONTROL_RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" --condition=None --quiet
  done
  for secret_name in "$G1_TUNED_SUPABASE_URL_SECRET" "$G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET"; do
    run_cmd gcloud secrets add-iam-policy-binding "$secret_name" \
      --project="$GCP_PROJECT" --member="serviceAccount:${G1_TUNED_RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" --condition=None --quiet
  done
  for runtime_sa in "$G1_CONTROL_RUNTIME_SA" "$G1_TUNED_RUNTIME_SA"; do
    for secret_name in "${shared_secrets[@]}"; do
      run_cmd gcloud secrets add-iam-policy-binding "$secret_name" \
        --project="$GCP_PROJECT" --member="serviceAccount:${runtime_sa}" \
        --role="roles/secretmanager.secretAccessor" --condition=None --quiet
    done
  done
  if [[ $APPLY -eq 1 ]]; then
    write_provision_state "g1_runtime_secret_scopes_bound" ""
  fi
}

parse_genie_deploy_operation_name() {
  local operation_json="$1"
  local endpoint_id="$2"
  local operation_name location_prefix endpoint_prefix operation_id

  operation_name="$(jq -er '
    select(type == "object")
    | .name
    | select(type == "string")
  ' <<<"$operation_json" 2>/dev/null)" || return 1
  location_prefix="projects/${IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER}/locations/${CLOUD_RUN_REGION}/operations/"
  endpoint_prefix="projects/${IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER}/locations/${CLOUD_RUN_REGION}/endpoints/${endpoint_id}/operations/"
  if [[ "$operation_name" == "$location_prefix"* ]]; then
    operation_id="${operation_name#"$location_prefix"}"
  elif [[ "$operation_name" == "$endpoint_prefix"* ]]; then
    operation_id="${operation_name#"$endpoint_prefix"}"
  else
    return 1
  fi
  [[ "$operation_id" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$operation_name"
}

probe_tuned_gemini_preclock() {
  local access_token="$1"
  local endpoint_id="$2"
  local timeout_seconds=300 interval_seconds=10
  local deadline_seconds=$((SECONDS + timeout_seconds))
  local attempt=0 remaining_seconds request_timeout_seconds
  local probe_payload probe_url probe_result probe_json http_status normalized_status
  probe_payload='{"contents":[{"role":"user","parts":[{"text":"Synthetic Arkova S3.3 capability probe; no customer data. Return one short JSON object."}]}],"generationConfig":{"responseMimeType":"application/json","temperature":0,"maxOutputTokens":64}}'
  probe_url="https://${CLOUD_RUN_REGION}-aiplatform.googleapis.com/v1beta1/projects/${IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER}/locations/${CLOUD_RUN_REGION}/endpoints/${endpoint_id}:generateContent"

  while (( SECONDS < deadline_seconds )); do
    attempt=$((attempt + 1))
    remaining_seconds=$((deadline_seconds - SECONDS))
    request_timeout_seconds=$remaining_seconds
    (( request_timeout_seconds <= 60 )) || request_timeout_seconds=60
    if ! probe_result="$(/usr/bin/curl --silent --show-error \
      --connect-timeout 10 --max-time "$request_timeout_seconds" \
      --request POST "$probe_url" \
      --header "Authorization: Bearer ${access_token}" \
      --header 'Content-Type: application/json' \
      --data-binary "$probe_payload" \
      --write-out $'\n%{http_code}' 2>/dev/null)"; then
      echo "ERROR: tuned-Gemini capability probe terminal category: transport failure." >&2
      return 1
    fi
    http_status="${probe_result##*$'\n'}"
    probe_json="${probe_result%$'\n'*}"
    if [[ ! "$http_status" =~ ^[1-5][0-9][0-9]$ ]]; then
      echo "ERROR: tuned-Gemini capability probe terminal category: malformed HTTP status." >&2
      return 1
    fi
    if [[ "$http_status" == "200" ]]; then
      if jq -e 'type == "object" and (.candidates | type == "array" and length > 0)' \
        >/dev/null 2>&1 <<<"$probe_json"; then
        return 0
      fi
      echo "ERROR: tuned-Gemini capability probe terminal category: http=200 reason=NO_CANDIDATE." >&2
      return 1
    fi
    if [[ "$http_status" =~ ^2 ]]; then
      echo "ERROR: tuned-Gemini capability probe terminal category: http=$http_status reason=UNEXPECTED_2XX." >&2
      return 1
    fi
    normalized_status="$(jq -er --argjson code "$http_status" '
      select(type == "object")
      | .error
      | select(type == "object" and .code == $code)
      | .status
      | select(type == "string")
    ' <<<"$probe_json" 2>/dev/null || true)"
    case "${http_status}:${normalized_status}" in
      403:PERMISSION_DENIED|404:NOT_FOUND|429:RESOURCE_EXHAUSTED|500:INTERNAL|503:UNAVAILABLE|504:DEADLINE_EXCEEDED)
        ;;
      *)
        echo "ERROR: tuned-Gemini capability probe terminal category: http=$http_status reason=${normalized_status:-MALFORMED_ERROR}." >&2
        return 1
        ;;
    esac
    remaining_seconds=$((deadline_seconds - SECONDS))
    if (( remaining_seconds <= 0 )); then
      break
    fi
    echo "# tuned-Gemini preclock probe waiting: attempt=$attempt http=$http_status reason=$normalized_status" >&2
    (( remaining_seconds >= interval_seconds )) || interval_seconds=$remaining_seconds
    /bin/sleep "$interval_seconds"
  done
  echo "ERROR: tuned-Gemini capability probe exhausted its ${timeout_seconds}s deadline on a retryable status." >&2
  return 1
}

provision_temporary_vertex_endpoint() {
  local endpoint_id endpoint_resource endpoint_display model_resource model_version_resource
  local checkpoint_id deployed_id deployed_display runtime_sa denied_runtime_sa created_flag_label
  local vertex_endpoint_url vertex_endpoint_iam_url deploy_payload operation_json operation_name operation_url
  local operator_access_token attempt endpoint_policy set_policy_payload set_policy_response
  local access_token
  if [[ $IS_G1_RIG -eq 1 ]]; then
    endpoint_id="$RIG_G1_ENDPOINT_ID"
    endpoint_resource="$G1_ENDPOINT_RESOURCE"
    endpoint_display="$RIG_G1_ENDPOINT_DISPLAY_NAME"
    model_resource="$RIG_G1_CANDIDATE_MODEL_RESOURCE"
    model_version_resource="$RIG_G1_CANDIDATE_MODEL_VERSION_RESOURCE"
    checkpoint_id="$RIG_G1_CHECKPOINT_ID"
    deployed_id="$RIG_G1_DEPLOYED_MODEL_ID"
    deployed_display="$RIG_G1_DEPLOYED_MODEL_DISPLAY_NAME"
    runtime_sa="$G1_TUNED_RUNTIME_SA"
    denied_runtime_sa="$G1_CONTROL_RUNTIME_SA"
    created_flag_label="G1"
  elif [[ $IS_RIG_R -eq 1 ]]; then
    endpoint_id="$RIG_R_ENDPOINT_ID"
    endpoint_resource="$RIG_R_VERTEX_ENDPOINT"
    endpoint_display="$RIG_R_ENDPOINT_DISPLAY_NAME"
    model_resource="$RIG_R_VERTEX_MODEL"
    model_version_resource="$RIG_R_PROTECTED_V6_MODEL_VERSION"
    checkpoint_id="$RIG_R_CHECKPOINT_ID"
    deployed_id="$RIG_R_DEPLOYED_MODEL_ID"
    deployed_display="$RIG_R_DEPLOYED_MODEL_DISPLAY_NAME"
    runtime_sa="$RUNTIME_SA"
    denied_runtime_sa=""
    created_flag_label="R"
  else
    return 0
  fi

  echo "# temporary Vertex endpoint — deterministic signed ID, GENIE model@1 checkpoint 6, automatic 1x1"
  run_cmd gcloud ai endpoints create \
    --endpoint-id="$endpoint_id" \
    --display-name="$endpoint_display" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION"
  if [[ $APPLY -eq 1 ]]; then
    if [[ "$created_flag_label" == "G1" ]]; then
      CREATED_G1_VERTEX_ENDPOINT=1
    else
      CREATED_RIG_R_VERTEX_ENDPOINT=1
    fi
    write_provision_state "temporary_vertex_endpoint_created" ""
  fi

  # The installed stable gcloud deploy client cannot handle GENIE models that
  # omit supportedDeploymentResourcesTypes. Use the exact previously-successful
  # v1 DeployModel REST shape and poll its regional long-running operation.
  vertex_endpoint_url="https://${CLOUD_RUN_REGION}-aiplatform.googleapis.com/v1/projects/${IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER}/locations/${CLOUD_RUN_REGION}/endpoints/${endpoint_id}"
  vertex_endpoint_iam_url="https://${CLOUD_RUN_REGION}-aiplatform.googleapis.com/v1beta1/projects/${IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER}/locations/${CLOUD_RUN_REGION}/endpoints/${endpoint_id}"
  deploy_payload="$(jq -nc \
    --arg id "$deployed_id" \
    --arg model "$model_version_resource" \
    --arg display "$deployed_display" \
    --arg checkpoint "$checkpoint_id" '
      {
        deployedModel: {
          id: $id,
          model: $model,
          displayName: $display,
          checkpointId: $checkpoint,
          automaticResources: {minReplicaCount: 1, maxReplicaCount: 1}
        },
        trafficSplit: {"0": 100}
      }
    ')"
  if [[ $APPLY -eq 1 ]]; then
    operator_access_token="$(gcloud auth print-access-token)" || exit 2
    if [[ -z "$operator_access_token" ]]; then
      echo "ERROR: could not obtain an operator access token for GENIE deployment." >&2
      exit 2
    fi
    if ! operation_json="$(/usr/bin/curl --silent --show-error --fail-with-body \
      --request POST "${vertex_endpoint_url}:deployModel" \
      --header "Authorization: Bearer ${operator_access_token}" \
      --header 'Content-Type: application/json' \
      --data-binary "$deploy_payload" 2>/dev/null)"; then
      unset operator_access_token operation_json
      echo "ERROR: GENIE DeployModel REST request failed." >&2
      exit 2
    fi
    operation_name="$(parse_genie_deploy_operation_name "$operation_json" "$endpoint_id")" || {
      unset operator_access_token operation_json
      echo "ERROR: GENIE DeployModel did not return one of the two exact canonical operation shapes." >&2
      exit 2
    }
    operation_url="https://${CLOUD_RUN_REGION}-aiplatform.googleapis.com/v1/${operation_name}"
    attempt=0
    while (( attempt < 120 )); do
      attempt=$((attempt + 1))
      operation_json="$(/usr/bin/curl --silent --show-error --fail-with-body \
        --header "Authorization: Bearer ${operator_access_token}" \
        "$operation_url" 2>/dev/null)" || {
        unset operator_access_token operation_json
        echo "ERROR: could not poll GENIE deployment operation." >&2
        exit 2
      }
      if jq -e '.done == true and has("error")' >/dev/null 2>&1 <<<"$operation_json"; then
        unset operator_access_token operation_json
        echo "ERROR: GENIE deployment operation completed with an error." >&2
        exit 2
      fi
      if jq -e '.done == true and (has("error") | not)' >/dev/null 2>&1 <<<"$operation_json"; then
        break
      fi
      /bin/sleep 15
    done
    if (( attempt >= 120 )) && ! jq -e '.done == true and (has("error") | not)' \
      >/dev/null 2>&1 <<<"$operation_json"; then
      unset operator_access_token operation_json
      echo "ERROR: GENIE deployment did not complete within the 30-minute hard timeout." >&2
      exit 2
    fi
    unset operation_json

    if [[ "$created_flag_label" == "G1" ]]; then
      verify_g1_candidate_endpoint_binding
      G1_OBSERVED_DEPLOYED_MODEL_ID="$deployed_id"
    else
      verify_rig_r_candidate_endpoint_binding
    fi

    # Installed gcloud has no endpoint IAM subcommands. Preserve the endpoint's
    # etag and use resource-scoped Vertex getIamPolicy/setIamPolicy REST calls.
    endpoint_policy="$(/usr/bin/curl --silent --show-error --fail-with-body \
      --request POST "${vertex_endpoint_iam_url}:getIamPolicy" \
      --header "Authorization: Bearer ${operator_access_token}" \
      --header 'Content-Type: application/json' --data-binary '{}' 2>/dev/null)" || exit 2
    if jq -e 'any(.bindings[]?; .role == "roles/aiplatform.endpointUser")' \
      >/dev/null 2>&1 <<<"$endpoint_policy"; then
      unset operator_access_token endpoint_policy
      echo "ERROR: new temporary endpoint unexpectedly had a pre-existing predictor binding." >&2
      exit 2
    fi
    endpoint_policy="$(jq -ce --arg member "serviceAccount:${runtime_sa}" '
      select(type == "object")
      | .version = (.version // 1)
      | .bindings = ((.bindings // []) + [{role: "roles/aiplatform.endpointUser", members: [$member]}])
    ' <<<"$endpoint_policy")" || exit 2
    set_policy_payload="$(jq -nc --argjson policy "$endpoint_policy" \
      '{policy: $policy}')"
    set_policy_response="$(/usr/bin/curl --silent --show-error --fail-with-body \
      --request POST "${vertex_endpoint_iam_url}:setIamPolicy" \
      --header "Authorization: Bearer ${operator_access_token}" \
      --header 'Content-Type: application/json' \
      --data-binary "$set_policy_payload" 2>/dev/null)" || exit 2
    unset set_policy_payload set_policy_response
    endpoint_policy="$(/usr/bin/curl --silent --show-error --fail-with-body \
      --request POST "${vertex_endpoint_iam_url}:getIamPolicy" \
      --header "Authorization: Bearer ${operator_access_token}" \
      --header 'Content-Type: application/json' --data-binary '{}' 2>/dev/null)" || exit 2
    unset operator_access_token
    if ! jq -e --arg expected "serviceAccount:${runtime_sa}" --arg denied "serviceAccount:${denied_runtime_sa}" '
      [
        .bindings[]?
        | select(.role == "roles/aiplatform.endpointUser")
        | .members[]?
      ] as $predictors
      | ($predictors | sort | unique) == [$expected]
      and ($denied == "serviceAccount:" or ($predictors | index($denied) == null))
    ' >/dev/null 2>&1 <<<"$endpoint_policy"; then
      echo "ERROR: temporary endpoint predictor IAM is not bound only to its exact tuned/release runtime identity." >&2
      exit 2
    fi

    # Pre-clock synthetic capability probe. The bearer token and raw response
    # remain memory-only and are never printed or persisted.
    access_token="$(gcloud auth print-access-token \
      --impersonate-service-account="$runtime_sa")" || exit 2
    if [[ -z "$access_token" ]]; then
      echo "ERROR: could not obtain the temporary runtime identity's access token for the capability probe." >&2
      exit 2
    fi
    if ! probe_tuned_gemini_preclock "$access_token" "$endpoint_id"; then
      unset access_token
      exit 2
    fi
    unset access_token
    if [[ "$created_flag_label" == "G1" ]]; then
      G1_PREDICT_PROBE_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    else
      RIG_R_PREDICT_PROBE_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    fi
    write_provision_state "temporary_vertex_endpoint_verified_and_probed_preclock" ""
  else
    print_cmd /usr/bin/curl --request POST "${vertex_endpoint_url}:deployModel" \
      --header 'Authorization: Bearer <memory-only-operator-token>' \
      --header 'Content-Type: application/json' --data-binary "$deploy_payload"
    echo "# apply only: poll the exact regional LRO, then v1beta1 REST-set endpoint-scoped roles/aiplatform.endpointUser for ${runtime_sa} with etag preservation"
    echo "# apply only: impersonate ${runtime_sa} and run one synthetic, non-customer-data :generateContent capability probe"
  fi
}

provision_rig_b1_bitcoin_core_node() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local worker_secret
  local worker_secrets=(
    "$SUPABASE_URL_SECRET_NAME"
    "$SUPABASE_SERVICE_ROLE_SECRET_NAME"
    "$STRIPE_SECRET_KEY_SECRET"
    "$STRIPE_WEBHOOK_SECRET_SECRET"
    "$API_KEY_HMAC_SECRET_SECRET"
    "$CRON_SECRET_SECRET"
    "$BITCOIN_CORE_RPC_URL_SECRET"
    "$BITCOIN_CORE_RPC_AUTH_SECRET"
    "$TREASURY_WIF_SECRET"
  )

  echo "# Step 2c/6 — provision the temporary isolated Bitcoin Core Signet node topology"
  for b1_service_account in "$RUNTIME_SA" "$CRON_OIDC_SA" "$RIG_B1_NODE_SERVICE_ACCOUNT"; do
    if gcloud iam service-accounts describe "$b1_service_account" \
      --project="$GCP_PROJECT" >/dev/null 2>&1; then
      echo "ERROR: RIG-B1 dedicated service account '$b1_service_account' already exists; refusing ownership ambiguity." >&2
      exit 2
    fi
  done
  run_cmd gcloud iam service-accounts create "${RUNTIME_SA%@*}" \
    --project="$GCP_PROJECT" --display-name="S3.3 RIG-B1 temporary worker runtime"
  run_cmd gcloud iam service-accounts create "${CRON_OIDC_SA%@*}" \
    --project="$GCP_PROJECT" --display-name="S3.3 RIG-B1 temporary Scheduler OIDC"
  run_cmd gcloud iam service-accounts create "${RIG_B1_NODE_SERVICE_ACCOUNT%@*}" \
    --project="$GCP_PROJECT" \
    --display-name="S3.3 RIG-B1 temporary Bitcoin Core Signet node"
  run_cmd gcloud secrets add-iam-policy-binding "$BITCOIN_CORE_RPC_AUTH_SECRET" \
    --project="$GCP_PROJECT" \
    --member="serviceAccount:${RIG_B1_NODE_SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None --quiet
  run_cmd gcloud artifacts repositories add-iam-policy-binding "$RIG_B1_ARTIFACT_REPOSITORY" \
    --project="$GCP_PROJECT" --location="$CLOUD_RUN_REGION" \
    --member="serviceAccount:${RIG_B1_NODE_SERVICE_ACCOUNT}" \
    --role="roles/artifactregistry.reader" \
    --condition=None --quiet
  for worker_secret in "${worker_secrets[@]}"; do
    run_cmd gcloud secrets add-iam-policy-binding "$worker_secret" \
      --project="$GCP_PROJECT" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --condition=None --quiet
  done
  run_cmd gcloud compute networks create "$RIG_B1_NODE_NETWORK" \
    --project="$GCP_PROJECT" --subnet-mode=custom
  run_cmd gcloud compute networks subnets create "$RIG_B1_NODE_SUBNET" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
    --network="$RIG_B1_NODE_NETWORK" --range="$RIG_B1_NODE_SUBNET_CIDR" \
    --enable-private-ip-google-access
  run_cmd gcloud compute addresses create "$RIG_B1_NODE_INTERNAL_ADDRESS" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
    --subnet="$RIG_B1_NODE_SUBNET" --addresses="$RIG_B1_NODE_RPC_BIND" --purpose=GCE_ENDPOINT
  run_cmd gcloud compute addresses create "$RIG_B1_NODE_EXTERNAL_ADDRESS" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION"
  run_cmd gcloud compute firewall-rules create "$RIG_B1_NODE_RPC_FIREWALL" \
    --project="$GCP_PROJECT" --network="$RIG_B1_NODE_NETWORK" \
    --direction=INGRESS --action=ALLOW --rules=tcp:38332 \
    --source-ranges="$RIG_B1_NODE_CONNECTOR_CIDR" \
    --target-service-accounts="$RIG_B1_NODE_SERVICE_ACCOUNT"
  run_cmd gcloud compute networks vpc-access connectors create "$RIG_B1_NODE_VPC_CONNECTOR" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" \
    --network="$RIG_B1_NODE_NETWORK" --range="$RIG_B1_NODE_CONNECTOR_CIDR" \
    --min-instances=2 --max-instances=3 --machine-type=e2-micro
  run_cmd gcloud compute disks create "$RIG_B1_NODE_BOOT_DISK" \
    --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" \
    --image-family=cos-stable --image-project=cos-cloud \
    --type=pd-balanced --size=20GB
  run_cmd gcloud compute disks create "$RIG_B1_NODE_DATA_DISK" \
    --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" \
    --type=pd-balanced --size=100GB
  run_cmd gcloud compute instances create "$RIG_B1_NODE_VM" \
    --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" \
    --machine-type=e2-standard-2 \
    --subnet="$RIG_B1_NODE_SUBNET" \
    --private-network-ip="$RIG_B1_NODE_RPC_BIND" \
    --address="$RIG_B1_NODE_EXTERNAL_ADDRESS" \
    --service-account="$RIG_B1_NODE_SERVICE_ACCOUNT" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --disk="name=${RIG_B1_NODE_BOOT_DISK},device-name=${RIG_B1_NODE_BOOT_DISK},mode=rw,boot=yes,auto-delete=no" \
    --disk="name=${RIG_B1_NODE_DATA_DISK},device-name=${RIG_B1_NODE_DATA_DISK},mode=rw,boot=no,auto-delete=no" \
    --metadata="gcp-project-id=${GCP_PROJECT},bitcoin-core-image=${RIG_B1_BITCOIN_CORE_IMAGE},rpc-auth-secret=${BITCOIN_CORE_RPC_AUTH_SECRET},rpc-auth-secret-version=${RIG_B1_RPC_AUTH_SECRET_VERSION},rpc-bind=${RIG_B1_NODE_RPC_BIND},rpc-allow-cidr=${RIG_B1_NODE_CONNECTOR_CIDR},data-disk-name=${RIG_B1_NODE_DATA_DISK},treasury-address=${RIG_B1_TREASURY_ADDRESS},treasury-descriptor=${RIG_B1_TREASURY_DESCRIPTOR},treasury-split-plan-digest=${RIG_B1_TREASURY_SPLIT_PLAN_DIGEST},treasury-split-txid=${RIG_B1_TREASURY_SPLIT_TXID},treasury-expected-output-count=32,treasury-expected-total-sats=${RIG_B1_TREASURY_EXPECTED_TOTAL_SATS},bitcoin-core-version=${RIG_B1_BITCOIN_CORE_VERSION},bitcoin-core-source-sha256=${RIG_B1_BITCOIN_CORE_SOURCE_SHA256}" \
    --metadata-from-file="startup-script=${RIG_B1_NODE_STARTUP_SCRIPT}"
  echo
}

wait_for_rig_b1_node_readiness() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local attempt serial_output marker verified
  local max_attempts=240
  local interval_seconds=20
  if [[ $APPLY -ne 1 ]]; then
    print_cmd gcloud compute instances get-serial-port-output "$RIG_B1_NODE_VM" \
      --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --port=1 --start=0
    echo "#   apply polls for at most $((max_attempts * interval_seconds)) seconds and requires"
    echo "#   one exact ARKOVA_RIG_B1_READY_V1 marker before any Cloud Run deploy."
    return 0
  fi

  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    serial_output="$(gcloud compute instances get-serial-port-output "$RIG_B1_NODE_VM" \
      --project="$GCP_PROJECT" --zone="$RIG_B1_NODE_ZONE" --port=1 --start=0 2>/dev/null || true)"
    marker="$(printf '%s\n' "$serial_output" \
      | sed -n 's/^.*ARKOVA_RIG_B1_READY_V1 \({.*}\)$/\1/p' \
      | tail -n 1)"
    if [[ -n "$marker" && "$marker" != *[[:space:]]* ]] \
      && verified="$(jq -ce \
        --arg image "$RIG_B1_EXPECTED_BITCOIN_CORE_IMAGE" \
        --arg split_plan "$RIG_B1_TREASURY_SPLIT_PLAN_DIGEST" \
        --arg split_txid "$RIG_B1_TREASURY_SPLIT_TXID" \
        --argjson total_sats "$RIG_B1_TREASURY_TOTAL_SATS" '
          select(
            type == "object"
            and ((keys | sort) == ([
              "schemaVersion", "bitcoinCoreVersion", "bitcoinCoreImage",
              "sourceTarballSha256", "chain", "initialBlockDownload", "blocks",
              "headers", "genesisHash", "txindexSynced", "txindexBestBlockHeight",
              "treasurySplitPlanDigest", "splitTransactionId", "confirmedOutputCount",
              "confirmedTotalSats", "splitBlockHash", "splitBlockHeader", "txOutProof"
            ] | sort))
            and .schemaVersion == "arkova.s33.rig-b1.node-readiness/v1"
            and .bitcoinCoreVersion == "31.1"
            and .bitcoinCoreImage == $image
            and .sourceTarballSha256 == "b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"
            and .chain == "signet"
            and .initialBlockDownload == false
            and (.blocks | type == "number" and floor == . and . >= 0)
            and (.headers | type == "number" and floor == . and . >= 0)
            and (.headers >= .blocks)
            and .genesisHash == "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6"
            and .txindexSynced == true
            and .txindexBestBlockHeight == .blocks
            and .treasurySplitPlanDigest == $split_plan
            and .splitTransactionId == $split_txid
            and .confirmedOutputCount == 32
            and .confirmedTotalSats == $total_sats
            and (.splitBlockHash | type == "string" and test("^[0-9a-f]{64}$"))
            and (.splitBlockHeader | type == "string" and test("^[0-9a-f]{160}$"))
            and (.txOutProof | type == "string" and test("^([0-9a-f]{2})+$"))
          )
        ' <<<"$marker" 2>/dev/null)"; then
      RIG_B1_NODE_READINESS_JSON="$verified"
      write_provision_state "b1_node_readiness_verified_before_worker_deploy" ""
      return 0
    fi
    sleep "$interval_seconds"
  done
  echo "ERROR: RIG-B1 node did not emit the exact nonsecret readiness marker within $((max_attempts * interval_seconds)) seconds; refusing Cloud Run deploy." >&2
  return 1
}

resolve_head_sha() {
  if [[ "$DECLARED_SOURCE_HEAD" != \<required-in-apply:* ]]; then
    printf '%s\n' "$DECLARED_SOURCE_HEAD"
  elif [[ -n "${GITHUB_SHA:-}" ]]; then
    printf '%s\n' "$GITHUB_SHA"
  else
    local script_input_dir script_dir
    case "$0" in */*) script_input_dir="${0%/*}" ;; *) script_input_dir="." ;; esac
    script_dir="$(cd -P -- "$script_input_dir" 2>/dev/null && pwd -P)" || script_dir=""
    trusted_git -C "$script_dir" rev-parse --verify 'HEAD^{commit}' 2>/dev/null \
      || printf 'unknown\n'
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
    if [[ -n "$TRUSTED_REPO_ROOT" && -n "${REMOTE_MAIN_SHA:-}" ]]; then
      trusted_git -C "$TRUSTED_REPO_ROOT" merge-base HEAD "$REMOTE_MAIN_SHA" 2>/dev/null \
        || printf 'unknown\n'
    else
      printf 'unknown\n'
    fi
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

  local revision_json expected_digest resolved_digest observed_runtime_sa
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
  observed_runtime_sa="$(jq -r '.spec.serviceAccountName // empty' <<<"$revision_json")"

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
  if [[ -z "$EXPECTED_RUNTIME_SA_FOR_REVISION" \
    || "$observed_runtime_sa" != "$EXPECTED_RUNTIME_SA_FOR_REVISION" ]]; then
    echo "ERROR: deployed revision runtime identity mismatch: expected=${EXPECTED_RUNTIME_SA_FOR_REVISION:-<unset>} got=${observed_runtime_sa:-<missing>}." >&2
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

deployed_revision_secret_binding_is_exact() {
  local revision_json="$1"
  local env_name="$2"
  local expected_secret="$3"
  local expected_version="$4"
  jq -e --arg name "$env_name" --arg secret "$expected_secret" --arg version "$expected_version" '
    [.spec.containers[0].env[]? | select(.name == $name)] as $matches
    | ($matches | length) == 1
    and (
      (
        (($matches[0] | keys | sort) == (["name", "valueSource"] | sort))
        and (($matches[0].valueSource | keys) == ["secretKeyRef"])
        and (($matches[0].valueSource.secretKeyRef | keys | sort) == (["secret", "version"] | sort))
        and $matches[0].valueSource.secretKeyRef.secret == $secret
        and $matches[0].valueSource.secretKeyRef.version == $version
      )
      or
      (
        (($matches[0] | keys | sort) == (["name", "valueFrom"] | sort))
        and (($matches[0].valueFrom | keys) == ["secretKeyRef"])
        and (($matches[0].valueFrom.secretKeyRef | keys | sort) == (["key", "name"] | sort))
        and $matches[0].valueFrom.secretKeyRef.name == $secret
        and $matches[0].valueFrom.secretKeyRef.key == $version
      )
    )
  ' >/dev/null 2>&1 <<<"$revision_json"
}

verify_deployed_revision_env() {
  local revision_json="$1"
  local entry key expected observed count expected_names_json observed_names_json secret_binding expected_secret expected_version
  local expected_names=()
  for entry in "${ENV_VARS[@]}"; do
    key="${entry%%=*}"
    expected_names+=("$key")
    expected="${entry#*=}"
    count="$(jq -r --arg name "$key" '[.spec.containers[0].env[]? | select(.name == $name)] | length' <<<"$revision_json")"
    observed="$(observed_revision_env_value "$revision_json" "$key")"
    if [[ "$count" != "1" || "$observed" != "$expected" ]]; then
      echo "ERROR: deployed revision environment '$key' does not exactly match the declared non-secret value." >&2
      exit 1
    fi
  done
  for entry in "${EXPECTED_REVISION_SECRETS[@]}"; do
    key="${entry%%=*}"
    secret_binding="${entry#*=}"
    expected_secret="${secret_binding%:*}"
    expected_version="${secret_binding##*:}"
    expected_names+=("$key")
    if ! deployed_revision_secret_binding_is_exact \
      "$revision_json" "$key" "$expected_secret" "$expected_version"; then
      echo "ERROR: deployed revision secret '$key' does not bind its exact declared Secret Manager name/version." >&2
      exit 1
    fi
  done

  expected_names_json="$(printf '%s\n' "${expected_names[@]}" \
    | jq -Rsc 'split("\n") | map(select(length > 0)) | sort | unique')"
  observed_names_json="$(jq -c \
    '[.spec.containers[0].env[]? | .name] | sort' <<<"$revision_json")"
  if [[ "$observed_names_json" != "$expected_names_json" ]]; then
    echo "ERROR: deployed revision environment name set differs from the declared env/secret set." >&2
    exit 1
  fi

  count="$(jq -r '[.spec.containers[0].env[]? | select(.name == "GEMINI_TUNED_RESPONSE_SCHEMA")] | length' <<<"$revision_json")"
  if [[ "$count" != "0" ]]; then
    echo "ERROR: deployed revision environment contains forbidden GEMINI_TUNED_RESPONSE_SCHEMA flag bleed." >&2
    exit 1
  fi

  # Admission values come from the immutable deployed revision, not the caller's
  # requested overlay. --set-env-vars replaces the old set, and this observation
  # proves the schema selector was actively absent from the resulting revision.
  ADMISSION_NODE_ENV="$(observed_revision_env_value "$revision_json" "NODE_ENV")"
  ADMISSION_ENABLE_AI_EXTRACTION="$(observed_revision_env_value "$revision_json" "ENABLE_AI_EXTRACTION")"
  ADMISSION_ENABLE_VERTEX_AI="$(observed_revision_env_value "$revision_json" "ENABLE_VERTEX_AI")"
  ADMISSION_ENABLE_AI_FRAUD="$(observed_revision_env_value "$revision_json" "ENABLE_AI_FRAUD")"
  ADMISSION_ENABLE_AI_REPORTS="$(observed_revision_env_value "$revision_json" "ENABLE_AI_REPORTS")"
  ADMISSION_FRONTEND_URL="$(observed_revision_env_value "$revision_json" "FRONTEND_URL")"
  USE_MOCKS_VALUE="$(observed_revision_env_value "$revision_json" "USE_MOCKS")"
  ENABLE_PROD_NETWORK_ANCHORING_VALUE="$(observed_revision_env_value "$revision_json" "ENABLE_PROD_NETWORK_ANCHORING")"
  if [[ "$PROFILE" == "chain" ]]; then
    ADMISSION_KMS_PROVIDER="$(observed_revision_env_value "$revision_json" "KMS_PROVIDER")"
    ADMISSION_BITCOIN_NETWORK="$(observed_revision_env_value "$revision_json" "BITCOIN_NETWORK")"
    ADMISSION_BITCOIN_UTXO_PROVIDER="$(observed_revision_env_value "$revision_json" "BITCOIN_UTXO_PROVIDER")"
  elif [[ "$PROFILE" == "gemini" || "$PROFILE" == "gemini-release" ]]; then
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

verify_scheduler_job_config() {
  local scheduler_spec="$1"
  local expected_schedule="$2"
  local job_name expected_time_zone expected_attempt_deadline observed_json
  job_name="$(scheduler_job_name_for_spec "$scheduler_spec")"
  expected_time_zone="$(scheduler_spec_time_zone "$scheduler_spec")"
  expected_attempt_deadline="$(scheduler_spec_attempt_deadline "$scheduler_spec")"
  if ! observed_json="$(gcloud scheduler jobs describe "$job_name" \
    --project="$GCP_PROJECT" \
    --location="$CLOUD_RUN_REGION" \
    --format="json(schedule,timeZone,attemptDeadline,retryConfig)")"; then
    echo "ERROR: Scheduler job '$job_name' could not be described while verifying binding config." >&2
    exit 1
  fi
  if ! jq -e \
    --arg schedule "$expected_schedule" \
    --arg time_zone "$expected_time_zone" \
    --arg attempt_deadline "$expected_attempt_deadline" \
    --arg min_backoff "$SCHEDULER_RETRY_MIN_BACKOFF" \
    --arg max_backoff "$SCHEDULER_RETRY_MAX_BACKOFF" \
    --arg max_doublings "$SCHEDULER_RETRY_MAX_DOUBLINGS" \
    '.schedule == $schedule
      and .timeZone == $time_zone
      and .attemptDeadline == $attempt_deadline
      and .retryConfig.minBackoffDuration == $min_backoff
      and .retryConfig.maxBackoffDuration == $max_backoff
      and (.retryConfig.maxDoublings | tostring) == $max_doublings' \
    >/dev/null <<<"$observed_json"; then
    echo "ERROR: Scheduler job '$job_name' binding config differs from its declared schedule/timezone/deadline/retry contract." >&2
    exit 1
  fi
}

sha256_file() {
  execute_sha256_checksum "$1"
}

resolve_driver_sha256() {
  if [[ ! -f "$DRIVER_PATH" ]]; then
    echo "ERROR: required staging driver '$DRIVER_PATH' does not exist." >&2
    exit 1
  fi
  if [[ $APPLY -eq 1 ]]; then
    if [[ ! "$DECLARED_DRIVER_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
      echo "ERROR: declared driver blob digest was not established by trusted Git admission." >&2
      exit 1
    fi
    printf '%s\n' "$DECLARED_DRIVER_SHA256"
    return 0
  fi
  sha256_file "$DRIVER_PATH"
}

resolve_cloud_run_url_for_service() {
  local service="$1"
  if [[ $APPLY -eq 1 ]]; then
    local url
    url="$(gcloud run services describe "$service" \
      --region="$CLOUD_RUN_REGION" \
      --project="$GCP_PROJECT" \
      --format="value(status.url)")"
    if [[ -z "$url" ]]; then
      echo "ERROR: could not resolve Cloud Run service URL for $service." >&2
      exit 1
    fi
    printf '%s\n' "$url"
    return 0
  fi

  printf '<captured-cloud-run-url-for-%s>\n' "$service"
}

resolve_cloud_run_url() {
  if [[ $APPLY -ne 1 && -n "${STAGING_RIG_TAG_URL:-}" ]]; then
    printf '%s\n' "$STAGING_RIG_TAG_URL"
    return 0
  fi
  resolve_cloud_run_url_for_service "$CLOUD_RUN_SERVICE"
}

wait_for_rig_r_runtime_ingress_readiness() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local timeout_seconds=300 interval_seconds=10
  local deadline_seconds=$((SECONDS + timeout_seconds))
  local attempt=0 remaining_seconds request_timeout_seconds
  local service_url identity_token probe_result probe_body http_status

  service_url="$(resolve_cloud_run_url_for_service "$CLOUD_RUN_SERVICE")"
  identity_token="$(gcloud auth print-identity-token \
    --impersonate-service-account="$RUNTIME_SA" \
    --audiences="$service_url")" || {
      echo "ERROR: could not obtain the exact RIG-R runtime ingress token." >&2
      return 1
    }
  if [[ -z "$identity_token" ]]; then
    echo "ERROR: exact RIG-R runtime ingress token was empty." >&2
    return 1
  fi

  while (( SECONDS < deadline_seconds )); do
    attempt=$((attempt + 1))
    remaining_seconds=$((deadline_seconds - SECONDS))
    request_timeout_seconds=$remaining_seconds
    (( request_timeout_seconds <= 20 )) || request_timeout_seconds=20
    if ! probe_result="$(/usr/bin/curl --silent --show-error \
      --connect-timeout 10 --max-time "$request_timeout_seconds" \
      --request GET "${service_url}/health" \
      --header "X-Serverless-Authorization: Bearer ${identity_token}" \
      --write-out $'\n%{http_code}' 2>/dev/null)"; then
      http_status="transport"
      probe_body=""
    else
      http_status="${probe_result##*$'\n'}"
      probe_body="${probe_result%$'\n'*}"
    fi

    if [[ "$http_status" == "200" ]]; then
      if jq -e --arg expected_sha "$DECLARED_SOURCE_HEAD" '
        type == "object"
        and .status == "healthy"
        and .checks.database == "ok"
        and .git_sha == $expected_sha
      ' >/dev/null 2>&1 <<<"$probe_body"; then
        unset identity_token probe_result probe_body
        echo "# RIG-R runtime ingress ready: exact principal reached exact candidate app after ${attempt} attempt(s)."
        return 0
      fi
      unset identity_token probe_result probe_body
      echo "ERROR: RIG-R runtime ingress reached an unexpected app identity or unhealthy response." >&2
      return 1
    fi

    case "$http_status" in
      transport|401|403|429|500|502|503|504)
        ;;
      *)
        unset identity_token probe_result probe_body
        echo "ERROR: RIG-R runtime ingress readiness returned terminal HTTP ${http_status}." >&2
        return 1
        ;;
    esac
    remaining_seconds=$((deadline_seconds - SECONDS))
    if (( remaining_seconds <= 0 )); then
      break
    fi
    echo "# RIG-R runtime ingress readiness waiting: attempt=${attempt} status=${http_status}" >&2
    (( remaining_seconds >= interval_seconds )) || interval_seconds=$remaining_seconds
    /bin/sleep "$interval_seconds"
  done

  unset identity_token probe_result probe_body
  echo "ERROR: RIG-R runtime ingress readiness exhausted its ${timeout_seconds}s deadline." >&2
  return 1
}

verify_rig_r_app_auth_boundary_pre_admission() {
  [[ $IS_RIG_R -eq 1 ]] || return 0
  local service_url identity_token probe_result probe_body http_status

  service_url="$(resolve_cloud_run_url_for_service "$CLOUD_RUN_SERVICE")"
  identity_token="$(gcloud auth print-identity-token \
    --impersonate-service-account="$RUNTIME_SA" \
    --audiences="$service_url")" || {
      echo "ERROR: could not obtain the exact RIG-R runtime token for app-boundary readiness." >&2
      return 1
    }
  if [[ -z "$identity_token" ]]; then
    echo "ERROR: exact RIG-R runtime app-boundary token was empty." >&2
    return 1
  fi

  if ! probe_result="$(/usr/bin/curl --silent --show-error \
    --connect-timeout 10 --max-time 20 \
    --request POST "${service_url}/api/v1/ai/template" \
    --header "X-Serverless-Authorization: Bearer ${identity_token}" \
    --header 'Content-Type: application/json' \
    --data-binary '{"fields":{},"confidence":1}' \
    --write-out $'\n%{http_code}' 2>/dev/null)"; then
    unset identity_token probe_result
    echo "ERROR: RIG-R pre-admission app-auth readiness transport failed." >&2
    return 1
  fi
  http_status="${probe_result##*$'\n'}"
  probe_body="${probe_result%$'\n'*}"
  if [[ "$http_status" != "401" ]] || ! jq -e '
    type == "object"
    and keys == ["error"]
    and .error == "Supabase JWT authentication required for this endpoint"
  ' >/dev/null 2>&1 <<<"$probe_body"; then
    unset identity_token probe_result probe_body
    echo "ERROR: RIG-R pre-admission app-auth boundary did not return the exact app-level 401." >&2
    return 1
  fi

  unset identity_token probe_result probe_body
  echo "# RIG-R pre-admission app-auth ready: DB gates passed and missing app JWT returned exact app-level 401."
}

g1_topology_json() {
  local _compatibility_project_ref="$1"
  if [[ $IS_G1_RIG -ne 1 ]]; then
    printf 'null\n'
    return 0
  fi

  local control_teardown tuned_teardown
  control_teardown="$(teardown_command_for_project_ref "$G1_CONTROL_PROJECT_REF")"
  tuned_teardown="$(teardown_command_for_project_ref "$G1_TUNED_PROJECT_REF")"
  jq -nc \
    --arg candidate_model_resource "$RIG_G1_CANDIDATE_MODEL_RESOURCE" \
    --arg candidate_model_version_resource "$RIG_G1_CANDIDATE_MODEL_VERSION_RESOURCE" \
    --arg checkpoint_id "$RIG_G1_CHECKPOINT_ID" \
    --arg corpus_digest "$G1_CORPUS_DIGEST" \
    --arg control_project_name "$G1_CONTROL_PROJECT_NAME" \
    --arg control_project_ref "$G1_CONTROL_PROJECT_REF" \
    --arg tuned_project_name "$G1_TUNED_PROJECT_NAME" \
    --arg tuned_project_ref "$G1_TUNED_PROJECT_REF" \
    --arg control_runtime_service_account "$G1_CONTROL_RUNTIME_SA" \
    --arg tuned_runtime_service_account "$G1_TUNED_RUNTIME_SA" \
    --arg control_runtime_unique_id "$G1_CONTROL_RUNTIME_SA_UNIQUE_ID" \
    --arg tuned_runtime_unique_id "$G1_TUNED_RUNTIME_SA_UNIQUE_ID" \
    --arg control_supabase_url_secret "${G1_CONTROL_SUPABASE_URL_SECRET}@1" \
    --arg control_supabase_role_secret "${G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET}@1" \
    --arg tuned_supabase_url_secret "${G1_TUNED_SUPABASE_URL_SECRET}@1" \
    --arg tuned_supabase_role_secret "${G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET}@1" \
    --arg stripe_secret_key_secret "${STRIPE_SECRET_KEY_SECRET}@${SHARED_STRIPE_SECRET_VERSION}" \
    --arg stripe_webhook_secret "${STRIPE_WEBHOOK_SECRET_SECRET}@${SHARED_STRIPE_WEBHOOK_VERSION}" \
    --arg api_key_hmac_secret "${API_KEY_HMAC_SECRET_SECRET}@${SHARED_API_KEY_HMAC_VERSION}" \
    --arg cron_secret "${CRON_SECRET_SECRET}@${SHARED_CRON_SECRET_VERSION}" \
    --arg gemini_api_key_secret "${GEMINI_API_KEY_SECRET}@${GEMINI_API_KEY_SECRET_VERSION}" \
    --arg immutable_ledger_bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
    --arg owner "$G1_OWNER" \
    --arg expires_at "$G1_EXPIRES_AT" \
    --arg stop_authority "$G1_STOP_AUTHORITY" \
    --arg teardown_owner "$G1_TEARDOWN_OWNER" \
    --argjson paired_cadence_max_min "$G1_PAIRED_CADENCE_MIN" \
    --argjson required_worker_uptime_min "$REQUIRED_UPTIME_MIN" \
    --argjson required_wall_min "$REQUIRED_WALL_MIN" \
    --argjson s33_total_cap_usd "$S33_COST_CAP_USD_JSON" \
    --argjson g1_variable_compute_model_cap_usd "$G1_COMPUTE_MODEL_CAP_USD_JSON" \
    --argjson isolated_project_count "$S33_ISOLATED_SUPABASE_PROJECT_COUNT" \
    --argjson isolated_project_monthly_each_usd "$S33_ISOLATED_SUPABASE_PROJECT_MONTHLY_EACH_USD" \
    --argjson isolated_projects_monthly_total_usd "$S33_ISOLATED_SUPABASE_PROJECTS_MONTHLY_TOTAL_USD" \
    --argjson spend_approval "$G1_SPEND_APPROVAL_JSON" \
    --argjson approval_claim "$G1_APPROVAL_CLAIM_JSON" \
    --argjson authority "$G1_AUTHORITY_JSON" \
    --argjson immutable_ledger_capability "$IMMUTABLE_LEDGER_CAPABILITY_JSON" \
    --arg control_service "$G1_CONTROL_SERVICE" \
    --arg tuned_service "$G1_TUNED_SERVICE" \
    --arg control_revision "$G1_CONTROL_DEPLOYED_REVISION" \
    --arg tuned_revision "$G1_TUNED_DEPLOYED_REVISION" \
    --arg control_url "$G1_CONTROL_TAG_URL" \
    --arg tuned_url "$G1_TUNED_TAG_URL" \
    --arg control_run_id "$G1_CONTROL_RUN_ID" \
    --arg tuned_run_id "$G1_TUNED_RUN_ID" \
    --arg control_queue "$G1_CONTROL_QUEUE" \
    --arg tuned_queue "$G1_TUNED_QUEUE" \
    --arg control_deployed_at "$G1_CONTROL_DEPLOYED_AT" \
    --arg tuned_deployed_at "$G1_TUNED_DEPLOYED_AT" \
    --arg control_clean_mirror_id "$G1_CONTROL_CLEAN_MIRROR_ATTESTATION_ID" \
    --arg tuned_clean_mirror_id "$G1_TUNED_CLEAN_MIRROR_ATTESTATION_ID" \
    --arg control_clean_mirror_at "$G1_CONTROL_PREFLIGHT_VERIFIED_AT" \
    --arg tuned_clean_mirror_at "$G1_TUNED_PREFLIGHT_VERIFIED_AT" \
    --arg control_clean_mirror_artifact "$G1_CONTROL_PREFLIGHT_ARTIFACT_PATH" \
    --arg tuned_clean_mirror_artifact "$G1_TUNED_PREFLIGHT_ARTIFACT_PATH" \
    --arg public_model "$RIG_G1_PUBLIC_MODEL" \
    --arg endpoint_id "$RIG_G1_ENDPOINT_ID" \
    --arg endpoint_resource "projects/arkova1/locations/us-central1/endpoints/${RIG_G1_ENDPOINT_ID}" \
    --arg endpoint_display_name "$RIG_G1_ENDPOINT_DISPLAY_NAME" \
    --arg deployed_model_id "$RIG_G1_DEPLOYED_MODEL_ID" \
    --arg deployed_model_display_name "$RIG_G1_DEPLOYED_MODEL_DISPLAY_NAME" \
    --arg deployment_resources_mode "$RIG_G1_DEPLOYMENT_RESOURCES_MODE" \
    --arg endpoint_iam_role "roles/aiplatform.endpointUser" \
    --arg endpoint_iam_member "serviceAccount:${G1_TUNED_RUNTIME_SA}" \
    --arg predict_probe_at "$G1_PREDICT_PROBE_AT" \
    --arg v6_prompt "$GEMINI_V6_PROMPT_VALUE" \
    --arg image "$PINNED_IMAGE" \
    --arg control_teardown "$control_teardown" \
    --arg tuned_teardown "$tuned_teardown" \
    --arg paired_deploy_delta_seconds "$G1_PAIRED_DEPLOY_DELTA_SECONDS" \
    --argjson min_replica_count "$RIG_G1_MIN_REPLICA_COUNT" \
    --argjson max_replica_count "$RIG_G1_MAX_REPLICA_COUNT" \
    '{
      candidate_model_resource: $candidate_model_resource,
      candidate_model_version_resource: $candidate_model_version_resource,
      checkpoint_id: $checkpoint_id,
      corpus_digest: $corpus_digest,
      tier: "T2",
      required_worker_uptime_min: $required_worker_uptime_min,
      required_wall_min: $required_wall_min,
      paired_cadence_max_min: $paired_cadence_max_min,
      execution_state: "PAUSED",
      background_execution: "disabled",
      actual_soak_clock: {
        status: "DEFERRED_CTO_AUTHORITY",
        control_started_at: null,
        tuned_started_at: null,
        deployment_timestamps_are_soak_clocks: false,
        prerequisite: "both physical clean-mirror attestations plus explicit CTO start authority",
        maximum_signed_start_delta_min: $paired_cadence_max_min
      },
      owner: $owner,
      expires_at: $expires_at,
      stop_authority: $stop_authority,
      teardown_owner: $teardown_owner,
      authority: $authority,
      budget: {
        s33_total_cap_usd: $s33_total_cap_usd,
        g1_variable_compute_model_cap_usd: $g1_variable_compute_model_cap_usd,
        isolated_supabase_project_count: $isolated_project_count,
        isolated_supabase_project_monthly_each_usd: $isolated_project_monthly_each_usd,
        isolated_supabase_projects_monthly_total_usd: $isolated_projects_monthly_total_usd
      },
      spend_approval: $spend_approval,
      approval_claim: $approval_claim,
      shared_secret_references: {
        stripe_secret_key: $stripe_secret_key_secret,
        stripe_webhook_secret: $stripe_webhook_secret,
        api_key_hmac_secret: $api_key_hmac_secret,
        cron_secret: $cron_secret,
        gemini_api_key: $gemini_api_key_secret
      },
      immutable_authority_ledger: {
        backend: "gcs-if-generation-match-0-locked-retention",
        bucket: $immutable_ledger_bucket,
        project_id: "arkova1",
        requires_per_object_retention: true,
        capability: $immutable_ledger_capability
      },
      shared_inputs: {
        image: $image,
        corpus_digest: $corpus_digest
      },
      arms: [
        {
          rig_id: "RIG-G1-A",
          arm: "public_control",
          supabase_project_name: $control_project_name,
          supabase_project_ref: $control_project_ref,
          service: $control_service,
          runtime_service_account: $control_runtime_service_account,
          runtime_service_account_unique_id: $control_runtime_unique_id,
          generated_secret_references: {
            supabase_url: $control_supabase_url_secret,
            supabase_service_role_key: $control_supabase_role_secret
          },
          revision: $control_revision,
          url: $control_url,
          deployed_at: $control_deployed_at,
          run_id: $control_run_id,
          queue: $control_queue,
          queue_binding: "external_harness",
          gemini_model: $public_model,
          gemini_tuned_model: "<unset>",
          gemini_v6_prompt: "<unset>",
          gemini_tuned_response_schema: "<unset>",
          vertex_endpoint: null,
          authenticated_capability_probe: {status: "NOT_APPLICABLE"},
          clean_mirror: {
            artifact: $control_clean_mirror_artifact,
            attestation_id: $control_clean_mirror_id,
            verified_at: $control_clean_mirror_at
          },
          teardown: {
            command: $control_teardown,
            default_mode: "dry-run",
            live_confirmation: ("CONFIRM_TEARDOWN=" + $control_project_ref)
          }
        },
        {
          rig_id: "RIG-G1-B",
          arm: "tuned_v6",
          supabase_project_name: $tuned_project_name,
          supabase_project_ref: $tuned_project_ref,
          service: $tuned_service,
          runtime_service_account: $tuned_runtime_service_account,
          runtime_service_account_unique_id: $tuned_runtime_unique_id,
          generated_secret_references: {
            supabase_url: $tuned_supabase_url_secret,
            supabase_service_role_key: $tuned_supabase_role_secret
          },
          revision: $tuned_revision,
          url: $tuned_url,
          deployed_at: $tuned_deployed_at,
          run_id: $tuned_run_id,
          queue: $tuned_queue,
          queue_binding: "external_harness",
          gemini_model: $public_model,
          gemini_tuned_model: $endpoint_resource,
          gemini_v6_prompt: $v6_prompt,
          gemini_tuned_response_schema: "<unset>",
          vertex_endpoint: {
            id: $endpoint_id,
            resource: $endpoint_resource,
            display_name: $endpoint_display_name,
            model_resource: $candidate_model_resource,
            model_version_resource: $candidate_model_version_resource,
            checkpoint_id: $checkpoint_id,
            deployed_model_id: $deployed_model_id,
            deployed_model_display_name: $deployed_model_display_name,
            deployment_resources_mode: $deployment_resources_mode,
            min_replica_count: $min_replica_count,
            max_replica_count: $max_replica_count,
            endpoint_iam_role: $endpoint_iam_role,
            endpoint_iam_member: $endpoint_iam_member
          },
          authenticated_capability_probe: {
            status: "PASSED_PRECLOCK_NO_CUSTOMER_DATA",
            verified_at: $predict_probe_at
          },
          clean_mirror: {
            artifact: $tuned_clean_mirror_artifact,
            attestation_id: $tuned_clean_mirror_id,
            verified_at: $tuned_clean_mirror_at
          },
          teardown: {
            command: $tuned_teardown,
            default_mode: "dry-run",
            live_confirmation: ("CONFIRM_TEARDOWN=" + $tuned_project_ref)
          }
        }
      ],
      paired_deploy_observation: {
        control_deployed_at: $control_deployed_at,
        tuned_deployed_at: $tuned_deployed_at,
        delta_seconds: ($paired_deploy_delta_seconds
          | if test("^[0-9]+$") then tonumber else . end),
        deploy_guard_only: true
      },
      teardown: {
        owner: $teardown_owner,
        physical_arm_commands: [$control_teardown, $tuned_teardown],
        default_mode: "dry-run",
        live_confirmation: "CONFIRM_TEARDOWN=<exact-project-ref>"
      }
    }'
}

rig_r_topology_json() {
  local supabase_project_ref="$1"
  if [[ $IS_RIG_R -ne 1 ]]; then
    printf 'null\n'
    return 0
  fi
  jq -nc \
    --arg candidate_head "$DECLARED_SOURCE_HEAD" \
    --arg candidate_tree "$RIG_R_CANDIDATE_TREE_SHA" \
    --arg provision_artifact_sha256 "$RIG_R_PROVISION_ARTIFACT_SHA256" \
    --arg provision_started_at "$RIG_R_PROVISION_STARTED_AT" \
    --arg expires_at "$RIG_R_EXPIRES_AT" \
    --arg endpoint "$RIG_R_VERTEX_ENDPOINT" \
    --arg vertex_model "$RIG_R_VERTEX_MODEL" \
    --arg deployed_model_id "$RIG_R_DEPLOYED_MODEL_ID" \
    --arg runtime_service_account "$RUNTIME_SA" \
    --arg runtime_impersonator_service_account "$RIG_R_OPERATOR_SA" \
    --arg runtime_impersonation_role "$RIG_R_RUNTIME_IMPERSONATION_ROLE" \
    --arg runtime_impersonation_member "$RIG_R_RUNTIME_IMPERSONATION_MEMBER" \
    --arg supabase_project_ref "$supabase_project_ref" \
    --arg lease_id "$LEASE_ID" \
    --arg lease_uri "$RIG_R_LEASE_URI" \
    --arg supabase_url_secret "$SUPABASE_URL_SECRET_NAME" \
    --arg supabase_service_role_secret "$SUPABASE_SERVICE_ROLE_SECRET_NAME" \
    --arg stripe_secret_key_secret "$STRIPE_SECRET_KEY_SECRET" \
    --arg stripe_webhook_secret "$STRIPE_WEBHOOK_SECRET_SECRET" \
    --arg api_key_hmac_secret "$API_KEY_HMAC_SECRET_SECRET" \
    --arg cron_secret "$CRON_SECRET_SECRET" \
    --arg gemini_api_key_secret "$GEMINI_API_KEY_SECRET" \
    --arg immutable_ledger_bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
    --arg teardown_command "$(teardown_command_for_project_ref "$supabase_project_ref")" \
    --argjson required_worker_uptime_min "$REQUIRED_UPTIME_MIN" \
    --argjson required_wall_min "$REQUIRED_WALL_MIN" \
    --argjson provision_approval "$RIG_R_PROVISION_APPROVAL_JSON" \
    --argjson approval_claim "$RIG_R_PROVISION_APPROVAL_CLAIM_JSON" \
    --argjson immutable_ledger_capability "$IMMUTABLE_LEDGER_CAPABILITY_JSON" '
      {
        candidate_head_sha: $candidate_head,
        candidate_tree_sha: $candidate_tree,
        provision_artifact_sha256: $provision_artifact_sha256,
        tier: "T3",
        required_worker_uptime_min: $required_worker_uptime_min,
        required_wall_min: $required_wall_min,
        provision_started_at: $provision_started_at,
        hard_stop_expires_at: $expires_at,
        cto_provision_authority_status: $provision_approval.status,
        provision_approval: $provision_approval,
        approval_claim: $approval_claim,
        project: "arkova1",
        region: "us-central1",
        supabase_project_name: "arkova-soak-s33-r",
        supabase_project_ref: $supabase_project_ref,
        cloud_run_service: "arkova-worker-s33-r-staging",
        runtime_service_account: $runtime_service_account,
        runtime_impersonator_service_account: $runtime_impersonator_service_account,
        runtime_impersonation_role: $runtime_impersonation_role,
        runtime_impersonation_member: $runtime_impersonation_member,
        secret_references: {
          supabase_url: $supabase_url_secret,
          supabase_service_role_key: $supabase_service_role_secret,
          stripe_secret_key: $stripe_secret_key_secret,
          stripe_webhook_secret: $stripe_webhook_secret,
          api_key_hmac_secret: $api_key_hmac_secret,
          cron_secret: $cron_secret,
          gemini_api_key: $gemini_api_key_secret
        },
        immutable_authority_ledger: {
          backend: "gcs-if-generation-match-0-locked-retention",
          bucket: $immutable_ledger_bucket,
          project_id: "arkova1",
          requires_per_object_retention: true,
          capability: $immutable_ledger_capability
        },
        vertex_endpoint: $endpoint,
        vertex_model: $vertex_model,
        deployed_model_id: $deployed_model_id,
        chain_mode: "mocked",
        contained_database_queues: ["ai-rollback", "chain-fault"],
        scheduler_jobs: [],
        managed_queues: [],
        oidc_identities: [],
        lease: {
          cardinality: 1,
          lease_id: $lease_id,
          object_uri: $lease_uri,
          object_name_is_code_fixed: true,
          acquisition: "gcs-singleton-if-generation-match-0",
          release: "ownership-verified-generation-bound-delete"
        },
        teardown: {
          command: $teardown_command,
          hard_stop_triggers_teardown: true,
          projected_monthly_recurring_usd: 0
        }
      }
    '
}

rig_b1_infrastructure_json() {
  if [[ "$RIG_ID" != "RIG-B1" ]]; then
    printf 'null\n'
    return 0
  fi
  local startup_sha="$RIG_B1_NODE_STARTUP_SCRIPT_SHA256"
  if [[ -z "$startup_sha" ]]; then
    startup_sha="$(execute_sha256_checksum "$RIG_B1_NODE_STARTUP_SCRIPT" 2>/dev/null || printf '%064d' 0)"
  fi
  jq -nc \
    --arg recipe_commit "$RIG_B1_BITCOIN_CORE_RECIPE_COMMIT" \
    --arg container_image "$RIG_B1_BITCOIN_CORE_IMAGE" \
    --arg amd64_runtime_digest "$RIG_B1_BITCOIN_CORE_AMD64_RUNTIME_DIGEST" \
    --arg startup_sha "$startup_sha" \
    --arg rpc_url_secret "$BITCOIN_CORE_RPC_URL_SECRET" \
    --arg rpc_url_version "$RIG_B1_RPC_URL_SECRET_VERSION" \
    --arg rpc_auth_secret "$BITCOIN_CORE_RPC_AUTH_SECRET" \
    --arg rpc_auth_version "$RIG_B1_RPC_AUTH_SECRET_VERSION" \
    --arg treasury_wif_secret "$TREASURY_WIF_SECRET" \
    --arg treasury_wif_version "$RIG_B1_TREASURY_WIF_SECRET_VERSION" \
    --arg treasury_address "$RIG_B1_TREASURY_ADDRESS" \
    --arg treasury_descriptor "$RIG_B1_TREASURY_DESCRIPTOR" \
    --arg split_txid "$RIG_B1_TREASURY_SPLIT_TXID" \
    --arg split_plan_digest "$RIG_B1_TREASURY_SPLIT_PLAN_DIGEST" \
    --arg service "$CLOUD_RUN_SERVICE" \
    --arg approval_id "$RIG_B1_APPROVAL_ID" \
    --arg approval_envelope_sha256 "$RIG_B1_APPROVAL_ENVELOPE_SHA256" \
    --arg approval_payload_sha256 "$RIG_B1_APPROVAL_PAYLOAD_SHA256" \
    --arg claim_backend "$(jq -r '.backend // empty' <<<"$RIG_B1_APPROVAL_CLAIM_JSON")" \
    --arg claim_object_uri "$(jq -r '.object_uri // empty' <<<"$RIG_B1_APPROVAL_CLAIM_JSON")" \
    --arg claim_generation "$(jq -r '.generation // empty' <<<"$RIG_B1_APPROVAL_CLAIM_JSON")" \
    --argjson node_readiness "$RIG_B1_NODE_READINESS_JSON" \
    --argjson expected_total_sats "${RIG_B1_TREASURY_EXPECTED_TOTAL_SATS:-0}" \
    --argjson spend_cap_usd "${RIG_B1_SPEND_CAP_USD:-0}" '
      {
        provider: {
          workerProvider: "rpc",
          primary: "bitcoin-core-signet-rpc",
          secondary: "mempool-space-signet",
          secondaryApiUrl: "https://mempool.space/signet/api"
        },
        bitcoinCore: {
          version: "31.1",
          recipeCommit: $recipe_commit,
          sourceTarballUrl: "https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz",
          sourceTarballSha256: "b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e",
          containerImage: $container_image,
          amd64RuntimeDigest: $amd64_runtime_digest,
          startupScriptPath: "scripts/staging/start-rig-b1-bitcoin-core.sh",
          startupScriptSha256: $startup_sha
        },
        resources: {
          zone: "us-central1-a",
          vm: "arkova-s33-rig-b1-bitcoin-core-signet",
          bootDisk: "arkova-s33-rig-b1-bitcoin-core-signet-boot",
          dataDisk: "arkova-s33-rig-b1-bitcoin-core-signet-data",
          internalAddress: "arkova-s33-rig-b1-bitcoin-core-signet-rpc-ip",
          externalAddress: "arkova-s33-rig-b1-bitcoin-core-signet-p2p-ip",
          network: "arkova-s33-rig-b1-bitcoin-core-signet-vpc",
          subnet: "arkova-s33-rig-b1-bitcoin-core-signet-subnet",
          rpcFirewall: "arkova-s33-rig-b1-bitcoin-core-signet-rpc",
          vpcConnector: "arkova-s33-rig-b1-bitcoin-core-signet-connector",
          nodeServiceAccount: "s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com"
        },
        schedulerJobs: [
          "\($service)-batch-anchors",
          "\($service)-batch-anchors-forced-flush",
          "\($service)-check-confirmations",
          "\($service)-org-queue-scheduler",
          "\($service)-populate-confirmation-proofs",
          "\($service)-recover-broadcasts"
        ],
        iam: {
          artifactRegistryReader: {
            repository: "projects/arkova1/locations/us-central1/repositories/arkova-worker-images",
            member: "serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com",
            role: "roles/artifactregistry.reader"
          },
          rpcAuthSecretAccessor: {
            secretName: "arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth",
            member: "serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com",
            role: "roles/secretmanager.secretAccessor"
          }
        },
        network: {
          rpcEndpoint: "http://10.33.10.10:38332",
          rpcBind: "10.33.10.10",
          rpcAllowCidr: "10.33.11.0/28",
          subnetCidr: "10.33.10.0/28",
          rpcPort: 38332,
          signetP2pPort: 38333,
          publicRpc: false
        },
        secretReferences: [
          {
            env: "BITCOIN_RPC_URL",
            secretName: $rpc_url_secret,
            version: $rpc_url_version,
            resource: "projects/arkova1/secrets/\($rpc_url_secret)/versions/\($rpc_url_version)"
          },
          {
            env: "BITCOIN_RPC_AUTH",
            secretName: $rpc_auth_secret,
            version: $rpc_auth_version,
            resource: "projects/arkova1/secrets/\($rpc_auth_secret)/versions/\($rpc_auth_version)"
          },
          {
            env: "BITCOIN_TREASURY_WIF",
            secretName: $treasury_wif_secret,
            version: $treasury_wif_version,
            resource: "projects/arkova1/secrets/\($treasury_wif_secret)/versions/\($treasury_wif_version)"
          }
        ],
        nodeSecretEnvs: ["BITCOIN_RPC_AUTH"],
        forbiddenNodeSecretEnvs: ["BITCOIN_TREASURY_WIF"],
        treasuryWatchOnly: {
          address: $treasury_address,
          descriptor: $treasury_descriptor,
          splitTransactionId: $split_txid,
          preSplitPlanDigest: $split_plan_digest,
          expectedConfirmedOutputCount: 32,
          expectedTotalSats: $expected_total_sats,
          descriptorPolicy: "addr-checksummed-importdescriptors",
          wifOnNode: false
        },
        nodeReadiness: $node_readiness,
        authority: {
          binding: "ed25519-signed-node-approval",
          approvalId: $approval_id,
          approvalEnvelopeSha256: $approval_envelope_sha256,
          signedPayloadSha256: $approval_payload_sha256,
          spendCapUsd: $spend_cap_usd,
          claim: {
            backend: $claim_backend,
            objectUri: $claim_object_uri,
            generation: $claim_generation
          }
        },
        teardown: {
          orderedResources: [
            "scheduler-jobs", "cloud-run-service", "bitcoin-core-vm", "boot-disk", "data-disk",
            "external-address", "internal-address", "rpc-firewall", "vpc-connector",
            "subnet", "vpc-network", "artifact-registry-iam", "node-secret-iam", "node-service-account",
            "worker-secret-iam", "worker-runtime-service-account",
            "scheduler-oidc-service-account", "supabase-project"
          ],
          projectedMonthlyRecurringUsd: 0
        }
      }
    '
}

b1_observed_identity() {
  local label="$1"
  local jq_filter="$2"
  shift 2
  local observed identity
  if ! observed="$("$@")" \
    || ! identity="$(jq -er "$jq_filter" <<<"$observed")" \
    || [[ -z "$identity" ]]; then
    echo "ERROR: RIG-B1 could not observe exact $label identity for immutable ownership." >&2
    return 1
  fi
  printf '%s\n' "$identity"
}

publish_rig_b1_topology_ownership() {
  [[ "$RIG_ID" == "RIG-B1" ]] || return 0
  local resources secrets scheduler_names generated_secrets service_url node_readiness
  local cloud_run_uid vm_id boot_disk_id data_disk_id internal_address_id external_address_id
  local firewall_id connector_name subnet_id network_id node_sa_uid worker_sa_uid scheduler_sa_uid
  local object_name payload payload_temp metadata generation observed_payload

  resources="$(jq -c '.payload.topology.resources' <<<"$RIG_B1_NODE_APPROVAL_JSON")"
  secrets="$(jq -c '.payload.topology.secretReferences' <<<"$RIG_B1_NODE_APPROVAL_JSON")"
  scheduler_names="$(jq -c '.payload.topology.schedulerJobs' <<<"$RIG_B1_NODE_APPROVAL_JSON")"
  generated_secrets="$(jq -nc \
      --arg url "$SUPABASE_URL_SECRET_NAME" \
      --arg role "$SUPABASE_SERVICE_ROLE_SECRET_NAME" '[$url, $role]')"
  if ! node_readiness="$(jq -ce \
    'select(.schemaVersion == "arkova.s33.rig-b1.node-readiness/v1")' \
    <<<"$RIG_B1_NODE_READINESS_JSON" 2>/dev/null)"; then
    echo "ERROR: RIG-B1 immutable topology publication requires the verified pre-worker node readiness marker." >&2
    return 1
  fi
  service_url="$(resolve_cloud_run_url_for_service "$CLOUD_RUN_SERVICE")"

  cloud_run_uid="$(b1_observed_identity "Cloud Run service UID" \
    '.metadata.uid | select(type == "string" and test("^[A-Za-z0-9-]{8,}$"))' \
    gcloud run services describe "$CLOUD_RUN_SERVICE" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)" || return 1
  vm_id="$(b1_observed_identity "VM ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute instances describe "$RIG_B1_NODE_VM" --project="$GCP_PROJECT" \
    --zone="$RIG_B1_NODE_ZONE" --format=json)" || return 1
  boot_disk_id="$(b1_observed_identity "boot disk ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute disks describe "$RIG_B1_NODE_BOOT_DISK" --project="$GCP_PROJECT" \
    --zone="$RIG_B1_NODE_ZONE" --format=json)" || return 1
  data_disk_id="$(b1_observed_identity "data disk ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute disks describe "$RIG_B1_NODE_DATA_DISK" --project="$GCP_PROJECT" \
    --zone="$RIG_B1_NODE_ZONE" --format=json)" || return 1
  internal_address_id="$(b1_observed_identity "internal address ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute addresses describe "$RIG_B1_NODE_INTERNAL_ADDRESS" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)" || return 1
  external_address_id="$(b1_observed_identity "external address ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute addresses describe "$RIG_B1_NODE_EXTERNAL_ADDRESS" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)" || return 1
  firewall_id="$(b1_observed_identity "RPC firewall ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute firewall-rules describe "$RIG_B1_NODE_RPC_FIREWALL" --project="$GCP_PROJECT" \
    --format=json)" || return 1
  connector_name="$(b1_observed_identity "VPC connector name" \
    '.name | select(type == "string" and test("^projects/arkova1/locations/us-central1/connectors/arkova-s33-rig-b1-bitcoin-core-signet-connector$"))' \
    gcloud compute networks vpc-access connectors describe "$RIG_B1_NODE_VPC_CONNECTOR" \
    --project="$GCP_PROJECT" --region="$CLOUD_RUN_REGION" --format=json)" || return 1
  subnet_id="$(b1_observed_identity "subnet ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute networks subnets describe "$RIG_B1_NODE_SUBNET" --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" --format=json)" || return 1
  network_id="$(b1_observed_identity "network ID" '(.id | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud compute networks describe "$RIG_B1_NODE_NETWORK" --project="$GCP_PROJECT" \
    --format=json)" || return 1
  node_sa_uid="$(b1_observed_identity "node service-account unique ID" \
    '(.uniqueId | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud iam service-accounts describe "$RIG_B1_NODE_SERVICE_ACCOUNT" \
    --project="$GCP_PROJECT" --format=json)" || return 1
  worker_sa_uid="$(b1_observed_identity "worker service-account unique ID" \
    '(.uniqueId | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud iam service-accounts describe "$RUNTIME_SA" \
    --project="$GCP_PROJECT" --format=json)" || return 1
  scheduler_sa_uid="$(b1_observed_identity "Scheduler service-account unique ID" \
    '(.uniqueId | tostring) | select(test("^[1-9][0-9]*$"))' \
    gcloud iam service-accounts describe "$CRON_OIDC_SA" \
    --project="$GCP_PROJECT" --format=json)" || return 1

  object_name="${RIG_B1_TOPOLOGY_LEDGER_PREFIX}/${RIG_B1_APPROVAL_ID}.json"
  RIG_B1_TOPOLOGY_OWNERSHIP_URI="gs://${IMMUTABLE_AUTHORITY_LEDGER_BUCKET}/${object_name}"
  payload="$(jq -nc \
    --arg approval_id "$RIG_B1_APPROVAL_ID" \
    --arg envelope_sha "$RIG_B1_APPROVAL_ENVELOPE_SHA256" \
    --arg payload_sha "$RIG_B1_APPROVAL_PAYLOAD_SHA256" \
    --arg source_head "$DECLARED_SOURCE_HEAD" \
    --arg source_tree "$RIG_B1_CANDIDATE_TREE_SHA" \
    --arg corpus "$RIG_B1_CORPUS_DIGEST" \
    --arg rc_id "$RIG_B1_RELEASE_CANDIDATE_ID" \
    --arg soak_id "$SOAK_ID" --arg lease_id "$LEASE_ID" \
    --arg project_ref "$NEW_PROJECT_REF" \
    --arg service "$CLOUD_RUN_SERVICE" \
    --arg runtime_sa "$RUNTIME_SA" --arg scheduler_sa "$CRON_OIDC_SA" \
    --arg service_url "$service_url" \
    --arg cloud_run_uid "$cloud_run_uid" --arg vm_id "$vm_id" \
    --arg boot_disk_name "$RIG_B1_NODE_BOOT_DISK" --arg boot_disk_id "$boot_disk_id" \
    --arg data_disk_id "$data_disk_id" --arg internal_address_id "$internal_address_id" \
    --arg external_address_id "$external_address_id" --arg firewall_id "$firewall_id" \
    --arg connector_name "$connector_name" --arg subnet_id "$subnet_id" --arg network_id "$network_id" \
    --arg node_sa_uid "$node_sa_uid" --arg worker_sa_uid "$worker_sa_uid" \
    --arg scheduler_sa_uid "$scheduler_sa_uid" \
    --arg claim_uri "$(jq -r '.object_uri' <<<"$RIG_B1_APPROVAL_CLAIM_JSON")" \
    --arg claim_generation "$(jq -r '.generation' <<<"$RIG_B1_APPROVAL_CLAIM_JSON")" \
    --argjson resources "$resources" --argjson secrets "$secrets" \
    --argjson scheduler_names "$scheduler_names" --argjson generated_secrets "$generated_secrets" \
    --argjson node_readiness "$node_readiness" '
      {
        schemaVersion: "arkova.s33.rig-b1.topology-ownership/v1",
        approvalId: $approval_id,
        envelopeSha256: $envelope_sha,
        signedPayloadSha256: $payload_sha,
        sourceHeadSha: $source_head,
        sourceTreeSha: $source_tree,
        corpusDigest: $corpus,
        releaseCandidateId: $rc_id,
        rigId: "RIG-B1",
        rigName: "s33-rig-b1",
        soakId: $soak_id,
        leaseId: $lease_id,
        gcpProjectId: "arkova1",
        gcpRegion: "us-central1",
        supabaseProjectRef: $project_ref,
        supabaseProjectName: "arkova-soak-s33-rig-b1",
        workerService: $service,
        workerRuntimeServiceAccount: $runtime_sa,
        schedulerOidcServiceAccount: $scheduler_sa,
        cloudRunServiceUrl: $service_url,
        resources: $resources,
        secretReferences: $secrets,
        schedulerJobNames: $scheduler_names,
        generatedSecretNames: $generated_secrets,
        nodeReadiness: $node_readiness,
        resourceIdentities: {
          cloudRunServiceUid: $cloud_run_uid,
          vmId: $vm_id,
          bootDiskName: $boot_disk_name,
          bootDiskId: $boot_disk_id,
          dataDiskId: $data_disk_id,
          internalAddressId: $internal_address_id,
          externalAddressId: $external_address_id,
          rpcFirewallId: $firewall_id,
          vpcConnectorName: $connector_name,
          subnetId: $subnet_id,
          networkId: $network_id,
          nodeServiceAccountUniqueId: $node_sa_uid,
          workerRuntimeServiceAccountUniqueId: $worker_sa_uid,
          schedulerOidcServiceAccountUniqueId: $scheduler_sa_uid
        },
        approvalClaim: {objectUri: $claim_uri, generation: $claim_generation},
        projectedMonthlyRecurringUsd: 0
      }
    ')" || return 1
  umask 077
  payload_temp="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/arkova-b1-topology.XXXXXX")" || return 1
  if ! printf '%s\n' "$payload" >"$payload_temp" \
    || ! gcloud storage cp "$payload_temp" "$RIG_B1_TOPOLOGY_OWNERSHIP_URI" \
      --project="$GCP_PROJECT" --if-generation-match=0 --content-type=application/json \
      --retain-until="$RIG_B1_APPROVAL_EXPIRES_AT" --retention-mode=Locked --quiet; then
    rm -f -- "$payload_temp"
    echo "ERROR: RIG-B1 immutable topology ownership could not be created exactly once." >&2
    return 1
  fi
  rm -f -- "$payload_temp"
  if ! metadata="$(gcloud storage objects describe "$RIG_B1_TOPOLOGY_OWNERSHIP_URI" \
    --project="$GCP_PROJECT" --raw --format=json)" \
    || ! jq -e --arg bucket "$IMMUTABLE_AUTHORITY_LEDGER_BUCKET" \
      --arg name "$object_name" --arg expires_at "$RIG_B1_APPROVAL_EXPIRES_AT" '
        def utc_epoch:
          if type != "string"
            or (test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|\\+00:00)$") | not)
          then error("timestamp is not canonical UTC")
          else
            sub("\\+00:00$"; "Z")
            | sub("\\.[0-9]{1,9}Z$"; "Z")
            | fromdateiso8601
          end;
        .bucket == $bucket and .name == $name
        and (.generation | tostring | test("^[1-9][0-9]*$"))
        and (.retention | type == "object")
        and .retention.mode == "Locked"
        and (.retention.retainUntilTime | type == "string")
        and ((.retention.retainUntilTime | utc_epoch) >= ($expires_at | utc_epoch))
      ' >/dev/null 2>&1 <<<"$metadata"; then
    echo "ERROR: RIG-B1 immutable topology ownership metadata did not re-observe exactly." >&2
    return 1
  fi
  generation="$(jq -r '.generation | tostring' <<<"$metadata")"
  if ! observed_payload="$(gcloud storage cat "${RIG_B1_TOPOLOGY_OWNERSHIP_URI}#${generation}" \
    --project="$GCP_PROJECT")" \
    || [[ "$(jq -cS . <<<"$observed_payload" 2>/dev/null)" != "$(jq -cS . <<<"$payload")" ]]; then
    echo "ERROR: RIG-B1 immutable topology ownership content did not re-bind exactly." >&2
    return 1
  fi
  RIG_B1_TOPOLOGY_OWNERSHIP_GENERATION="$generation"
  RIG_B1_TOPOLOGY_OWNERSHIP_JSON="$payload"
  write_provision_state "b1_immutable_topology_ownership_published" ""
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
    --arg rig_id "$RIG_ID" \
    --arg profile "$PROFILE" \
    --arg soak_id "$SOAK_ID" \
    --arg lease_id "$LEASE_ID" \
    --arg gcp_project_id "$GCP_PROJECT" \
    --arg supabase_org_id "$SUPABASE_ORG" \
    --arg region "$CLOUD_RUN_REGION" \
    --arg cloud_run_service "$cloud_run_service" \
    --arg tier "$TIER" \
    --argjson duration_min "$DURATION_MIN" \
    --argjson required_uptime_min "$REQUIRED_UPTIME_MIN" \
    --argjson required_wall_min "$REQUIRED_WALL_MIN" \
    --arg sha "$head_sha" \
    --arg declared_source_head "$DECLARED_SOURCE_HEAD" \
    --arg source_head_image_ref "$SOURCE_HEAD_IMAGE_REF" \
    --arg source_head_image_digest "$SOURCE_HEAD_IMAGE_DIGEST" \
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
    --arg clean_mirror_attestation_id "$CLEAN_MIRROR_ATTESTATION_ID" \
    --arg node_env "$ADMISSION_NODE_ENV" \
    --arg enable_ai_extraction "$ADMISSION_ENABLE_AI_EXTRACTION" \
    --arg enable_vertex_ai "$ADMISSION_ENABLE_VERTEX_AI" \
    --arg db_enable_verification_api "$ADMISSION_DB_ENABLE_VERIFICATION_API" \
    --arg db_enable_ai_extraction "$ADMISSION_DB_ENABLE_AI_EXTRACTION" \
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
    --arg scheduler_activation_mode "$SCHEDULER_ACTIVATION_MODE" \
    --arg scheduler_state "$SCHEDULER_STATE" \
    --arg scheduler_creation_guard "$SCHEDULER_CREATION_GUARD" \
    --argjson scheduler_jobs "$(scheduler_jobs_json)" \
    --arg driver_path "$driver_path" \
    --arg driver_sha256 "$driver_sha256" \
    --arg changed_behavior "$changed_behavior" \
    --arg harness_version "$driver_path@$(short_sha "$head_sha")" \
    --arg tool_version "scripts/staging/provision-isolated-rig.sh@$(short_sha "$head_sha")" \
    --arg owner "$owner" \
    --argjson g1_topology "$(g1_topology_json "$supabase_project_ref")" \
    --argjson rig_r_topology "$(rig_r_topology_json "$supabase_project_ref")" \
    --argjson rig_b1_infrastructure "$(rig_b1_infrastructure_json)" \
    '{
      schema_version: $schema_version,
      kind: $kind,
      generated_at: $generated_at,
      rig_name: $rig_name,
      rig_id: $rig_id,
      profile: $profile,
      soak_id: $soak_id,
      lease_id: $lease_id,
      gcp_project_id: $gcp_project_id,
      supabase_org_id: $supabase_org_id,
      region: $region,
      cloud_run_service: $cloud_run_service,
      tier: $tier,
      duration_min: $duration_min,
      required_uptime_min: $required_uptime_min,
      required_wall_min: $required_wall_min,
      sha: $sha,
      declared_source_head: $declared_source_head,
      source_head_image_ref: $source_head_image_ref,
      source_head_image_digest: $source_head_image_digest,
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
      clean_mirror_attestation_id: $clean_mirror_attestation_id,
      clean_mirror: {
        result: $preflight_result,
        artifact: $preflight_artifact,
        verified_at: $preflight_verified_at,
        attestation_id: $clean_mirror_attestation_id
      },
      critical_config: ({
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
      } + (if $rig_id == "RIG-R" then {
        enable_ai_extraction: $enable_ai_extraction,
        enable_vertex_ai: $enable_vertex_ai,
        db_enable_verification_api: $db_enable_verification_api,
        db_enable_ai_extraction: $db_enable_ai_extraction
      } else {} end)),
      scheduler: {
        applicable: $scheduler_applicable,
        jobs: $scheduler_jobs,
        creation_guard: $scheduler_creation_guard,
        paused_through_clean_mirror: $scheduler_paused_through_clean_mirror,
        activation_mode: $scheduler_activation_mode,
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
        "rig_id or lease_id mismatch against the declared run",
        "base SHA drift with runtime/schema/staging/deploy impact",
        "image digest mismatch against deployed Cloud Run revision",
        "source image repository differs from the approved Arkova worker repository",
        "dirty preflight (environment_type != clean_mirror)",
        "clean_mirror attestation hash mismatch against sanitized artifact bytes",
        "required worker uptime or wall-clock floor not met",
        "Supabase project ref resolves to prod or shared staging",
        "RIG-B1 Supabase organization differs from the approved organization",
        "Cloud Run service/tag URL points at shared/main staging",
        "driver_path or driver_sha256 mismatch",
        "soak harness exits non-zero or fails required duration"
      ]
    }
    + (if $g1_topology == null then {} else {g1: $g1_topology} end)
    + (if $rig_r_topology == null then {} else {rig_r: $rig_r_topology} end)
    + (if $rig_b1_infrastructure == null then {} else {infrastructure: $rig_b1_infrastructure} end)'
}

persist_admission_artifact() {
  local raw="$1"
  mkdir -p "$STAGING_ADMISSION_DIR"
  if [[ -e "$ADMISSION_ARTIFACT_PATH" && ! -f "$ADMISSION_ARTIFACT_PATH" ]]; then
    echo "ERROR: admission artifact target is not a regular file: '$ADMISSION_ARTIFACT_PATH'." >&2
    return 1
  fi
  rm -f -- "$ADMISSION_TEMP_PATH"
  if ! printf '%s\n' "$raw" | jq . >"$ADMISSION_TEMP_PATH"; then
    rm -f -- "$ADMISSION_TEMP_PATH"
    echo "ERROR: could not serialize the final admission artifact." >&2
    return 1
  fi
  if ! mv -f -- "$ADMISSION_TEMP_PATH" "$ADMISSION_ARTIFACT_PATH"; then
    rm -f -- "$ADMISSION_TEMP_PATH"
    echo "ERROR: could not atomically install the final admission artifact." >&2
    return 1
  fi
  if [[ ! -f "$ADMISSION_ARTIFACT_PATH" ]]; then
    echo "ERROR: final admission artifact did not persist as a regular file." >&2
    return 1
  fi
  ADMISSION_ARTIFACT_PERSISTED=1
}

# ---------------------------------------------------------------------------
# Plan header.
# ---------------------------------------------------------------------------
echo "S0-4.1 isolated soak-rig provision"
echo "rig name:          $NAME"
echo "rig id:            $RIG_ID"
echo "lease id:          $LEASE_ID"
echo "profile:           $PROFILE"
echo "required uptime:   $REQUIRED_UPTIME_MIN min"
echo "required wall:     $REQUIRED_WALL_MIN min"
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
if [[ $IS_RIG_R -eq 1 ]]; then
  echo "Vertex endpoint:   $RIG_R_VERTEX_ENDPOINT"
  echo "Vertex model:      $RIG_R_VERTEX_MODEL"
  echo "Deployed model id: $RIG_R_DEPLOYED_MODEL_ID"
  echo "DB queues:         ai-rollback, chain-fault (contained by isolated project)"
  echo "managed topology:  Scheduler=0, managed-queue=0, OIDC=0"
  echo "authority hard stop: $RIG_R_EXPIRES_AT"
  echo "exclusive lease:   $RIG_R_LEASE_URI"
fi
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
G1_CONTROL_CREATE_CMD=(npx supabase projects create "$G1_CONTROL_PROJECT_NAME" --org-id "$SUPABASE_ORG" --region "$SUPABASE_REGION")
G1_TUNED_CREATE_CMD=(npx supabase projects create "$G1_TUNED_PROJECT_NAME" --org-id "$SUPABASE_ORG" --region "$SUPABASE_REGION")
if [[ $APPLY -eq 1 ]]; then
  claim_b1_node_approval_once
  claim_g1_spend_approval_once
  claim_rig_r_provision_approval_once
  # Persist every deterministic cleanup target and exact delete command before
  # the first paid/cloud mutation. Every later state rewrite carries the same
  # cleanup block, including failures during either G1 deploy or verification.
  write_provision_state "pre_mutation_cleanup_plan_persisted" ""
  if [[ $IS_RIG_R -eq 1 ]]; then
    assert_rig_r_frozen_operator_identity
    if gcloud iam service-accounts describe "$RUNTIME_SA" \
      --project="$GCP_PROJECT" >/dev/null 2>&1; then
      echo "ERROR: RIG-R runtime service account already exists; refusing ownership ambiguity." >&2
      exit 2
    fi
    claim_rig_r_lease_once
    run_cmd gcloud iam service-accounts create "${RUNTIME_SA%@*}" \
      --project="$GCP_PROJECT" \
      --display-name="S3.3 RIG-R temporary runtime"
    CREATED_RUNTIME_SA=1
    wait_for_rig_r_runtime_identity_visibility
    write_provision_state "rig_r_runtime_identity_visible" ""
    grant_rig_r_runtime_impersonation
    write_provision_state "rig_r_runtime_impersonation_bound" ""
    for runtime_role in "${RIG_R_RUNTIME_ROLES[@]}"; do
      grant_rig_r_runtime_project_role_with_propagation_retry "$runtime_role"
    done
    write_provision_state "rig_r_lease_and_runtime_identity_created" ""
  fi
else
  if [[ $IS_RIG_R -eq 1 ]]; then
    echo "# Step 0/6 — atomically claim one exclusive RIG-R lease and create one temporary runtime identity"
    print_cmd gcloud storage cp '<canonical-rig-r-lease-payload>' "$RIG_R_LEASE_URI" \
      --project="$GCP_PROJECT" --if-generation-match=0 --content-type=application/json --quiet
    print_cmd gcloud iam service-accounts create "${RUNTIME_SA%@*}" \
      --project="$GCP_PROJECT" --display-name="S3.3 RIG-R temporary runtime"
    print_cmd gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --member="$RIG_R_RUNTIME_IMPERSONATION_MEMBER" \
      --role="$RIG_R_RUNTIME_IMPERSONATION_ROLE" --condition=None --quiet
    print_cmd gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" \
      --project="$GCP_PROJECT" --format=json
    for runtime_role in "${RIG_R_RUNTIME_ROLES[@]}"; do
      print_cmd gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
        --member="serviceAccount:${RUNTIME_SA}" --role="$runtime_role" --condition=None --quiet
    done
  fi
fi
if [[ $IS_G1_RIG -eq 1 ]]; then
  print_cmd "${G1_CONTROL_CREATE_CMD[@]}" --db-password '<redacted:STAGING_G1_A_SUPABASE_DB_PASSWORD>' --output json
  print_cmd "${G1_TUNED_CREATE_CMD[@]}" --db-password '<redacted:STAGING_G1_B_SUPABASE_DB_PASSWORD>' --output json
else
  print_cmd "${CREATE_CMD[@]}" --db-password '<redacted:STAGING_NEW_SUPABASE_DB_PASSWORD>' --output json
fi
if [[ $APPLY -eq 1 ]]; then
  if [[ $IS_G1_RIG -eq 1 ]]; then
    G1_CONTROL_PROJECT_REF="$(create_supabase_project_ref \
      STAGING_G1_A_SUPABASE_DB_PASSWORD "$G1_CONTROL_DB_PASSWORD" \
      "$G1_CONTROL_PROJECT_NAME" "${G1_CONTROL_CREATE_CMD[@]}")"
    if [[ ! "$G1_CONTROL_PROJECT_REF" =~ ^[a-z]{20}$ \
      || "$G1_CONTROL_PROJECT_REF" == "$PROD_SUPABASE_REF" \
      || "$G1_CONTROL_PROJECT_REF" == "$SHARED_STAGING_SUPABASE_REF" ]]; then
      echo "ERROR: RIG-G1-A project creation did not return one safe isolated 20-letter ref." >&2
      exit 1
    fi
    CREATED_PROJECT_REF="$G1_CONTROL_PROJECT_REF"
    NEW_PROJECT_REF="$G1_CONTROL_PROJECT_REF"
    write_provision_state "g1_a_project_created_pending_readiness" ""
    wait_for_supabase_project_ready "$G1_CONTROL_PROJECT_REF" "$G1_CONTROL_PROJECT_NAME"
    write_provision_state "g1_a_project_ready_for_schema" ""

    G1_TUNED_PROJECT_REF="$(create_supabase_project_ref \
      STAGING_G1_B_SUPABASE_DB_PASSWORD "$G1_TUNED_DB_PASSWORD" \
      "$G1_TUNED_PROJECT_NAME" "${G1_TUNED_CREATE_CMD[@]}")"
    if [[ ! "$G1_TUNED_PROJECT_REF" =~ ^[a-z]{20}$ \
      || "$G1_TUNED_PROJECT_REF" == "$PROD_SUPABASE_REF" \
      || "$G1_TUNED_PROJECT_REF" == "$SHARED_STAGING_SUPABASE_REF" \
      || "$G1_TUNED_PROJECT_REF" == "$G1_CONTROL_PROJECT_REF" ]]; then
      echo "ERROR: RIG-G1-B project creation did not return a distinct safe isolated 20-letter ref." >&2
      echo "       RIG-G1-A remains recorded in $PROVISION_STATE_PATH for immediate teardown." >&2
      exit 1
    fi
    write_provision_state "g1_a_and_g1_b_projects_created_pending_readiness" ""
    wait_for_supabase_project_ready "$G1_TUNED_PROJECT_REF" "$G1_TUNED_PROJECT_NAME"
    write_provision_state "g1_a_and_g1_b_projects_ready_for_schema" ""
    echo "captured distinct RIG-G1 refs A=$G1_CONTROL_PROJECT_REF B=$G1_TUNED_PROJECT_REF" >&2
  else
    # Capture the new ref so links/pushes/preflight target the validated project.
    NEW_PROJECT_REF="$(create_supabase_project_ref \
      STAGING_NEW_SUPABASE_DB_PASSWORD "$SUPABASE_DB_PASSWORD" \
      "$PROJECT_NAME" "${CREATE_CMD[@]}")"
    if [[ ! "$NEW_PROJECT_REF" =~ ^[a-z]{20}$ ]]; then
      echo "ERROR: created Supabase project ref must be exactly 20 lowercase letters; got '$NEW_PROJECT_REF'." >&2
      exit 1
    fi
    if [[ "$NEW_PROJECT_REF" == "$PROD_SUPABASE_REF" || "$NEW_PROJECT_REF" == "$SHARED_STAGING_SUPABASE_REF" ]]; then
      deny "created/resolved ref '$NEW_PROJECT_REF' is prod/shared — aborting before any schema push."
    fi
    CREATED_PROJECT_REF="$NEW_PROJECT_REF"
    echo "captured NEW_PROJECT_REF=$NEW_PROJECT_REF" >&2
    write_provision_state "project_created_pending_readiness" ""
    wait_for_supabase_project_ready "$NEW_PROJECT_REF" "$PROJECT_NAME"
    write_provision_state "project_ready_for_schema" ""
  fi
else
  echo "#   -> apply captures and deny-validates every physical project ref before schema work."
  if [[ $IS_G1_RIG -eq 1 ]]; then
    echo "#   -> RIG-G1-A and RIG-G1-B are two distinct projects; one signed orchestrator claim binds both."
  fi
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
if [[ $IS_G1_RIG -eq 1 ]]; then
  run_cmd_with_db_password STAGING_G1_A_SUPABASE_DB_PASSWORD "$G1_CONTROL_DB_PASSWORD" \
    npx supabase link --project-ref "$G1_CONTROL_PROJECT_REF"
  run_cmd_with_db_password STAGING_G1_A_SUPABASE_DB_PASSWORD "$G1_CONTROL_DB_PASSWORD" \
    npx supabase db push --linked
  run_cmd_with_db_password STAGING_G1_B_SUPABASE_DB_PASSWORD "$G1_TUNED_DB_PASSWORD" \
    npx supabase link --project-ref "$G1_TUNED_PROJECT_REF"
  run_cmd_with_db_password STAGING_G1_B_SUPABASE_DB_PASSWORD "$G1_TUNED_DB_PASSWORD" \
    npx supabase db push --linked
  # Restore the control project as the compatibility link; arm operations below
  # always pass their exact refs and never infer ownership from this link.
  run_cmd_with_db_password STAGING_G1_A_SUPABASE_DB_PASSWORD "$G1_CONTROL_DB_PASSWORD" \
    npx supabase link --project-ref "$G1_CONTROL_PROJECT_REF"
else
  run_cmd_with_db_password STAGING_NEW_SUPABASE_DB_PASSWORD "$SUPABASE_DB_PASSWORD" \
    npx supabase link --project-ref "$NEW_PROJECT_REF"
  if [[ $IS_RIG_R -eq 1 ]]; then
    run_rig_r_schema_push_with_deadlock_retry
  else
    run_cmd_with_db_password STAGING_NEW_SUPABASE_DB_PASSWORD "$SUPABASE_DB_PASSWORD" \
      npx supabase db push --linked
  fi
fi
echo

echo "# Step 2b/6 — create/record per-rig Supabase Secret Manager secrets"
provision_g1_runtime_identities
if [[ $APPLY -eq 1 ]]; then
  if [[ $IS_G1_RIG -eq 1 ]]; then
    SUPABASE_URL_SECRET_NAME="$G1_CONTROL_SUPABASE_URL_SECRET"
    SUPABASE_SERVICE_ROLE_SECRET_NAME="$G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET"
    create_supabase_runtime_secrets "$G1_CONTROL_PROJECT_REF"
    SUPABASE_URL_SECRET_NAME="$G1_TUNED_SUPABASE_URL_SECRET"
    SUPABASE_SERVICE_ROLE_SECRET_NAME="$G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET"
    create_supabase_runtime_secrets "$G1_TUNED_PROJECT_REF"
    SUPABASE_URL_SECRET_NAME="$G1_CONTROL_SUPABASE_URL_SECRET"
    SUPABASE_SERVICE_ROLE_SECRET_NAME="$G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET"
    write_provision_state "g1_distinct_project_secrets_created" ""
  else
    create_supabase_runtime_secrets "$NEW_PROJECT_REF"
  fi
  grant_g1_runtime_secret_access
  grant_rig_r_runtime_secret_access
else
  if [[ $IS_G1_RIG -eq 1 ]]; then
    print_cmd npx supabase projects api-keys --project-ref "$G1_CONTROL_PROJECT_REF" --output json
    print_cmd gcloud secrets create "$G1_CONTROL_SUPABASE_URL_SECRET" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
    print_cmd gcloud secrets create "$G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
    print_cmd npx supabase projects api-keys --project-ref "$G1_TUNED_PROJECT_REF" --output json
    print_cmd gcloud secrets create "$G1_TUNED_SUPABASE_URL_SECRET" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
    print_cmd gcloud secrets create "$G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
  else
    print_cmd npx supabase projects api-keys --project-ref "$NEW_PROJECT_REF" --output json
    print_cmd gcloud secrets create "$SUPABASE_URL_SECRET_NAME" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
    print_cmd gcloud secrets create "$SUPABASE_SERVICE_ROLE_SECRET_NAME" --project="$GCP_PROJECT" --replication-policy=automatic --data-file=-
  fi
  grant_g1_runtime_secret_access
  grant_rig_r_runtime_secret_access
  echo "#   apply mode derives https://<captured-ref>.supabase.co, fetches the service-role key,"
  echo "#   writes both per-rig secrets, verifies latest versions are readable, and records"
  echo "#   the secret names in $PROVISION_STATE_PATH before Cloud Run deploy."
fi
echo

provision_temporary_vertex_endpoint

provision_rig_b1_bitcoin_core_node
wait_for_rig_b1_node_readiness

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
if [[ $IS_G1_RIG -eq 1 ]]; then
  echo "# Step 3/6 — deploy physical RIG-G1-A + RIG-G1-B on one pinned image/corpus (PAUSED)"
  echo "#   public/control env-vars: $WORKER_ENV_VARS"
  EXPECTED_RUNTIME_SA_FOR_REVISION="$G1_CONTROL_RUNTIME_SA"
  run_cmd gcloud run deploy "$G1_CONTROL_SERVICE" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --image="$PINNED_IMAGE" \
    --labels="arkova-source-head=${DECLARED_SOURCE_HEAD},arkova-rig-id=rig-g1,arkova-g1-arm=public-control" \
    --service-account="$G1_CONTROL_RUNTIME_SA" \
    --allow-unauthenticated \
    --min-instances=0 \
    --max-instances=2 \
    --memory=1Gi \
    --cpu=1 \
    --timeout=300 \
    --set-env-vars="$WORKER_ENV_VARS" \
    --set-secrets="$G1_CONTROL_WORKER_SECRETS"
  if [[ $APPLY -eq 1 ]]; then
    CREATED_CLOUD_RUN_SERVICE=1
    CLOUD_RUN_SERVICE="$G1_CONTROL_SERVICE"
    ENV_VARS=("${G1_CONTROL_ENV_VARS[@]}")
    EXPECTED_REVISION_SECRETS=("${G1_CONTROL_SECRET_ENTRIES[@]}")
    verify_deployed_revision_provenance
    G1_CONTROL_DEPLOYED_REVISION="$DEPLOYED_REVISION"
    G1_CONTROL_TAG_URL="$(resolve_cloud_run_url_for_service "$G1_CONTROL_SERVICE")"
    G1_CONTROL_START_EPOCH="$(date -u +%s)"
    G1_CONTROL_DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    write_provision_state "g1_a_deployed_provenance_verified" ""
  fi

  echo "#   tuned-v6 env-vars: $G1_TUNED_WORKER_ENV_VARS"
  EXPECTED_RUNTIME_SA_FOR_REVISION="$G1_TUNED_RUNTIME_SA"
  run_cmd gcloud run deploy "$G1_TUNED_SERVICE" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --image="$PINNED_IMAGE" \
    --labels="arkova-source-head=${DECLARED_SOURCE_HEAD},arkova-rig-id=rig-g1,arkova-g1-arm=tuned-v6" \
    --service-account="$G1_TUNED_RUNTIME_SA" \
    --allow-unauthenticated \
    --min-instances=0 \
    --max-instances=2 \
    --memory=1Gi \
    --cpu=1 \
    --timeout=300 \
    --set-env-vars="$G1_TUNED_WORKER_ENV_VARS" \
    --set-secrets="$G1_TUNED_WORKER_SECRETS"
  if [[ $APPLY -eq 1 ]]; then
    CLOUD_RUN_SERVICE="$G1_TUNED_SERVICE"
    ENV_VARS=("${G1_TUNED_ENV_VARS[@]}")
    EXPECTED_REVISION_SECRETS=("${G1_TUNED_SECRET_ENTRIES[@]}")
    verify_deployed_revision_provenance
    G1_TUNED_DEPLOYED_REVISION="$DEPLOYED_REVISION"
    G1_TUNED_TAG_URL="$(resolve_cloud_run_url_for_service "$G1_TUNED_SERVICE")"
    G1_TUNED_START_EPOCH="$(date -u +%s)"
    G1_TUNED_DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    G1_PAIRED_DEPLOY_DELTA_SECONDS="$((10#$G1_TUNED_START_EPOCH - 10#$G1_CONTROL_START_EPOCH))"
    if (( G1_PAIRED_DEPLOY_DELTA_SECONDS < 0 \
      || G1_PAIRED_DEPLOY_DELTA_SECONDS > 10#$G1_PAIRED_CADENCE_MIN * 60 )); then
      echo "ERROR: RIG-G1 physical service deploys exceeded the signed <=${G1_PAIRED_CADENCE_MIN} minute pairing window." >&2
      echo "       This is only a deploy guard; actual soak clocks remain CTO-gated after both clean mirrors." >&2
      write_provision_state "g1_paired_deploy_window_failed" "paired physical deploy delta exceeded"
      exit 1
    fi

    # Restore the top-level compatibility fields to the public/control arm.
    CLOUD_RUN_SERVICE="$G1_CONTROL_SERVICE"
    ENV_VARS=("${G1_CONTROL_ENV_VARS[@]}")
    EXPECTED_REVISION_SECRETS=("${G1_CONTROL_SECRET_ENTRIES[@]}")
    WORKER_ENV_VARS="$(join_by_comma "${ENV_VARS[@]}")"
    DEPLOYED_REVISION="$G1_CONTROL_DEPLOYED_REVISION"
    ADMISSION_GEMINI_TUNED_MODEL=""
    ADMISSION_GEMINI_V6_PROMPT=""
    EXPECTED_RUNTIME_SA_FOR_REVISION="$G1_CONTROL_RUNTIME_SA"
    write_provision_state "g1_arm_provenance_verified_paused" ""
  fi
else
  echo "# Step 3/6 — deploy isolated worker '$CLOUD_RUN_SERVICE' on pinned image (profile=$PROFILE)"
  echo "#   env-vars: $WORKER_ENV_VARS"
  RUNTIME_LABELS="arkova-source-head=${DECLARED_SOURCE_HEAD}"
  if [[ $IS_RIG_R -eq 1 ]]; then
    RUNTIME_LABELS="${RUNTIME_LABELS},arkova-source-tree=${RIG_R_CANDIDATE_TREE_SHA},arkova-rig-id=rig-r"
  fi
  EXPECTED_RUNTIME_SA_FOR_REVISION="$RUNTIME_SA"
  run_cmd gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --project="$GCP_PROJECT" \
    --region="$CLOUD_RUN_REGION" \
    --image="$PINNED_IMAGE" \
    --labels="$RUNTIME_LABELS" \
    --service-account="$RUNTIME_SA" \
    --no-allow-unauthenticated \
    --min-instances=0 \
    --max-instances=2 \
    --memory=1Gi \
    --cpu=1 \
    --timeout=300 \
    ${CLOUD_RUN_NETWORK_ARGS[@]+"${CLOUD_RUN_NETWORK_ARGS[@]}"} \
    --set-env-vars="$WORKER_ENV_VARS" \
    --set-secrets="$WORKER_SECRETS"
  if [[ $APPLY -eq 1 ]]; then
    CREATED_CLOUD_RUN_SERVICE=1
    verify_deployed_revision_provenance
    write_provision_state "cloud_run_provenance_verified" ""
  fi
fi
if [[ $IS_RIG_R -eq 1 ]]; then
  echo "#   grant the exact RIG-R runtime principal service-scoped invoker"
  run_cmd gcloud run services add-iam-policy-binding "$CLOUD_RUN_SERVICE" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/run.invoker" \
    --region="$CLOUD_RUN_REGION" \
    --project="$GCP_PROJECT" \
    --condition=None \
    --quiet
  if [[ $APPLY -eq 1 ]]; then
    write_provision_state "rig_r_service_invoker_bound" ""
    wait_for_rig_r_runtime_ingress_readiness
    write_provision_state "rig_r_runtime_ingress_ready" ""
  else
    echo "#   apply only: poll /health with the exact runtime principal until Cloud Run IAM reaches the exact candidate app"
  fi
fi
if [[ $IS_MOCK_PROFILE -ne 1 && $IS_G1_RIG -ne 1 && $IS_RIG_R -ne 1 ]]; then
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
if [[ $IS_MOCK_PROFILE -eq 1 || $IS_G1_RIG -eq 1 || $IS_RIG_R -eq 1 ]]; then
  if [[ $IS_G1_RIG -eq 1 ]]; then
    echo "#   RIG-G1 — external A/B harness only; Scheduler and in-process background execution remain disabled."
  elif [[ $IS_RIG_R -eq 1 ]]; then
    echo "#   RIG-R — release driver only; zero Scheduler jobs and zero OIDC identities."
  else
  echo "#   profile=mock — no behavioral cron to drive; skipping Scheduler job creation."
  fi
else
  # WORKER_URL: apply mode resolves the REAL URL from the service deployed in
  # Step 3 (gcloud run services describe); dry-run keeps the clearly-labeled
  # <captured-cloud-run-url-…> placeholder. Both paths live in
  # resolve_cloud_run_url() — no hand-built URL, no stale placeholder.
  WORKER_URL="$(resolve_cloud_run_url)"
  if [[ $APPLY -eq 1 ]]; then
    # Fetch the exact runtime-bound cron secret VERSION from Secret Manager so the
    # Scheduler POST passes the worker's cronAuth. The value stays in memory:
    # every printed/logged command form is redacted (run_cmd_cron_redacted).
    CRON_SECRET_VALUE="$(gcloud secrets versions access "$CRON_SECRET_VERSION" \
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
  if [[ $APPLY -eq 1 ]]; then
    # From the first create attempt through final admission persistence, any
    # failure re-pauses and re-verifies the complete declared job set. This
    # contains partial resume and post-resume artifact/state failures.
    SCHEDULER_FAILURE_CONTAINMENT_ARMED=1
  fi
  for scheduler_spec in "${SCHEDULER_JOB_SPECS[@]}"; do
    [[ -z "$scheduler_spec" ]] && continue
    scheduler_job_name="$(scheduler_job_name_for_spec "$scheduler_spec")"
    scheduler_request_path="$(scheduler_spec_path "$scheduler_spec")"
    scheduler_time_zone="$(scheduler_spec_time_zone "$scheduler_spec")"
    scheduler_attempt_deadline="$(scheduler_spec_attempt_deadline "$scheduler_spec")"
    run_cmd_cron_redacted gcloud scheduler jobs create http "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" \
      --schedule="$SCHEDULER_HOLD_SCHEDULE" \
      --time-zone="$scheduler_time_zone" \
      --attempt-deadline="$scheduler_attempt_deadline" \
      --min-backoff="$SCHEDULER_RETRY_MIN_BACKOFF" \
      --max-backoff="$SCHEDULER_RETRY_MAX_BACKOFF" \
      --max-doublings="$SCHEDULER_RETRY_MAX_DOUBLINGS" \
      --uri="${WORKER_URL}${scheduler_request_path}" \
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
if [[ "$RIG_ID" == "RIG-B1" ]]; then
  if [[ $APPLY -eq 1 ]]; then
    publish_rig_b1_topology_ownership
  else
    print_cmd gcloud storage cp '<exact-observed-rig-b1-topology-ownership>' \
      "gs://${IMMUTABLE_AUTHORITY_LEDGER_BUCKET}/${RIG_B1_TOPOLOGY_LEDGER_PREFIX}/<approval-id>.json" \
      --project="$GCP_PROJECT" --if-generation-match=0 \
      --content-type=application/json --retain-until='<signed-expiry>' --retention-mode=Locked --quiet
  fi
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
if [[ $IS_G1_RIG -eq 1 ]]; then
  run_cmd_with_db_password STAGING_G1_A_SUPABASE_DB_PASSWORD "$G1_CONTROL_DB_PASSWORD" \
    npx supabase link --project-ref "$G1_CONTROL_PROJECT_REF"
  run_cmd npx supabase db query --linked --file scripts/staging/seed-baseline-fixture.sql
  run_cmd_with_db_password STAGING_G1_B_SUPABASE_DB_PASSWORD "$G1_TUNED_DB_PASSWORD" \
    npx supabase link --project-ref "$G1_TUNED_PROJECT_REF"
  run_cmd npx supabase db query --linked --file scripts/staging/seed-baseline-fixture.sql
  run_cmd_with_db_password STAGING_G1_A_SUPABASE_DB_PASSWORD "$G1_CONTROL_DB_PASSWORD" \
    npx supabase link --project-ref "$G1_CONTROL_PROJECT_REF"
else
  run_cmd_with_db_password STAGING_NEW_SUPABASE_DB_PASSWORD "$SUPABASE_DB_PASSWORD" \
    npx supabase link --project-ref "$NEW_PROJECT_REF"
  run_cmd npx supabase db query --linked --file scripts/staging/seed-baseline-fixture.sql
  if [[ $IS_RIG_R -eq 1 ]]; then
    echo "#   RIG-R — enable and independently read back both DB gates required before JWT auth"
    run_cmd npx supabase db query --linked --file scripts/staging/seed-rig-r-release-switchboard.sql
    ADMISSION_DB_ENABLE_VERIFICATION_API="true"
    ADMISSION_DB_ENABLE_AI_EXTRACTION="true"
    if [[ $APPLY -eq 1 ]]; then
      write_provision_state "rig_r_release_switchboard_verified" ""
      verify_rig_r_app_auth_boundary_pre_admission
      write_provision_state "rig_r_app_auth_boundary_ready" ""
    else
      echo "#   apply only: exact runtime principal POST /api/v1/ai/template without app JWT must return the exact app-level 401"
    fi
  fi
fi

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
  if [[ $IS_G1_RIG -eq 1 ]]; then
    PREFLIGHT_TARGETS=("$G1_CONTROL_PROJECT_REF" "$G1_TUNED_PROJECT_REF")
  else
    PREFLIGHT_TARGETS=("$NEW_PROJECT_REF")
  fi
  for PREFLIGHT_TARGET_REF in "${PREFLIGHT_TARGETS[@]}"; do
    NEW_PROJECT_REF="$PREFLIGHT_TARGET_REF"
    if [[ $IS_G1_RIG -eq 1 && "$PREFLIGHT_TARGET_REF" == "$G1_CONTROL_PROJECT_REF" ]]; then
      PREFLIGHT_ARTIFACT_PATH="$G1_CONTROL_PREFLIGHT_ARTIFACT_PATH"
      PREFLIGHT_SERVICE_ROLE_SECRET_NAME="$G1_CONTROL_SUPABASE_SERVICE_ROLE_SECRET"
      run_cmd_with_db_password STAGING_G1_A_SUPABASE_DB_PASSWORD "$G1_CONTROL_DB_PASSWORD" \
        npx supabase link --project-ref "$PREFLIGHT_TARGET_REF"
    elif [[ $IS_G1_RIG -eq 1 ]]; then
      PREFLIGHT_ARTIFACT_PATH="$G1_TUNED_PREFLIGHT_ARTIFACT_PATH"
      PREFLIGHT_SERVICE_ROLE_SECRET_NAME="$G1_TUNED_SUPABASE_SERVICE_ROLE_SECRET"
      run_cmd_with_db_password STAGING_G1_B_SUPABASE_DB_PASSWORD "$G1_TUNED_DB_PASSWORD" \
        npx supabase link --project-ref "$PREFLIGHT_TARGET_REF"
    else
      PREFLIGHT_SERVICE_ROLE_SECRET_NAME="$SUPABASE_SERVICE_ROLE_SECRET_NAME"
      run_cmd_with_db_password STAGING_NEW_SUPABASE_DB_PASSWORD "$SUPABASE_DB_PASSWORD" \
        npx supabase link --project-ref "$PREFLIGHT_TARGET_REF"
    fi
  print_cmd npx tsx scripts/ci/staging-honesty-preflight.ts \
    --project-ref "$NEW_PROJECT_REF" \
    --format json
  echo "executing: npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref $NEW_PROJECT_REF --format json" >&2
  PREFLIGHT_JSON="$(run_staging_honesty_preflight_with_generated_service_role \
    "$NEW_PROJECT_REF" "$PREFLIGHT_SERVICE_ROLE_SECRET_NAME")"
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
  CLEAN_MIRROR_ATTESTATION_ID="sha256:$(sha256_file "$PREFLIGHT_ARTIFACT_PATH")"
  if [[ ! "$CLEAN_MIRROR_ATTESTATION_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: could not derive clean_mirror attestation identity from sanitized artifact bytes." >&2
    exit 1
  fi
  if [[ $IS_G1_RIG -eq 1 && "$PREFLIGHT_TARGET_REF" == "$G1_CONTROL_PROJECT_REF" ]]; then
    G1_CONTROL_CLEAN_MIRROR_ATTESTATION_ID="$CLEAN_MIRROR_ATTESTATION_ID"
    G1_CONTROL_PREFLIGHT_VERIFIED_AT="$PREFLIGHT_VERIFIED_AT"
  elif [[ $IS_G1_RIG -eq 1 ]]; then
    G1_TUNED_CLEAN_MIRROR_ATTESTATION_ID="$CLEAN_MIRROR_ATTESTATION_ID"
    G1_TUNED_PREFLIGHT_VERIFIED_AT="$PREFLIGHT_VERIFIED_AT"
  fi

  # Re-observe every declared trigger after both seed and clean_mirror. The
  # initial pause check cannot prove this interval; an enabled, missing, or
  # partially-created job fails before any cadence update or resume.
  if [[ $SCHEDULER_APPLICABLE_JSON == true ]]; then
    SCHEDULER_STATE="post_clean_mirror_pause_verification_pending"
    for scheduler_spec in "${SCHEDULER_JOB_SPECS[@]}"; do
      [[ -z "$scheduler_spec" ]] && continue
      scheduler_job_name="$(scheduler_job_name_for_spec "$scheduler_spec")"
      verify_scheduler_job_state "$scheduler_job_name" "PAUSED"
    done
    SCHEDULER_PAUSED_THROUGH_CLEAN_MIRROR_JSON=true
    SCHEDULER_STATE="clean_mirror_admitted_scheduler_paused"
  fi
  if [[ $SCHEDULER_APPLICABLE_JSON == true ]]; then
    write_provision_state "clean_mirror_admitted_scheduler_paused" ""
  else
    write_provision_state "clean_mirror_admitted" ""
  fi
  done
  if [[ $IS_G1_RIG -eq 1 ]]; then
    NEW_PROJECT_REF="$G1_CONTROL_PROJECT_REF"
    PREFLIGHT_ARTIFACT_PATH="${STAGING_ADMISSION_DIR%/}/clean-mirror-preflight-${NAME}.json"
    jq -nc \
      --arg a_ref "$G1_CONTROL_PROJECT_REF" --arg a_id "$G1_CONTROL_CLEAN_MIRROR_ATTESTATION_ID" \
      --arg a_path "$G1_CONTROL_PREFLIGHT_ARTIFACT_PATH" --arg a_at "$G1_CONTROL_PREFLIGHT_VERIFIED_AT" \
      --arg b_ref "$G1_TUNED_PROJECT_REF" --arg b_id "$G1_TUNED_CLEAN_MIRROR_ATTESTATION_ID" \
      --arg b_path "$G1_TUNED_PREFLIGHT_ARTIFACT_PATH" --arg b_at "$G1_TUNED_PREFLIGHT_VERIFIED_AT" '
        {
          environment_type: "clean_mirror_pair",
          physical_projects: [
            {rig: "RIG-G1-A", project_ref: $a_ref, artifact: $a_path, attestation_id: $a_id, verified_at: $a_at},
            {rig: "RIG-G1-B", project_ref: $b_ref, artifact: $b_path, attestation_id: $b_id, verified_at: $b_at}
          ]
        }
      ' | jq . >"$PREFLIGHT_ARTIFACT_PATH"
    CLEAN_MIRROR_ATTESTATION_ID="sha256:$(sha256_file "$PREFLIGHT_ARTIFACT_PATH")"
    PREFLIGHT_VERIFIED_AT="$G1_TUNED_PREFLIGHT_VERIFIED_AT"
    PREFLIGHT_RESULT="environment_type=clean_mirror_pair"
    write_provision_state "g1_both_physical_clean_mirrors_admitted" ""
  fi
else
  if [[ $IS_G1_RIG -eq 1 ]]; then
    run_cmd npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref "$G1_CONTROL_PROJECT_REF" --format json
    run_cmd npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref "$G1_TUNED_PROJECT_REF" --format json
  else
    run_cmd npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref "$NEW_PROJECT_REF" --format json
  fi
fi
echo

# Prepare each isolated job's final cadence after clean_mirror while retaining
# PAUSED. RIG-B1 is always prepared at the CTO's exact five-minute isolated-rig
# cadence; every other profile restores its production-equivalent cadence. This
# provisioner never resumes Scheduler traffic. The separate B1 start controller
# must re-observe the immutable admission/pre-clock packet and all six PAUSED
# bindings before activation. Shared production identities are never referenced.
if [[ $IS_MOCK_PROFILE -ne 1 && $IS_G1_RIG -ne 1 && $IS_RIG_R -ne 1 ]]; then
  if [[ "$RIG_ID" == "RIG-B1" ]]; then
    echo "# Post-admission — prepare exact five-minute RIG-B1 cadence and retain PAUSED"
  else
    echo "# Post-admission — restore production-equivalent cadence and retain PAUSED"
  fi
  for scheduler_spec in "${SCHEDULER_JOB_SPECS[@]}"; do
    [[ -z "$scheduler_spec" ]] && continue
    scheduler_job_name="$(scheduler_job_name_for_spec "$scheduler_spec")"
    if [[ "$RIG_ID" == "RIG-B1" ]]; then
      scheduler_schedule="$SCHEDULER_ACCELERATED_SCHEDULE"
    else
      scheduler_schedule="$(scheduler_spec_production_schedule "$scheduler_spec")"
    fi
    scheduler_time_zone="$(scheduler_spec_time_zone "$scheduler_spec")"
    scheduler_attempt_deadline="$(scheduler_spec_attempt_deadline "$scheduler_spec")"
    run_cmd gcloud scheduler jobs update http "$scheduler_job_name" \
      --project="$GCP_PROJECT" \
      --location="$CLOUD_RUN_REGION" \
      --schedule="$scheduler_schedule" \
      --time-zone="$scheduler_time_zone" \
      --attempt-deadline="$scheduler_attempt_deadline" \
      --min-backoff="$SCHEDULER_RETRY_MIN_BACKOFF" \
      --max-backoff="$SCHEDULER_RETRY_MAX_BACKOFF" \
      --max-doublings="$SCHEDULER_RETRY_MAX_DOUBLINGS"
    if [[ $APPLY -eq 1 ]]; then
      verify_scheduler_job_state "$scheduler_job_name" "PAUSED"
    else
      print_cmd gcloud scheduler jobs describe "$scheduler_job_name" \
        --project="$GCP_PROJECT" \
        --location="$CLOUD_RUN_REGION" \
        --format="value(state)"
    fi
    if [[ $APPLY -eq 1 ]]; then
      verify_scheduler_job_config "$scheduler_spec" "$scheduler_schedule"
    else
      print_cmd gcloud scheduler jobs describe "$scheduler_job_name" \
        --project="$GCP_PROJECT" \
        --location="$CLOUD_RUN_REGION" \
        --format="json(schedule,timeZone,attemptDeadline,retryConfig)"
    fi
  done
  SCHEDULER_STATE="paused_after_clean_mirror"
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
  CHANGED_BEHAVIOR="PR #1408 chain resilience: bounded retry/backoff, Bitcoin Core RPC/mempool.space duplicate and retry classification, and confirmation-proof transient-to-pending vs definitive-to-stale behavior"
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
if [[ $APPLY -eq 1 ]]; then
  persist_admission_artifact "$ADMISSION_JSON"
  if [[ $SCHEDULER_APPLICABLE_JSON == true ]]; then
    if [[ "$SCHEDULER_ACTIVATION_MODE" == "FORCE_ACCELERATED_RIG_ONLY" ]]; then
      write_provision_state "admission_persisted_scheduler_enabled" ""
    else
      write_provision_state "admission_persisted_scheduler_paused" ""
    fi
  else
    write_provision_state "admission_persisted" ""
  fi
  ADMISSION_FINALIZED=1
  trap - EXIT
fi
echo "ADMISSION_JSON=$ADMISSION_JSON"
