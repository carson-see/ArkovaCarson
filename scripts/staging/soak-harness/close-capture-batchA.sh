#!/usr/bin/env bash
# Seals a soak window for ONE PR. Invoked by that PR's supervisor when the
# window closes — the existing ferpa2314/train6 supervisors never call their
# close-capture at all, which is why their windows had to be sealed by hand.
#
# Usage: close-capture.sh <pr> <revision> <tag-url> <head-sha> <clock-start-iso>
set -uo pipefail
PR="$1"; REV="$2"; BASE="$3"; HEAD_SHA="$4"; CLOCK_START="$5"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# SOAK_REPO_OVERRIDE exists so the seal-location fallback below is testable
# (point it at an unwritable path and the local-fallback branch must fire).
REPO="${SOAK_REPO_OVERRIDE:-/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main}"
REPO_OUT="$REPO/docs/staging/batchA-2026-08-28/pr-$PR/close-$STAMP"
LOCAL_OUT="$HOME/arkova-soak/batchA-2026-08-28/evidence/pr-$PR/close-$STAMP"
say() { echo "[close-$PR] $*"; }

# BUG FIXED 2026-08-29: `mkdir -p "$OUT"` was unchecked. The repo lives on the
# EXTERNAL volume /Volumes/Extreme; when the detached supervisors lost their
# macOS TCC removable-volume grant mid-window, this mkdir returned EPERM, EVERY
# subsequent redirect into $OUT failed with ENOENT, the preflight capture at the
# bottom printed "preflight_at_close: UNREADABLE [Errno 2]" — and the script
# STILL printed "sealed -> <path>" for a directory that does not exist. #2433
# and #2446 were both reported sealed to close dirs that were never created.
# Now: the seal ALWAYS lands somewhere real. Local disk is the primary target,
# the repo is a mirror, and the location actually used is stated in the log.
SEAL_MODE="repo"
if mkdir -p "$REPO_OUT" 2>/dev/null; then
  OUT="$REPO_OUT"
else
  SEAL_MODE="local-fallback"
  mkdir -p "$LOCAL_OUT" || { echo "[close-$PR] FATAL: cannot create either $REPO_OUT or $LOCAL_OUT" >&2; exit 1; }
  OUT="$LOCAL_OUT"
  say "!!! repo close dir NOT creatable ($REPO_OUT) — sealing to local disk instead"
fi
say "seal_mode=$SEAL_MODE out=$OUT"

say "sealing window at $STAMP (clock start $CLOCK_START)"

# 1. Clock integrity: the revision must be the SAME one the clock started on.
gcloud run revisions describe "$REV" --region=us-central1 --project=arkova1 --format=json \
  > "$OUT/revision.json" 2>"$OUT/revision.err"
python3 - "$OUT/revision.json" "$CLOCK_START" > "$OUT/clock.txt" 2>&1 <<'PY'
import json,sys,datetime
d=json.load(open(sys.argv[1]))
created=d["metadata"]["creationTimestamp"]
img=d["spec"]["containers"][0]["image"]
now=datetime.datetime.now(datetime.timezone.utc)
c=datetime.datetime.fromisoformat(created.replace("Z","+00:00"))
ls=datetime.datetime.fromisoformat(sys.argv[2].replace("Z","+00:00"))
print("revision:", d["metadata"]["name"])
print("image:", img)
# TWO DISTINCT INTERVALS. Revision creation is NOT the soak clock: a revision
# can sit up for a day serving nothing, and that interval is a hollow window.
# The CLAIMABLE soak is the LOAD window, anchored at driver start. Worker
# uptime is reported alongside it as the conservative half of the claim.
print("revision_created:", created)
print("load_window_start:", sys.argv[2])
print("worker_uptime_hours: %.3f" % ((now-c).total_seconds()/3600.0))
print("load_window_hours: %.3f" % ((now-ls).total_seconds()/3600.0))
# The revision must predate the load window and must not have been replaced
# under it, or the load did not all land on the asserted image.
print("revision_predates_load_window:", c <= ls)
print("hollow_lead_in_hours: %.3f" % ((ls-c).total_seconds()/3600.0))
PY
cat "$OUT/clock.txt"

# 2. Service-level traffic + tag state.
gcloud run services describe arkova-worker-staging --region=us-central1 --project=arkova1 \
  --format=json > "$OUT/service.json" 2>/dev/null

# 3. Health at close, 5x.
TOK="$(gcloud auth print-identity-token 2>/dev/null)"
: > "$OUT/health-at-close.txt"
for i in 1 2 3 4 5; do
  curl -s --max-time 30 -H "X-Serverless-Authorization: Bearer $TOK" "$BASE/api/health" \
    -w "\nHTTP=%{http_code} t=%{time_total}\n" >> "$OUT/health-at-close.txt" 2>&1
  sleep 2
done
say "health at close:"; grep -c "HTTP=200" "$OUT/health-at-close.txt"

# 4. Which revisions actually served requests in the window, and every 5xx.
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=arkova-worker-staging AND resource.labels.revision_name=$REV AND httpRequest.status>=500" \
  --project=arkova1 --limit=200 --format=json > "$OUT/5xx.json" 2>/dev/null
python3 -c "
import json,sys
try: d=json.load(open('$OUT/5xx.json'))
except Exception: d=[]
print('5xx_count:', len(d))
" | tee "$OUT/5xx-summary.txt"

# 5. Container terminations / OOM on this revision.
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=arkova-worker-staging AND resource.labels.revision_name=$REV AND (textPayload:\"Container terminated\" OR textPayload:\"memory limit\" OR textPayload:\"OOM\")" \
  --project=arkova1 --limit=50 --format=json > "$OUT/terminations.json" 2>/dev/null
python3 -c "
import json
try: d=json.load(open('$OUT/terminations.json'))
except Exception: d=[]
print('termination_events:', len(d))
" | tee "$OUT/terminations-summary.txt"

# 6. Roll up every per-cycle evidence file for this PR.
python3 - "$REPO/docs/staging/batchA-2026-08-28/pr-$PR" "$OUT/rollup.json" "$HOME/arkova-soak/batchA-2026-08-28/evidence/pr-$PR" <<'PY'
import json,sys,glob,os
# Roll up the union of the repo mirror and the durable local evidence dir,
# de-duplicated by basename. A cycle whose repo mirror failed (EPERM on the
# external volume) is still real evidence and must still be counted.
dirs=[sys.argv[1]]+([sys.argv[3]] if len(sys.argv)>3 else [])
seen={}
for d in dirs:
    for f in glob.glob(os.path.join(d,"load-*.json")):
        seen.setdefault(os.path.basename(f), f)
files=[seen[k] for k in sorted(seen)]
tot={"ok":0,"fail":0,"http_200":0,"http_400":0,"http_404":0,"http_401":0,"http_429":0,"http_other":0}
cold=0; devs=[]; revs=set(); first=None; last=None
bad=[]
for f in files:
    try: j=json.load(open(f))
    except Exception as e:
        bad.append((os.path.basename(f), str(e))); continue
    for k in tot: tot[k]+=j.get("counts",{}).get(k,0)
    cold+=j.get("cold_start_retries",0)
    if j.get("deviations","").strip(): devs.append({"file":os.path.basename(f),"dev":j["deviations"]})
    revs.add(j.get("worker_revision"))
    if first is None: first=j.get("cycle_start")
    last=j.get("cycle_end")
out={"cycles":len(files)-len(bad),"cycles_found":len(files),
     "unparseable":[{"file":b[0],"error":b[1]} for b in bad],
     "totals":tot,"cold_start_retries":cold,
     "revisions_seen":sorted(x for x in revs if x),
     "loaded_from":first,"loaded_to":last,"deviations":devs}
json.dump(out,open(sys.argv[2],"w"),indent=2)
print(json.dumps({k:out[k] for k in ("cycles","totals","cold_start_retries","revisions_seen","loaded_from","loaded_to")},indent=2))
print("deviation_files:",len(devs))
print("unparseable:",len(bad))
if bad:
    for b in bad: print("  DISCARDED:",b[0],"->",b[1])
    print("Evidence is INCOMPLETE until these are repaired or explained")
else:
    print("All cycle artifacts parsed cleanly (0 discarded)")
PY

# 7. Re-run the staging-honesty preflight at close — evidence is only merge-grade
#    if the rig is STILL clean_mirror when the window is judged.
# BUG FIXED 2026-08-29: stderr went to /dev/null and the redirect target was
# assumed writable, so a failure here surfaced only as "UNREADABLE [Errno 2]"
# with no diagnosis. Keep the stderr, and report the exit status.
# BUG FIXED 2026-08-30 (second pass). The previous form still had three defects:
#   (a) `PF_RC=$?` after `( ... | grep ... ) > f` captures the SUBSHELL/pipeline
#       status, not tsx's — `grep -v` filtering every line to nothing returns 1
#       and masqueraded as a preflight failure. Take PIPESTATUS[0] instead.
#   (b) `cd "$REPO"` failing — the exact condition that makes the repo volume
#       unwritable and triggers the local-fallback seal above — short-circuits
#       the && chain, leaving an EMPTY json and no diagnosis. Check it first.
#   (c) the redirect target was assumed writable. $OUT is now guaranteed by the
#       SEAL_MODE block, but assert writability anyway so a failure is NAMED.
if [ ! -d "$REPO" ]; then
  say "!!! GAP: repo root $REPO not present — at-close preflight NOT captured"
elif ! : > "$OUT/preflight-at-close.json" 2>/dev/null; then
  say "!!! GAP: cannot write $OUT/preflight-at-close.json — at-close preflight NOT captured"
else
SRK="$(gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1 2>/dev/null)"
SAT="$(gcloud secrets versions access latest --secret=supabase_access --project=arkova1 2>/dev/null)"
( cd "$REPO" \
  && SUPABASE_SERVICE_ROLE_KEY="$SRK" SUPABASE_ACCESS_TOKEN="$SAT" \
     npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref fizyjojbebyalirtjjht \
       --prod-project-ref vzwyaatejekddvltxyye --format json ) \
  > "$OUT/preflight-at-close.json" 2>"$OUT/preflight-at-close.err"
PF_RC=${PIPESTATUS[0]}
fi
PF_RC=${PF_RC:-1}
[ "$PF_RC" -eq 0 ] || say "!!! preflight-at-close exited $PF_RC — see $OUT/preflight-at-close.err"
[ -s "$OUT/preflight-at-close.json" ] || say "!!! preflight-at-close.json is EMPTY — the at-close preflight was NOT captured"
python3 -c "
import json
try:
  raw=open('$OUT/preflight-at-close.json').read()
  d=json.loads(raw[raw.index('{'):])
  print('preflight_at_close:', d['environment_type'])
  for c in d['checks']:
    if not c['passed']: print('  FAIL', c['name'], c['details'][:120])
except Exception as e: print('preflight_at_close: UNREADABLE', e)
" | tee "$OUT/preflight-summary.txt"

if [ "$SEAL_MODE" = "local-fallback" ]; then
  if mkdir -p "$REPO_OUT" 2>/dev/null && cp -R "$OUT/." "$REPO_OUT/" 2>/dev/null; then
    say "repo volume recovered — local seal mirrored to $REPO_OUT"
  else
    say "!!! repo volume still not writable — seal exists ONLY at $OUT"
  fi
fi
say "sealed -> $OUT (seal_mode=$SEAL_MODE)"
