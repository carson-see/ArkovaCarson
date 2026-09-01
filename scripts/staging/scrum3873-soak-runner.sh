#!/usr/bin/env bash
# SCRUM-3873 T3 soak runner.
#
# Drives scrum3873-provisioning-driver.ts on a fixed cadence for the soak
# window. Supabase access tokens expire hourly, so tokens are re-minted every
# cycle rather than captured once — a runner that mints once dies silently at
# the first expiry and leaves a soak that looks like it ran.
#
# Refuses to target production. Isolated rigs only (§1.11A).
set -euo pipefail

TARGET_URL="${TARGET_URL:?TARGET_URL (rig Cloud Run URL) is required}"
RIG_SUPABASE_URL="${RIG_SUPABASE_URL:?RIG_SUPABASE_URL is required}"
RIG_ANON_KEY="${RIG_ANON_KEY:?RIG_ANON_KEY is required}"
ADMIN_EMAIL="${ADMIN_EMAIL:?ADMIN_EMAIL is required}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
NONADMIN_EMAIL="${NONADMIN_EMAIL:?NONADMIN_EMAIL is required}"
NONADMIN_PASSWORD="${NONADMIN_PASSWORD:?NONADMIN_PASSWORD is required}"
EVIDENCE="${EVIDENCE:?EVIDENCE (jsonl path) is required}"
DURATION_MIN="${DURATION_MIN:-2880}"     # 48h
INTERVAL_SEC="${INTERVAL_SEC:-900}"      # 15 min

case "$TARGET_URL$RIG_SUPABASE_URL" in
  *vzwyaatejekddvltxyye*|*app.arkova.ai*)
    echo "REFUSING: target resolves to production." >&2; exit 1 ;;
esac

mint() {  # $1=email $2=password — echoes an access_token or empty
  curl -s --max-time 20 -X POST \
    "$RIG_SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $RIG_ANON_KEY" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || echo ""
}

DEADLINE=$(( $(date +%s) + DURATION_MIN * 60 ))
CYCLE=0
mkdir -p "$(dirname "$EVIDENCE")"
echo "soak start $(date -u +%Y-%m-%dT%H:%M:%SZ) deadline=$(date -u -r "$DEADLINE" +%Y-%m-%dT%H:%M:%SZ)"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CYCLE=$((CYCLE + 1))
  ADMIN_TOKEN=$(mint "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  NONADMIN_TOKEN=$(mint "$NONADMIN_EMAIL" "$NONADMIN_PASSWORD")

  if [ -z "$ADMIN_TOKEN" ] || [ -z "$NONADMIN_TOKEN" ]; then
    # Record the gap rather than skipping quietly: a soak with unexplained
    # silent windows is not merge-grade.
    printf '{"utc":"%s","story":"SCRUM-3873","cycle":%d,"status":"fail","blockers":["token mint failed"]}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CYCLE" >> "$EVIDENCE"
    sleep "$INTERVAL_SEC"; continue
  fi

  npx tsx services/worker/scripts/scrum3873-provisioning-driver.ts \
    --live --target-url "$TARGET_URL" \
    --bearer-token "$ADMIN_TOKEN" --non-admin-token "$NONADMIN_TOKEN" \
    --evidence-jsonl "$EVIDENCE" >/dev/null 2>&1 \
    || echo "cycle $CYCLE reported a failure (recorded in $EVIDENCE)"

  sleep "$INTERVAL_SEC"
done

echo "soak end $(date -u +%Y-%m-%dT%H:%M:%SZ) cycles=$CYCLE"
echo "pass=$(grep -c '"status":"pass"' "$EVIDENCE" || true) fail=$(grep -c '"status":"fail"' "$EVIDENCE" || true)"
