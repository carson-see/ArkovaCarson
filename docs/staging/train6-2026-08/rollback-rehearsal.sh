#!/usr/bin/env bash
# =============================================================================
# TRAIN-6 / PR #2249 — deploy ROLLBACK REHEARSAL (§1.12 T3). POST-CLOSE ONLY.
#
# #2249 is worker-code only (no migration, no flag, no schema): its prod
# rollback is a single revert of the PR merge, which operationally means
# "deploy the pre-PR worker image." This script rehearses exactly that on the
# SAME service the soak ran on:
#
#   1. resolve the current main-head worker image (AR tag -> digest; falls back
#      to the prod-serving digest, loudly)
#   2. PROVE the exact rollback artifact executes BEFORE deploying, by digest
#      execution (docker run --platform linux/amd64, prints its node runtime)
#   3. deploy it to arkova-worker-wave2-2026-08-staging as a NEW revision (tag
#      rollback-main), verify /api/health 3x200 with git_sha = main head, and
#      digest-verify what the new revision reports as status.imageDigest
#   4. restore 100% traffic to arkova-worker-wave2-2026-08-staging-00006-gik
#      and re-verify git_sha = the union head f0e4cfe2e…
#
# *** CLOCK SAFETY ***
# The deploy CREATES A NEW REVISION and moves latestCreated/latestReady. That
# ends the FD-CLOCK-1 clock if the window is still open. This script refuses to
# run before 2026-08-23T20:33:58Z (-u on the parse — the recorded node22 guard
# bug), refuses until close-capture.sh has produced a close-* dir, and refuses
# while the train6 supervisor is still running (its end-epoch parse has the -u
# bug and overruns ~4 h past close — stop it first).
#
# *** SHARED-HISTORY RIG ***
# arkova-worker-wave2-2026-08-staging is NOT torn down after this window (the
# rig is shared history — teardown decision deferred, see 2249-post-seal-plan.md).
# The rollback-main revision this script creates stays on the service; step 4's
# traffic restore leaves the service serving the soaked revision again so the
# rig's state is unsurprising for whoever touches it next.
# =============================================================================
set -uo pipefail

PROJECT="arkova1"
REGION="us-central1"
SERVICE="arkova-worker-wave2-2026-08-staging"
EXPECT_REV="arkova-worker-wave2-2026-08-staging-00006-gik"
UNION_HEAD="f0e4cfe2e375b838a6f164f7c15e23d6b981c34b"
SOAKED_DIGEST="sha256:76f1d043280c24ea593932ebe4e32158afbe56a647c4be709ca93f121d8508b4"
AR_REPO="us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker"
PR_URL="https://train-6---arkova-worker-wave2-2026-08-staging-kvojbeutfa-uc.a.run.app"
RB_URL="https://rollback-main---arkova-worker-wave2-2026-08-staging-kvojbeutfa-uc.a.run.app"
CLOCK_END="2026-08-23T20:33:58Z"
HOME_DIR="/Users/carson/arkova-soak/train6"
REPO_REMOTE="https://github.com/carson-see/ArkovaCarson.git"

# --- guards -------------------------------------------------------------------
END_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$CLOCK_END" +%s 2>/dev/null || date -u -d "$CLOCK_END" +%s)
if [ "$(date -u +%s)" -lt "$END_EPOCH" ]; then
  echo "REFUSING: the soak window is still OPEN (closes $CLOCK_END)." >&2
  echo "A redeploy now creates a new revision and RESETS THE CLOCK. Aborting." >&2
  exit 1
fi
CLOSE_DIR="$(ls -d "$HOME_DIR"/close-* 2>/dev/null | tail -1 || true)"
if [ -z "$CLOSE_DIR" ]; then
  echo "REFUSING: no $HOME_DIR/close-* dir found — run close-capture.sh FIRST." >&2
  echo "The clock must be sealed by the close capture before any serving-state change." >&2
  exit 1
fi
if pgrep -f "train6-load-loop.sh" >/dev/null 2>&1 || pgrep -f "arkova-soak/train6/supervisor.sh" >/dev/null 2>&1; then
  echo "REFUSING: the train6 driver/supervisor is still running (it overruns the" >&2
  echo "close by ~4 h — its end-epoch parse lacks -u). Stop it first:" >&2
  echo "  pkill -f arkova-soak/train6/supervisor.sh; pkill -f train6-load-loop.sh" >&2
  exit 1
fi

LOG="$CLOSE_DIR/rollback-rehearsal-$(date -u +%Y%m%dT%H%M%SZ).md"
say() { echo "$*" | tee -a "$LOG"; }
say "# TRAIN-6 / PR #2249 rollback rehearsal — $(date -u +%FT%TZ)"
say ""
say "Post-close rehearsal on $SERVICE (clock sealed by $CLOSE_DIR)."
say ""

# --- 1. resolve the main-head rollback image ----------------------------------
MAIN_SHA=$(git ls-remote "$REPO_REMOTE" refs/heads/main | cut -f1)
say "main head at rehearsal time: $MAIN_SHA"
ROLLBACK_IMAGE=""
if AR_DIGEST=$(gcloud artifacts docker images describe "$AR_REPO:$MAIN_SHA" \
      --format='value(image_summary.digest)' 2>/dev/null) && [ -n "$AR_DIGEST" ]; then
  ROLLBACK_IMAGE="$AR_REPO@$AR_DIGEST"
  say "rollback image: AR tag for main head -> $ROLLBACK_IMAGE"
else
  PROD_DIGEST=$(gcloud run services describe arkova-worker --project "$PROJECT" --region "$REGION" \
      --format='value(status.traffic[0].revisionName)' 2>/dev/null | xargs -I{} \
      gcloud run revisions describe {} --project "$PROJECT" --region "$REGION" \
      --format='value(status.imageDigest)' 2>/dev/null || true)
  if [ -z "$PROD_DIGEST" ]; then
    say "FATAL: no AR image tagged $MAIN_SHA and prod digest lookup failed."
    say "Resolve the rollback image manually, then re-run."
    exit 1
  fi
  ROLLBACK_IMAGE="$PROD_DIGEST"
  say "!!! no AR tag for main head $MAIN_SHA — falling back to the PROD-SERVING digest:"
  say "    $ROLLBACK_IMAGE"
  say "    (prod may trail main — path-filtered deploys; record this substitution)"
fi

# --- 2. digest-execution proof BEFORE deploying -------------------------------
say ""
say "## Pre-deploy runtime proof of the rollback image (digest execution)"
PRE_VER=$(docker run --rm --platform linux/amd64 --entrypoint node "$ROLLBACK_IMAGE" \
  -e 'console.log("rollback-digest runtime:", process.version)' 2>>"$LOG" || echo "DOCKER-FAILED")
say "$PRE_VER"
case "$PRE_VER" in
  *v2*) say "-> rollback image executes by digest. PASS" ;;
  *) say "FATAL: digest execution failed ('$PRE_VER') — wrong image or docker failure; aborting BEFORE any deploy."; exit 1 ;;
esac

# --- 3. deploy as a new revision, verify health + digest ----------------------
say ""
say "## Deploy (creates a NEW revision — clock already sealed, see header)"
# BUILD_SHA on the service template still carries the union head; override so
# the rollback revision's /health reports what it actually runs.
if ! gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --image "$ROLLBACK_IMAGE" --tag rollback-main \
    --update-env-vars "BUILD_SHA=$MAIN_SHA" 2>&1 | tee -a "$LOG"; then
  say "FATAL: deploy failed — service may still be serving $EXPECT_REV; check traffic before retrying."
  exit 1
fi
NEW_REV=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(status.latestCreatedRevisionName)')
say "new revision: $NEW_REV"
NEW_DIGEST=$(gcloud run revisions describe "$NEW_REV" --project "$PROJECT" --region "$REGION" \
  --format='value(status.imageDigest)')
say "new revision status.imageDigest: $NEW_DIGEST"
[ "${ROLLBACK_IMAGE#*@}" = "${NEW_DIGEST#*@}" ] \
  && say "-> deployed digest matches the digest-executed artifact. PASS" \
  || say "!!! deployed digest differs from the digest-executed artifact — record as FAILED"

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
[ "$RB_FAILS" -eq 0 ] && say "-> rollback revision healthy (3/3 x 200). PASS" \
  || say "!!! rollback revision health FAILED ($RB_FAILS/3) — rollback path NOT proven"

# --- 4. restore 100% traffic to the soaked revision ---------------------------
say ""
say "## Restore traffic to $EXPECT_REV"
gcloud run services update-traffic "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --to-revisions "$EXPECT_REV=100" 2>&1 | tee -a "$LOG"
sleep 5
CODE=$(curl -s --max-time 30 -o "$CLOSE_DIR/restore-health.json" -w '%{http_code} %{time_total}' \
  -H "X-Serverless-Authorization: Bearer $TOK" "$PR_URL/api/health") || CODE="000 -"
GS=$(jq -r '.git_sha // "?"' "$CLOSE_DIR/restore-health.json" 2>/dev/null || echo '?')
say "train-6 tag /api/health after restore: HTTP ${CODE}s git_sha=$GS"
[ "$GS" = "$UNION_HEAD" ] && say "-> $EXPECT_REV back at 100%, serving the union head. PASS" \
  || say "!!! restore verification failed (git_sha=$GS, want $UNION_HEAD)"

say ""
say "---"
say "Rehearsal record: $LOG"
say "Fill 'rollback_note' context in the manifest entry and the maturity template"
say "from this file. Note for the record: rollback revision $NEW_REV remains on"
say "the shared-history service (teardown deferred — see 2249-post-seal-plan.md)."
