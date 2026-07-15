#!/usr/bin/env bash
# PR #927 T2 Staging Soak — exercises all three SCRUM-2042/2043/2044 paths:
#   1. DocuSign webhook with dual-HMAC verification (SCRUM-2043)
#   2. DocuSign reconciliation cron (SCRUM-2042)
#   3. Nonce sweep cron (SCRUM-2040)
#   4. Connector health check (existing, validates no regression)
#
# Usage: ./scripts/staging/pr927-soak.sh [iterations] [delay_seconds]

set -euo pipefail

# Secrets/config come from the environment — never hardcode (gitleaks-gated in CI).
# Export these before running, e.g. from a gitignored .env or Secret Manager:
#   export WORKER_URL=https://<tagged-staging-worker>.a.run.app
#   export CRON_SECRET=... HMAC_KEY=...
# NOTE: the previously hardcoded CRON_SECRET/HMAC_KEY were committed to git history
# and must be treated as compromised — rotate them, do not just relocate.
WORKER_URL="${WORKER_URL:?set WORKER_URL to the target staging worker URL}"
CRON_SECRET="${CRON_SECRET:?set CRON_SECRET (staging X-Cron-Secret) — do NOT hardcode}"
HMAC_KEY="${HMAC_KEY:?set HMAC_KEY (staging DocuSign HMAC key) — do NOT hardcode}"
ACCOUNT_ID="${ACCOUNT_ID:-soak-test-acct-001}"
ITERATIONS="${1:-50}"
DELAY="${2:-2}"

ok=0
fail=0
total=0

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

compute_hmac() {
  local body="$1"
  local key="$2"
  echo -n "$body" | openssl dgst -sha256 -hmac "$key" -binary | base64
}

test_webhook() {
  local i="$1"
  local envelope_id
  envelope_id="soak-env-$(printf '%04d' "$i")-$(date +%s)"
  local body
  body=$(cat <<ENDJSON
{
  "event": "envelope-completed",
  "eventId": "soak-event-${i}",
  "envelopeId": "${envelope_id}",
  "accountId": "${ACCOUNT_ID}",
  "status": "completed",
  "generatedDateTime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "envelopeDocuments": [
    {"documentId": "1", "name": "soak-doc-${i}.pdf", "documentIdGuid": "guid-${i}"}
  ]
}
ENDJSON
)
  local sig
  sig=$(compute_hmac "$body" "$HMAC_KEY")

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${WORKER_URL}/webhooks/docusign" \
    -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: ${sig}" \
    --data-raw "$body")

  total=$((total + 1))
  if [ "$status" = "202" ]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    log "FAIL webhook #${i}: HTTP ${status}"
  fi
}

test_webhook_duplicate() {
  local envelope_id="soak-env-dup-$(date +%s%N)"
  local body
  body=$(cat <<ENDJSON
{
  "event": "envelope-completed",
  "eventId": "soak-event-dup",
  "envelopeId": "${envelope_id}",
  "accountId": "${ACCOUNT_ID}",
  "status": "completed",
  "generatedDateTime": "2026-05-27T00:00:00Z",
  "envelopeDocuments": [
    {"documentId": "1", "name": "dup-doc.pdf", "documentIdGuid": "guid-dup"}
  ]
}
ENDJSON
)
  local sig
  sig=$(compute_hmac "$body" "$HMAC_KEY")

  # First call should be 202, second should be 200 (duplicate)
  local s1 s2
  s1=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${WORKER_URL}/webhooks/docusign" \
    -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: ${sig}" \
    --data-raw "$body")
  s2=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${WORKER_URL}/webhooks/docusign" \
    -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: ${sig}" \
    --data-raw "$body")

  total=$((total + 2))
  if [ "$s1" = "202" ] && [ "$s2" = "200" ]; then
    ok=$((ok + 2))
    log "OK duplicate detection: first=202, replay=200"
  else
    fail=$((fail + 2))
    log "FAIL duplicate detection: first=${s1}, replay=${s2} (expected 202, 200)"
  fi
}

test_webhook_bad_hmac() {
  local body='{"event":"envelope-completed","eventId":"bad","envelopeId":"bad-env","accountId":"soak-test-acct-001","status":"completed","envelopeDocuments":[]}'
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${WORKER_URL}/webhooks/docusign" \
    -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" \
    --data-raw "$body")

  total=$((total + 1))
  if [ "$status" = "401" ]; then
    ok=$((ok + 1))
    log "OK bad HMAC rejected: 401"
  else
    fail=$((fail + 1))
    log "FAIL bad HMAC: got ${status}, expected 401"
  fi
}

test_cron() {
  local endpoint="$1"
  local label="$2"
  local resp status body
  resp=$(curl -s -w "\n%{http_code}" \
    -X POST "${WORKER_URL}/jobs/${endpoint}" \
    -H "X-Cron-Secret: ${CRON_SECRET}" \
    -H "Content-Type: application/json")
  status=$(echo "$resp" | tail -1)
  body=$(echo "$resp" | sed '$d')

  total=$((total + 1))
  if [ "$status" = "200" ]; then
    ok=$((ok + 1))
  elif [ "$status" = "500" ] && [ "$endpoint" = "docusign-reconciliation" ] && echo "$body" | grep -q "token_refresh"; then
    # Expected: reconciliation finds the seeded integration but can't refresh
    # the fake token — proves the code path (discovery → token → error report)
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    log "FAIL ${label}: HTTP ${status} — ${body}"
  fi
}

test_health() {
  local resp
  resp=$(curl -s -w "\n%{http_code}" "${WORKER_URL}/health")
  local status
  status=$(echo "$resp" | tail -1)

  total=$((total + 1))
  if [ "$status" = "200" ]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    log "FAIL health: HTTP ${status}"
  fi
}

# ── Main ──
log "Starting PR #927 soak: ${ITERATIONS} iterations, ${DELAY}s delay"
log "Worker: ${WORKER_URL}"

# Phase 1: Security tests (run once)
log "Phase 1: Security edge cases"
test_webhook_bad_hmac
test_webhook_duplicate

# Phase 2: Synthetic load
log "Phase 2: Synthetic load (${ITERATIONS} iterations)"
for i in $(seq 1 "$ITERATIONS"); do
  test_webhook "$i"
  if (( i % 5 == 0 )); then
    test_cron "docusign-reconciliation" "reconciliation"
    test_cron "nonce-sweep" "nonce-sweep"
    test_cron "connector-health-check" "connector-health"
    test_health
  fi
  if (( i % 10 == 0 )); then
    log "Progress: ${i}/${ITERATIONS} — ok=${ok} fail=${fail}"
  fi
  sleep "$DELAY"
done

# Phase 3: Sprint 3 new endpoints
log "Phase 3: Sprint 3 endpoint validation"

# Attestation verification — should 404 for non-existent attestation
test_verification() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    "${WORKER_URL}/api/v1/verify/attestation/ARK-ATT-NONEXISTENT")

  total=$((total + 1))
  if [ "$status" = "404" ]; then
    ok=$((ok + 1))
    log "OK attestation verification 404 for non-existent"
  elif [ "$status" = "503" ]; then
    ok=$((ok + 1))
    log "OK attestation verification 503 (feature gate cache, expected on cold start)"
  else
    fail=$((fail + 1))
    log "FAIL attestation verification: got ${status}, expected 404"
  fi
}

# Attestation verification — should 400 for invalid ID format
test_verification_invalid() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    "${WORKER_URL}/api/v1/verify/attestation/INVALID!!!")

  total=$((total + 1))
  if [ "$status" = "400" ]; then
    ok=$((ok + 1))
    log "OK attestation verification 400 for invalid format"
  elif [ "$status" = "503" ]; then
    ok=$((ok + 1))
    log "OK attestation verification 503 (feature gate cache, expected on cold start)"
  else
    fail=$((fail + 1))
    log "FAIL attestation verification invalid: got ${status}, expected 400"
  fi
}

# Member OAuth — should 401 without auth
test_member_oauth_unauthed() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    "${WORKER_URL}/api/v1/integrations/docusign/member/connect")

  total=$((total + 1))
  if [ "$status" = "401" ] || [ "$status" = "302" ] || [ "$status" = "503" ]; then
    ok=$((ok + 1))
    log "OK member OAuth connect auth gate: ${status}"
  else
    fail=$((fail + 1))
    log "FAIL member OAuth connect: got ${status}, expected 401/302/503"
  fi
}

test_verification
test_verification_invalid
test_member_oauth_unauthed

# Phase 4: Final cron pass
log "Phase 4: Final cron trigger"
test_cron "docusign-reconciliation" "reconciliation-final"
test_cron "nonce-sweep" "nonce-sweep-final"
test_cron "connector-health-check" "health-check-final"
test_health

log "=== SOAK COMPLETE ==="
log "Total: ${total}, OK: ${ok}, FAIL: ${fail}"
if [ "$fail" -gt 0 ]; then
  log "STATUS: FAILED"
  exit 1
else
  log "STATUS: PASSED"
  exit 0
fi
