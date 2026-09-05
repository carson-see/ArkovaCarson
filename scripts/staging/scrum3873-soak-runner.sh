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
RIG_SERVICE_ROLE_KEY="${RIG_SERVICE_ROLE_KEY:?RIG_SERVICE_ROLE_KEY is required (seeds the collision org)}"
COLLISION_DOMAIN="${COLLISION_DOMAIN:-soak-collision.test}"
EVIDENCE_PUSH_EVERY="${EVIDENCE_PUSH_EVERY:-20}"   # cycles between durability pushes
DURATION_MIN="${DURATION_MIN:-2880}"     # 48h
# 16 calls/cycle at 180s = ~5.3 req/min against the /admin router's 10/min
# ceiling. The previous 900s cadence used 7% of the available budget and made
# a 48h rig produce 192 shallow cycles.
INTERVAL_SEC="${INTERVAL_SEC:-180}"

case "$TARGET_URL$RIG_SUPABASE_URL" in
  *vzwyaatejekddvltxyye*|*fizyjojbebyalirtjjht*|*app.arkova.ai*)
    echo "REFUSING: target resolves to production." >&2; exit 1 ;;
  *) ;;
esac

# Keep bearer tokens and fixture passwords out of command-line arguments.
export RIG_SUPABASE_URL RIG_ANON_KEY RIG_SERVICE_ROLE_KEY COLLISION_DOMAIN
export SUPABASE_URL="$RIG_SUPABASE_URL"
export SUPABASE_ANON_KEY="$RIG_ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$RIG_SERVICE_ROLE_KEY"
export EXPECTED_SOURCE_HEAD="${EXPECTED_SOURCE_HEAD:?EXPECTED_SOURCE_HEAD is required}"
mint() {
  local mint_email="$1" mint_password="$2"
  MINT_EMAIL="$mint_email" MINT_PASSWORD="$mint_password" python3 - <<'PYTHON'
import json, os, urllib.request
try:
    payload = json.dumps({"email": os.environ["MINT_EMAIL"], "password": os.environ["MINT_PASSWORD"]}).encode()
    request = urllib.request.Request(os.environ["RIG_SUPABASE_URL"] + "/auth/v1/token?grant_type=password", data=payload,
        headers={"apikey": os.environ["RIG_ANON_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        print(json.load(response).get("access_token", ""))
except Exception:
    print("")
PYTHON
}

# One-time: an org that CLAIMS the collision domain. Without this,
# auto_associate_profile_to_org_by_email_domain never fires and the soak never
# touches F2 — the mechanism the whole design exists to defend against.
seed_collision_org() {
  local existing
  existing=$(curl -s --max-time 20 \
    "$RIG_SUPABASE_URL/rest/v1/organizations?domain=eq.$COLLISION_DOMAIN&select=id&limit=1" \
    -H "apikey: $RIG_SERVICE_ROLE_KEY" -H "Authorization: Bearer $RIG_SERVICE_ROLE_KEY")
  if [[ "$existing" == "[]" ]]; then
    curl -s --max-time 20 -X POST "$RIG_SUPABASE_URL/rest/v1/organizations" \
      -H "apikey: $RIG_SERVICE_ROLE_KEY" -H "Authorization: Bearer $RIG_SERVICE_ROLE_KEY" \
      -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
      -d "{\"display_name\":\"Soak Collision Claimant\",\"legal_name\":\"Soak Collision Claimant\",\"domain\":\"$COLLISION_DOMAIN\",\"verification_status\":\"UNVERIFIED\"}" >/dev/null
    echo "seeded collision org claiming $COLLISION_DOMAIN"
  else
    echo "collision org already claims $COLLISION_DOMAIN"
  fi
}
seed_collision_org

# Durability: the evidence must never live only on this disk.
push_evidence() {
  local snap=/tmp/soak-evidence-wt
  [[ -d "$snap" ]] || return 0
  cp "$EVIDENCE" "$snap/docs/staging/provisioning-3873/" 2>/dev/null || return 0
  ( cd "$snap" && git add -A \
    && git -c user.name=carson -c user.email=carson@arkova.io \
         commit -q -m "chore(SCRUM-3873): soak evidence @ $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    && git push -q origin soak-evidence/scrum-3873 ) >/dev/null 2>&1 \
    && echo "evidence pushed at $(date -u +%H:%M:%SZ)"
}

DEADLINE=$(( $(date +%s) + DURATION_MIN * 60 ))
CYCLE=0
mkdir -p "$(dirname "$EVIDENCE")"
echo "soak start $(date -u +%Y-%m-%dT%H:%M:%SZ) deadline=$(date -u -r "$DEADLINE" +%Y-%m-%dT%H:%M:%SZ)"

while [[ "$(date +%s)" -lt "$DEADLINE" ]]; do
  CYCLE=$((CYCLE + 1))
  export ADMIN_TOKEN NONADMIN_TOKEN
  ADMIN_TOKEN=$(mint "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  NONADMIN_TOKEN=$(mint "$NONADMIN_EMAIL" "$NONADMIN_PASSWORD")

  if [[ -z "$ADMIN_TOKEN" || -z "$NONADMIN_TOKEN" ]]; then
    # Record the gap rather than skipping quietly: a soak with unexplained
    # silent windows is not merge-grade.
    printf '{"utc":"%s","story":"SCRUM-3873","cycle":%d,"status":"fail","blockers":["token mint failed"]}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CYCLE" >> "$EVIDENCE"
    sleep "$INTERVAL_SEC"; continue
  fi

  npx tsx services/worker/scripts/scrum3873-provisioning-driver.ts \
    --live --target-url "$TARGET_URL" \
    --collision-domain "$COLLISION_DOMAIN" \
    --evidence-jsonl "$EVIDENCE" >/dev/null 2>&1 \
    || echo "cycle $CYCLE reported a failure (recorded in $EVIDENCE)"

  if [[ $(( CYCLE % EVIDENCE_PUSH_EVERY )) -eq 0 ]]; then push_evidence; fi

  sleep "$INTERVAL_SEC"
done

push_evidence
echo "soak end $(date -u +%Y-%m-%dT%H:%M:%SZ) cycles=$CYCLE"
echo "pass=$(grep -c '"status":"pass"' "$EVIDENCE" || true) fail=$(grep -c '"status":"fail"' "$EVIDENCE" || true)"
