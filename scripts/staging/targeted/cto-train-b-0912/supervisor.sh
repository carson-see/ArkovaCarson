#!/bin/bash
# cto-train-b-0912 supervisor: one train-cycle every 5 minutes, PID-locked,
# health-gated single retry on a FAIL (min-instance recycle rule), rolling
# summary.json. Usage: supervisor.sh <candidate-sha> <out-dir>
set -u
CANDIDATE_SHA="$1"; OUT_DIR="$2"; SUMMARY="$OUT_DIR/summary.json"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
mkdir -p "$OUT_DIR"
LOCK="$OUT_DIR/supervisor.pid"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then echo "another supervisor ($(cat "$LOCK")) holds $LOCK" >&2; exit 2; fi
echo $$ > "$LOCK"
export TRAIN_CANDIDATE_SHA="$CANDIDATE_SHA"
export TRAIN_TAG_URL="${TRAIN_TAG_URL:-https://arkova-worker-cto-train-b-0912-staging-270018525501.us-central1.run.app}"
export STAGING_SUPABASE_SERVICE_ROLE_KEY="$(gcloud secrets versions access latest --secret=supabase-service-role-key-cto-train-b-0912-staging --project=arkova1)"
export STAGING_SUPABASE_ANON_KEY="$(gcloud secrets versions access latest --secret=supabase-anon-key-cto-train-b-0912-staging --project=arkova1)"
export CRON_SECRET="$(gcloud secrets versions access latest --secret=cron-secret --project=arkova1)"
export API_KEY_HMAC_SECRET="$(gcloud secrets versions access latest --secret=api-key-hmac-secret-staging --project=arkova1)"
export FIXTURE_STATE="${FIXTURE_STATE:-/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/state/fixtures.json}"
wait_for_healthy() {
  local deadline=$((SECONDS + 180))
  while [ $SECONDS -lt $deadline ]; do
    IAM=$(gcloud auth print-identity-token 2>/dev/null)
    BODY=$(curl -s -m 10 -H "X-Serverless-Authorization: Bearer $IAM" "$TRAIN_TAG_URL/health" 2>/dev/null)
    echo "$BODY" | grep -q '"status":"healthy"' && echo "$BODY" | grep -q "\"git_sha\":\"$CANDIDATE_SHA\"" && return 0
    sleep 5
  done
  return 1
}
c=0; p=0; f=0; r=0
echo "[supervisor $$] start $(date -u +%FT%TZ) sha=$CANDIDATE_SHA out=$OUT_DIR" >> "$OUT_DIR/supervisor.log"
while true; do
  c=$((c+1)); cd "$HERE/../../../.." || exit 1
  node "$HERE/train-cycle.mjs" "$OUT_DIR" >> "$OUT_DIR/supervisor.log" 2>&1; s=$?
  if [ $s -ne 0 ]; then r=$((r+1)); echo "[supervisor $$] cycle $c FAILED; health-gated single retry" >> "$OUT_DIR/supervisor.log"
    if wait_for_healthy; then node "$HERE/train-cycle.mjs" "$OUT_DIR" >> "$OUT_DIR/supervisor.log" 2>&1; s=$?; fi; fi
  if [ $s -eq 0 ]; then p=$((p+1)); else f=$((f+1)); fi
  printf '{"driver":"%s","out_dir":"%s","pid":%s,"candidate_sha":"%s","updated_at":"%s","cycles_run":%s,"cycles_pass":%s,"cycles_fail":%s,"retries_attempted":%s}\n' "$HERE/train-cycle.mjs" "$OUT_DIR" $$ "$CANDIDATE_SHA" "$(date -u +%FT%TZ)" $c $p $f $r > "$SUMMARY"
  echo "[supervisor $$] cycle $c status=$s pass=$p fail=$f" >> "$OUT_DIR/supervisor.log"
  sleep 300
done
