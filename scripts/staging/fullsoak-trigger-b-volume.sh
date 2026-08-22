#!/usr/bin/env bash
# scripts/staging/fullsoak-trigger-b-volume.sh
#
# ONE-SHOT volume injection to make Trigger B reachable on the fullsoak rig.
#
# WHY. Batching is trigger-based (services/worker/src/jobs/batch-anchor.ts):
#   Trigger A — pendingCount >= BATCH_SIZE (10,000)
#   Trigger B — pendingCount >= MIN_BATCH_THRESHOLD (3,000) AND oldest age >= 3h
#   Trigger D — daily 03:00 forced flush, fires whatever is queued
# The continuous anchor-traffic generator submits ~36/day, so A and B are
# STRUCTURALLY UNREACHABLE and the window would evidence Trigger D only.
# CLAUDE.md §1.12 lists "Trigger A fires, Trigger B fires" as required T3
# evidence. See docs/staging/fullsoak-2026-08/batch-trigger-coverage.md.
#
# WHAT IT DOES. Submits N fingerprints through the REAL product API
# (POST /api/v1/anchor, API-key auth, anchor:write scope) — the same path a
# customer uses. No direct DB writes, no status set, no chain client. The
# rig's own bound */30 cron evaluates the triggers and drives the broadcast.
#
# SAFETY.
#   * Submission only. Never mutates or deletes existing rows.
#   * Never changes rig config, env or revision — the soak clock (worker
#     uptime) is untouched.
#   * Paced at PACE_PER_SEC (default 8/s ≈ 480/min) against a 1,000/min
#     API-key limit, so it cannot trip the rate limiter it shares with the
#     probes.
#   * Refuses to run if the window has closed.
#   * Idempotent-ish by construction: every fingerprint is fresh random hex,
#     so no dedup short-circuit and no quota double-spend on re-submission.
#
# Exit: 0 target reached, 1 rejections seen, 2 harness error.

set -uo pipefail

CLOCK_END="2026-08-19T15:51:30Z"
GCP_PROJECT="${GCP_PROJECT:-arkova1}"
RIG_URL="${RIG_URL:-https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app}"
API_KEY_SECRET="${API_KEY_SECRET:-arkova-fullsoak-2026-08-apikey-soak-sdk-write}"
TARGET="${TARGET:-3100}"          # a little over the 3,000 floor
PACE_PER_SEC="${PACE_PER_SEC:-8}"
CONCURRENCY="${CONCURRENCY:-8}"
CREDENTIAL_TYPE="${CREDENTIAL_TYPE:-OTHER}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVID_ROOT="${EVID_ROOT_ABS:-$REPO_ROOT/docs/staging/evidence/fullsoak-2026-08}"

NOW_EPOCH="$(python3 -c 'import time; print(int(time.time()))')"
END_EPOCH="$(python3 -c "import datetime,sys; print(int(datetime.datetime.strptime('$CLOCK_END','%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()))")"
[ "$NOW_EPOCH" -gt "$END_EPOCH" ] && { echo "Soak window closed — no-op."; exit 0; }

UTC_NOW="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ"))')"
UTC_DATE="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"))')"
OUT_DIR="$EVID_ROOT/$UTC_DATE"; mkdir -p "$OUT_DIR" || exit 2
OUT="$OUT_DIR/trigger-b-volume-$UTC_NOW.md"

command -v gcloud >/dev/null 2>&1 || { echo "gcloud unavailable" >&2; exit 2; }
KEY="$(gcloud secrets versions access latest --secret="$API_KEY_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
[ -n "$KEY" ] || { echo "could not read $API_KEY_SECRET" >&2; exit 2; }
IDT="$(gcloud auth print-identity-token --audiences="$RIG_URL" 2>/dev/null)"

# Credentials go to curl via a mode-0600 --config file, never argv (`ps`).
RC="$(mktemp)"; ( umask 077; { printf 'header = "X-API-Key: %s"\n' "$KEY"
  [ -n "$IDT" ] && printf 'header = "Authorization: Bearer %s"\n' "$IDT"
  printf 'header = "Content-Type: application/json"\n'; } > "$RC" )
CODES="$(mktemp)"
trap 'rm -f "$RC" "$CODES"' EXIT

submit_one() {
  FP="$(openssl rand -hex 32)"
  curl -sS -m 30 -K "$RC" -X POST "$RIG_URL/api/v1/anchor" \
    -d "{\"fingerprint\":\"$FP\",\"credential_type\":\"$CREDENTIAL_TYPE\"}" \
    -o /dev/null -w '%{http_code}\n' 2>/dev/null
}
export -f submit_one; export RC RIG_URL CREDENTIAL_TYPE

START_TS="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')"
echo "injecting $TARGET anchors at ~${PACE_PER_SEC}/s (concurrency $CONCURRENCY)"
BATCH=$((PACE_PER_SEC))
SENT=0
while [ "$SENT" -lt "$TARGET" ]; do
  N=$BATCH; [ $((SENT+N)) -gt "$TARGET" ] && N=$((TARGET-SENT))
  seq 1 "$N" | xargs -P "$CONCURRENCY" -I{} bash -c 'submit_one' >> "$CODES" 2>/dev/null
  SENT=$((SENT+N))
  [ $((SENT % 500)) -eq 0 ] && echo "  sent $SENT/$TARGET"
  sleep 1
done
END_TS="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')"

OK="$(grep -c '^20[01]$' "$CODES" 2>/dev/null || echo 0)"
BAD=$((SENT-OK))

{
  echo "# Trigger B volume injection — $UTC_NOW"
  echo
  echo "One-shot. Makes Trigger B reachable so the window can evidence more than the"
  echo "daily flush. See \`batch-trigger-coverage.md\` for why A and B are otherwise"
  echo "structurally unreachable at ~36 anchors/day."
  echo
  echo "| field | value |"
  echo "|---|---|"
  echo "| submitted | $SENT |"
  echo "| accepted (2xx) | $OK |"
  echo "| rejected | $BAD |"
  echo "| start | $START_TS |"
  echo "| end | $END_TS |"
  echo "| pace | ~${PACE_PER_SEC}/s against a 1,000/min API-key limit |"
  echo
  echo "Response-code histogram:"; echo '```'
  sort "$CODES" | uniq -c | sort -rn | head; echo '```'
  echo
  echo "Submitted via the real product API (\`POST /api/v1/anchor\`, API-key auth,"
  echo "\`anchor:write\` scope). No direct DB writes; no status set by this instrument."
  echo "Trigger evaluation and broadcast are the rig's own bound cron."
} > "$OUT"

cat "$OUT"
[ "$BAD" -gt 0 ] && exit 1
exit 0
