#!/usr/bin/env bash
# scripts/staging/teardown-isolated-rig.sh — S0-4.1 (epic S0-E4).
#
# Reclaims an isolated soak rig provisioned by provision-isolated-rig.sh:
#   1. Delete the isolated Cloud Run worker service.
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
SERVICE=""
APPLY=0
FLAG_ONLY=0

usage() {
  sed -n '2,44p' "$0"
  echo
  echo "Usage: $0 --project-ref <ref> --service <arkova-worker-*-staging> [--apply] [--flag-only]"
  echo "          [--gcp-project arkova1] [--gcp-region us-central1]"
  echo
  echo "Live run also requires: CONFIRM_TEARDOWN=<ref> matching --project-ref."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-ref) PROJECT_REF="${2:?}"; shift 2 ;;
    --service) SERVICE="${2:?}"; shift 2 ;;
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
if [[ -z "$PROJECT_REF" || -z "$SERVICE" ]]; then
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
for denied in "${DENIED_CLOUD_RUN_SERVICES[@]}"; do
  if [[ "$SERVICE" == "$denied" ]]; then
    deny "--service '$SERVICE' is a shared/prod Cloud Run service."
  fi
done

# Isolated worker services are named arkova-worker-<name>-staging. Enforce the
# shape so a typo can't aim at an unrelated service. The shared service
# 'arkova-worker-staging' is already denied above; this also blocks 'arkova-worker'.
if [[ ! "$SERVICE" =~ ^arkova-worker-[a-z0-9][a-z0-9-]*-staging$ ]]; then
  echo "ERROR: --service must match arkova-worker-<name>-staging; got '$SERVICE'." >&2
  exit 2
fi

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
echo "Cloud Run service: $SERVICE"
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
echo "# Step 1/3 — delete Cloud Run worker '$SERVICE'"
run_cmd gcloud run services delete "$SERVICE" \
  --project="$GCP_PROJECT" \
  --region="$CLOUD_RUN_REGION" \
  --quiet
echo

# ---------------------------------------------------------------------------
# Step 2 — delete Cloud Scheduler jobs wired to this worker.
#
# Isolated rigs name their cron jobs after the worker for discoverability.
# In dry-run we emit the discover-then-delete plan; in --apply we enumerate
# matching jobs and delete each. Failures to find jobs are non-fatal.
# ---------------------------------------------------------------------------
echo "# Step 2/3 — delete Cloud Scheduler cron jobs for '$SERVICE'"
print_cmd gcloud scheduler jobs list \
  --project="$GCP_PROJECT" \
  --location="$CLOUD_RUN_REGION" \
  --filter="name ~ ${SERVICE}" \
  --format="value(name)"
if [[ $APPLY -eq 1 ]]; then
  echo "executing: gcloud scheduler jobs list (filter ~ $SERVICE)" >&2
  jobs="$(gcloud scheduler jobs list \
    --project="$GCP_PROJECT" \
    --location="$CLOUD_RUN_REGION" \
    --filter="name ~ ${SERVICE}" \
    --format="value(name)" || true)"
  if [[ -z "$jobs" ]]; then
    echo "No matching scheduler jobs found; continuing." >&2
  else
    while IFS= read -r job; do
      [[ -n "$job" ]] || continue
      run_cmd gcloud scheduler jobs delete "$job" \
        --project="$GCP_PROJECT" \
        --location="$CLOUD_RUN_REGION" \
        --quiet
    done <<<"$jobs"
  fi
else
  echo "#   then for each returned job: gcloud scheduler jobs delete <job> --quiet"
fi
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
