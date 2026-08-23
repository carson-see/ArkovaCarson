#!/usr/bin/env bash
# =============================================================================
# PR #2314 (FD-FERPA-1 directory opt-out) — T3 soak CLOSE CAPTURE. READ-ONLY.
#
#   Window : 2026-08-21T19:24:30.248332Z -> 2026-08-23T19:24:30Z  (T3, 48 h)
#   Rig    : arkova-worker-ferpa2314-staging  rev arkova-worker-ferpa2314-staging-00001-cit
#   Tag    : pr-2314   Supabase: wjuelohtpklodpjklvqy   project: arkova1
#   Head   : 93747a6aa451991476ab0b00d58c3fb0754f2e2d (frozen SOAKED head — the
#            live PR head has moved past it; see maturity-TEMPLATE.md §"Exact-head
#            deviation". BUILD_SHA on the rig is this soaked head.)
#
# Run AT/AFTER 2026-08-23T19:24:30Z. The script refuses to run early — closing
# the window early is exactly the mistake this guard exists to prevent. Every
# date parse in this file uses `-u`: the 2026-08-23 node22 close was refused at
# seal because its guard parsed the close time as LOCAL EDT (4 h late). The
# supervisor at ~/arkova-soak/ferpa2314/supervisor.sh STILL carries that -u-less
# parse, so it will NOT stop at 19:24:30Z on its own — it runs until ~23:24:30Z
# local-parsed epoch. Stop it manually right after this capture (teardown
# checklist step 0); post-close driver cycles are excluded from the in-window
# roll-up below either way.
#
# It makes NO serving-state change: probes are GETs, everything else is gcloud
# describe / logging read / local file reads. Rollback rehearsal is a SEPARATE
# script (rollback-rehearsal.sh) and must run AFTER this one AND after the
# supervisor is stopped, because (a) the rehearsal creates a new revision and
# this script's whole job is to seal the clock first, and (b) the rehearsal's
# SQL rollback would make the still-running driver's suppression probes fail
# loudly mid-rehearsal.
#
# Captures in one pass (everything lands in $OUTDIR):
#   1. 5x /api/health with timings (identity token WITHOUT --audiences,
#      riding X-Serverless-Authorization — FD-WAVE3-1 constraint)
#   2. serving revision + traffic split (must still be 00001-cit @ 100%)
#   3. revision creationTimestamp + digest (FD-CLOCK-1: this IS the soak clock)
#   4. distinct revisions that served in-window (request-log revision_name
#      sample, 24 x 2h chunks, per-chunk counts so a 20k read-cap hit is VISIBLE)
#   5. container terminations / OOM / system-log warnings in-window
#   6. every 5xx in-window with per-status/per-path counts (targeted query)
#   7. daily-flush observation queries (03:00Z both nights) — T3 evidence input
#   8. driver evidence roll-up: all load-*.json (verification runs vs sustained,
#      IN-WINDOW only — finished_at <= clock end), gap scan (>30 min deltas; the
#      known 2026-08-22 11:30:06Z -> 15:04:01Z fail-loud stop must be the ONLY
#      gap), supervisor rc history, and a copy of every artifact into $OUTDIR.
# =============================================================================
set -uo pipefail

PROJECT="arkova1"
REGION="us-central1"
SERVICE="arkova-worker-ferpa2314-staging"
EXPECT_REV="arkova-worker-ferpa2314-staging-00001-cit"
EXPECT_REV_CREATED="2026-08-21T19:24:30.248332Z"
EXPECT_DIGEST="sha256:be79097dc3fcf9b755d45ad301cd55abb28f33a8726226386fdcb8986e5ef518"
SOAKED_HEAD="93747a6aa451991476ab0b00d58c3fb0754f2e2d"
BASE_URL="https://pr-2314---arkova-worker-ferpa2314-staging-kvojbeutfa-uc.a.run.app"
CLOCK_START="2026-08-21T19:24:30Z"
CLOCK_END="2026-08-23T19:24:30Z"
HOME_DIR="/Users/carson/arkova-soak/ferpa2314"
EVIDENCE_DIR="/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/pr2314-ferpa-2026-08/evidence"
REQ_LOG='projects/arkova1/logs/run.googleapis.com%2Frequests'
SYS_LOG='projects/arkova1/logs/run.googleapis.com%2Fvarlog%2Fsystem'
# The two pre-supervisor verification runs finished by 19:40Z on 08-21 (the
# 19:30:56Z run is the one that DISCOVERED the real 60/min ceiling — 10x429,
# kept in evidence deliberately). Everything after this cutoff is sustained.
VERIFICATION_CUTOFF="2026-08-21T19:40:00Z"

# epoch -> ISO-8601 Z, portable BSD/GNU, always UTC
iso() { date -u -r "$1" +%FT%TZ 2>/dev/null || date -u -d "@$1" +%FT%TZ; }
# ISO-8601 Z -> epoch, ALWAYS -u on the parse (the recorded node22 guard bug
# was exactly a -u-less BSD parse reading a Z timestamp as local EDT).
epoch() { date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || date -u -d "$1" +%s; }

# --- guard: never close early -------------------------------------------------
END_EPOCH=$(epoch "$CLOCK_END")
NOW_EPOCH=$(date -u +%s)
if [ "$NOW_EPOCH" -lt "$END_EPOCH" ]; then
  REMAIN=$(( END_EPOCH - NOW_EPOCH ))
  echo "REFUSING: window closes $CLOCK_END; now $(date -u +%FT%TZ)." >&2
  echo "Do not close the soak early. ($(( REMAIN / 60 )) min = $(( REMAIN / 3600 ))h$(printf '%02d' $(( (REMAIN % 3600) / 60 )))m remain)" >&2
  exit 1
fi

OUTDIR="$HOME_DIR/close-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/summary.md"
say() { echo "$*" | tee -a "$SUMMARY"; }
say "# PR #2314 FERPA T3 close capture — $(date -u +%FT%TZ)"
say ""

# --- 1. 5x /api/health with timings ------------------------------------------
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
  [ "$GS" = "$SOAKED_HEAD" ] || { say "  run $i: GIT_SHA MISMATCH (want $SOAKED_HEAD)"; HEALTH_FAILS=$((HEALTH_FAILS+1)); }
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

# 2h chunk boundaries for the 48 h window, generated from epochs (24 chunks).
START_EPOCH=$(epoch "$CLOCK_START")
CHUNKS=""
T=$START_EPOCH
while [ "$T" -le "$END_EPOCH" ]; do
  CHUNKS="$CHUNKS $(iso "$T")"
  T=$(( T + 7200 ))
done

# --- 4. distinct revisions that served in-window (2h chunks) ------------------
# Offered load ~18/min => ~2,160 req / 2h chunk; the 20k cap should never be
# near. Per-chunk counts are PRINTED so a cap hit is visible, never silent.
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
say "  NOTE: the 09:24->13:24Z chunks on 08-22 bracket the KNOWN 3h34m load gap"
say "  (11:30:06Z fail-loud stop -> 15:04:01Z restart) — low counts there are the"
say "  documented gap, not a capture defect. See maturity template §Load coverage."
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
say "  (at least ONE is expected: the 2026-08-22T11:30:06Z cold-start 503 on"
say "   /api/health that fail-loud-stopped the driver. If it is absent here the"
say "   maturity narrative needs re-examination, not celebration.)"
if [ "$TOTAL_5XX" -gt 0 ]; then
  say "  per status+path:"
  awk '{ url=$4; sub(/^https?:\/\/[^\/]+/, "", url); sub(/\?.*/, "", url); print $2, url }' \
    "$OUTDIR/5xx.txt" | sort | uniq -c | sort -rn | sed 's/^/    /' | tee -a "$SUMMARY"
  say "  full list with timestamps: $OUTDIR/5xx.txt"
fi
say ""

# --- 7. daily-flush observation inputs (T3) -----------------------------------
say "## 6. Daily-flush observation inputs (03:00Z both nights)"
for NIGHT in 2026-08-22 2026-08-23; do
  F="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND timestamp>=\"${NIGHT}T02:55:00Z\" AND timestamp<\"${NIGHT}T03:10:00Z\""
  gcloud logging read "$F" --project "$PROJECT" --limit 500 \
    --format='value(timestamp,severity,httpRequest.requestUrl,textPayload)' \
    > "$OUTDIR/dailyflush-$NIGHT.txt" 2>> "$OUTDIR/logread.err" || true
  N=$(grep -c . "$OUTDIR/dailyflush-$NIGHT.txt" || true)
  NFLUSH=$(grep -ciE "flush|batch" "$OUTDIR/dailyflush-$NIGHT.txt" || true)
  say "  ${NIGHT}T02:55-03:10Z: $N log entries, $NFLUSH matching flush|batch -> $OUTDIR/dailyflush-$NIGHT.txt"
done
say "  Interpretation belongs in the maturity record: a flush firing over a ~1-2"
say "  row PENDING population is an OBSERVATION of the trigger, not volume proof."
say ""

# --- 8. driver evidence roll-up ----------------------------------------------
say "## 7. Driver evidence roll-up ($EVIDENCE_DIR)"
if ls "$EVIDENCE_DIR"/load-*.json >/dev/null 2>&1; then
  # In-window only: the supervisor's own -u-less end-epoch parse means it keeps
  # producing cycles for ~4 h after the true close; those are excluded here and
  # counted separately so the overrun is visible, not silently folded in.
  jq -s --arg vcut "$VERIFICATION_CUTOFF" --arg wend "$CLOCK_END" '{
      files: length,
      verification_runs: [.[] | select(.finished_at <= $vcut) | {finished_at, window_seconds, fail: .requests.fail, status_other: .requests.status_other, deviations}],
      sustained_in_window: {
        cycles: [.[] | select(.finished_at > $vcut and .finished_at <= $wend)] | length,
        ok:   ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .requests.ok] | add),
        fail: ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .requests.fail] | add),
        s200: ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .requests.status_200] | add),
        s404: ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .requests.status_404] | add),
        s429: ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .requests.status_429 // 0] | add),
        s_other: ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .requests.status_other] | add),
        coldStartRetries: ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .coldStartRetries // 0] | add),
        deviations: [.[] | select(.finished_at > $vcut and .finished_at <= $wend) | select(.deviations | length > 0) | {finished_at, deviations}],
        first_finished: ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .finished_at] | min),
        last_finished:  ([.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .finished_at] | max)
      },
      post_close_overrun_cycles: [.[] | select(.finished_at > $wend)] | length
    }' "$EVIDENCE_DIR"/load-*.json > "$OUTDIR/driver-rollup.json"
  tee -a "$SUMMARY" < "$OUTDIR/driver-rollup.json"
  say ""
  say "  gap scan (sustained in-window, file-to-file finished_at deltas > 30 min):"
  jq -rs --arg vcut "$VERIFICATION_CUTOFF" --arg wend "$CLOCK_END" '
      [.[] | select(.finished_at > $vcut and .finished_at <= $wend) | .finished_at] | sort as $t
      | [range(1; $t|length)
         | select((($t[.] | fromdate) - ($t[.-1] | fromdate)) > 1800)
         | "\($t[.-1]) -> \($t[.]) (\(((($t[.] | fromdate) - ($t[.-1] | fromdate)) / 60 | floor)) min)"]
      | if length == 0 then "    (none)" else map("    " + .) | join("\n") end
    ' "$EVIDENCE_DIR"/load-*.json | tee -a "$SUMMARY"
  say "  EXPECTED: exactly one gap, the known fail-loud stop (driver down"
  say "  2026-08-22T11:30:06Z -> 15:04:01Z; by finished_at it reads ~11:30 -> ~15:29"
  say "  because the restarted cycle finishes 25 min after the 15:04:01Z restart)."
  say "  Any OTHER gap is undocumented — investigate before sealing the record."
else
  say "  !!! no load-*.json found in $EVIDENCE_DIR"
fi
say ""
say "  supervisor.log cycle exits:"
grep -c "cycle exited rc=0" "$HOME_DIR/supervisor.log" | sed 's/^/    rc=0 cycles: /' | tee -a "$SUMMARY"
grep "rc=[^0]" "$HOME_DIR/supervisor.log" | sed 's/^/    NONZERO: /' | tee -a "$SUMMARY" || say "    no nonzero exits"
say "    (ONE nonzero is EXPECTED: rc=1 at 2026-08-22T11:30:06Z — the health=503"
say "     fail-loud stop. Zero or two+ nonzero exits contradicts the record.)"
grep "supervisor start" "$HOME_DIR/supervisor.log" | sed 's/^/    /' | tee -a "$SUMMARY"
grep "supervisor done" "$HOME_DIR/supervisor.log" | sed 's/^/    /' | tee -a "$SUMMARY" || say "    (supervisor not yet done — expected: its own end-epoch parse runs 4 h long; stop it manually per the teardown checklist)"

# Copy all driver artifacts so the close-out commit stages from ONE place.
mkdir -p "$OUTDIR/evidence-copy"
cp "$EVIDENCE_DIR"/load-*.json "$OUTDIR/evidence-copy/" 2>/dev/null || true
cp "$HOME_DIR/supervisor.log" "$OUTDIR/evidence-copy/" 2>/dev/null || true
say ""
say "---"
say "Artifacts: $OUTDIR"
say "Next: STOP the supervisor (teardown checklist step 0 — it will NOT stop on"
say "its own until ~23:24Z because of its -u-less end-epoch parse), then"
say "rollback-rehearsal.sh (creates a new revision + rolls the rig DB back and"
say "forward — ONLY after this capture), then fill"
say "docs/staging/pr2314-ferpa-2026-08/maturity-TEMPLATE.md markers from summary.md,"
say "then paste the evidence block from 2314-evidence-draft.md into PR #2314."
