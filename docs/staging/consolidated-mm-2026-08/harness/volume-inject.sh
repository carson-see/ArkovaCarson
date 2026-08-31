#!/usr/bin/env bash
# Volume injection through the REAL product API (POST /api/v1/anchor, API-key
# auth) so batch Trigger A / Trigger B become reachable (FD-TRIGGER-1).
# Usage: volume-inject.sh <target-count> <phase-label>
# Never mutates existing rows; every fingerprint is fresh random hex. Paced at
# 8/s (~480/min) under the 1,000/min API-key limit.
set -uo pipefail
D="$HOME/arkova-soak/consolidated-mm-2026-08"
. "$D/env.cmm"
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3
TARGET="${1:?target}"; PHASE="${2:-x}"
PACE=8
[ -f "$APIKEY_FILE" ] || { echo "FATAL: no API key at $APIKEY_FILE"; exit 2; }
APIKEY="$(cat "$APIKEY_FILE")"
IDT="$(gcloud auth print-identity-token 2>/dev/null)"
IDT_AT=$(date +%s)
ok=0; rej=0; i=0
echo "volume-$PHASE start $(date -u +%FT%TZ) target=$TARGET pace=${PACE}/s"
while [ "$ok" -lt "$TARGET" ]; do
  i=$((i+1))
  # refresh IAM token every 25 min
  now=$(date +%s); if [ $((now - IDT_AT)) -gt 1500 ]; then IDT="$(gcloud auth print-identity-token 2>/dev/null)"; IDT_AT=$now; fi
  FP="$(openssl rand -hex 32)"
  CODE=$(curl -s -m 20 -o /tmp/vol-body.$$ -w '%{http_code}' -X POST "$BASE/api/v1/anchor" \
    -H "X-Serverless-Authorization: Bearer $IDT" \
    -H "Authorization: Bearer $APIKEY" -H 'Content-Type: application/json' \
    -d '{"fingerprint":"'"$FP"'","credential_type":"OTHER","metadata":{"source":"cmm-volume-'"$PHASE"'"}}')
  case "$CODE" in
    200|201|202) ok=$((ok+1)) ;;
    *) rej=$((rej+1))
       if [ $((rej % 50)) -eq 1 ]; then echo "rej#$rej http=$CODE body=$(head -c 200 /tmp/vol-body.$$)"; fi
       if [ "$rej" -ge 500 ]; then echo "ABORT: 500 rejections (last http=$CODE)"; rm -f /tmp/vol-body.$$; exit 1; fi
       sleep 2 ;;
  esac
  [ $((i % PACE)) -eq 0 ] && sleep 1
  [ $((ok % 500)) -eq 0 ] && [ "$ok" -gt 0 ] && [ $((i % PACE)) -eq 0 ] && echo "progress ok=$ok rej=$rej $(date -u +%FT%TZ)"
done
rm -f /tmp/vol-body.$$
echo "volume-$PHASE done $(date -u +%FT%TZ) ok=$ok rej=$rej"
echo "{\"phase\":\"$PHASE\",\"target\":$TARGET,\"accepted\":$ok,\"rejected\":$rej,\"done_at\":\"$(date -u +%FT%TZ)\"}" > "$OUTDIR/volume-$PHASE-$(date -u +%Y%m%dT%H%M%SZ).json"
