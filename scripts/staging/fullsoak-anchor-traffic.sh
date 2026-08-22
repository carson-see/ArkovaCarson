#!/usr/bin/env bash
# scripts/staging/fullsoak-anchor-traffic.sh
#
# Generates real anchor traffic on the fullsoak rig so the 7-day window
# evidences the CHAIN LIFECYCLE, not just availability.
#
# WHY THIS EXISTS — read before citing any evidence it produces.
# The daily probe suite was deliberately built non-destructive, so anchor
# creation happened only on Day 0. Verified 2026-08-16: 12 anchors total,
# ZERO created since clock start (2026-08-12T15:51:30Z), and
# checks.anchoring.lastSecuredAt = 2026-08-12T14:11:51Z — BEFORE the window
# began. The daily-parity assertion A16c (lastSecuredAt advancing) was
# correctly FAILING. The soak was proving a system at rest.
#
# **PROVENANCE RULE — DO NOT BACKDATE.** This instrument starts on **Day 4**
# (2026-08-16). The evidence pack must say "continuous anchor traffic from
# Day 4 onward", never "for the 7-day window". Days 0-3 evidence availability,
# configuration stability and control operation ONLY. The chain lifecycle was
# proven end-to-end on Day 0 (12/12 SECURED with 80-byte proofs) and then idle.
#
# What it does per run: submits N fingerprints through the REAL product API
# (`POST /api/v1/anchor`, API-key auth, anchor:write scope) — the same path a
# customer uses. It does NOT write to `anchors` directly, does NOT set status,
# and does NOT touch the chain client: the rig's own bound cron drives
# PENDING -> batch -> broadcast -> SECURED on prod-parity cadence, which is
# exactly the pipeline under test.
#
# Safety: submission only. Never mutates existing rows, never deletes, never
# changes rig config/env/revision — the soak clock (worker uptime) is untouched.
# Self-limiting: exits as a no-op once the window closes.
#
# Exit: 0 all submissions accepted, 1 any rejected, 2 harness error.

set -uo pipefail

CLOCK_START="2026-08-12T15:51:30Z"
CLOCK_END="2026-08-19T15:51:30Z"
TRAFFIC_START="2026-08-16"          # Day 4 — the honest start of throughput evidence

GCP_PROJECT="${GCP_PROJECT:-arkova1}"
RIG_URL="${RIG_URL:-https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app}"
API_KEY_SECRET="${API_KEY_SECRET:-arkova-fullsoak-2026-08-apikey-soak-sdk-write}"
ANCHORS_PER_RUN="${ANCHORS_PER_RUN:-3}"
CREDENTIAL_TYPE="${CREDENTIAL_TYPE:-OTHER}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVID_ROOT="${EVID_ROOT_ABS:-$REPO_ROOT/docs/staging/evidence/fullsoak-2026-08}"

iso_to_epoch() { python3 -c "import datetime,sys; print(int(datetime.datetime.strptime(sys.argv[1],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()))" "$1"; }
NOW_EPOCH="$(python3 -c 'import time; print(int(time.time()))')"
if [ "$NOW_EPOCH" -gt "$(iso_to_epoch "$CLOCK_END")" ]; then
  echo "Soak window closed ($CLOCK_END) — anchor traffic is a no-op. Remove this agent."
  exit 0
fi

UTC_NOW="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ"))')"
UTC_DATE="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"))')"
OUT_DIR="$EVID_ROOT/$UTC_DATE"; mkdir -p "$OUT_DIR" || exit 2
OUT="$OUT_DIR/anchor-traffic-$UTC_NOW.md"

command -v gcloud >/dev/null 2>&1 || { echo "gcloud unavailable" >&2; exit 2; }
KEY="$(gcloud secrets versions access latest --secret="$API_KEY_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
[ -n "$KEY" ] || { echo "could not read $API_KEY_SECRET" >&2; exit 2; }
IDT="$(gcloud auth print-identity-token --audiences="$RIG_URL" 2>/dev/null)"

# Credentials go to curl via a mode-0600 --config file, never argv (`ps`).
RC="$(mktemp)"; ( umask 077; { printf 'header = "X-API-Key: %s"\n' "$KEY"
  [ -n "$IDT" ] && printf 'header = "Authorization: Bearer %s"\n' "$IDT"
  printf 'header = "Content-Type: application/json"\n'; } > "$RC" )
trap 'rm -f "$RC"' EXIT

OK=0; BAD=0; declare -a ROWS=()
for i in $(seq 1 "$ANCHORS_PER_RUN"); do
  FP="$(openssl rand -hex 32)"
  BODY="$(printf '{"fingerprint":"%s","credential_type":"%s"}' "$FP" "$CREDENTIAL_TYPE")"
  # Body and status captured separately: BSD `head -n -1` (macOS) cannot strip
  # a trailing line, which silently emptied public_id on the first version.
  BODYF="$(mktemp)"
  CODE="$(curl -sS -m 30 -K "$RC" -X POST "$RIG_URL/api/v1/anchor" -d "$BODY" -o "$BODYF" -w '%{http_code}' 2>/dev/null)"
  PUB="$(python3 -c "import json,sys
try: print(json.load(open(sys.argv[1])).get('public_id',''))
except Exception: print('')" "$BODYF" 2>/dev/null)"
  rm -f "$BODYF"
  if [ "$CODE" = "201" ] || [ "$CODE" = "200" ]; then
    OK=$((OK+1)); ROWS+=("| $i | \`${FP:0:16}…\` | $CODE | \`$PUB\` | accepted |")
  else
    BAD=$((BAD+1)); ROWS+=("| $i | \`${FP:0:16}…\` | $CODE | — | **REJECTED** |")
  fi
  sleep 2
done

# Observed state AFTER submission — reported, never asserted as caused by this run.
HEALTH="$(curl -sS -m 15 ${IDT:+-H "Authorization: Bearer $IDT"} "$RIG_URL/health" 2>/dev/null)"
UPTIME="$(printf '%s' "$HEALTH" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('uptime','?'))
except Exception: print('?')" 2>/dev/null)"

{
  echo "# Anchor traffic — $UTC_NOW"
  echo
  echo "Window $CLOCK_START → $CLOCK_END. **Traffic generation began $TRAFFIC_START (Day 4).**"
  echo "Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule"
  echo "in this script's header. Do not describe throughput as covering the full 7 days."
  echo
  echo "Submitted via the real product API (\`POST /api/v1/anchor\`, API-key auth,"
  echo "\`anchor:write\` scope). No direct DB writes; no status set by this instrument."
  echo "PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron."
  echo
  echo "| # | fingerprint | HTTP | public_id | result |"
  echo "|---|---|---|---|---|"
  for r in "${ROWS[@]}"; do echo "$r"; done
  echo
  echo "**ANCHOR_TRAFFIC: $([ "$BAD" -eq 0 ] && echo PASS || echo FAIL)** ($OK accepted / $BAD rejected)"
  echo
  echo "Rig worker uptime at submission: ${UPTIME}s (unchanged by this instrument — it only calls the API)."
} > "$OUT"

cat "$OUT"
[ "$BAD" -gt 0 ] && exit 1
exit 0
