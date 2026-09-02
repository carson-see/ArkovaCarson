#!/usr/bin/env bash
# T3 soak supervisor — epic SCRUM-3863, PR #2572.
#
# The AUTHORITATIVE clock is Cloud Run worker uptime (a probe loop dies on a
# laptop restart; the revision does not). This loop supplies continuous
# PR-specific load and one evidence row per cycle.
#
# END is computed with `date -u` on purpose: the 2026-08-23 soaks each overran
# by exactly four hours because their supervisors parsed the window end WITHOUT
# -u and macOS read it as local time.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
EVID="$HERE/evidence"
URL="https://jpdhektjeawfjkznmpfe.supabase.co"
END_EPOCH=$(( $(date -u +%s) + 48*3600 ))
echo "soak start $(date -u +%Y-%m-%dT%H:%M:%SZ)  end $(date -u -r "$END_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
while [ "$(date -u +%s)" -lt "$END_EPOCH" ]; do
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  ID_TOKEN="$(gcloud auth print-identity-token 2>/dev/null)"
  ( cd "$REPO/services/worker" && npx tsx scripts/suborg-tenancy-driver.ts \
      --mode live \
      --supabase-url "$URL" \
      --service-role-key "$(cat /tmp/ark-rig-svc)" \
      --anon-key "$(cat /tmp/ark-rig-anon)" \
      --target-url "https://arkova-worker-suborg-3863-staging-270018525501.us-central1.run.app" \
      --worker-bearer "$ID_TOKEN" \
      --admission-json "$HERE/admission-suborg-3863.json" \
      --evidence-jsonl "$EVID/soak-${STAMP}.jsonl" ) >/dev/null 2>&1
  sleep 300
done
echo "soak window closed $(date -u +%Y-%m-%dT%H:%M:%SZ) — run close-out, do NOT glob past the end stamp"
