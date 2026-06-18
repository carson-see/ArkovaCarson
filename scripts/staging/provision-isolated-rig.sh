#!/usr/bin/env bash
# scripts/staging/provision-isolated-rig.sh — S0-4.1 (epic S0-E4).
#
# One-command provision of a CLEAN, ISOLATED soak rig for a parallel T3 soak:
#   1. Create a standalone Supabase project (region us-east-2, PG 17.x) — NOT a
#      preview branch off prod (the lettered-suffix builder bug; see
#      docs/reference/STAGING_RIG.md "Why a standalone project").
#   2. Replay the repo schema onto it via `npx supabase db push --linked`.
#   3. Deploy a wired `arkova-worker-<name>-staging` Cloud Run service on the
#      prod-pinned image with the staging env deltas (USE_MOCKS=true,
#      ENABLE_PROD_NETWORK_ANCHORING=false) — zero real Bitcoin exposure.
#   4. Run scripts/ci/staging-honesty-preflight.ts and require `clean_mirror`.
#
# SAFETY MODEL (CLAUDE.md §1.11A — the whole point of this script):
#   * --dry-run is the DEFAULT. With no flags the script PRINTS the plan and
#     mutates NOTHING (no gcloud/supabase/MCP create calls run).
#   * A real run requires BOTH:
#       --apply
#       CONFIRM_PROVISION=<project-name>   (must match --name exactly)
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

NAME=""
APPLY=0

usage() {
  sed -n '2,38p' "$0"
  echo
  echo "Usage: $0 --name <rig-name> [--apply] [--region us-east-2] [--gcp-region us-central1]"
  echo "          [--image <ref>] [--org <supabase-org>] [--gcp-project arkova1]"
  echo
  echo "Live run also requires: CONFIRM_PROVISION=<rig-name> matching --name."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:?}"; shift 2 ;;
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

# ---------------------------------------------------------------------------
# Plan header.
# ---------------------------------------------------------------------------
echo "S0-4.1 isolated soak-rig provision"
echo "rig name:          $NAME"
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
echo "# Step 1/4 — create standalone Supabase project (cost-gated; \$10/mo Pro)"
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
echo "# Step 2/4 — link to the captured ref + replay repo schema (CLI parser, lettered-suffix safe)"
run_cmd npx supabase link --project-ref "$NEW_PROJECT_REF"
echo "#   bootstrap extensions + enum pre-adds (see STAGING_RIG.md) via MCP execute_sql / Mgmt API"
echo "#   db push --linked now targets the just-linked $NEW_PROJECT_REF (validated above)."
run_cmd npx supabase db push --linked
echo

# ---------------------------------------------------------------------------
# Step 3 — deploy the wired isolated Cloud Run worker on the pinned image.
#
# Staging env deltas (STAGING_RIG.md "env-var deltas"): NODE_ENV=production
# (Zod rejects 'staging'), USE_MOCKS=true, ENABLE_PROD_NETWORK_ANCHORING=false,
# AI fraud/reports off, IAM-protected, min=0/max=2. The worker points at the
# NEW project's own secrets — never the prod secrets and never shared staging's.
# ---------------------------------------------------------------------------
echo "# Step 3/4 — deploy isolated worker '$CLOUD_RUN_SERVICE' on pinned image"
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
  --set-env-vars="NODE_ENV=production,USE_MOCKS=true,ENABLE_PROD_NETWORK_ANCHORING=false,ENABLE_AI_FRAUD=false,ENABLE_AI_REPORTS=false,CORS_ALLOWED_ORIGINS=https://app.arkova.ai" \
  --set-secrets="SUPABASE_URL=supabase-url-${NAME}-staging:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key-${NAME}-staging:latest"
echo "#   NOTE: create the supabase-url-${NAME}-staging + supabase-service-role-key-${NAME}-staging"
echo "#         secrets from the NEW project's keys (MCP get_publishable_keys) FIRST."
echo

# ---------------------------------------------------------------------------
# Step 4 — clean_mirror preflight against the NEW project.
#
# This MUST report environment_type=clean_mirror before the rig is declared
# soak-ready (CLAUDE.md §1.11A). Exit non-zero from the preflight aborts here
# under set -e in --apply mode.
# ---------------------------------------------------------------------------
echo "# Step 4/4 — clean_mirror preflight (CLAUDE.md §1.11A)"
run_cmd npx tsx scripts/ci/staging-honesty-preflight.ts \
  --project-ref "$NEW_PROJECT_REF" \
  --format text
echo
echo "# Provision plan complete."
if [[ $APPLY -eq 1 ]]; then
  echo "# Verify the preflight printed environment_type=clean_mirror above."
  echo "# Record NEW_PROJECT_REF, service URL, image digest, and preflight result"
  echo "# into the rig inventory (see the 'Isolated Soak-Rig Automation Runbook'"
  echo "# Google Doc in Drive ARKOVA PI-1-S0:"
  echo "#   https://docs.google.com/document/d/1c0F_9NSy9ldfeR28xlY7s7zFFwKpS8cmTzvhI9dI__E/edit )."
else
  echo "# (dry-run — nothing was created)"
fi
