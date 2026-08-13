#!/usr/bin/env bash
# scripts/staging/fullsoak-90min-soc2-health.sh
#
# Lightweight, READ-ONLY SOC 2 Type 2 health check for the 2026-08 7-day
# full-functionality soak, run every 90 minutes for the duration of the
# window. Distinct from fullsoak-daily-check.sh (BL-1 parity, once/day) and
# fullsoak-daily-probes.sh (behavioural, mints fixtures/API keys — running
# THAT every 90 min for a week would mint ~112 undeleteable keys, see FD-P7).
# This script creates zero fixtures and mutates nothing.
#
# Maps each check to the SOC 2 Type 2 criterion it evidences:
#   CC6.1 (change management)   — freeze gates + pinned revision/digest unchanged
#   CC7.2 (system monitoring)   — soak alert policies + uptime checks still enabled
#   A1.2  (availability)        — rig + prod /health, uptime monotonic (no restart)
#   Evidence integrity          — SECURED count monotonic non-decreasing,
#                                  mock-height detector stays 0
#   Chain-evidence dependency   — signet bitcoind VM still RUNNING (soak's
#                                  GetBlock-hybrid provider needs it live all week)
#
# Self-limiting: after the soak window closes (clock end below) this exits
# 0 immediately with no checks and no artifact, so a forgotten cron entry
# produces silence, not noise.
#
# Exit code: 0 on SOC2_HEALTH: PASS, 1 on SOC2_HEALTH: FAIL, 2 on harness error.

set -uo pipefail

CLOCK_START="2026-08-12T15:51:30Z"
CLOCK_END="2026-08-19T15:51:30Z"

GCP_PROJECT="${GCP_PROJECT:-arkova1}"
REGION="${REGION:-us-central1}"
RIG_SERVICE="${RIG_SERVICE:-arkova-worker-fullsoak-2026-08-staging}"
RIG_URL="${RIG_URL:-https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app}"
PROD_URL="${PROD_URL:-https://arkova-worker-270018525501.us-central1.run.app}"
RIG_SUPABASE_REF="${RIG_SUPABASE_REF:-gnkuaywlpmsaezwvlvhk}"
SB_URL_SECRET="${SB_URL_SECRET:-supabase-url-fullsoak-2026-08-staging}"
SB_KEY_SECRET="${SB_KEY_SECRET:-supabase-service-role-key-fullsoak-2026-08-staging}"
BTC_VM="${BTC_VM:-arkova-s33-rig-b1-bitcoin-core-signet}"
BTC_VM_ZONE="${BTC_VM_ZONE:-us-central1-a}"

EXPECTED_REVISION="${EXPECTED_REVISION:-arkova-worker-fullsoak-2026-08-staging-00013-mrw}"
EXPECTED_DIGEST="${EXPECTED_DIGEST:-sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18}"
EXPECTED_GIT_SHA="${EXPECTED_GIT_SHA:-f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVID_ROOT="${EVID_ROOT:-$REPO_ROOT/docs/staging/evidence/fullsoak-2026-08}"
STATE_FILE="${STATE_FILE:-$EVID_ROOT/day0-snapshots/90min-health-last-state.txt}"

now_epoch() { python3 -c 'import time; print(int(time.time()))'; }
iso_to_epoch() { python3 -c "import datetime,sys; print(int(datetime.datetime.strptime(sys.argv[1],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()))" "$1"; }
NOW_EPOCH="$(now_epoch)"
END_EPOCH="$(iso_to_epoch "$CLOCK_END")"

if [ "$NOW_EPOCH" -gt "$END_EPOCH" ]; then
  echo "Soak window closed ($CLOCK_END) — 90-min health check is a no-op. Remove this cron entry."
  exit 0
fi

UTC_NOW="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ"))')"
UTC_DATE="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"))')"
OUT_DIR="$EVID_ROOT/$UTC_DATE"
mkdir -p "$OUT_DIR" "$(dirname "$STATE_FILE")"
OUT="$OUT_DIR/90min-health-$UTC_NOW.md"

# Read prior state ONCE, before any check runs or writes happen this cycle.
# Both monotonic comparisons below read from these PRIOR_* values; the file
# itself is written exactly once, at the very end of the script, from
# whatever this cycle actually observed (falling back to the prior value
# for any reading this cycle failed to obtain) — see the final write block.
PRIOR_UPTIME="<none>"; PRIOR_SECURED="<none>"
if [ -f "$STATE_FILE" ]; then
  PRIOR_UPTIME="$(grep -m1 '^last_uptime=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)"
  PRIOR_SECURED="$(grep -m1 '^last_secured=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)"
  [ -n "$PRIOR_UPTIME" ] || PRIOR_UPTIME="<none>"
  [ -n "$PRIOR_SECURED" ] || PRIOR_SECURED="<none>"
fi

PASS=0; FAIL=0; WARN=0
declare -a ROWS=()
check() { # check <name> <status PASS|FAIL|WARN> <detail>
  local name="$1" status="$2" detail="$3"
  case "$status" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; WARN) WARN=$((WARN+1));; esac
  ROWS+=("| $name | $status | $detail |")
}

command -v gcloud >/dev/null 2>&1 && GCLOUD_OK=1 || GCLOUD_OK=0
command -v gh >/dev/null 2>&1 && GH_OK=1 || GH_OK=0

# ── CC6.1: change-management freeze gates ───────────────────────────────────
if [ "$GH_OK" = 1 ]; then
  DWP="$(gh variable get DEPLOY_WORKER_PAUSED --repo "${GH_REPO_SLUG:-carson-see/ArkovaCarson}" 2>/dev/null | tr -d '\r\n')"
  SGD="$(gh variable get SOAK_GATE_DISABLED --repo "${GH_REPO_SLUG:-carson-see/ArkovaCarson}" 2>/dev/null | tr -d '\r\n')"
  [ "$DWP" = "true" ] && check "CC6.1 DEPLOY_WORKER_PAUSED" PASS "true" || check "CC6.1 DEPLOY_WORKER_PAUSED" FAIL "got '$DWP', expected true"
  [ "$SGD" = "false" ] && check "CC6.1 SOAK_GATE_DISABLED" PASS "false" || check "CC6.1 SOAK_GATE_DISABLED" FAIL "got '$SGD', expected false"
else
  check "CC6.1 freeze gates" WARN "gh not available — could not read repo variables"
fi

# ── CC6.1: pinned revision + digest unchanged ────────────────────────────────
if [ "$GCLOUD_OK" = 1 ]; then
  TRAFFIC_JSON="$(gcloud run services describe "$RIG_SERVICE" --region="$REGION" --project="$GCP_PROJECT" --format=json 2>/dev/null)"
  SERVING_REV="$(printf '%s' "$TRAFFIC_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); t=d.get('status',{}).get('traffic',[{}]); print(next((x.get('revisionName') for x in t if x.get('percent')==100), t[0].get('revisionName','')) if t else '')" 2>/dev/null)"
  SERVING_DIGEST="$(printf '%s' "$TRAFFIC_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); img=d.get('spec',{}).get('template',{}).get('spec',{}).get('containers',[{}])[0].get('image',''); print(img.split('@',1)[1] if '@' in img else '')" 2>/dev/null)"
  [ "$SERVING_REV" = "$EXPECTED_REVISION" ] && check "CC6.1 rig revision pinned" PASS "$SERVING_REV" || check "CC6.1 rig revision pinned" FAIL "got '$SERVING_REV', expected $EXPECTED_REVISION"
  [ "$SERVING_DIGEST" = "$EXPECTED_DIGEST" ] && check "CC6.1 rig digest == prod's" PASS "matches" || check "CC6.1 rig digest == prod's" FAIL "got '$SERVING_DIGEST'"
else
  check "CC6.1 revision/digest" WARN "gcloud not available"
fi

# ── A1.2: availability + uptime monotonic ────────────────────────────────────
RIG_HEALTH="$(curl -sS -m 15 -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences="$RIG_URL" 2>/dev/null)" "$RIG_URL/health" 2>/dev/null)"
RIG_STATUS="$(printf '%s' "$RIG_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','<error>'))" 2>/dev/null)"
RIG_UPTIME="$(printf '%s' "$RIG_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uptime',-1))" 2>/dev/null)"
RIG_GITSHA="$(printf '%s' "$RIG_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('git_sha',''))" 2>/dev/null)"
[ "$RIG_STATUS" = "healthy" ] && check "A1.2 rig /health" PASS "healthy, uptime=${RIG_UPTIME}s" || check "A1.2 rig /health" FAIL "status=$RIG_STATUS"
[ "$RIG_GITSHA" = "$EXPECTED_GIT_SHA" ] && check "A1.2 rig git_sha pinned" PASS "matches" || check "A1.2 rig git_sha pinned" FAIL "got '$RIG_GITSHA'"

PROD_HEALTH="$(curl -sS -m 15 "$PROD_URL/health" 2>/dev/null)"
PROD_STATUS="$(printf '%s' "$PROD_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','<error>'))" 2>/dev/null)"
[ "$PROD_STATUS" = "healthy" ] && check "A1.2 prod /health" PASS "healthy" || check "A1.2 prod /health" WARN "status=$PROD_STATUS (prod, informational)"

if [ "$PRIOR_UPTIME" != "<none>" ] && [ "${RIG_UPTIME:--1}" -ge 0 ] 2>/dev/null; then
  if [ "$RIG_UPTIME" -ge "$PRIOR_UPTIME" ]; then
    check "A1.2 uptime monotonic (no restart)" PASS "$PRIOR_UPTIME -> $RIG_UPTIME"
  else
    check "A1.2 uptime monotonic (no restart)" FAIL "DROPPED $PRIOR_UPTIME -> $RIG_UPTIME — rig restarted; R2 (>1 restart/24h restarts the soak day) applies"
  fi
else
  check "A1.2 uptime monotonic (no restart)" WARN "no prior reading to compare (first run or state lost)"
fi
# NOTE: state is written exactly ONCE, at the very end of the script (after
# the evidence-integrity block below has had a chance to read LAST_SECURED).
# An earlier version wrote state here too, which clobbered last_secured=
# before it was ever read — the SECURED-monotonic check below would then
# warn "no prior reading" on every run, forever, not just the first. Do not
# reintroduce a write in this section.

# ── CC7.2: soak monitoring instruments still enabled ─────────────────────────
if [ "$GCLOUD_OK" = 1 ]; then
  TOKEN="$(gcloud auth print-access-token 2>/dev/null)"
  POLICIES_JSON="$(curl -sS -m 20 -H "Authorization: Bearer $TOKEN" "https://monitoring.googleapis.com/v3/projects/$GCP_PROJECT/alertPolicies" 2>/dev/null)"
  # Count only LIVE soak policies. A policy renamed to start with "RETIRED"
  # is deliberately disabled and superseded (e.g. the boot-line detector that
  # fired on autoscaling cold starts rather than revision changes) — counting
  # it would make this check report a permanent false FAIL.
  SOAK_POLICIES_ON="$(printf '%s' "$POLICIES_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
pols=[p for p in d.get('alertPolicies',[])
      if 'SOAK' in p.get('displayName','') and not p.get('displayName','').startswith('RETIRED')]
on=[p for p in pols if p.get('enabled')]
print(f'{len(on)}/{len(pols)}')" 2>/dev/null)"
  SOAK_POLICIES_COUNT_OK="$(printf '%s' "$SOAK_POLICIES_ON" | python3 -c "import sys; s=sys.stdin.read().strip(); a,b=s.split('/'); print('1' if a==b and int(b)>=3 else '0')" 2>/dev/null)"
  [ "$SOAK_POLICIES_COUNT_OK" = "1" ] && check "CC7.2 soak alert policies enabled" PASS "$SOAK_POLICIES_ON" || check "CC7.2 soak alert policies enabled" FAIL "$SOAK_POLICIES_ON (expect >=3, all enabled)"

  CHECKS_JSON="$(curl -sS -m 20 -H "Authorization: Bearer $TOKEN" "https://monitoring.googleapis.com/v3/projects/$GCP_PROJECT/uptimeCheckConfigs" 2>/dev/null)"
  SOAK_CHECKS_COUNT="$(printf '%s' "$CHECKS_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
n=len([c for c in d.get('uptimeCheckConfigs',[]) if 'SOAK' in c.get('displayName','') or 'soak' in c.get('displayName','')])
print(n)" 2>/dev/null)"
  [ "${SOAK_CHECKS_COUNT:-0}" -ge 4 ] 2>/dev/null && check "CC7.2 soak uptime checks present" PASS "$SOAK_CHECKS_COUNT found" || check "CC7.2 soak uptime checks present" FAIL "only $SOAK_CHECKS_COUNT found, expect >=4"
else
  check "CC7.2 monitoring instruments" WARN "gcloud not available"
fi

# ── Chain-evidence dependency: signet bitcoind VM ────────────────────────────
if [ "$GCLOUD_OK" = 1 ]; then
  VM_STATUS="$(gcloud compute instances describe "$BTC_VM" --zone="$BTC_VM_ZONE" --project="$GCP_PROJECT" --format="value(status)" 2>/dev/null)"
  [ "$VM_STATUS" = "RUNNING" ] && check "Chain-dep bitcoind VM" PASS "RUNNING" || check "Chain-dep bitcoind VM" FAIL "status='$VM_STATUS' — BL-2's GetBlock-hybrid provider needs this live all week"
else
  check "Chain-dep bitcoind VM" WARN "gcloud not available"
fi

# ── Evidence integrity: SECURED monotonic, mock-height detector ─────────────
SB_URL_VAL="$(gcloud secrets versions access latest --secret="$SB_URL_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
SB_KEY_VAL="$(gcloud secrets versions access latest --secret="$SB_KEY_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
if [ -n "$SB_URL_VAL" ] && [ -n "$SB_KEY_VAL" ]; then
  CURLRC="$(mktemp)"
  ( umask 077; { printf 'header = "apikey: %s"\n' "$SB_KEY_VAL"; printf 'header = "Authorization: Bearer %s"\n' "$SB_KEY_VAL"; } > "$CURLRC" )
  SECURED_NOW="$(curl -sS -m 15 -K "$CURLRC" "$SB_URL_VAL/rest/v1/anchors?select=id&status=eq.SECURED&limit=1" -H "Prefer: count=exact" -o /dev/null -D - 2>/dev/null | grep -i '^content-range' | sed -E 's#.*/##' | tr -d '\r')"
  MOCK_COUNT="$(curl -sS -m 15 -K "$CURLRC" "$SB_URL_VAL/rest/v1/anchors?select=id&chain_block_height=gt.400000&limit=1" -H "Prefer: count=exact" -o /dev/null -D - 2>/dev/null | grep -i '^content-range' | sed -E 's#.*/##' | tr -d '\r')"
  rm -f "$CURLRC"

  [ "${MOCK_COUNT:-0}" = "0" ] && check "Evidence mock-height detector" PASS "0 anchors above height 400000" || check "Evidence mock-height detector" FAIL "$MOCK_COUNT anchors with chain_block_height>400000 — MockChainClient contamination"

  if [ "$PRIOR_SECURED" != "<none>" ] && [ -n "${SECURED_NOW:-}" ]; then
    if [ "$SECURED_NOW" -ge "$PRIOR_SECURED" ] 2>/dev/null; then
      check "Evidence SECURED count monotonic" PASS "$PRIOR_SECURED -> $SECURED_NOW"
    else
      check "Evidence SECURED count monotonic" FAIL "DROPPED $PRIOR_SECURED -> $SECURED_NOW — investigate immediately, do not assume benign"
    fi
  else
    check "Evidence SECURED count monotonic" WARN "no prior reading (first run) — now=${SECURED_NOW:-<unreadable>}"
  fi
else
  check "Evidence integrity (SECURED/mock-height)" WARN "could not reach Supabase REST"
fi

# Single state write for the whole run, using this cycle's readings where
# available and falling back to the prior value otherwise — never clobbers
# a good prior reading with an unreadable one.
WRITE_UPTIME="${RIG_UPTIME:-}"
[ -n "$WRITE_UPTIME" ] && [ "$WRITE_UPTIME" -ge 0 ] 2>/dev/null || WRITE_UPTIME="$PRIOR_UPTIME"
WRITE_SECURED="${SECURED_NOW:-}"
[ -n "$WRITE_SECURED" ] || WRITE_SECURED="$PRIOR_SECURED"
{ echo "last_uptime=$WRITE_UPTIME"; echo "last_secured=$WRITE_SECURED"; echo "last_check_utc=$UTC_NOW"; } > "$STATE_FILE"

VERDICT="PASS"
[ "$FAIL" -gt 0 ] && VERDICT="FAIL"

{
  echo "# 90-min SOC 2 Type 2 health check — $UTC_NOW"
  echo
  echo "Window: $CLOCK_START -> $CLOCK_END. Read-only; no fixtures created; no infra mutated."
  echo
  echo "| Check | Status | Detail |"
  echo "|---|---|---|"
  for r in "${ROWS[@]}"; do echo "$r"; done
  echo
  echo "**SOC2_HEALTH: $VERDICT** ($PASS pass / $FAIL fail / $WARN warn)"
} > "$OUT"

cat "$OUT"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
