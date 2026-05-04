#!/usr/bin/env bash
# scripts/staging/claim.sh — lease the staging rig so two engineers
# (or two agents) don't soak conflicting changes simultaneously.
#
# The lease is a row in the `staging_lease` table on the staging
# Supabase branch. Acquiring writes the row; releasing deletes it.
# Stale leases (>72h) are auto-evicted by the lease check.
#
# Usage:
#   ./scripts/staging/claim.sh acquire <pr-number> "<short reason>"
#   ./scripts/staging/claim.sh release <pr-number>
#   ./scripts/staging/claim.sh status
#
# Env required:
#   STAGING_SUPABASE_URL
#   STAGING_SUPABASE_SERVICE_ROLE_KEY
#   SLACK_WEBHOOK_URL  (optional — posts to #eng-staging if set)

set -euo pipefail

ACTION="${1:-status}"
PR_NUM="${2:-}"
REASON="${3:-}"

: "${STAGING_SUPABASE_URL:?STAGING_SUPABASE_URL is required}"
: "${STAGING_SUPABASE_SERVICE_ROLE_KEY:?STAGING_SUPABASE_SERVICE_ROLE_KEY is required}"

PG_REST="${STAGING_SUPABASE_URL}/rest/v1/staging_lease"
AUTH=( -H "apikey: ${STAGING_SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${STAGING_SUPABASE_SERVICE_ROLE_KEY}" )

post_slack() {
  local msg="$1"
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    curl -sS -X POST -H "Content-Type: application/json" \
      -d "{\"text\":\"${msg}\"}" "${SLACK_WEBHOOK_URL}" >/dev/null || true
  fi
  echo "${msg}"
}

case "${ACTION}" in
  acquire)
    if [ -z "${PR_NUM}" ] || [ -z "${REASON}" ]; then
      echo "Usage: $0 acquire <pr-number> \"<short reason>\"" >&2
      exit 2
    fi
    # Stale check: any lease older than 72h is treated as released.
    EXISTING=$(curl -sS "${AUTH[@]}" \
      "${PG_REST}?select=pr_number,reason,acquired_at,acquired_by&acquired_at=gte.$(date -u -v-72H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-72 hours' +%Y-%m-%dT%H:%M:%SZ)")
    if [ "${EXISTING}" != "[]" ]; then
      echo "::error::Staging rig is currently leased:" >&2
      echo "${EXISTING}" | jq . >&2 || echo "${EXISTING}" >&2
      exit 1
    fi
    OWNER="${USER:-unknown}@$(hostname -s 2>/dev/null || echo host)"
    PAYLOAD=$(jq -n --arg pr "${PR_NUM}" --arg r "${REASON}" --arg o "${OWNER}" \
      '{pr_number: ($pr|tonumber), reason: $r, acquired_by: $o, acquired_at: now|todate}')
    curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
      -H "Prefer: return=representation" \
      -d "${PAYLOAD}" "${PG_REST}" | jq .
    post_slack ":lock: Staging rig acquired by ${OWNER} for PR #${PR_NUM}: ${REASON}"
    ;;

  release)
    if [ -z "${PR_NUM}" ]; then
      echo "Usage: $0 release <pr-number>" >&2
      exit 2
    fi
    curl -sS -X DELETE "${AUTH[@]}" "${PG_REST}?pr_number=eq.${PR_NUM}" >/dev/null
    post_slack ":unlock: Staging rig released for PR #${PR_NUM}."
    ;;

  status)
    curl -sS "${AUTH[@]}" "${PG_REST}?select=*&order=acquired_at.desc" | jq .
    ;;

  *)
    echo "Usage: $0 {acquire|release|status} [pr-number] [reason]" >&2
    exit 2
    ;;
esac
