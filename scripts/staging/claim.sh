#!/usr/bin/env bash
# scripts/staging/claim.sh — staging-rig leases.
#
# SCRUM-1803 (2026-05-09): leases are now PER-PR with a primary key on
# pr_number, so multiple PRs can hold leases simultaneously. Each PR's
# soak gets its own tag-routed Cloud Run revision URL via
# scripts/staging/deploy.sh; the lease scopes which PR is the legitimate
# author of deploys for its tag.
#
# Pre-1803 behavior was "one lease at a time" — that became a bottleneck
# and didn't actually prevent collisions because nothing checked the
# lease before `gcloud run deploy`. The new contract is:
#
#   1. claim.sh writes/deletes a row in `staging_lease` keyed by pr_number.
#   2. deploy.sh refuses to deploy without a row for the PR (or --force
#      with audited reason).
#   3. Multiple PRs may have rows simultaneously; each owns its tag URL.
#
# Stale leases (>72h) are auto-evicted on `acquire`.
#
# Usage:
#   ./scripts/staging/claim.sh acquire <pr-number> "<short reason>"
#   ./scripts/staging/claim.sh release <pr-number>
#   ./scripts/staging/claim.sh status [--all|--pr <N>]
#
# Env required:
#   STAGING_SUPABASE_URL
#   STAGING_SUPABASE_SERVICE_ROLE_KEY
#   SLACK_WEBHOOK_URL  (optional)

set -euo pipefail

ACTION="${1:-status}"
PR_NUM="${2:-}"
REASON="${3:-}"

: "${STAGING_SUPABASE_URL:?STAGING_SUPABASE_URL is required}"
: "${STAGING_SUPABASE_SERVICE_ROLE_KEY:?STAGING_SUPABASE_SERVICE_ROLE_KEY is required}"

PG_REST_BASE="${STAGING_SUPABASE_URL}/rest/v1"
PG_REST="${PG_REST_BASE}/staging_lease"
TAG_URL_HOST="${STAGING_CLOUD_RUN_HOST:-arkova-worker-staging-270018525501.us-central1.run.app}"
AUTH=( -H "apikey: ${STAGING_SUPABASE_SERVICE_ROLE_KEY}"
       -H "Authorization: Bearer ${STAGING_SUPABASE_SERVICE_ROLE_KEY}" )

# 72 hours in the past, portable across BSD date (macOS) and GNU date (Linux).
stale_cutoff() {
  date -u -v-72H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d '-72 hours' +%Y-%m-%dT%H:%M:%SZ
}

post_slack() {
  local msg="$1"
  if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    curl -sS -X POST -H "Content-Type: application/json" \
      -d "{\"text\":\"${msg}\"}" "${SLACK_WEBHOOK_URL}" >/dev/null || true
  fi
  echo "${msg}"
}

print_status() {
  local leases="$1" logs="$2"
  jq -s --arg host "$TAG_URL_HOST" '
    (.[0] // []) as $leases
    | (.[1] // []) as $logs
    | $leases
    | map(
        . as $lease
        | ($logs | map(select(.pr_number == $lease.pr_number)) | first) as $log
        | ($log.tag // ("pr-" + ($lease.pr_number | tostring))) as $tag
        | . + {
            tag_url: ("https://" + $tag + "---" + $host),
            latest_staging_deploy_log_id: ($log.id // null),
            latest_staging_deploy_at: ($log.deployed_at // null)
          }
      )
  ' <(printf '%s\n' "$leases") <(printf '%s\n' "$logs")
}

print_all_status() {
  local leases logs
  leases=$(curl -sS "${AUTH[@]}" "${PG_REST}?select=*&order=acquired_at.desc")
  logs=$(curl -sS "${AUTH[@]}" "${PG_REST_BASE}/staging_deploy_log?select=pr_number,id,tag,deployed_at&order=deployed_at.desc")
  print_status "$leases" "$logs"
}

# Best-effort cleanup of leases older than 72h. Idempotent; not fatal if it fails.
evict_stale() {
  local cutoff
  cutoff=$(stale_cutoff)
  curl -sS -X DELETE "${AUTH[@]}" \
    "${PG_REST}?acquired_at=lt.${cutoff}" >/dev/null || true
}

case "${ACTION}" in
  acquire)
    if [[ -z "${PR_NUM}" || -z "${REASON}" ]]; then
      echo "Usage: $0 acquire <pr-number> \"<short reason>\"" >&2
      exit 2
    fi
    evict_stale

    # Reject if THIS PR already holds a lease.
    EXISTING=$(curl -sS "${AUTH[@]}" \
      "${PG_REST}?pr_number=eq.${PR_NUM}&select=pr_number,reason,acquired_at,acquired_by")
    if [[ "${EXISTING}" != "[]" && -n "${EXISTING}" ]]; then
      echo "::error::PR #${PR_NUM} already holds a staging lease:" >&2
      echo "${EXISTING}" | jq . >&2 || echo "${EXISTING}" >&2
      echo "Run \`$0 release ${PR_NUM}\` first if this is stale." >&2
      exit 1
    fi

    # Soft-warn if other PRs hold leases — informational, not blocking.
    OTHERS=$(curl -sS "${AUTH[@]}" "${PG_REST}?select=pr_number,acquired_by,reason")
    if [[ "${OTHERS}" != "[]" && -n "${OTHERS}" ]]; then
      echo "::notice::Other PRs currently soaking on the staging rig:" >&2
      echo "${OTHERS}" | jq -r '.[] | "  PR #\(.pr_number) — \(.acquired_by): \(.reason)"' >&2 \
        || echo "${OTHERS}" >&2
      echo "::notice::This is OK — each PR uses its own tag URL via scripts/staging/deploy.sh." >&2
    fi

    OWNER="${USER:-unknown}@$(hostname -s 2>/dev/null || echo host)"
    PAYLOAD=$(jq -n --arg pr "${PR_NUM}" --arg r "${REASON}" --arg o "${OWNER}" \
      '{pr_number: ($pr|tonumber), reason: $r, acquired_by: $o, acquired_at: now|todate}')
    curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
      -H "Prefer: return=representation" \
      -d "${PAYLOAD}" "${PG_REST}" | jq .
    post_slack ":lock: Staging rig lease acquired by ${OWNER} for PR #${PR_NUM}: ${REASON}"
    echo
    echo "Next: deploy with"
    echo "  ./scripts/staging/deploy.sh --pr ${PR_NUM} --image <ref>"
    echo "and run the soak harness against the tag URL it prints."
    ;;

  release)
    if [[ -z "${PR_NUM}" ]]; then
      echo "Usage: $0 release <pr-number>" >&2
      exit 2
    fi
    curl -sS -X DELETE "${AUTH[@]}" "${PG_REST}?pr_number=eq.${PR_NUM}" >/dev/null
    post_slack ":unlock: Staging rig lease released for PR #${PR_NUM}."
    ;;

  status)
    # `claim.sh status` lists all current leases.
    # `claim.sh status --all` does the same, explicitly.
    # `claim.sh status --pr <N>` filters to a single PR.
    # Note: positional arg parsing at the top of this script reads $2 as
    # PR_NUM. For `status` we ignore PR_NUM and parse the optional --pr flag
    # from the original command line ourselves so `status --pr N` and
    # `status` both work without confusing the acquire/release cases.
    if [[ "${PR_NUM}" == "--pr" && -n "${REASON}" ]]; then
      LEASES=$(curl -sS "${AUTH[@]}" "${PG_REST}?pr_number=eq.${REASON}&select=*")
      LOGS=$(curl -sS "${AUTH[@]}" "${PG_REST_BASE}/staging_deploy_log?pr_number=eq.${REASON}&select=pr_number,id,tag,deployed_at&order=deployed_at.desc&limit=1")
      print_status "$LEASES" "$LOGS"
    elif [[ -z "${PR_NUM}" ]]; then
      # Default: all current leases, newest first.
      print_all_status
    elif [[ "${PR_NUM}" == "--all" && -z "${REASON}" ]]; then
      print_all_status
    else
      echo "Usage: $0 status [--all|--pr <pr-number>]" >&2
      exit 2
    fi
    ;;

  *)
    echo "Usage: $0 {acquire|release|status} [pr-number] [reason]" >&2
    exit 2
    ;;
esac
