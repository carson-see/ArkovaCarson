#!/usr/bin/env bash
# =============================================================================
# PR #2291 (Node 22 LTS worker upgrade) — deploy ROLLBACK REHEARSAL (§1.12 T2).
#
# For a runtime pin the rollback is: redeploy the Node 20 (current main-head)
# image. This script rehearses exactly that, on the SAME service the soak ran on:
#
#   1. resolve the current main-head Node 20 worker image (Artifact Registry tag
#      for the main-head SHA; falls back to the prod-serving digest, loudly)
#   2. PROVE the candidate image is Node 20 BEFORE deploying, by executing the
#      digest — the same method the stand-up used for the Node 22 proof
#   3. deploy it to arkova-worker-node22-staging as a NEW revision (tag
#      rollback-node20); verify /api/health 200 + node major 20 via digest
#      execution of what the new revision actually reports as status.imageDigest
#   4. restore 100% traffic to arkova-worker-node22-staging-00001-8md and
#      re-verify its digest (sha256:c6f51425...) executes as v22.23.1 — the same
#      digest-execution method again
#
# *** CLOCK SAFETY — READ BEFORE RUNNING ***
# Redeploying CREATES A NEW REVISION and moves latestCreated/latestReady (and,
# because the service's traffic spec is latestRevision:true, serving traffic).
# That would END the FD-CLOCK-1 soak clock if the window were still open. This
# script therefore:
#   - refuses to run before the window close (2026-08-23T09:27:29Z), and
#   - refuses to run until close-capture.sh has produced a close-* dir —
#     the clock must ALREADY BE SEALED by the close capture before the first
#     serving-state change here. This is deliberately AFTER clock close: the
#     rehearsal cannot contaminate evidence that is already captured.
# A mid-window run of this script is the one way to destroy this soak. Don't.
# =============================================================================
set -uo pipefail

PROJECT="arkova1"
REGION="us-central1"
SERVICE="arkova-worker-node22-staging"
EXPECT_REV="arkova-worker-node22-staging-00001-8md"
NODE22_DIGEST="sha256:c6f51425d50744c8aeecf439dafae2b5055567ad440b9e891dae617f9d652556"
HEAD_SHA="f41192e061d72ef8866f19dbd50c16593ccbca23"
AR_REPO="us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker"
PR2291_URL="https://pr-2291---arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app"
RB_URL="https://rollback-node20---arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app"
CLOCK_END="2026-08-23T09:27:29Z"
HOME_DIR="/Users/carson/arkova-soak/node22"
REPO_REMOTE="https://github.com/carson-see/ArkovaCarson.git"

# --- guards: post-close only, and only after close-capture sealed the clock ---
END_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$CLOCK_END" +%s 2>/dev/null || date -d "$CLOCK_END" +%s)
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

LOG="$CLOSE_DIR/rollback-rehearsal-$(date -u +%Y%m%dT%H%M%SZ).md"
say() { echo "$*" | tee -a "$LOG"; }
say "# PR #2291 rollback rehearsal — $(date -u +%FT%TZ)"
say ""
say "Post-close rehearsal on $SERVICE (clock sealed by $CLOSE_DIR)."
say ""

# --- 1. resolve the main-head Node 20 image -----------------------------------
MAIN_SHA=$(git ls-remote "$REPO_REMOTE" refs/heads/main | cut -f1)
say "main head at rehearsal time: $MAIN_SHA"
ROLLBACK_IMAGE=""
if AR_DIGEST=$(gcloud artifacts docker images describe "$AR_REPO:$MAIN_SHA" \
      --format='value(image_summary.digest)' 2>/dev/null) && [ -n "$AR_DIGEST" ]; then
  ROLLBACK_IMAGE="$AR_REPO@$AR_DIGEST"
  say "rollback image: AR tag for main head -> $ROLLBACK_IMAGE"
else
  # Fallback: the digest prod is serving. Prod can trail main (path-filtered
  # deploys), so this is stated loudly rather than passed off as main-head.
  PROD_DIGEST=$(gcloud run services describe arkova-worker --project "$PROJECT" --region "$REGION" \
      --format='value(status.traffic[0].revisionName)' 2>/dev/null | xargs -I{} \
      gcloud run revisions describe {} --project "$PROJECT" --region "$REGION" \
      --format='value(status.imageDigest)' 2>/dev/null || true)
  if [ -z "$PROD_DIGEST" ]; then
    say "FATAL: no AR image tagged $MAIN_SHA and prod digest lookup failed."
    say "Resolve the Node 20 rollback image manually, then re-run."
    exit 1
  fi
  ROLLBACK_IMAGE="$PROD_DIGEST"
  say "!!! no AR tag for main head $MAIN_SHA — falling back to the PROD-SERVING digest:"
  say "    $ROLLBACK_IMAGE"
  say "    (prod may trail main; record this substitution in the maturity record)"
fi

# --- 2. prove the candidate is Node 20 BEFORE deploying (digest execution) ----
say ""
say "## Pre-deploy runtime proof of the rollback image (digest execution)"
PRE_VER=$(docker run --rm --platform linux/amd64 --entrypoint node "$ROLLBACK_IMAGE" \
  -e 'console.log(process.version)' 2>>"$LOG" || echo "DOCKER-FAILED")
say "rollback-image runtime: $PRE_VER"
case "$PRE_VER" in
  v20.*) say "-> Node major 20 confirmed pre-deploy. PASS" ;;
  *) say "FATAL: expected v20.x, got '$PRE_VER'. Wrong image or docker failure — aborting BEFORE any deploy."; exit 1 ;;
esac

# --- 3. deploy as a new revision, verify health + runtime ---------------------
say ""
say "## Deploy (creates a NEW revision — clock already sealed, see header)"
# BUILD_SHA env on the service template still carries the PR head; override it
# to the main head so the rollback revision's /health reports what it runs.
if ! gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --image "$ROLLBACK_IMAGE" --tag rollback-node20 \
    --update-env-vars "BUILD_SHA=$MAIN_SHA" 2>&1 | tee -a "$LOG"; then
  say "FATAL: deploy failed — service may still be serving $EXPECT_REV; check traffic before retrying."
  exit 1
fi
NEW_REV=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(status.latestCreatedRevisionName)')
say "new revision: $NEW_REV"

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

NEW_DIGEST=$(gcloud run revisions describe "$NEW_REV" --project "$PROJECT" --region "$REGION" \
  --format='value(status.imageDigest)')
say "new revision status.imageDigest: $NEW_DIGEST"
NEW_VER=$(docker run --rm --platform linux/amd64 --entrypoint node "$NEW_DIGEST" \
  -e 'console.log("rollback-digest runtime:", process.version)' 2>>"$LOG" || echo "DOCKER-FAILED")
say "$NEW_VER"
case "$NEW_VER" in
  *v20.*) say "-> deployed rollback revision executes Node 20 by digest. PASS" ;;
  *) say "!!! digest execution did not show v20.x — record as FAILED" ;;
esac

# --- 4. restore 100% traffic to the soaked revision ---------------------------
say ""
say "## Restore traffic to $EXPECT_REV"
gcloud run services update-traffic "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --to-revisions "$EXPECT_REV=100" 2>&1 | tee -a "$LOG"
sleep 5
CODE=$(curl -s --max-time 30 -o "$CLOSE_DIR/restore-health.json" -w '%{http_code} %{time_total}' \
  -H "X-Serverless-Authorization: Bearer $TOK" "$PR2291_URL/api/health") || CODE="000 -"
GS=$(jq -r '.git_sha // "?"' "$CLOSE_DIR/restore-health.json" 2>/dev/null || echo '?')
say "pr-2291 tag /api/health after restore: HTTP ${CODE}s git_sha=$GS"
[ "$GS" = "$HEAD_SHA" ] && say "-> $EXPECT_REV back at 100%, serving the PR head. PASS" \
  || say "!!! restore verification failed (git_sha=$GS, want $HEAD_SHA)"

# Same digest-execution method on the restored revision's image:
REST_VER=$(docker run --rm --platform linux/amd64 --entrypoint node "$AR_REPO@$NODE22_DIGEST" \
  -e 'console.log("restored-digest runtime:", process.version)' 2>>"$LOG" || echo "DOCKER-FAILED")
say "$REST_VER"
case "$REST_VER" in
  *v22.*) say "-> restored digest executes Node 22. PASS" ;;
  *) say "!!! restored-digest execution did not show v22.x" ;;
esac

say ""
say "---"
say "Rehearsal record: $LOG"
say "Fill 'Rollback rehearsed:' in the evidence block and the maturity template from this file."
say "Note for the record: rollback revision $NEW_REV remains on the service until teardown"
say "(teardown deletes the whole service; no cleanup needed here)."
