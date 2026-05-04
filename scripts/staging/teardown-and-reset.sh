#!/usr/bin/env bash
# scripts/staging/teardown-and-reset.sh — return the staging branch to
# a known-good schema snapshot + reseed.
#
# Run between PRs so the next soak starts clean. Faster than deleting
# and recreating the Supabase branch (which costs branch-recreate time
# + new connection-string distribution).
#
# Steps:
#   1. Acquire the lease (will fail if someone else holds it).
#   2. Truncate all soak-test tables (anchors, audit_events, org_credits,
#      attestations, webhook_delivery_logs).
#   3. Re-apply any migrations that landed on main since the last reset.
#   4. Reseed via scripts/staging/seed.ts.
#   5. Release the lease.
#
# Usage:
#   ./scripts/staging/teardown-and-reset.sh
#
# Env required (same as seed.ts):
#   STAGING_SUPABASE_URL
#   STAGING_SUPABASE_SERVICE_ROLE_KEY

set -euo pipefail

: "${STAGING_SUPABASE_URL:?STAGING_SUPABASE_URL is required}"
: "${STAGING_SUPABASE_SERVICE_ROLE_KEY:?STAGING_SUPABASE_SERVICE_ROLE_KEY is required}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

PG_REST="${STAGING_SUPABASE_URL}/rest/v1"
AUTH=( -H "apikey: ${STAGING_SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${STAGING_SUPABASE_SERVICE_ROLE_KEY}" )

LEASE_PR="${RESET_PR_NUMBER:-0}"

echo "▶ Acquiring lease (PR=${LEASE_PR})..."
"${REPO_ROOT}/scripts/staging/claim.sh" acquire "${LEASE_PR}" "teardown-and-reset" || {
  echo "::error::Could not acquire lease — refusing to truncate." >&2
  exit 1
}

cleanup() {
  echo "▶ Releasing lease..."
  "${REPO_ROOT}/scripts/staging/claim.sh" release "${LEASE_PR}" || true
}
trap cleanup EXIT

echo "▶ Truncating soak-test tables (CASCADE)..."
# We use the SQL passthrough RPC `exec_sql` (set up on the staging branch
# only — never on prod). If unavailable, fall back to per-table DELETEs.
TRUNC_SQL='TRUNCATE TABLE anchors, audit_events, org_credits, attestations, webhook_delivery_logs RESTART IDENTITY CASCADE;'
HTTP_CODE=$(curl -sS -o /tmp/staging-reset.out -w '%{http_code}' \
  -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"sql\":\"${TRUNC_SQL}\"}" "${PG_REST}/rpc/exec_sql" || echo "000")
if [ "${HTTP_CODE}" != "200" ] && [ "${HTTP_CODE}" != "204" ]; then
  echo "::warning::exec_sql RPC not available on staging (HTTP ${HTTP_CODE}); falling back to per-table DELETE."
  for tbl in anchors audit_events org_credits attestations webhook_delivery_logs; do
    curl -sS -X DELETE "${AUTH[@]}" "${PG_REST}/${tbl}?id=neq.00000000-0000-0000-0000-000000000000" >/dev/null
  done
fi

echo "▶ Re-applying any new migrations from supabase/migrations/..."
# Best-effort: assumes Supabase CLI is wired with STAGING_SUPABASE_DB_URL.
if [ -n "${STAGING_SUPABASE_DB_URL:-}" ]; then
  npx supabase db push --db-url "${STAGING_SUPABASE_DB_URL}" || {
    echo "::warning::supabase db push failed — staging may drift from main."
  }
else
  echo "::warning::STAGING_SUPABASE_DB_URL not set — skipping migration sync."
fi

echo "▶ Reseeding..."
( cd "${REPO_ROOT}" && npm run staging:seed )

echo "✅ Teardown + reset complete."
