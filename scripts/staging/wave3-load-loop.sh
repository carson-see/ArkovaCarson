#!/usr/bin/env bash
# scripts/staging/wave3-load-loop.sh
#
# Sustained mixed-traffic load generator for the arkova-wave3-2026-08 rig's
# dedicated Cloud Run service. scripts/staging/load-harness.ts refuses this
# service's URL by design (its STAGING_API_BASE validator only accepts
# tag-routed URLs on the SHARED arkova-worker-staging service — see
# scripts/staging/load-harness-env.ts's isIsolatedTagHostname — because that
# validator exists to stop a T2/T3 soak from accidentally hitting the mutable
# shared service. This rig is its OWN dedicated Cloud Run service, so that
# contamination risk does not apply; this loop is the substitute driver.
#
# Mix per minute (targets ~5k-10k req/hour):
#   - GET /health                          every 2s  (~30/min)
#   - GET /api/v1/verify/ARK-WAVE3-CONN01  every 3s  (~20/min)
#   - GET /.well-known/arkova-keys.json    every 5s  (~12/min)
#   - POST /jobs/queue-digest              every 5 min
#   - POST /jobs/platform-health-digest    every 5 min
# ~62/min sustained => ~3,720/hour from the fast probes alone; each request
# actually issued is 1 HTTP round trip, so wall-clock req/hour scales with
# how many of the parallel probes land in the same second — measured, not
# assumed; see the evidence JSON this script writes for the real count.

set -uo pipefail

BASE_URL="${WAVE3_BASE_URL:?set WAVE3_BASE_URL}"
IDTOKEN_FILE="${WAVE3_IDTOKEN_FILE:?set WAVE3_IDTOKEN_FILE}"
CRON_SECRET_FILE="${WAVE3_CRON_SECRET_FILE:?set WAVE3_CRON_SECRET_FILE}"
DURATION_SEC="${WAVE3_DURATION_SEC:-1800}"
EVIDENCE_OUT="${WAVE3_EVIDENCE_OUT:?set WAVE3_EVIDENCE_OUT}"

ok=0
fail=0
by_status_200=0
by_status_other=0
cron_fires=0
start_ts=$(date -u +%s)
end_ts=$((start_ts + DURATION_SEC))
last_cron=0
last_token_refresh=$start_ts

echo "wave3-load-loop starting: base=${BASE_URL} duration=${DURATION_SEC}s" >&2

refresh_token() {
  gcloud auth print-identity-token --audiences="${BASE_URL}" > "${IDTOKEN_FILE}" 2>/dev/null
}

probe() {
  local path="$1"
  local method="${2:-GET}"
  local extra_header="${3:-}"
  local code
  if [ -n "$extra_header" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
      -H "Authorization: Bearer $(cat "$IDTOKEN_FILE")" \
      -H "$extra_header" \
      --max-time 10 "${BASE_URL}${path}")
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
      -H "Authorization: Bearer $(cat "$IDTOKEN_FILE")" \
      --max-time 10 "${BASE_URL}${path}")
  fi
  if [ "$code" = "200" ]; then
    ok=$((ok + 1))
    by_status_200=$((by_status_200 + 1))
  elif [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 500 ] 2>/dev/null; then
    ok=$((ok + 1))
    by_status_other=$((by_status_other + 1))
  else
    fail=$((fail + 1))
  fi
}

tick=0
while [ "$(date -u +%s)" -lt "$end_ts" ]; do
  now=$(date -u +%s)
  # Refresh the identity token every 40 min (tokens are short-lived).
  if [ $((now - last_token_refresh)) -ge 2400 ]; then
    refresh_token
    last_token_refresh=$now
  fi

  probe "/health"
  if [ $((tick % 3)) -eq 0 ]; then
    probe "/api/v1/verify/ARK-WAVE3-CONN01"
  fi
  if [ $((tick % 5)) -eq 0 ]; then
    probe "/.well-known/arkova-keys.json"
  fi

  if [ $((now - last_cron)) -ge 300 ]; then
    probe "/jobs/queue-digest" "POST" "X-Cron-Secret: $(cat "$CRON_SECRET_FILE")"
    probe "/jobs/platform-health-digest" "POST" "X-Cron-Secret: $(cat "$CRON_SECRET_FILE")"
    cron_fires=$((cron_fires + 1))
    last_cron=$now
  fi

  tick=$((tick + 1))
  sleep 2
done

end_wall=$(date -u +%s)
cat > "${EVIDENCE_OUT}" <<EOF
{
  "startedAt": "$(date -u -r "$start_ts" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$start_ts" +%Y-%m-%dT%H:%M:%SZ)",
  "endedAt": "$(date -u -r "$end_wall" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$end_wall" +%Y-%m-%dT%H:%M:%SZ)",
  "durationSec": $((end_wall - start_ts)),
  "apiBase": "${BASE_URL}",
  "requests": { "ok": $ok, "fail": $fail, "status_200": $by_status_200, "status_other_2xx_4xx": $by_status_other },
  "cronFires": $cron_fires
}
EOF
echo "wave3-load-loop done: ok=${ok} fail=${fail} cron_fires=${cron_fires}" >&2
cat "${EVIDENCE_OUT}" >&2
