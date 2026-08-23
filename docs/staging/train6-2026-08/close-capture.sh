#!/usr/bin/env bash
# =============================================================================
# TRAIN-6 / PR #2249 — T3 soak CLOSE CAPTURE (WINDOW 2). READ-ONLY.
#
#   Window : 2026-08-21T20:33:58.053472Z -> 2026-08-23T20:33:58Z  (T3, 48 h)
#   Rig    : arkova-worker-wave2-2026-08-staging  rev ...-00006-gik  tag train-6
#   Supabase: tkciooifwxwnkoizgalp (isolated)   GCP project: arkova1
#   Head   : f0e4cfe2e375b838a6f164f7c15e23d6b981c34b (union head = PR #2249's
#            df0e6fa93… + base 224cef8a9…; BUILD_SHA set explicitly at deploy)
#
#   WINDOW 1 (clock 2026-08-21T18:54:36Z, revision 00005-nax) is VOID
#   (FD-SEED-1 / failed preflight). Its 4 driver cycles sit in the SAME evidence
#   dir — every aggregate below filters on
#   .servingRevision == "arkova-worker-wave2-2026-08-staging-00006-gik".
#   An unfiltered aggregate is wrong by 4 cycles.
#
# Run AT/AFTER 2026-08-23T20:33:58Z. The guard refuses to run early, with -u on
# every date parse (the recorded node22 guard bug was a -u-less local-EDT parse).
# The supervisor at ~/arkova-soak/train6/supervisor.sh STILL carries that -u-less
# parse, so it will NOT stop at 20:33:58Z on its own (~00:33Z local-parsed epoch).
# Stop it manually right after this capture; post-close cycles are excluded from
# the in-window roll-up below either way.
#
# READ-ONLY: probes are GETs; gcloud describe / logging read; Supabase
# Management-API calls are strictly SELECTs. The rollback rehearsal is a
# SEPARATE script (rollback-rehearsal.sh), post-capture only.
#
# Captures in one pass (everything lands in $OUTDIR):
#   1. 5x /api/health with timings (identity token WITHOUT --audiences)
#   2. serving revision + traffic (must still be 00006-gik @ 100%, tag train-6;
#      the extra no-traffic tag pr-2290 on 00003-qiz is expected)
#   3. revision creationTimestamp + digest (FD-CLOCK-1)
#   4. distinct revisions that served in-window (24 x 2h chunks, per-chunk counts)
#   5. container terminations / OOM in-window
#   6. every 5xx in-window with per-status/per-path counts. NOTE: a steady
#      /jobs/professional-education-extraction 503 stream is DECLARED behavior
#      (flag off -> fail closed); the per-path table must show it separated so
#      real 5xx cannot hide under it.
#   7. T3/poison-path DB reads (SELECT-only): Set A durability (5 SUBMITTED,
#      updated_at never moved off the seed value), Set B end-state
#      (secured+expired=100 conserved), org-queue second claim at ~+24h,
#      the disclosed PENDING control rows.
#   8. daily-flush observation inputs (03:00Z both nights)
#   9. driver evidence roll-up (WINDOW-2 FILTERED): cycles, totals, 429=0 check,
#      fixture monotonicity (submitted floor 5; secured+expired conservation),
#      deviations (expect exactly one: health=503 in the 01:11:08Z cycle),
#      gap scan, supervisor rc history, artifact copy.
# =============================================================================
set -uo pipefail

PROJECT="arkova1"
REGION="us-central1"
SERVICE="arkova-worker-wave2-2026-08-staging"
EXPECT_REV="arkova-worker-wave2-2026-08-staging-00006-gik"
EXPECT_REV_CREATED="2026-08-21T20:33:58.053472Z"
EXPECT_DIGEST="sha256:76f1d043280c24ea593932ebe4e32158afbe56a647c4be709ca93f121d8508b4"
UNION_HEAD="f0e4cfe2e375b838a6f164f7c15e23d6b981c34b"
BASE_URL="https://train-6---arkova-worker-wave2-2026-08-staging-kvojbeutfa-uc.a.run.app"
CLOCK_START="2026-08-21T20:33:58Z"
CLOCK_END="2026-08-23T20:33:58Z"
HOME_DIR="/Users/carson/arkova-soak/train6"
EVIDENCE_DIR="/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/train6-2026-08/evidence"
RIG_REF="tkciooifwxwnkoizgalp"
REQ_LOG='projects/arkova1/logs/run.googleapis.com%2Frequests'
SYS_LOG='projects/arkova1/logs/run.googleapis.com%2Fvarlog%2Fsystem'

iso() { date -u -r "$1" +%FT%TZ 2>/dev/null || date -u -d "@$1" +%FT%TZ; }
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
say "# TRAIN-6 / PR #2249 T3 close capture (window 2) — $(date -u +%FT%TZ)"
say ""

# --- 1. 5x /api/health --------------------------------------------------------
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
  [ "$GS" = "$UNION_HEAD" ] || { say "  run $i: GIT_SHA MISMATCH (want $UNION_HEAD)"; HEALTH_FAILS=$((HEALTH_FAILS+1)); }
  i=$((i+1))
done
say "  -> health fails: $HEALTH_FAILS (template wants 5/5 x HTTP 200, git_sha match)"
say "  NOTE: /health uptime is the current INSTANCE, not the soak clock (FD-CLOCK-1)."
say ""

# --- 2+3. serving revision, traffic, creationTimestamp ------------------------
say "## 2. Serving revision + traffic at close"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format=json > "$OUTDIR/service.json" 2> "$OUTDIR/service.err" || say "  ERROR: services describe failed"
jq '{latestReady: .status.latestReadyRevisionName, latestCreated: .status.latestCreatedRevisionName, traffic: .status.traffic}' \
  "$OUTDIR/service.json" | tee -a "$SUMMARY"
SERVING=$(jq -r '[.status.traffic[] | select(.percent == 100)] | first.revisionName // "?"' "$OUTDIR/service.json")
N100=$(jq -r '[.status.traffic[] | select(.percent == 100)] | length' "$OUTDIR/service.json")
NTAGONLY=$(jq -r '[.status.traffic[] | select(.percent == null or .percent == 0)] | length' "$OUTDIR/service.json")
if [ "$SERVING" = "$EXPECT_REV" ] && [ "$N100" = "1" ]; then
  say "  -> REVISION UNCHANGED: $EXPECT_REV @ 100% (plus $NTAGONLY no-traffic tag entries — pr-2290 on 00003-qiz is EXPECTED). PASS"
else
  say "  -> !!! REVISION/TRAFFIC CHANGED (100%-serving=$SERVING count=$N100; want $EXPECT_REV) — CLOCK INTEGRITY BROKEN, investigate before writing the maturity record"
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

START_EPOCH=$(epoch "$CLOCK_START")
CHUNKS=""
T=$START_EPOCH
while [ "$T" -le "$END_EPOCH" ]; do
  CHUNKS="$CHUNKS $(iso "$T")"
  T=$(( T + 7200 ))
done

# --- 4. distinct revisions that served in-window ------------------------------
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

# --- 6. all 5xx in-window, per-path counts ------------------------------------
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
say "  per status+path (the /jobs/professional-education-extraction 503 stream is"
say "  DECLARED fail-closed behavior — ~1 per 5-min member pass, ~575 expected;"
say "  it must appear as its own row so real 5xx cannot hide under it):"
awk '{ url=$4; sub(/^https?:\/\/[^\/]+/, "", url); sub(/\?.*/, "", url); print $2, url }' \
  "$OUTDIR/5xx.txt" | sort | uniq -c | sort -rn | sed 's/^/    /' | tee -a "$SUMMARY"
say "  full list with timestamps: $OUTDIR/5xx.txt"
say "  NON-declared 5xx (everything except the prof-education 503s):"
awk '{ url=$4; sub(/^https?:\/\/[^\/]+/, "", url); sub(/\?.*/, "", url); print $1, $2, url }' "$OUTDIR/5xx.txt" \
  | grep -v "503 /jobs/professional-education-extraction" | sed 's/^/    /' | tee -a "$SUMMARY" || true
say "  (expect: at most the single 2026-08-22T01:11Z health 503 the driver recorded)"
say ""

# --- 7. T3 / poison-path DB reads (SELECT-only via Management API) ------------
say "## 6. T3 / poison-path DB state at close (SELECT-only)"
SB_TOKEN=$(gcloud secrets versions access latest --secret=supabase_access --project="$PROJECT" 2>/dev/null || true)
if [ -z "$SB_TOKEN" ]; then
  say "  !!! could not read supabase_access token — fill this section manually via MCP"
else
  sql() {
    jq -n --arg q "$1" '{query: $q}' | curl -sS --max-time 60 \
      -X POST -H "Authorization: Bearer $SB_TOKEN" -H "Content-Type: application/json" \
      -d @- "https://api.supabase.com/v1/projects/$RIG_REF/database/query"
  }
  say "  Set A durability (want: 5 rows, all SUBMITTED, updated_at = seed value 2026-08-21 20:16:26.495388+00):"
  sql "SELECT id, status, updated_at FROM public.anchors WHERE id::text LIKE '5eed0002-%' ORDER BY id" \
    | jq -c '.[]' | sed 's/^/    /' | tee -a "$SUMMARY"
  say "  Set B end-state (want: secured+expired = 100 conserved, expired ~100 by close):"
  sql "SELECT status, count(*) FROM public.anchors WHERE id::text LIKE '5eed0003-%' GROUP BY status ORDER BY status" \
    | jq -c '.[]' | sed 's/^/    /' | tee -a "$SUMMARY"
  say "  Disclosed PENDING controls (want: 2 — the seed row + the reclaimed positive control):"
  sql "SELECT count(*) AS pending FROM public.anchors WHERE status = 'PENDING'" \
    | jq -c '.[]' | sed 's/^/    /' | tee -a "$SUMMARY"
  say "  Org-queue claims (the fixture org id IS the non-RFC uuid #2249 exists for;"
  say "  want: last_run_at ~2026-08-22T20:34Z or later = the +24h SECOND claim, status succeeded):"
  sql "SELECT org_id, last_run_at, last_run_status, last_run_trigger FROM public.organization_queue_run_state" \
    | jq -c '.[]' | sed 's/^/    /' | tee -a "$SUMMARY"
fi
say "  Request-log sweep/scheduler execution counts in-window (both drive the"
say "  changed dbUuid sites on every pass):"
for P in anchor-expiry-sweep org-queue-scheduler; do
  F="log_name=\"$REQ_LOG\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND httpRequest.requestUrl:\"/jobs/$P\" AND timestamp>=\"$CLOCK_START\" AND timestamp<\"$CLOCK_END\""
  gcloud logging read "$F" --project "$PROJECT" --limit 20000 \
    --format='value(httpRequest.status)' > "$OUTDIR/jobs-$P.txt" 2>> "$OUTDIR/logread.err" || true
  say "  /jobs/$P: $(grep -c . "$OUTDIR/jobs-$P.txt" || true) requests, statuses: $(sort "$OUTDIR/jobs-$P.txt" | uniq -c | tr '\n' ' ')"
done
say "  The +24h org-queue claim window (2026-08-22T20:25-20:45Z), timestamps:"
gcloud logging read "log_name=\"$REQ_LOG\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND httpRequest.requestUrl:\"/jobs/org-queue-scheduler\" AND timestamp>=\"2026-08-22T20:25:00Z\" AND timestamp<\"2026-08-22T20:45:00Z\"" \
  --project "$PROJECT" --limit 100 --format='value(timestamp,httpRequest.status)' \
  | sed 's/^/    /' | tee -a "$SUMMARY" || true
say ""

# --- 8. daily-flush observation inputs (T3) -----------------------------------
say "## 7. Daily-flush observation inputs (03:00Z both nights)"
for NIGHT in 2026-08-22 2026-08-23; do
  F="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND timestamp>=\"${NIGHT}T02:55:00Z\" AND timestamp<\"${NIGHT}T03:10:00Z\""
  gcloud logging read "$F" --project "$PROJECT" --limit 500 \
    --format='value(timestamp,severity,httpRequest.requestUrl,textPayload)' \
    > "$OUTDIR/dailyflush-$NIGHT.txt" 2>> "$OUTDIR/logread.err" || true
  N=$(grep -c . "$OUTDIR/dailyflush-$NIGHT.txt" || true)
  NFLUSH=$(grep -ciE "flush|batch" "$OUTDIR/dailyflush-$NIGHT.txt" || true)
  say "  ${NIGHT}T02:55-03:10Z: $N log entries, $NFLUSH matching flush|batch -> $OUTDIR/dailyflush-$NIGHT.txt"
done
say "  Interpretation belongs in the maturity record: 2 disclosed PENDING rows are"
say "  three orders of magnitude below MIN_BATCH_THRESHOLD (3,000) — an observation"
say "  of the trigger firing (or an honest NOT OBSERVED), never volume proof."
say ""

# --- 9. driver evidence roll-up (WINDOW-2 FILTERED) ---------------------------
say "## 8. Driver evidence roll-up ($EVIDENCE_DIR, servingRevision-filtered)"
if ls "$EVIDENCE_DIR"/load-*.json >/dev/null 2>&1; then
  jq -s --arg rev "$EXPECT_REV" --arg wend "$CLOCK_END" '
    [.[] | select(.servingRevision == $rev)] as $w2 | {
      files_total: length,
      window1_excluded: ([.[] | select(.servingRevision != $rev)] | length),
      in_window: ([$w2[] | select(.capturedAt <= $wend)]) | {
        cycles: length,
        ok:   ([.[].requests.ok] | add),
        fail: ([.[].requests.fail] | add),
        s200: ([.[].requests.status_200] | add),
        s429: ([.[].requests.status_429] | add),
        s_other: ([.[].requests.status_other] | add),
        deviations: [.[] | select(.deviations | length > 0) | {capturedAt, deviations, requests}],
        fixture_first: (first | .fixture),
        fixture_last: (last | .fixture),
        submitted_min: ([.[].fixture.submitted] | min),
        conservation_violations: [.[] | select((.fixture.secured + .fixture.expired) != 100) | {capturedAt, fixture}],
        first_captured: ([.[].capturedAt] | min),
        last_captured:  ([.[].capturedAt] | max)
      },
      post_close_overrun_cycles: ([$w2[] | select(.capturedAt > $wend)] | length)
    }' "$EVIDENCE_DIR"/load-*.json > "$OUTDIR/driver-rollup.json"
  tee -a "$SUMMARY" < "$OUTDIR/driver-rollup.json"
  say ""
  say "  PASS conditions: s429 == 0 (FD-LOAD-1 positive control), submitted_min == 5"
  say "  (the continuously-audited invariant), conservation_violations == [],"
  say "  deviations == exactly the one health=503 cycle (capturedAt 2026-08-22T01:11:06Z"
  say "  file load-20260822T011106Z.json), fixture_last.expired ~100."
  say ""
  say "  gap scan (window-2 in-window, file-to-file capturedAt deltas > 30 min):"
  jq -rs --arg rev "$EXPECT_REV" --arg wend "$CLOCK_END" '
      [.[] | select(.servingRevision == $rev and .capturedAt <= $wend) | .capturedAt] | sort as $t
      | [range(1; $t|length)
         | select((($t[.] | fromdate) - ($t[.-1] | fromdate)) > 1800)
         | "\($t[.-1]) -> \($t[.]) (\(((($t[.] | fromdate) - ($t[.-1] | fromdate)) / 60 | floor)) min)"]
      | if length == 0 then "    (none — expect NONE for this window: 89 rc=0 cycles, no supervisor stop)" else map("    " + .) | join("\n") end
    ' "$EVIDENCE_DIR"/load-*.json | tee -a "$SUMMARY"
  say "  ANY gap here is undocumented (this window had no fail-loud stop) — investigate."
else
  say "  !!! no load-*.json found in $EVIDENCE_DIR"
fi
say ""
say "  supervisor.log cycle exits (window 2 log):"
grep -c "cycle exited rc=0" "$HOME_DIR/supervisor.log" | sed 's/^/    rc=0 cycles: /' | tee -a "$SUMMARY"
grep "rc=[^0]" "$HOME_DIR/supervisor.log" | sed 's/^/    NONZERO: /' | tee -a "$SUMMARY" || say "    no nonzero exits (EXPECTED for this window)"
grep "supervisor start" "$HOME_DIR/supervisor.log" | sed 's/^/    /' | tee -a "$SUMMARY"
grep "supervisor done" "$HOME_DIR/supervisor.log" | sed 's/^/    /' | tee -a "$SUMMARY" || say "    (supervisor not yet done — expected: its own end-epoch parse runs ~4 h long; stop it manually per the close-out plan)"
say "  KNOWN DRIVER CAVEAT (state in the maturity record): unlike the ferpa2314"
say "  driver, train6-load-loop.sh does NOT end with a fail-on-FAIL assertion —"
say "  the 01:11:08Z fail=1 cycle exited rc=0 and the supervisor kept going. The"
say "  deviation is recorded in the cycle file; the supervisor's fail-loud claim"
say "  holds only for driver-level (script) failures, not probe failures."

mkdir -p "$OUTDIR/evidence-copy"
cp "$EVIDENCE_DIR"/load-*.json "$OUTDIR/evidence-copy/" 2>/dev/null || true
cp "$HOME_DIR/supervisor.log" "$HOME_DIR/supervisor.window1.log" "$OUTDIR/evidence-copy/" 2>/dev/null || true
say ""
say "---"
say "Artifacts: $OUTDIR"
say "Next: STOP the supervisor (close-out plan step 0 — it will NOT stop on its"
say "own until ~00:33Z), then rollback-rehearsal.sh (creates a new revision —"
say "ONLY after this capture), then fill"
say "docs/staging/train6-2026-08/maturity-TEMPLATE.md from summary.md, then follow"
say "docs/staging/train6-2026-08/2249-post-seal-plan.md (merge main -> manifest"
say "roster move -> cycle+ready)."
