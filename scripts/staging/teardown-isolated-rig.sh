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

# ---------------------------------------------------------------------------
# Defaults (overridable via flags / env).
# ---------------------------------------------------------------------------
GCP_PROJECT="${STAGING_GCP_PROJECT:-arkova1}"
CLOUD_RUN_REGION="${STAGING_CLOUD_RUN_REGION:-us-central1}"

PROJECT_REF=""
SERVICES=()
RIG_NAME=""
APPLY=0
FLAG_ONLY=0

usage() {
  sed -n '2,44p' "$0"
  echo
  echo "Usage: $0 --project-ref <ref> --service <arkova-worker-*-staging> [--service <second-service>]"
  echo "          [--rig-name <rig-name>] [--apply] [--flag-only]"
  echo "          [--gcp-project arkova1] [--gcp-region us-central1]"
  echo
  echo "Live run also requires: CONFIRM_TEARDOWN=<ref> matching --project-ref."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-ref) PROJECT_REF="${2:?}"; shift 2 ;;
    --service) SERVICES+=("${2:?}"); shift 2 ;;
    --rig-name) RIG_NAME="${2:?}"; shift 2 ;;
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
