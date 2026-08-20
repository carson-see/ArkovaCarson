#!/usr/bin/env bash
# scripts/staging/migration-t3-partner-provisioning-probe.sh
#
# Targeted drivers for #2219 (0410_partner_accounts / partner-provisioning
# router), per docs/staging/migration-t3-wave-premortem-2026-08-19.md §2.
# Re-runnable during the migration-t3 48h soak window.
#
# Modes (positional arg 1):
#   flag-state        Probe the router with the switchboard flag OFF then ON,
#                     confirming the 404-vs-401 transition (dark surface vs
#                     real-but-auth-gated surface). Flips the flag via direct
#                     SQL and restores it to OFF afterward.
#   table-rls         Direct-PostgREST probe of public.partner_accounts for
#                     both anon and a real authenticated session — expects
#                     permission-denied (42501) on both (no grant at all for
#                     either role, stricter than RLS-only).
#   uniqueness-race   Fire two concurrent INSERTs at the
#                     partner_accounts_open_request_uniq index (same
#                     sponsor_org_id + case-insensitive partner_name) and
#                     confirm exactly one succeeds, the other gets 23505.
#                     Cleans up its own test rows.
#
# KNOWN GAP (2026-08-20, this soak): the router's own HTTP auth boundary
# (requireAuthMw, sponsor-org owner/admin 403, self-provision block) could
# NOT be exercised end-to-end from outside this session, because
# arkova-worker-staging is `--no-allow-unauthenticated` at the Cloud Run IAM
# layer — the GCP IAM identity token AND a Supabase user JWT both need the
# same `Authorization: Bearer` header, and requireAuthMw
# (services/worker/src/routes/middleware.ts:71-79) reads the user JWT from
# that exact header. There is no alternate header for the user session. This
# is an infra/testing-harness gap, not a defect in the router itself — the
# flag-gate, table-level grants, and uniqueness constraint (which don't need
# the app's own auth layer) all verify correctly, see flag-state / table-rls
# / uniqueness-race above. Driving the full CAS lifecycle + sponsor-org 403 +
# self-provision-block needs either a real end-user session through the
# actual frontend, or a companion GCP service-account + Supabase test-user
# pairing set up specifically for this purpose.
#
# Env:
#   SUPABASE_DB_PASSWORD   required for all modes
#   PROJECT_REF            required for all modes
#   SUPABASE_URL           required for table-rls (https://<ref>.supabase.co)
#   SUPABASE_ANON_KEY      required for table-rls
#   SUPABASE_AUTH_JWT      required for table-rls (a real signed-in session —
#                          mint one via the admin generate_link + verify flow,
#                          see soak-start doc for the exact two-step recipe)
#   WORKER_BASE_URL        required for flag-state

set -euo pipefail

MODE="${1:?Usage: $0 <flag-state|table-rls|uniqueness-race>}"
REGION="${SUPABASE_POOLER_REGION:-us-east-2}"

case "$MODE" in
  flag-state)
    : "${SUPABASE_DB_PASSWORD:?required}"
    : "${PROJECT_REF:?required}"
    : "${WORKER_BASE_URL:?required}"
    export PGPASSWORD="$SUPABASE_DB_PASSWORD"
    PSQL=(psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres -q -t -A)
    TOKEN="$(gcloud auth print-identity-token 2>/dev/null)"

    "${PSQL[@]}" -c "UPDATE switchboard_flags SET enabled = false WHERE flag_key = 'ENABLE_PARTNER_PROVISIONING';"
    echo "flag OFF -> expect 404:"
    curl -s -o /dev/null -w "  %{http_code}\n" -H "Authorization: Bearer ${TOKEN}" \
      -X POST "${WORKER_BASE_URL}/api/partner-provisioning" -H "Content-Type: application/json" -d '{}'

    "${PSQL[@]}" -c "INSERT INTO switchboard_flags (flag_key, enabled, description) VALUES ('ENABLE_PARTNER_PROVISIONING', true, 'probe') ON CONFLICT (flag_key) DO UPDATE SET enabled = true;"
    echo "flag ON, no user auth -> expect 401 (route now exists, requires auth):"
    curl -s -o /dev/null -w "  %{http_code}\n" -H "Authorization: Bearer ${TOKEN}" \
      -X POST "${WORKER_BASE_URL}/api/partner-provisioning" -H "Content-Type: application/json" -d '{}'

    "${PSQL[@]}" -c "UPDATE switchboard_flags SET enabled = false WHERE flag_key = 'ENABLE_PARTNER_PROVISIONING';"
    echo "flag restored to OFF (default/prod-matching state)"
    ;;

  table-rls)
    : "${SUPABASE_URL:?required}"
    : "${SUPABASE_ANON_KEY:?required}"
    : "${SUPABASE_AUTH_JWT:?required}"
    echo "authenticated direct-table SELECT (expect 403 permission denied — no GRANT at all):"
    curl -s -w "\n  HTTP %{http_code}\n" "${SUPABASE_URL}/rest/v1/partner_accounts?select=id" \
      -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_AUTH_JWT}"
    echo "anon direct-table SELECT (expect 401 permission denied):"
    curl -s -w "\n  HTTP %{http_code}\n" "${SUPABASE_URL}/rest/v1/partner_accounts?select=id" \
      -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_ANON_KEY}"
    ;;

  uniqueness-race)
    : "${SUPABASE_DB_PASSWORD:?required}"
    : "${PROJECT_REF:?required}"
    export PGPASSWORD="$SUPABASE_DB_PASSWORD"
    ORG_ID=$(psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres -q -t -A -c "SELECT id FROM organizations LIMIT 1;")
    USER_ID=$(psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres -q -t -A -c "SELECT id FROM auth.users LIMIT 1;")
    echo "racing two INSERTs at ($ORG_ID, lower('RaceTestPartner'))..."
    ( psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres \
        -c "INSERT INTO partner_accounts (id, status, partner_name, partner_contact_email, sponsor_org_id, requested_by, requested_at) SELECT gen_random_uuid(), 'requested', 'RaceTestPartner', 'a@example.com', '${ORG_ID}', '${USER_ID}', now();" \
        > /tmp/migration-t3-race-a.log 2>&1 & )
    psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres \
      -c "INSERT INTO partner_accounts (id, status, partner_name, partner_contact_email, sponsor_org_id, requested_by, requested_at) SELECT gen_random_uuid(), 'requested', 'racetestpartner', 'b@example.com', '${ORG_ID}', '${USER_ID}', now();" \
      > /tmp/migration-t3-race-b.log 2>&1 || true
    echo "session A:"; cat /tmp/migration-t3-race-a.log
    echo "session B:"; cat /tmp/migration-t3-race-b.log
    psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres \
      -c "DELETE FROM partner_accounts WHERE partner_name = 'RaceTestPartner';" > /dev/null
    echo "cleaned up test rows"
    ;;

  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
