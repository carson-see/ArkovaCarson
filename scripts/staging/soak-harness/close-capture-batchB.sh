#!/usr/bin/env bash
# Batch B T2 CLOSE CAPTURE — READ-ONLY. Parameterised per PR.
# Required env: PR HEAD_SHA BASE_URL CLOCK_START CLOCK_END EXPECT_REV EXPECT_DIGEST
set -uo pipefail
: "${PR:?}" "${HEAD_SHA:?}" "${BASE_URL:?}" "${CLOCK_START:?}" "${CLOCK_END:?}"
PROJECT=arkova1; REGION=us-central1; SERVICE=arkova-worker-staging; TAG="pr-$PR"
H=/Users/carson/arkova-soak/batch-b
EVIDENCE_DIR="/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-$PR"
REQ_LOG='projects/arkova1/logs/run.googleapis.com%2Frequests'
SYS_LOG='projects/arkova1/logs/run.googleapis.com%2Fvarlog%2Fsystem'

END_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$CLOCK_END" +%s)
if [ "$(date -u +%s)" -lt "$END_EPOCH" ]; then
  echo "REFUSING: window closes $CLOCK_END; now $(date -u +%FT%TZ). Closing early is the mistake this guard exists to prevent." >&2
  exit 1
fi

OUT="$EVIDENCE_DIR/close-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$OUT"
SUM="$OUT/summary.md"; say() { echo "$*" | tee -a "$SUM"; }
say "# PR #$PR Batch B T2 close capture — $(date -u +%FT%TZ)"
say ""; say "Window $CLOCK_START -> $CLOCK_END; tag $TAG; head $HEAD_SHA"; say ""

# 1. health x5 with the exact-head predicate
gcloud auth print-identity-token > "$OUT/idtoken" 2>"$OUT/idtoken.err" || { say "FATAL: token mint failed"; exit 1; }
chmod 600 "$OUT/idtoken"; TOK="$(cat "$OUT/idtoken")"
say "## 1. Health at close (5x /health, exact-head predicate)"
HF=0
for i in 1 2 3 4 5; do
  CODE=$(curl -s --max-time 25 -o "$OUT/health-$i.json" -w '%{http_code} %{time_total}' -H "Authorization: Bearer $TOK" "$BASE_URL/health") || CODE="000 -"
  GS=$(jq -r '.git_sha // "?"' "$OUT/health-$i.json" 2>/dev/null || echo '?')
  say "  run $i: HTTP ${CODE}s git_sha=${GS}"
  case "$CODE" in 200\ *) :;; *) HF=$((HF+1));; esac
  [ "$GS" = "$HEAD_SHA" ] || { say "  run $i: GIT_SHA MISMATCH (want $HEAD_SHA)"; HF=$((HF+1)); }
done
say "  -> health fails: $HF (want 0)"; say ""

# 2. tag routing + revision identity
say "## 2. Tag routing / revision identity"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format=json > "$OUT/service.json" 2>"$OUT/service.err" || say "  ERROR: describe failed"
SERVING=$(jq -r --arg t "$TAG" '.status.traffic[] | select(.tag==$t) | .revisionName' "$OUT/service.json")
say "  tag $TAG -> revision $SERVING (expected ${EXPECT_REV:-<unset>})"
[ -n "${EXPECT_REV:-}" ] && { [ "$SERVING" = "$EXPECT_REV" ] && say "  -> REVISION UNCHANGED. PASS" || say "  -> !!! TAG MOVED — clock integrity broken"; }
gcloud run revisions describe "$SERVING" --project "$PROJECT" --region "$REGION" \
  --format="value(metadata.creationTimestamp,status.imageDigest)" > "$OUT/revision.txt" 2>&1 || true
say "  revision createTime + digest: $(cat "$OUT/revision.txt")"
[ -n "${EXPECT_DIGEST:-}" ] && { grep -q "$EXPECT_DIGEST" "$OUT/revision.txt" && say "  -> digest matches. PASS" || say "  -> !!! digest mismatch (want ${EXPECT_DIGEST})"; }
say "  NOTE: the soak clock is this revision's creationTimestamp / uptime, not the driver loop."; say ""

# 3. revisions that actually served in-window, 2h chunks with visible caps
CH=$(python3 - "$CLOCK_START" "$CLOCK_END" <<'PY'
import sys,datetime
s=datetime.datetime.strptime(sys.argv[1],"%Y-%m-%dT%H:%M:%SZ");e=datetime.datetime.strptime(sys.argv[2],"%Y-%m-%dT%H:%M:%SZ")
o=[];c=s
while c<e: o.append(c.strftime("%Y-%m-%dT%H:%M:%SZ")); c+=datetime.timedelta(hours=2)
o.append(e.strftime("%Y-%m-%dT%H:%M:%SZ")); print(" ".join(o))
PY
)
say "## 3. Serving revisions in-window (2h chunks, 20k cap made visible)"
: > "$OUT/revnames.txt"; TOTAL=0; PREV=""
for T in $CH; do
  if [ -n "$PREV" ]; then
    F="log_name=\"$REQ_LOG\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND timestamp>=\"$PREV\" AND timestamp<\"$T\""
    gcloud logging read "$F" --project "$PROJECT" --limit 20000 --format='value(resource.labels.revision_name)' > "$OUT/c.tmp" 2>>"$OUT/logread.err" || true
    N=$(grep -c . "$OUT/c.tmp" || true); CAP=""; [ "$N" -ge 20000 ] && CAP="  <-- HIT 20k CAP, UNDER-COUNTED"
    say "  $PREV -> $T : $N requests$CAP"; cat "$OUT/c.tmp" >> "$OUT/revnames.txt"; TOTAL=$((TOTAL+N))
  fi; PREV="$T"
done
rm -f "$OUT/c.tmp"
grep -c "$SERVING" "$OUT/revnames.txt" > /dev/null 2>&1
sort "$OUT/revnames.txt" | uniq -c | sort -rn > "$OUT/revnames-distinct.txt"
say "  total sampled requests (whole service, all tags): $TOTAL"
say "  distinct serving revisions:"; sed 's/^/    /' "$OUT/revnames-distinct.txt" | tee -a "$SUM"
grep -q "$SERVING" "$OUT/revnames-distinct.txt" && say "  -> $SERVING served in-window. PASS" || say "  -> !!! $SERVING never appears in the request log"
say ""

# 4. terminations / OOM
say "## 4. Container terminations / OOM / errors in-window"
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$SERVING\" AND (log_name=\"$SYS_LOG\" OR severity>=ERROR) AND timestamp>=\"$CLOCK_START\" AND timestamp<\"$CLOCK_END\"" \
  --project "$PROJECT" --limit 1000 --format=json > "$OUT/system-events.json" 2>>"$OUT/logread.err" || true
NSYS=$(jq 'length' "$OUT/system-events.json" 2>/dev/null || echo '?')
NOOM=$(jq '[.[] | select((.textPayload // "" | test("(?i)memory|oom|terminat")))] | length' "$OUT/system-events.json" 2>/dev/null || echo '?')
say "  entries: $NSYS ; memory/OOM/termination-shaped: $NOOM"
[ "$NOOM" = "0" ] && say "  -> none. PASS" || jq -r '.[] | select((.textPayload // "" | test("(?i)memory|oom|terminat"))) | "    \(.timestamp) \(.severity) \(.textPayload)"' "$OUT/system-events.json" | tee -a "$SUM"
say ""

# 5. 5xx on THIS revision in-window
say "## 5. 5xx on $SERVING in-window"
: > "$OUT/5xx.txt"; T5=0; PREV=""
for T in $CH; do
  if [ -n "$PREV" ]; then
    F="log_name=\"$REQ_LOG\" AND resource.labels.revision_name=\"$SERVING\" AND httpRequest.status>=500 AND timestamp>=\"$PREV\" AND timestamp<\"$T\""
    gcloud logging read "$F" --project "$PROJECT" --limit 20000 --format='value(timestamp,httpRequest.status,httpRequest.requestMethod,httpRequest.requestUrl)' > "$OUT/c5.tmp" 2>>"$OUT/logread.err" || true
    N=$(grep -c . "$OUT/c5.tmp" || true); say "  $PREV -> $T : $N x 5xx"; cat "$OUT/c5.tmp" >> "$OUT/5xx.txt"; T5=$((T5+N))
  fi; PREV="$T"
done
rm -f "$OUT/c5.tmp"; say "  TOTAL 5xx in-window: $T5"
say "  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal."
[ "$T5" -gt 0 ] && awk '{u=$4; sub(/^https?:\/\/[^\/]+/,"",u); sub(/\?.*/,"",u); print $2, u}' "$OUT/5xx.txt" | sort | uniq -c | sort -rn | sed 's/^/    /' | tee -a "$SUM"
say ""

# 6. driver roll-up — counts AND NAMES unparseable artifacts, never skips them
say "## 6. Driver evidence roll-up ($EVIDENCE_DIR)"
python3 - "$EVIDENCE_DIR" "$OUT" <<'PY' | tee -a "$SUM"
import json,sys,glob,os
d,out=sys.argv[1],sys.argv[2]
files=sorted(glob.glob(os.path.join(d,"cycle-*.json")))
good,bad=[],[]
for f in files:
    try:
        with open(f) as fh: good.append((f,json.load(fh)))
    except Exception as e: bad.append((f,str(e)))
tot=lambda k: sum((c.get("requests",{}).get(k) or 0) for _,c in good)
dev=[{"file":os.path.basename(f),"finished_at":c.get("finished_at"),"deviations":c["deviations"]} for f,c in good if c.get("deviations")]
r={"artifacts_found":len(files),"artifacts_parsed":len(good),
   "artifacts_UNPARSEABLE":len(bad),
   "unparseable_files":[{"file":os.path.basename(f),"error":e} for f,e in bad],
   "first_cycle":good[0][1].get("finished_at") if good else None,
   "last_cycle":good[-1][1].get("finished_at") if good else None,
   "requests_total":tot("total"),"requests_failed_transport":tot("fail"),
   "status_429":tot("status_429"),
   "cycles_with_deviations":len(dev),"deviations":dev}
json.dump(r,open(os.path.join(out,"driver-rollup.json"),"w"),indent=2)
print(json.dumps({k:v for k,v in r.items() if k!="deviations"},indent=2))
if bad: print("!!! UNPARSEABLE ARTIFACTS (named, NOT skipped):"); [print("   ",os.path.basename(f),"->",e) for f,e in bad]
if dev: print(f"!!! {len(dev)} cycle(s) carry deviations — see driver-rollup.json")
PY
say ""
say "  supervisor log:"
grep -c "cycle exited rc=0" "$H/pr-$PR/supervisor.log" 2>/dev/null | sed 's/^/    rc=0 cycles: /' | tee -a "$SUM"
grep "UNTOLERATED\|TOLERATED signal\|HALTING\|supervisor done" "$H/pr-$PR/supervisor.log" 2>/dev/null | sed 's/^/    /' | tee -a "$SUM"
mkdir -p "$OUT/evidence-copy"; cp "$EVIDENCE_DIR"/cycle-*.json "$OUT/evidence-copy/" 2>/dev/null || true
cp "$H/pr-$PR/supervisor.log" "$OUT/evidence-copy/" 2>/dev/null || true

# 7. At-close staging-honesty preflight.
#
# BUG FIXED 2026-08-30: this step used to be a prose "Next:" instruction rather
# than code, so whether the at-close preflight existed depended on the operator
# remembering. Batch A's variant DID run it but wrote it with
#   ( cd "$REPO" && ... 2>"$OUT/x.err" | grep -v '^npm warn' ) > "$OUT/x.json"
# which has three defects, all reproduced as real losses on the 2433/2446/2450
# closes:
#   (a) the redirect target directory was assumed to exist -> ENOENT, and the
#       only surfaced symptom was "preflight_at_close: UNREADABLE [Errno 2]";
#   (b) PF_RC=$? after that construct captures the SUBSHELL/pipeline status, so
#       `grep` filtering every line to nothing returns 1 and masquerades as a
#       preflight failure, while a real tsx failure whose stderr still produced
#       matching stdout could read as success;
#   (c) `cd "$REPO"` failing (the exact condition that makes the repo volume
#       unwritable) short-circuits the && chain, leaving an EMPTY json and no
#       diagnosis.
# Now: $OUT is created and verified writable first, the tsx exit status is taken
# from PIPESTATUS, the repo dir is checked before cd, and the JSON is parsed and
# asserted to say clean_mirror. Any failure is LOUD and non-fatal to the rest of
# the seal, but is recorded as a named gap instead of a silent absence.
say "## 7. At-close staging-honesty preflight"
PF_JSON="$OUT/preflight-at-close.json"
PF_ERR="$OUT/preflight-at-close.err"
REPO_ROOT="/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main"
if ! mkdir -p "$OUT" 2>/dev/null || ! : > "$PF_JSON" 2>/dev/null; then
  say "  !!! GAP: cannot write $PF_JSON — at-close preflight NOT captured"
elif [ ! -d "$REPO_ROOT" ]; then
  say "  !!! GAP: repo root $REPO_ROOT not present — at-close preflight NOT captured"
else
  SRK="$(gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1 2>/dev/null)"
  SAT="$(gcloud secrets versions access latest --secret=supabase_access --project=arkova1 2>/dev/null)"
  if [ -z "$SRK" ]; then
    say "  !!! GAP: could not read supabase-service-role-key-staging — at-close preflight NOT captured"
  else
    ( cd "$REPO_ROOT" \
      && SUPABASE_SERVICE_ROLE_KEY="$SRK" SUPABASE_ACCESS_TOKEN="$SAT" \
         npx tsx scripts/ci/staging-honesty-preflight.ts \
           --project-ref fizyjojbebyalirtjjht \
           --prod-project-ref vzwyaatejekddvltxyye --format json ) \
      > "$PF_JSON" 2> "$PF_ERR"
    PF_RC=${PIPESTATUS[0]}
    [ "$PF_RC" -eq 0 ] || say "  !!! preflight tsx exited $PF_RC — see $PF_ERR"
    python3 - "$PF_JSON" <<'PYPF' | tee -a "$SUM"
import json,sys
try:
    raw=open(sys.argv[1]).read()
    # tsx can emit npm noise before the JSON; take from the first brace.
    d=json.loads(raw[raw.index('{'):])
except Exception as e:
    print("  !!! GAP: preflight-at-close.json unreadable/unparseable ->", e)
    print("  !!! This close has NO at-close preflight. Do not describe one in the evidence block.")
    raise SystemExit(0)
env=d.get("environment_type"); ck=d.get("checks",[])
npass=sum(1 for c in ck if c.get("passed"))
print(f"  preflight_at_close: environment_type={env} ts={d.get('timestamp')} ref={d.get('staging_project_ref')} checks={npass}/{len(ck)}")
for c in ck:
    if not c.get("passed"): print("    FAIL", c.get("name"), str(c.get("details"))[:140])
if env!="clean_mirror":
    print("  !!! RIG IS NOT clean_mirror AT CLOSE — this evidence is NOT merge-grade until reconciled")
PYPF
  fi
fi
say ""

say ""; say "---"; say "Artifacts: $OUT"
say "Next: the rollback rehearsal (it moves the pr-$PR tag, so it must come AFTER this capture and only once THIS window has closed). Use --update-tags, never --set-tags."
