#!/usr/bin/env bash
# =============================================================================
# PR #2314 (FD-FERPA-1) — ROLLBACK REHEARSAL (§1.12 T3). POST-CLOSE ONLY.
#
# #2314's rollback has TWO halves and this script rehearses both, on the same
# isolated rig the soak ran on (Supabase wjuelohtpklodpjklvqy + Cloud Run
# arkova-worker-ferpa2314-staging):
#
#   PHASE A — migration rollback + re-apply (the RC-manifest "migration
#   rollback/reapply proof"). 0415's `-- ROLLBACK:` block: restore the
#   pre-0415 PRODUCTION bodies of public.get_public_anchor(text) and
#   public.search_public_credentials(text,integer), DROP
#   private.is_directory_info_suppressed(boolean,text), NOTIFY pgrst. The
#   rollback SOURCE is read live from prod (`pg_get_functiondef`) — prod still
#   runs the pre-0415 bodies because 0415 is deliberately NOT prod-applied —
#   and md5-gated against the values 0415's ROLLBACK block documents
#   (get_public_anchor 83770caee7e7fe9c1fa3963dadb387c2, search_public_credentials
#   6c2d77e1af8aeb2a56d316443ad090a1). Prod is READ ONLY here; every write goes
#   to the rig. Behavioral proof at each step: the opted-out CLE fixture
#   ARK-ACD-A7VMJJ leaves/rejoins the `search_public_credentials('CLE Ethics
#   Seminar Alpha', 10)` match set (1 row with 0415, 2 rows rolled back).
#
#   PHASE B — worker deploy rollback. Resolve the current main-head worker
#   image (AR tag -> digest), PROVE the exact rollback artifact executes by
#   digest (docker run --platform linux/amd64, prints its node runtime) BEFORE
#   deploying, deploy it to the rig service as a NEW revision (tag
#   rollback-main), verify /api/health 3x200 with git_sha = main head, then
#   restore 100% traffic to arkova-worker-ferpa2314-staging-00001-cit and
#   re-verify git_sha = the soaked head.
#
# *** CLOCK SAFETY — READ BEFORE RUNNING ***
# Phase B CREATES A NEW REVISION and moves latestCreated/latestReady; Phase A
# rewrites rig DB state the driver's probes assert on. Either one mid-window
# destroys the soak. This script therefore refuses to run:
#   - before the window close (2026-08-23T19:24:30Z; -u on the parse — the
#     recorded node22 guard bug was a -u-less local-EDT parse),
#   - until close-capture.sh has produced a close-* dir (clock sealed first),
#   - while the ferpa2314 supervisor/load-loop is still running (its own
#     end-epoch parse has the -u bug and overruns ~4 h past close — stop it
#     first, teardown checklist step 0, or Phase A makes its probes fail).
# =============================================================================
set -uo pipefail

PROJECT="arkova1"
REGION="us-central1"
SERVICE="arkova-worker-ferpa2314-staging"
EXPECT_REV="arkova-worker-ferpa2314-staging-00001-cit"
RIG_REF="wjuelohtpklodpjklvqy"
PROD_REF="vzwyaatejekddvltxyye"
SOAKED_HEAD="93747a6aa451991476ab0b00d58c3fb0754f2e2d"
AR_REPO="us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker"
PR_URL="https://pr-2314---arkova-worker-ferpa2314-staging-kvojbeutfa-uc.a.run.app"
RB_URL="https://rollback-main---arkova-worker-ferpa2314-staging-kvojbeutfa-uc.a.run.app"
CLOCK_END="2026-08-23T19:24:30Z"
HOME_DIR="/Users/carson/arkova-soak/ferpa2314"
REPO_REMOTE="https://github.com/carson-see/ArkovaCarson.git"
# The 0415 file is PR-only (not on main), so it is extracted from git at the
# SOAKED head — never from a checkout that may sit on another branch. Byte md5
# must equal what the stand-up applied: 192e5797b9fc052ae0e8dbbeb3d4bd9a.
GIT_DIR="/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main"
MIG_0415_GITPATH="supabase/migrations/0415_ferpa_directory_info_opt_out_public_projections.sql"
MIG_0415_MD5="192e5797b9fc052ae0e8dbbeb3d4bd9a"
# Documented md5s (0415 header + its ROLLBACK block):
PRE_GPA_MD5="83770caee7e7fe9c1fa3963dadb387c2"   # pre-0415 get_public_anchor prosrc
PRE_SPC_MD5="6c2d77e1af8aeb2a56d316443ad090a1"   # pre-0415 search_public_credentials prosrc
POST_GPA_MD5="8019d49a18fd142517b9445c70c002e7"  # 0415 get_public_anchor prosrc
POST_SPC_MD5="f8e7631742fd327290585e5f421c393b"  # 0415 search_public_credentials prosrc
POST_PRED_MD5="298388e7efb8c93c24b73e36e0443565" # 0415 is_directory_info_suppressed prosrc

# --- guards -------------------------------------------------------------------
END_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$CLOCK_END" +%s 2>/dev/null || date -u -d "$CLOCK_END" +%s)
if [ "$(date -u +%s)" -lt "$END_EPOCH" ]; then
  echo "REFUSING: the soak window is still OPEN (closes $CLOCK_END)." >&2
  echo "Phase A/B here would destroy the running soak. Aborting." >&2
  exit 1
fi
CLOSE_DIR="$(ls -d "$HOME_DIR"/close-* 2>/dev/null | tail -1 || true)"
if [ -z "$CLOSE_DIR" ]; then
  echo "REFUSING: no $HOME_DIR/close-* dir found — run close-capture.sh FIRST." >&2
  exit 1
fi
if pgrep -f "ferpa2314-load-loop.sh" >/dev/null 2>&1 || pgrep -f "arkova-soak/ferpa2314/supervisor.sh" >/dev/null 2>&1; then
  echo "REFUSING: the ferpa2314 driver/supervisor is still running (it overruns" >&2
  echo "the close by ~4 h — its end-epoch parse lacks -u). Stop it first:" >&2
  echo "  pkill -f arkova-soak/ferpa2314/supervisor.sh; pkill -f ferpa2314-load-loop.sh" >&2
  exit 1
fi

LOG="$CLOSE_DIR/rollback-rehearsal-$(date -u +%Y%m%dT%H%M%SZ).md"
say() { echo "$*" | tee -a "$LOG"; }
say "# PR #2314 rollback rehearsal — $(date -u +%FT%TZ)"
say ""
say "Post-close rehearsal on $SERVICE / $RIG_REF (clock sealed by $CLOSE_DIR)."
say ""

SB_TOKEN=$(gcloud secrets versions access latest --secret=supabase_access --project="$PROJECT")
[ -n "$SB_TOKEN" ] || { say "FATAL: could not read supabase_access token"; exit 1; }

# run SQL via the Management API query endpoint; $1 = project ref, $2 = SQL
sql() {
  jq -n --arg q "$2" '{query: $q}' | curl -sS --max-time 120 \
    -X POST -H "Authorization: Bearer $SB_TOKEN" -H "Content-Type: application/json" \
    -d @- "https://api.supabase.com/v1/projects/$1/database/query"
}

MD5_Q_GPA="SELECT md5(prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_public_anchor'"
MD5_Q_SPC="SELECT md5(prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='search_public_credentials'"
MD5_Q_PRED="SELECT md5(prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='is_directory_info_suppressed'"
SEARCH_Q="SELECT count(*) AS n FROM public.search_public_credentials('CLE Ethics Seminar Alpha', 10)"

md5_of() { sql "$1" "$2" | jq -r '.[0].m // "ABSENT"'; }
searchcount() { sql "$1" "$SEARCH_Q" | jq -r '.[0].n // "?"'; }

# --- Phase A step 0: baseline (0415 live on the rig) --------------------------
say "## A0. Baseline — 0415 live on the rig"
G=$(md5_of "$RIG_REF" "$MD5_Q_GPA"); S=$(md5_of "$RIG_REF" "$MD5_Q_SPC"); P=$(md5_of "$RIG_REF" "$MD5_Q_PRED")
N=$(searchcount "$RIG_REF")
say "  rig get_public_anchor prosrc md5:        $G (want $POST_GPA_MD5)"
say "  rig search_public_credentials prosrc md5: $S (want $POST_SPC_MD5)"
say "  rig is_directory_info_suppressed md5:     $P (want $POST_PRED_MD5)"
say "  rig search('CLE Ethics Seminar Alpha') rows: $N (want 1 — A7VMJJ suppressed)"
if [ "$G" != "$POST_GPA_MD5" ] || [ "$S" != "$POST_SPC_MD5" ] || [ "$P" != "$POST_PRED_MD5" ] || [ "$N" != "1" ]; then
  say "FATAL: rig baseline is not the 0415 state — investigate before rehearsing."
  exit 1
fi
say "  -> baseline PASS"
say ""

# --- Phase A step 1: read the rollback source from PROD (READ ONLY) ----------
say "## A1. Rollback source — prod's live pre-0415 bodies (pg_get_functiondef, read-only)"
PROD_G_MD5=$(md5_of "$PROD_REF" "$MD5_Q_GPA")
PROD_S_MD5=$(md5_of "$PROD_REF" "$MD5_Q_SPC")
say "  prod get_public_anchor prosrc md5:        $PROD_G_MD5 (want $PRE_GPA_MD5)"
say "  prod search_public_credentials prosrc md5: $PROD_S_MD5 (want $PRE_SPC_MD5)"
if [ "$PROD_G_MD5" != "$PRE_GPA_MD5" ] || [ "$PROD_S_MD5" != "$PRE_SPC_MD5" ]; then
  say "FATAL: prod's live bodies no longer match 0415's documented ROLLBACK md5s —"
  say "prod has moved since the ROLLBACK block was written (or 0415 reached prod)."
  say "Do NOT proceed on stale instructions; re-derive the rollback target first."
  exit 1
fi
GPA_DEF=$(sql "$PROD_REF" "SELECT pg_get_functiondef('public.get_public_anchor(text)'::regprocedure) AS d" | jq -r '.[0].d')
SPC_DEF=$(sql "$PROD_REF" "SELECT pg_get_functiondef('public.search_public_credentials(text,integer)'::regprocedure) AS d" | jq -r '.[0].d')
[ -n "$GPA_DEF" ] && [ "$GPA_DEF" != "null" ] || { say "FATAL: empty prod def for get_public_anchor"; exit 1; }
[ -n "$SPC_DEF" ] && [ "$SPC_DEF" != "null" ] || { say "FATAL: empty prod def for search_public_credentials"; exit 1; }
printf '%s\n' "$GPA_DEF" > "$CLOSE_DIR/rollback-src-get_public_anchor.sql"
printf '%s\n' "$SPC_DEF" > "$CLOSE_DIR/rollback-src-search_public_credentials.sql"
say "  -> prod defs captured to $CLOSE_DIR/rollback-src-*.sql. PASS"
say ""

# --- Phase A step 2: ROLL BACK the rig ---------------------------------------
say "## A2. Roll the RIG back (writes go to $RIG_REF only)"
ROLLBACK_SQL="SET lock_timeout = '5s';
${GPA_DEF};
${SPC_DEF};
DROP FUNCTION IF EXISTS private.is_directory_info_suppressed(boolean, text);
NOTIFY pgrst, 'reload schema';"
sql "$RIG_REF" "$ROLLBACK_SQL" > "$CLOSE_DIR/rollback-apply-result.json" 2>&1 || true
G=$(md5_of "$RIG_REF" "$MD5_Q_GPA"); S=$(md5_of "$RIG_REF" "$MD5_Q_SPC"); P=$(md5_of "$RIG_REF" "$MD5_Q_PRED")
N=$(searchcount "$RIG_REF")
say "  rig get_public_anchor md5 after rollback:        $G (want $PRE_GPA_MD5)"
say "  rig search_public_credentials md5 after rollback: $S (want $PRE_SPC_MD5)"
say "  rig is_directory_info_suppressed after rollback:  $P (want ABSENT)"
say "  rig search('CLE Ethics Seminar Alpha') rows:      $N (want 2 — A7VMJJ REPUBLISHED)"
if [ "$G" = "$PRE_GPA_MD5" ] && [ "$S" = "$PRE_SPC_MD5" ] && [ "$P" = "ABSENT" ] && [ "$N" = "2" ]; then
  say "  -> ROLLBACK PROVEN: pre-0415 prod bodies installed, predicate dropped,"
  say "     the opted-out CLE record rejoined the public match set. PASS"
else
  say "  -> !!! rollback verification FAILED — rig may be in a mixed state."
  say "     Fix forward by re-applying 0415 (step A3) and record the failure."
fi
say ""

# --- Phase A step 3: RE-APPLY 0415 byte-exact --------------------------------
say "## A3. Re-apply 0415 (byte-exact, extracted from git at the soaked head)"
MIG_0415="$CLOSE_DIR/0415-soaked-head.sql"
git -C "$GIT_DIR" show "$SOAKED_HEAD:$MIG_0415_GITPATH" > "$MIG_0415" 2>>"$LOG" \
  || { say "FATAL: could not extract 0415 from git at $SOAKED_HEAD (fetch the PR branch into $GIT_DIR first: git fetch origin fix/fd-ferpa-1-directory-opt-out-public-projections)"; exit 1; }
FILE_MD5=$(md5 -q "$MIG_0415" 2>/dev/null || md5sum "$MIG_0415" | cut -d' ' -f1)
say "  extracted-file md5: $FILE_MD5 (want $MIG_0415_MD5)"
[ "$FILE_MD5" = "$MIG_0415_MD5" ] || { say "FATAL: extracted 0415 is not the byte-exact soaked file — aborting re-apply."; exit 1; }
jq -n --rawfile q "$MIG_0415" '{query: $q}' | curl -sS --max-time 300 \
  -X POST -H "Authorization: Bearer $SB_TOKEN" -H "Content-Type: application/json" \
  -d @- "https://api.supabase.com/v1/projects/$RIG_REF/database/query" \
  > "$CLOSE_DIR/reapply-0415-result.json" 2>&1 || true
sql "$RIG_REF" "NOTIFY pgrst, 'reload schema'" >/dev/null 2>&1 || true
G=$(md5_of "$RIG_REF" "$MD5_Q_GPA"); S=$(md5_of "$RIG_REF" "$MD5_Q_SPC"); P=$(md5_of "$RIG_REF" "$MD5_Q_PRED")
N=$(searchcount "$RIG_REF")
say "  rig get_public_anchor md5 after re-apply:        $G (want $POST_GPA_MD5)"
say "  rig search_public_credentials md5 after re-apply: $S (want $POST_SPC_MD5)"
say "  rig is_directory_info_suppressed after re-apply:  $P (want $POST_PRED_MD5)"
say "  rig search('CLE Ethics Seminar Alpha') rows:      $N (want 1 — suppression back)"
if [ "$G" = "$POST_GPA_MD5" ] && [ "$S" = "$POST_SPC_MD5" ] && [ "$P" = "$POST_PRED_MD5" ] && [ "$N" = "1" ]; then
  say "  -> RE-APPLY PROVEN: full rollback -> re-apply cycle is clean. PASS"
else
  say "  -> !!! re-apply verification FAILED — do NOT tear the rig down until resolved."
fi
say "  NOTE: the 0415 ledger row already exists on the rig; re-running the file"
say "  is CREATE OR REPLACE + COMMENT + REVOKE/GRANT — no new ledger row is"
say "  written by the query endpoint, so the ledger stays numeric head 0415."
say ""

# --- Phase B: worker deploy rollback -----------------------------------------
say "## B. Worker deploy rollback (creates a NEW revision — clock already sealed)"
MAIN_SHA=$(git ls-remote "$REPO_REMOTE" refs/heads/main | cut -f1)
say "  main head at rehearsal time: $MAIN_SHA"
ROLLBACK_IMAGE=""
if AR_DIGEST=$(gcloud artifacts docker images describe "$AR_REPO:$MAIN_SHA" \
      --format='value(image_summary.digest)' 2>/dev/null) && [ -n "$AR_DIGEST" ]; then
  ROLLBACK_IMAGE="$AR_REPO@$AR_DIGEST"
  say "  rollback image: AR tag for main head -> $ROLLBACK_IMAGE"
else
  PROD_DIGEST=$(gcloud run services describe arkova-worker --project "$PROJECT" --region "$REGION" \
      --format='value(status.traffic[0].revisionName)' 2>/dev/null | xargs -I{} \
      gcloud run revisions describe {} --project "$PROJECT" --region "$REGION" \
      --format='value(status.imageDigest)' 2>/dev/null || true)
  if [ -z "$PROD_DIGEST" ]; then
    say "FATAL: no AR image tagged $MAIN_SHA and prod digest lookup failed."
    say "Resolve the rollback image manually, then re-run Phase B."
    exit 1
  fi
  ROLLBACK_IMAGE="$PROD_DIGEST"
  say "  !!! no AR tag for main head $MAIN_SHA — falling back to the PROD-SERVING digest:"
  say "      $ROLLBACK_IMAGE  (prod may trail main; record this substitution)"
fi

# Digest-execution proof BEFORE deploying: the exact rollback artifact runs.
PRE_VER=$(docker run --rm --platform linux/amd64 --entrypoint node "$ROLLBACK_IMAGE" \
  -e 'console.log("rollback-digest runtime:", process.version)' 2>>"$LOG" || echo "DOCKER-FAILED")
say "  $PRE_VER"
case "$PRE_VER" in
  *v2*) say "  -> rollback image executes by digest. PASS" ;;
  *) say "FATAL: digest execution failed ('$PRE_VER') — aborting BEFORE any deploy."; exit 1 ;;
esac

if ! gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --image "$ROLLBACK_IMAGE" --tag rollback-main \
    --update-env-vars "BUILD_SHA=$MAIN_SHA" 2>&1 | tee -a "$LOG"; then
  say "FATAL: deploy failed — check traffic on $EXPECT_REV before retrying."
  exit 1
fi
NEW_REV=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(status.latestCreatedRevisionName)')
say "  new revision: $NEW_REV"
NEW_DIGEST=$(gcloud run revisions describe "$NEW_REV" --project "$PROJECT" --region "$REGION" \
  --format='value(status.imageDigest)')
say "  new revision status.imageDigest: $NEW_DIGEST"
[ "$NEW_DIGEST" = "$ROLLBACK_IMAGE" ] || [ "${ROLLBACK_IMAGE#*@}" = "${NEW_DIGEST#*@}" ] \
  && say "  -> deployed digest matches the digest-executed artifact. PASS" \
  || say "  -> !!! deployed digest differs from the digest-executed artifact"

TOK=$(gcloud auth print-identity-token)   # minted without --audiences, as always
i=1; RB_FAILS=0
while [ "$i" -le 3 ]; do
  CODE=$(curl -s --max-time 30 -o "$CLOSE_DIR/rb-health-$i.json" -w '%{http_code} %{time_total}' \
    -H "X-Serverless-Authorization: Bearer $TOK" "$RB_URL/api/health") || CODE="000 -"
  GS=$(jq -r '.git_sha // "?"' "$CLOSE_DIR/rb-health-$i.json" 2>/dev/null || echo '?')
  say "  rollback /api/health run $i: HTTP ${CODE}s git_sha=$GS"
  case "$CODE" in 200\ *) :;; *) RB_FAILS=$((RB_FAILS+1));; esac
  i=$((i+1))
done
[ "$RB_FAILS" -eq 0 ] && say "  -> rollback revision healthy (3/3 x 200). PASS" \
  || say "  -> !!! rollback revision health FAILED ($RB_FAILS/3) — rollback path NOT proven"

say ""
say "## B2. Restore traffic to $EXPECT_REV"
gcloud run services update-traffic "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --to-revisions "$EXPECT_REV=100" 2>&1 | tee -a "$LOG"
sleep 5
CODE=$(curl -s --max-time 30 -o "$CLOSE_DIR/restore-health.json" -w '%{http_code} %{time_total}' \
  -H "X-Serverless-Authorization: Bearer $TOK" "$PR_URL/api/health") || CODE="000 -"
GS=$(jq -r '.git_sha // "?"' "$CLOSE_DIR/restore-health.json" 2>/dev/null || echo '?')
say "  pr-2314 tag /api/health after restore: HTTP ${CODE}s git_sha=$GS"
[ "$GS" = "$SOAKED_HEAD" ] && say "  -> $EXPECT_REV back at 100%, serving the soaked head. PASS" \
  || say "  -> !!! restore verification failed (git_sha=$GS, want $SOAKED_HEAD)"

say ""
say "---"
say "Rehearsal record: $LOG"
say "Fill 'Rollback rehearsed:' in the evidence block and the maturity template"
say "from this file. Rollback revision $NEW_REV remains on the service until"
say "teardown (teardown deletes the whole service; no cleanup needed here)."
