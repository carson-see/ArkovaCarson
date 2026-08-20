#!/usr/bin/env bash
# scripts/staging/migration-t3-data-integrity-probe.sh
#
# Targeted drivers for #2235 (0411 BUG-019 / 0412 BUG-009 / 0413 BUG-011),
# per docs/staging/migration-t3-wave-premortem-2026-08-19.md §2. Re-runnable
# during the migration-t3 48h soak window.
#
# Modes (positional arg 1):
#   lock-contention   Hold audit_events IN ACCESS EXCLUSIVE MODE for
#                     LOCK_HOLD_SECONDS (default 15s) via a direct psql
#                     session, then fire POST /jobs/cleanup-retention against
#                     the worker mid-hold. Prints the observed status/timing.
#                     KNOWN FINDING (2026-08-20, this soak): on this rig the
#                     call fails at ~8.2s with HTTP 500 / SQLSTATE 57014
#                     ("canceling statement due to statement timeout"), not
#                     the intended HTTP 200 / audit_events_purge_skipped=true
#                     at ~5s. Root cause: the `authenticator`/`service_role`
#                     ambient session config sets BOTH statement_timeout=8s
#                     AND lock_timeout=8s (pg_roles.rolconfig); the function's
#                     own `SET LOCAL lock_timeout='5s'` does not appear to
#                     override this in a way that lets its own
#                     `EXCEPTION WHEN lock_not_available` handler fire before
#                     the ambient statement_timeout cancels the whole call.
#                     See docs/staging/migration-t3-soak-2026-08/soak-start-2026-08-20.md
#                     for the full writeup — this is a real finding, not a
#                     harness bug; re-running this script during the window is
#                     how to confirm whether it is consistent.
#   analyze-cycle     Run ANALYZE anchors; then refresh_cache_anchor_status_counts()
#                     and print total_source (should read 'estimate' after
#                     ANALYZE, 'exact' before it on a small/fresh table).
#   calibration-refit Fire POST /jobs/calibration-refit and print the result.
#   credential-expiry Fire POST /jobs/check-credential-expiry and print the
#                     result (route responds even when ENABLE_EXPIRY_ALERTS
#                     is off — that's a clean skip, not a failure).
#
# Env:
#   SUPABASE_DB_PASSWORD   required for lock-contention / analyze-cycle
#   PROJECT_REF            required for lock-contention / analyze-cycle
#   WORKER_BASE_URL        required for all HTTP modes (Cloud Run tag or
#                          base URL — base URL needs a GCP IAM identity token,
#                          fetched automatically via gcloud)
#   CRON_SECRET            required for calibration-refit / credential-expiry
#                          / lock-contention (X-Cron-Secret header)
#   LOCK_HOLD_SECONDS      optional, default 15

set -euo pipefail

MODE="${1:?Usage: $0 <lock-contention|analyze-cycle|calibration-refit|credential-expiry>}"
REGION="${SUPABASE_POOLER_REGION:-us-east-2}"

iam_token() {
  gcloud auth print-identity-token 2>/dev/null
}

case "$MODE" in
  lock-contention)
    : "${SUPABASE_DB_PASSWORD:?required}"
    : "${PROJECT_REF:?required}"
    : "${WORKER_BASE_URL:?required}"
    : "${CRON_SECRET:?required}"
    HOLD="${LOCK_HOLD_SECONDS:-15}"
    export PGPASSWORD="$SUPABASE_DB_PASSWORD"
    TOKEN="$(iam_token)"
    echo "Holding ACCESS EXCLUSIVE lock on audit_events for ${HOLD}s in the background..."
    ( psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres \
        -c "BEGIN; LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(${HOLD}); COMMIT;" \
        > /tmp/migration-t3-lock-session.log 2>&1 & )
    echo "Firing POST /jobs/cleanup-retention..."
    START=$(date +%s.%N)
    RESP=$(curl -s -X POST "${WORKER_BASE_URL}/jobs/cleanup-retention" \
      -H "Authorization: Bearer ${TOKEN}" -H "X-Cron-Secret: ${CRON_SECRET}" \
      -H "Content-Type: application/json" -w "\nHTTP_STATUS:%{http_code}\n")
    END=$(date +%s.%N)
    echo "$RESP"
    echo "elapsed: $(echo "$END - $START" | bc)s"
    echo ""
    echo "Expected (per 0411's design): HTTP 200, audit_events_purge_skipped=true, audit_events_deleted=-1"
    echo "Observed on 2026-08-20 (see header comment): HTTP 500 at ~8.2s — flagged finding, not yet fixed."
    ;;

  analyze-cycle)
    : "${SUPABASE_DB_PASSWORD:?required}"
    : "${PROJECT_REF:?required}"
    export PGPASSWORD="$SUPABASE_DB_PASSWORD"
    PSQL=(psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres -q -t -A)
    echo "Before ANALYZE:"
    "${PSQL[@]}" -c "SELECT refresh_cache_anchor_status_counts();"
    "${PSQL[@]}" -c "SELECT cache_value->>'total' AS total, cache_value->>'total_source' AS total_source FROM pipeline_dashboard_cache WHERE cache_key='anchor_status_counts';"
    echo "Running ANALYZE anchors..."
    "${PSQL[@]}" -c "ANALYZE anchors; SELECT refresh_cache_anchor_status_counts();"
    echo "After ANALYZE:"
    "${PSQL[@]}" -c "SELECT cache_value->>'total' AS total, cache_value->>'total_source' AS total_source FROM pipeline_dashboard_cache WHERE cache_key='anchor_status_counts';"
    ;;

  calibration-refit)
    : "${WORKER_BASE_URL:?required}"
    : "${CRON_SECRET:?required}"
    TOKEN="$(iam_token)"
    curl -s -X POST "${WORKER_BASE_URL}/jobs/calibration-refit" \
      -H "Authorization: Bearer ${TOKEN}" -H "X-Cron-Secret: ${CRON_SECRET}" \
      -H "Content-Type: application/json" -w "\nHTTP_STATUS:%{http_code}\n"
    ;;

  credential-expiry)
    : "${WORKER_BASE_URL:?required}"
    : "${CRON_SECRET:?required}"
    TOKEN="$(iam_token)"
    curl -s -X POST "${WORKER_BASE_URL}/jobs/check-credential-expiry" \
      -H "Authorization: Bearer ${TOKEN}" -H "X-Cron-Secret: ${CRON_SECRET}" \
      -H "Content-Type: application/json" -w "\nHTTP_STATUS:%{http_code}\n"
    ;;

  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
