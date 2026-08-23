#!/usr/bin/env bash
# =============================================================================
# PR #2291 (Node 22 LTS worker upgrade) — T2 soak CLOSE CAPTURE. READ-ONLY.
#
#   Window : 2026-08-22T21:27:29.654107Z -> 2026-08-23T09:27:29Z  (T2, 12 h)
#   Rig    : arkova-worker-node22-staging  rev arkova-worker-node22-staging-00001-8md
#   Tag    : pr-2291   Supabase: yklabujmzhzbvnhovcjt   project: arkova1
#   Head   : f41192e061d72ef8866f19dbd50c16593ccbca23 (frozen)
#
# Run AT/AFTER 2026-08-23T09:27:29Z. The script refuses to run early — closing
# the window early is exactly the mistake this guard exists to prevent. It makes
# NO serving-state change: probes are GETs, everything else is gcloud describe /
# logging read / local file reads. Rollback rehearsal is a SEPARATE script
# (rollback-rehearsal.sh) and must run AFTER this one, because the rehearsal
# creates a new revision and this script's whole job is to seal the clock first.
#
# Captures in one pass (everything lands in $OUTDIR):
#   1. 5x /api/health with timings (identity token WITHOUT --audiences,
#      riding X-Serverless-Authorization — FD-WAVE3-1 / train-4 constraints)
#   2. serving revision + traffic split (must still be 00001-8md @ 100%)
#   3. revision creationTimestamp (FD-CLOCK-1: this IS the soak clock)
#   4. distinct revisions that served in-window (request-log revision_name
#      sample, 6 x 2h chunks, per-chunk counts so a 20k read-cap hit is VISIBLE)
#   5. container terminations / OOM / system-log warnings in-window
#   6. every 5xx in-window with per-path counts (separate targeted query)
#   7. driver evidence roll-up: all load-*.json + supervisor.log (cycles,
#      ok/fail/429/coldStartRetries totals, deviations, rc history), and a copy
#      of every evidence artifact into $OUTDIR so the close-out commit can pick
#      them up from one place.
# =============================================================================
set -uo pipefail

PROJECT="arkova1"
REGION="us-central1"
SERVICE="arkova-worker-node22-staging"
EXPECT_REV="arkova-worker-node22-staging-00001-8md"
EXPECT_REV_CREATED="2026-08-22T21:27:29.654107Z"
EXPECT_DIGEST="sha256:c6f51425d50744c8aeecf439dafae2b5055567ad440b9e891dae617f9d652556"
HEAD_SHA="f41192e061d72ef8866f19dbd50c16593ccbca23"
BASE_URL="https://pr-2291---arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app"
CLOCK_START="2026-08-22T21:27:29Z"
CLOCK_END="2026-08-23T09:27:29Z"
HOME_DIR="/Users/carson/arkova-soak/node22"
EVIDENCE_DIR="/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/node22-2026-08/evidence"
REQ_LOG='projects/arkova1/logs/run.googleapis.com%2Frequests'
SYS_LOG='projects/arkova1/logs/run.googleapis.com%2Fvarlog%2Fsystem'

# --- guard: never close early -------------------------------------------------
END_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$CLOCK_END" +%s 2>/dev/null || date -d "$CLOCK_END" +%s)
NOW_EPOCH=$(date -u +%s)
if [ "$NOW_EPOCH" -lt "$END_EPOCH" ]; then
  echo "REFUSING: window closes $CLOCK_END; now $(date -u +%FT%TZ)." >&2
  echo "Do not close the soak early. ($(( (END_EPOCH - NOW_EPOCH) / 60 )) min remain)" >&2
  exit 1
fi

OUTDIR="$HOME_DIR/close-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/summary.md"
say() { echo "$*" | tee -a "$SUMMARY"; }
say "# PR #2291 node22 T2 close capture — $(date -u +%FT%TZ)"
say ""

# --- 1. 5x /api/health with timings ------------------------------------------
# Token minted fresh, ONCE, WITHOUT --audiences (train-4); mint stderr kept.
if ! gcloud auth print-identity-token > "$OUTDIR/idtoken" 2> "$OUTDIR/idtoken.err"; then
  say "FATAL: identity-token mint failed — see $OUTDIR/idtoken.err"; exit 1
fi
[ -s "$OUTDIR/idtoken" ] || { say "FATAL: minted token empty"; exit 1; }
chmod 600 "$OUTDIR/idtoken"
TOK="$(cat "$OUTDIR/idtoken")"

say "## 1. Health at close (5x /api/health)"
HEALTH_FAILS=0
i=1
while [ "$i" -le 5 ]; do
  CODE=$(curl -s --max-time 25 -o "$OUTDIR/health-$i.json" -w '%{http_code} %{time_total}' \
    -H "X-Serverless-Authorization: Bearer $TOK" "$BASE_URL/api/health") || CODE="000 -"
  GS=$(jq -r '.git_sha // "?"' "$OUTDIR/health-$i.json" 2>/dev/null || echo '?')
  UP=$(jq -r '.uptime // "?"' "$OUTDIR/health-$i.json" 2>/dev/null || echo '?')
  say "  run $i: HTTP ${CODE}s git_sha=${GS} uptime=${UP}"
  case "$CODE" in 200\ *) :;; *) HEALTH_FAILS=$((HEALTH_FAILS+1));; esac
  [ "$GS" = "$HEAD_SHA" ] || { say "  run $i: GIT_SHA MISMATCH (want $HEAD_SHA)"; HEALTH_FAILS=$((HEALTH_FAILS+1)); }
  i=$((i+1))
done
say "  -> health fails: $HEALTH_FAILS (template wants 5/5 x HTTP 200, git_sha match)"
say "  NOTE: /health uptime is the current INSTANCE, not the soak clock (FD-CLOCK-1)."
say ""

# --- 2+3. serving revision, traffic split, creationTimestamp ------------------
say "## 2. Serving revision + traffic at close"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format=json > "$OUTDIR/service.json" 2> "$OUTDIR/service.err" || say "  ERROR: services describe failed"
jq '{latestReady: .status.latestReadyRevisionName, latestCreated: .status.latestCreatedRevisionName, traffic: .status.traffic}' \
  "$OUTDIR/service.json" | tee -a "$SUMMARY"
SERVING=$(jq -r '.status.traffic[0].revisionName // "?"' "$OUTDIR/service.json")
PCT=$(jq -r '.status.traffic[0].percent // "?"' "$OUTDIR/service.json")
NTRAFFIC=$(jq -r '.status.traffic | length' "$OUTDIR/service.json")
if [ "$SERVING" = "$EXPECT_REV" ] && [ "$PCT" = "100" ] && [ "$NTRAFFIC" = "1" ]; then
  say "  -> REVISION UNCHANGED: $EXPECT_REV @ 100%, single entry. PASS"
else
  say "  -> !!! REVISION/TRAFFIC CHANGED (serving=$SERVING pct=$PCT entries=$NTRAFFIC; want $EXPECT_REV @100, 1 entry) — CLOCK INTEGRITY BROKEN, investigate before writing the maturity record"
fi

gcloud run revisions describe "$EXPECT_REV" --project "$PROJECT" --region "$REGION" \
  --format="value(metadata.creationTimestamp, status.imageDigest)" > "$OUTDIR/revision.txt" 2>&1 || true
say "  revision createTime + digest: $(cat "$OUTDIR/revision.txt")"
grep -q "$EXPECT_REV_CREATED" "$OUTDIR/revision.txt" \
  && say "  -> creationTimestamp matches clock start $EXPECT_REV_CREATED. PASS" \
  || say "  -> !!! creationTimestamp does not match $EXPECT_REV_CREATED"
grep -q "$EXPECT_DIGEST" "$OUTDIR/revision.txt" \
  && say "  -> imageDigest matches $EXPECT_DIGEST. PASS" \
  || say "  -> !!! imageDigest mismatch (want $EXPECT_DIGEST)"
say ""

# --- 4. distinct revisions that served in-window (2h chunks) ------------------
# gcloud logging read caps a read; slice into 2h chunks and PRINT PER-CHUNK
# COUNTS so a 20,000-entry cap hit is visible instead of silently truncating.
# Offered load ~19/min => ~2,280 req / 2h chunk; the cap should never be near.
CHUNKS="2026-08-22T21:27:29Z 2026-08-22T23:27:29Z 2026-08-23T01:27:29Z 2026-08-23T03:27:29Z 2026-08-23T05:27:29Z 2026-08-23T07:27:29Z 2026-08-23T09:27:29Z"
say "## 3. Request-log revision sample per 2h chunk (cap 20000/chunk)"
: > "$OUTDIR/revnames.txt"
TOTAL_REQ=0
PREV=""
for T in $CHUNKS; do
  if [ -n "$PREV" ]; then
    F="log_name=\"$REQ_LOG\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND timestamp>=\"$PREV\" AND timestamp<\"$T\""
    gcloud logging read "$F" --project "$PROJECT" --limit 20000 \
      --format='value(resource.labels.revision_name)' > "$OUTDIR/chunk-rev.tmp" 2>> "$OUTDIR/logread.err" || true
    N=$(grep -c . "$OUTDIR/chunk-rev.tmp" || true)
    CAP=""
    [ "$N" -ge 20000 ] && CAP="  <-- HIT 20k CAP, chunk UNDER-COUNTED: re-slice this chunk smaller"
    say "  $PREV -> $T : $N requests$CAP"
    cat "$OUTDIR/chunk-rev.tmp" >> "$OUTDIR/revnames.txt"
    TOTAL_REQ=$((TOTAL_REQ + N))
  fi
  PREV="$T"
done
rm -f "$OUTDIR/chunk-rev.tmp"
sort "$OUTDIR/revnames.txt" | uniq -c | sort -rn > "$OUTDIR/revnames-distinct.txt"
say "  total sampled requests in-window: $TOTAL_REQ"
say "  distinct serving revisions (count revision):"
sed 's/^/    /' "$OUTDIR/revnames-distinct.txt" | tee -a "$SUMMARY"
NDISTINCT=$(grep -c . "$OUTDIR/revnames-distinct.txt" || true)
[ "$NDISTINCT" = "1" ] && grep -q "$EXPECT_REV" "$OUTDIR/revnames-distinct.txt" \
  && say "  -> ONLY $EXPECT_REV served in-window. PASS" \
  || say "  -> !!! more than one revision (or an unexpected one) served in-window"
say ""

# --- 5. container terminations / OOM ------------------------------------------
say "## 4. Container terminations / OOM / system warnings in-window"
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND (log_name=\"$SYS_LOG\" OR severity>=ERROR) AND timestamp>=\"$CLOCK_START\" AND timestamp<\"$CLOCK_END\"" \
  --project "$PROJECT" --limit 1000 --format=json > "$OUTDIR/system-events.json" 2>> "$OUTDIR/logread.err" || true
NSYS=$(jq 'length' "$OUTDIR/system-events.json" 2>/dev/null || echo '?')
NOOM=$(jq '[.[] | select((.textPayload // "" | test("(?i)memory|oom|terminat")))] | length' "$OUTDIR/system-events.json" 2>/dev/null || echo '?')
say "  system/error entries: $NSYS ; matching memory/OOM/termination: $NOOM"
if [ "$NOOM" != "0" ]; then
  say "  !!! termination/OOM-shaped entries found — details:"
  jq -r '.[] | select((.textPayload // "" | test("(?i)memory|oom|terminat"))) | "    \(.timestamp) \(.severity) \(.textPayload)"' \
    "$OUTDIR/system-events.json" | tee -a "$SUMMARY"
else
  say "  -> none. PASS"
fi
say ""

# --- 6. all 5xx in-window, per-path counts (2h chunks) ------------------------
say "## 5. 5xx in-window (per 2h chunk; targeted query so counts are exact)"
: > "$OUTDIR/5xx.txt"
TOTAL_5XX=0
PREV=""
for T in $CHUNKS; do
  if [ -n "$PREV" ]; then
    F="log_name=\"$REQ_LOG\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND httpRequest.status>=500 AND timestamp>=\"$PREV\" AND timestamp<\"$T\""
    gcloud logging read "$F" --project "$PROJECT" --limit 20000 \
      --format='value(timestamp,httpRequest.status,httpRequest.requestMethod,httpRequest.requestUrl)' \
      > "$OUTDIR/chunk-5xx.tmp" 2>> "$OUTDIR/logread.err" || true
    N=$(grep -c . "$OUTDIR/chunk-5xx.tmp" || true)
    CAP=""
    [ "$N" -ge 20000 ] && CAP="  <-- HIT 20k CAP"
    say "  $PREV -> $T : $N x 5xx$CAP"
    cat "$OUTDIR/chunk-5xx.tmp" >> "$OUTDIR/5xx.txt"
    TOTAL_5XX=$((TOTAL_5XX + N))
  fi
  PREV="$T"
done
rm -f "$OUTDIR/chunk-5xx.tmp"
say "  TOTAL 5xx in-window: $TOTAL_5XX"
if [ "$TOTAL_5XX" -gt 0 ]; then
  say "  per status+path:"
  awk '{ url=$4; sub(/^https?:\/\/[^\/]+/, "", url); sub(/\?.*/, "", url); print $2, url }' \
    "$OUTDIR/5xx.txt" | sort | uniq -c | sort -rn | sed 's/^/    /' | tee -a "$SUMMARY"
  say "  full list with timestamps: $OUTDIR/5xx.txt"
fi
say ""

# --- 7. driver evidence roll-up ----------------------------------------------
say "## 6. Driver evidence roll-up ($EVIDENCE_DIR)"
if ls "$EVIDENCE_DIR"/load-*.json >/dev/null 2>&1; then
  # Verification runs (pre-supervisor, finished <= 2026-08-22T21:40:40Z) vs sustained.
  jq -s '{
      files: length,
      verification_runs: [.[] | select(.finished_at <= "2026-08-22T21:40:40Z") | {finished_at, window_seconds, fail: .requests.fail, deviations}],
      sustained: {
        cycles: [.[] | select(.finished_at > "2026-08-22T21:40:40Z")] | length,
        ok:   ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .requests.ok] | add),
        fail: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .requests.fail] | add),
        s200: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .requests.status_200] | add),
        s404: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .requests.status_404] | add),
        s401: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .requests.status_401] | add),
        s429: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .requests.status_429] | add),
        s_other: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .requests.status_other] | add),
        coldStartRetries: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .coldStartRetries] | add),
        deviations: [.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .deviations | select(length > 0)],
        first_finished: ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .finished_at] | min),
        last_finished:  ([.[] | select(.finished_at > "2026-08-22T21:40:40Z") | .finished_at] | max)
      }
    }' "$EVIDENCE_DIR"/load-*.json > "$OUTDIR/driver-rollup.json"
  tee -a "$SUMMARY" < "$OUTDIR/driver-rollup.json"
else
  say "  !!! no load-*.json found in $EVIDENCE_DIR"
fi
say ""
say "  supervisor.log cycle exits:"
grep -c "cycle exited rc=0" "$HOME_DIR/supervisor.log" | sed 's/^/    rc=0 cycles: /' | tee -a "$SUMMARY"
grep "rc=[^0]" "$HOME_DIR/supervisor.log" | sed 's/^/    NONZERO: /' | tee -a "$SUMMARY" || say "    no nonzero exits"
grep "supervisor done" "$HOME_DIR/supervisor.log" | sed 's/^/    /' | tee -a "$SUMMARY" || say "    (supervisor not yet done — fine if it is still inside its last cycle)"

# Copy all driver artifacts so the close-out commit stages from ONE place.
mkdir -p "$OUTDIR/evidence-copy"
cp "$EVIDENCE_DIR"/load-*.json "$OUTDIR/evidence-copy/" 2>/dev/null || true
cp "$HOME_DIR/supervisor.log" "$OUTDIR/evidence-copy/" 2>/dev/null || true
say ""
say "---"
say "Artifacts: $OUTDIR"
say "Next: rollback-rehearsal.sh (creates a new revision — ONLY after this capture),"
say "then fill docs/staging/node22-2026-08/maturity-TEMPLATE.md markers from summary.md,"
say "then paste the evidence block from 2291-evidence-draft.md into PR #2291."
