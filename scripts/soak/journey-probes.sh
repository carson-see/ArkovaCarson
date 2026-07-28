#!/usr/bin/env bash
# scripts/soak/journey-probes.sh — SCRUM-2980 follow-up: the 6 NOT-COVERED
# journey probes from docs/staging/legacy-soak-2026-08/journey-coverage.md,
# run against both 72h soak rigs (launch-72h-2026-08 / legacy-soak-2026-08).
#
# This is a RECORD of the exact commands run live during the 2026-07-28
# follow-up session, kept runnable/re-runnable rather than a polished test
# harness — each probe is read-only or writes to a clearly-fixture-scoped
# row (org id prefix 5eed0000-...-c1/c2, public_id ARK-PROBE-*) that does
# not touch the loadgen's own seeded org (…-b1) or any real soak-evidence
# anchor. Nothing here redeploys or mutates the FROZEN worker services.
#
# Requires: gcloud (CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14
# on this shell — see smoke-gate "gcloud environment finding"), curl, python3,
# and the Supabase MCP execute_sql tool for the SQL-only steps (marked below;
# those are not shell-runnable and are included here as documentation of the
# exact query, not as executable statements in this script).
#
# Full narrative + PASS/FAIL results: docs/staging/legacy-soak-2026-08/journey-coverage.md
# and docs/staging/launch-72h-2026-08/journey-probes.md.

set -euo pipefail
export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-/opt/homebrew/opt/python@3.14/bin/python3.14}"

LAUNCH_URL="https://arkova-worker-launch-72h-2026-08-staging-kvojbeutfa-uc.a.run.app"
LEGACY_URL="https://arkova-worker-legacy-soak-2026-08-staging-270018525501.us-central1.run.app"
SA="270018525501-compute@developer.gserviceaccount.com"

id_token() { gcloud auth print-identity-token --audiences="$1" --impersonate-service-account="$SA" 2>/dev/null; }

# ── Probe 1: auth/tenant sweep (cross-tenant deny) ─────────────────────────
# Prereq (SQL, run once per rig via MCP execute_sql — NOT executed by this
# script): insert a second org + profile + api_keys row using the same
# api-key-hmac-secret-staging secret (fetch via:
#   gcloud secrets versions access latest --secret=api-key-hmac-secret-staging --project=arkova1
# ), HMAC-SHA256(raw_key, secret) as key_hash. See journey-coverage.md for the
# exact org ids used (…c1 on launch, …c2 on legacy).
probe_cross_tenant() {
  local url="$1" key_a="$2" key_other_org="$3"
  local tok; tok=$(id_token "$url")
  echo "--- create anchor as org-under-test ---"
  local created; created=$(curl -s "$url/api/v1/anchor" -X POST \
    -H "Authorization: Bearer $tok" -H "X-API-Key: $key_other_org" -H "Content-Type: application/json" \
    -d "{\"fingerprint\":\"$(python3 -c 'import secrets;print(secrets.token_hex(32))')\",\"credential_type\":\"OTHER\",\"description\":\"cross-tenant probe\"}")
  echo "$created"
  local pid; pid=$(python3 -c "import json,sys;print(json.loads('''$created''')['public_id'])")
  echo "--- org A key reading that anchor's lifecycle (expect 404, not the real data) ---"
  curl -s -w "\nHTTP %{http_code}\n" "$url/api/v1/anchor/$pid/lifecycle" -H "Authorization: Bearer $tok" -H "X-API-Key: $key_a"
}

# ── Probe 2: SECURITY DEFINER grant enumeration (SQL — run via MCP execute_sql) ──
# select p.proname, pg_get_function_identity_arguments(p.oid) as args,
#        (select array_agg(acl.grantee::regrole::text) from aclexplode(p.proacl) acl
#           where acl.privilege_type='EXECUTE') as execute_grantees
# from pg_proc p join pg_namespace n on n.oid=p.pronamespace
# where n.nspname='public' and p.prosecdef=true
#   and p.proname in ('submit_batch_anchors','batch_insert_anchors','allocate_monthly_credits',
#     'deduct_ai_credits','deduct_unified_credits','roll_over_monthly_allocation','invite_member',
#     'finalize_public_record_anchor_batch','drain_submitted_to_secured_for_tx','bulk_promote_confirmed',
#     'archive_old_audit_events', /* + the wider 0377-listed HIGH/MEDIUM set */ )
# order by p.proname;
#
# Live-callability confirmation (safe: fake tx_id array matches 0 rows):
probe_secdef_callability() {
  local url="$1" anon_key="$2"
  curl -s -o /tmp/rpc_out.json -w "HTTP %{http_code}\n" "$url/rpc/bulk_promote_confirmed" \
    -H "apikey: $anon_key" -H "Authorization: Bearer $anon_key" -H "Content-Type: application/json" \
    -d '{"p_tx_ids": ["nonexistent-probe-txid"]}'
  cat /tmp/rpc_out.json
}

# ── Probe 3: RLS adversarial pass (anon PostgREST reads) ───────────────────
probe_rls_anon() {
  local rest_url="$1" anon_key="$2"
  for t in anchors api_keys org_credits webhook_endpoints; do
    echo "--- $t (anon) ---"
    curl -s -w "\nHTTP %{http_code}\n" "$rest_url/rest/v1/$t?select=*&limit=5" -H "apikey: $anon_key" -H "Authorization: Bearer $anon_key"
  done
}

# ── Probe 5: chain fault injection (legacy rig only, bounded/reversible) ───
# 1) SQL (via MCP execute_sql): insert one fixture anchor, status=BROADCASTING,
#    chain_tx_id=NULL, updated_at = now() - interval '20 minutes' (must exceed
#    recover_stuck_broadcasts' default p_stale_minutes=5 threshold), org_id
#    pointed at the fixture probe org so it never mixes with real evidence.
# 2) Force the SAME OIDC-audienced trigger Cloud Scheduler uses (a raw curl
#    with a self-minted identity token gets 401 — cronAuth checks the OIDC
#    audience configured on the job, not just "any valid token"):
force_recover_broadcasts_legacy() {
  gcloud scheduler jobs run arkova-worker-legacy-soak-2026-08-staging-recover-broadcasts \
    --location=us-central1 --project=arkova1
}
# 3) SQL: select status, chain_tx_id, metadata, updated_at from anchors
#    where public_id='ARK-PROBE-FAULT01'; -- expect status=PENDING,
#    metadata->>'_recovery_reason'='stuck_broadcasting'
# 4) Cleanup: update anchors set deleted_at=now() where public_id='ARK-PROBE-FAULT01';
#    (prevents the now-PENDING fixture from being picked up by the real
#    batch-anchors cron and consuming real treasury sats)

# ── Probe 6: edge/rate-limit/CORS surface ───────────────────────────────────
probe_edge_surface() {
  local url="$1"
  local tok; tok=$(id_token "$url")
  echo "--- private ingress (no IAM token, expect 403) ---"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" "$url/health"
  echo "--- rate-limit headers (anon) ---"
  curl -s -D - -o /dev/null "$url/api/v1/verify/ARK-DOC-VQ265W" -H "Authorization: Bearer $tok" | grep -i ratelimit
  echo "--- CORS preflight from an arbitrary origin (expect NO Access-Control-Allow-Origin reflection) ---"
  curl -s -D - -o /dev/null -X OPTIONS "$url/api/v1/verify/ARK-DOC-VQ265W" \
    -H "Authorization: Bearer $tok" -H "Origin: https://evil.example.com" -H "Access-Control-Request-Method: GET" \
    | grep -i "access-control\|HTTP"
  echo "--- /health honors flags, 200 when authenticated ---"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" "$url/health" -H "Authorization: Bearer $tok"
}

case "${1:-}" in
  cross-tenant) probe_cross_tenant "${@:2}" ;;
  secdef) probe_secdef_callability "${@:2}" ;;
  rls-anon) probe_rls_anon "${@:2}" ;;
  recover-legacy) force_recover_broadcasts_legacy ;;
  edge) probe_edge_surface "${@:2}" ;;
  *) echo "usage: $0 {cross-tenant|secdef|rls-anon|recover-legacy|edge} [args]"; exit 1 ;;
esac
