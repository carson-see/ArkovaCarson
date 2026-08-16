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
# EVID_ROOT_ABS is accepted as an alias so every soak instrument takes the same
# override. It used to be ignored HERE only, which silently sent manual runs to
# the repo default while launchd wrote the home path — two diverging state files,
# and the manual one was a stale orphan for 33h. See the staleness guard below.
EVID_ROOT="${EVID_ROOT:-${EVID_ROOT_ABS:-$REPO_ROOT/docs/staging/evidence/fullsoak-2026-08}}"
STATE_FILE="${STATE_FILE:-$EVID_ROOT/90min-health-last-state.txt}"

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
PRIOR_UPTIME="<none>"; PRIOR_SECURED="<none>"; PRIOR_AGE_MIN=""
if [ -f "$STATE_FILE" ]; then
  PRIOR_UPTIME="$(grep -m1 '^last_uptime=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)"
  PRIOR_SECURED="$(grep -m1 '^last_secured=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)"
  PRIOR_STAMP="$(grep -m1 '^last_check_utc=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)"
  [ -n "$PRIOR_UPTIME" ] || PRIOR_UPTIME="<none>"
  [ -n "$PRIOR_SECURED" ] || PRIOR_SECURED="<none>"
  # Staleness guard. A monotonic comparison against an OLD anchor is not an
  # assertion — it passes for the wrong reason. This actually happened: manual
  # runs read an orphaned state file frozen at last_uptime=125147 for 33h and
  # reported PASS every cycle purely because uptime kept exceeding it. The
  # cadence is 90 min, so anything older than 3h means the previous write did
  # not land and both monotonic checks below are meaningless.
  if [ -n "${PRIOR_STAMP:-}" ]; then
    PRIOR_AGE_MIN="$(python3 -c "
import datetime,sys
try:
  t=datetime.datetime.strptime(sys.argv[1],'%Y-%m-%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
  print(int((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()//60))
except Exception: print(-1)" "$PRIOR_STAMP" 2>/dev/null)"
  fi
fi

PASS=0; FAIL=0; WARN=0
declare -a ROWS=()

check_state_freshness() {
  if [ "$PRIOR_UPTIME" = "<none>" ]; then
    check "CC7.2 monotonic-state freshness" WARN "no prior state (first run, or STATE_FILE just reset) — monotonic checks are informational this cycle"
  elif [ -z "${PRIOR_AGE_MIN:-}" ] || [ "${PRIOR_AGE_MIN:--1}" -lt 0 ] 2>/dev/null; then
    check "CC7.2 monotonic-state freshness" FAIL "state file carries no parsable last_check_utc — the monotonic assertions below cannot be trusted; STATE_FILE=$STATE_FILE"
  elif [ "$PRIOR_AGE_MIN" -gt 180 ] 2>/dev/null; then
    check "CC7.2 monotonic-state freshness" FAIL "prior state is ${PRIOR_AGE_MIN}m old (>3h) — the previous write did not land, so uptime/SECURED monotonic below PASS for the wrong reason; STATE_FILE=$STATE_FILE"
  else
    check "CC7.2 monotonic-state freshness" PASS "prior state ${PRIOR_AGE_MIN}m old"
  fi
}
check() { # check <name> <status PASS|FAIL|WARN> <detail>
  local name="$1" status="$2" detail="$3"
  case "$status" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; WARN) WARN=$((WARN+1));; esac
  ROWS+=("| $name | $status | $detail |")
}

# Must run AFTER check() exists — an earlier version called this one line too
# early, so it silently no-op'd and the guard never appeared in the report.
check_state_freshness

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

  # A18 (added Day 4, 2026-08-16) — TREASURY VISIBILITY.
  # FD-CHAIN-1: the worker claimed "Treasury has no UTXOs — ... until funded"
  # while the treasury held 742,637 sat, because GetBlockHybridProvider
  # .listUnspent guards on `length >= 0` and so returns [] instead of falling
  # back. The VM being RUNNING says nothing about whether the worker can SEE
  # the treasury through it. Assert on the worker's own claim.
  UTXO_BLIND="$(gcloud logging read "resource.type=\"cloud_run_revision\"
   AND resource.labels.service_name=\"$RIG_SERVICE\"
   AND (jsonPayload.msg:\"Treasury has no UTXOs\" OR jsonPayload.msg:\"Treasury empty\")
   AND timestamp>=\"$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=95)).strftime("%Y-%m-%dT%H:%M:%SZ"))')\"" \
   --project="$GCP_PROJECT" --limit=1 --format="value(timestamp)" 2>/dev/null | head -1)"
  if [ -z "$UTXO_BLIND" ]; then
    check "Chain-dep treasury visible to worker" PASS "no 'no UTXOs' claim in last 95m"
  else
    check "Chain-dep treasury visible to worker" FAIL "worker reported treasury empty at $UTXO_BLIND — VERIFY THE BALANCE INDEPENDENTLY before funding anything (FD-CHAIN-1: this claim was false once already)"
  fi
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
  # A17 (added Day 4, 2026-08-16; THRESHOLD CORRECTED same day) — DRAIN LIVENESS.
  # Added because this script reported 13/13 PASS straight through a TOTAL
  # anchoring outage (FD-CHAIN-1): batch-anchors returned HTTP 200 while
  # skipping every batch, so nothing here noticed. Worker liveness is not
  # anchoring liveness.
  #
  # CORRECTION: the first version failed any PENDING older than 75 min, on the
  # assumption that the */30 cron drains every cycle. It does not, and that
  # assertion would have raised a false FAIL every single day. Batching is
  # TRIGGER-based (batch-anchor.ts):
  #   Trigger A — pendingCount >= BATCH_SIZE (10,000)         → fire
  #   Trigger B — pendingCount >= 3,000 AND oldest age >= 3h  → fire
  #   Trigger D — daily 03:00 forced flush                    → fire whatever is queued
  # A micro-queue is DESIGNED to sit until the 03:00 flush; firing a TX for a
  # handful of leaves burns a UTXO for nothing (the pre-2026-04-28 behavior
  # that PR #627 removed). So the real failure signal is a MISSED DAILY FLUSH,
  # not an anchor waiting a few hours. 26h allows one full daily cycle plus margin.
  OLDEST_PENDING="$(curl -sS -m 15 -K "$CURLRC" "$SB_URL_VAL/rest/v1/anchors?select=created_at&status=eq.PENDING&order=created_at.asc&limit=1" 2>/dev/null | python3 -c "
import json,sys,datetime
try:
  d=json.load(sys.stdin)
  if not d: print(-1)
  else:
    t=datetime.datetime.fromisoformat(d[0]['created_at'].replace('Z','+00:00'))
    print(int((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()//60))
except Exception: print(-2)" 2>/dev/null)"
  rm -f "$CURLRC"

  if [ "${OLDEST_PENDING:--2}" = "-1" ]; then
    check "A1.2 anchor drain liveness (daily flush)" PASS "no PENDING anchors"
  elif [ "${OLDEST_PENDING:--2}" -ge 0 ] 2>/dev/null && [ "$OLDEST_PENDING" -le 1560 ]; then
    check "A1.2 anchor drain liveness (daily flush)" PASS "oldest PENDING ${OLDEST_PENDING}m (<=26h; micro-queues drain at the 03:00 flush by design)"
  elif [ "${OLDEST_PENDING:--2}" -gt 1560 ] 2>/dev/null; then
    check "A1.2 anchor drain liveness (daily flush)" FAIL "oldest PENDING ${OLDEST_PENDING}m > 26h — a DAILY FLUSH WAS MISSED (Trigger D), not merely a deferred micro-batch"
  else
    check "A1.2 anchor drain liveness (daily flush)" WARN "could not read PENDING age"
  fi

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
