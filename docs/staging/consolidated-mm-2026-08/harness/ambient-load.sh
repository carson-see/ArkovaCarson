#!/usr/bin/env bash
# One ~9.5-minute ambient load segment against the isolated rig.
# Replaces load-harness.ts here: Cloud Run's 46-char tag+service limit makes a
# tag URL impossible on this service name, and load-harness (correctly) refuses
# untagged hosts. This service is single-revision with traffic pinned 100% to
# the soaked revision, so the base URL routes to the pinned revision only.
# Two lanes, both paced under their rate tiers (FD-LOAD-1):
#   anon lane  ~1.2 req/s (fixture verify / unknown-404 / health) < 100/min IP cap
#   key  lane  ~1.0 req/s (authenticated verify)                  < 1000/min tier
set -uo pipefail
D="$HOME/arkova-soak/consolidated-mm-2026-08"
. "$D/env.cmm"
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3
DUR="${1:-570}"
IDT="$(gcloud auth print-identity-token 2>/dev/null)"
APIKEY=""; [ -f "$APIKEY_FILE" ] && APIKEY="$(cat "$APIKEY_FILE")"
END=$(( $(date +%s) + DUR ))
a_ok=0; a_429=0; a_other=0; k_ok=0; k_other=0; n=0
while [ "$(date +%s)" -lt "$END" ]; do
  n=$((n+1))
  case $((n % 3)) in
    0) P="/api/v1/verify/$FIXTURE_PUBLIC_ID" ;;
    1) P="/api/v1/verify/ARK-DOC-ZZZZ99" ;;
    2) P="/health" ;;
  esac
  C=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "X-Serverless-Authorization: Bearer $IDT" -H "Authorization: Bearer $IDT" "$BASE$P" 2>/dev/null)
  case "$C" in 200|404) a_ok=$((a_ok+1));; 429) a_429=$((a_429+1));; *) a_other=$((a_other+1));; esac
  if [ -n "$APIKEY" ]; then
    CK=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "X-Serverless-Authorization: Bearer $IDT" -H "Authorization: Bearer $APIKEY" "$BASE/api/v1/verify/$FIXTURE_PUBLIC_ID" 2>/dev/null)
    case "$CK" in 200) k_ok=$((k_ok+1));; *) k_other=$((k_other+1));; esac
  fi
  sleep 0.45
done
echo "ambient segment done $(date -u +%FT%TZ) anon_ok=$a_ok anon_429=$a_429 anon_other=$a_other key_ok=$k_ok key_other=$k_other"
