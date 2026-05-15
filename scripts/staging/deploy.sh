#!/usr/bin/env bash
# scripts/staging/deploy.sh — lease-enforced, tag-routed staging-worker deploys.
#
# SCRUM-1803 fix for the recurring deploy collisions on `arkova-worker-staging`
# (PR #742↔#743 on 2026-05-08, PR #742↔#755 on 2026-05-09 — the latter
# contaminated PR #742's 4h SOC 2 T2 soak ~12 minutes in).
#
# Each PR's soak gets its OWN tagged Cloud Run revision URL on the shared
# arkova-worker-staging service:
#
#   https://pr-742---arkova-worker-staging-270018525501.us-central1.run.app
#
# Multiple PRs can soak in parallel because each lives on its own tag URL.
# The main-traffic URL is unchanged unless `--promote` is passed. The lease
# check refuses to deploy without an active staging_lease row for the PR
# (override with `--force "<reason>"`, which logs an audit entry).
#
# Required env (matches the rest of scripts/staging/*):
#   STAGING_SUPABASE_URL
#   STAGING_SUPABASE_SERVICE_ROLE_KEY
#
# Usage:
#   ./scripts/staging/deploy.sh \
#       --pr 742 \
#       --image us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:scrum1794-8e0fe6d7
#
# Flags:
#   --pr <N>             REQUIRED. Lease must exist for this PR (or --force).
#   --image <REF>        REQUIRED. Full Artifact-Registry image reference.
#   --build-sha <SHA>    Optional. Sets BUILD_SHA env var on the revision.
#                        Defaults to `git rev-parse HEAD`. "unknown" if not in a repo.
#   --force "<reason>"   Bypass lease check. Reason must start with a Jira key,
#                        e.g. "SCRUM-1821: emergency repair". Logs forced=true.
#   --promote            After deploying the tag revision, route 100% of the main-URL
#                        traffic to it. Default: --no-traffic (tag URL only).
#   --promote-token <T>  Required with --promote. Prefer STAGING_PROMOTE_TOKEN
#                        sourced from Secret Manager over passing this in shell history.
#   --dry-run            Print what would happen, do nothing.
#   --help               Show this banner.
#
# Output (stdout): the tag URL the soak harness should hit, in the form
#   STAGING_API_BASE=https://pr-N---arkova-worker-staging-...run.app

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────
PROJECT="${STAGING_GCP_PROJECT:-arkova1}"
REGION="${STAGING_GCP_REGION:-us-central1}"
SERVICE="${STAGING_CLOUD_RUN_SERVICE:-arkova-worker-staging}"

# Hard production guard. The script lives in scripts/staging/ and only ever
# wants to talk to a staging Cloud Run service. Anything that doesn't end in
# "-staging" is refused even if explicitly passed via env. If a future second
# staging env (per SCRUM-1803 follow-ups) shows up, extend this check; do NOT
# remove it.
case "$SERVICE" in
  *-staging) ;;
  *)
    echo "ERROR: STAGING_CLOUD_RUN_SERVICE='$SERVICE' does not end in '-staging'." >&2
    echo "       This script is staging-only. Refusing to deploy." >&2
    exit 2
    ;;
esac

PR=""; IMAGE=""; BUILD_SHA=""; PROMOTE_TOKEN="${STAGING_PROMOTE_TOKEN:-}"
FORCE=0; FORCE_REASON=""
PROMOTE=0; DRY_RUN=0

# ─── Parse args ──────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)         PR="${2:?}"; shift 2 ;;
    --image)      IMAGE="${2:?}"; shift 2 ;;
    --build-sha)  BUILD_SHA="${2:?}"; shift 2 ;;
    --force)      FORCE=1; FORCE_REASON="${2:-}"; shift 2 ;;
    --promote)    PROMOTE=1; shift ;;
    --promote-token) PROMOTE_TOKEN="${2:?}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --help|-h)
      sed -n '2,40p' "$0"
      exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Run with --help for usage." >&2
      exit 2 ;;
  esac
done

[ -n "$PR" ]    || { echo "ERROR: --pr is required" >&2; exit 2; }
[ -n "$IMAGE" ] || { echo "ERROR: --image is required" >&2; exit 2; }

# Tag URLs require lowercase + hyphenated. PR numbers are numeric, so just prefix.
TAG="pr-${PR}"

# Numeric guard
case "$PR" in
  *[!0-9]*|"") echo "ERROR: --pr must be a numeric PR number, got: $PR" >&2; exit 2 ;;
esac

if [ $FORCE -eq 1 ] && [ -z "$FORCE_REASON" ]; then
  echo "ERROR: --force requires a non-empty reason: --force \"<reason>\"" >&2
  exit 2
fi

if [ $FORCE -eq 1 ] && [[ ! "$FORCE_REASON" =~ ^[A-Z][A-Z0-9]+-[0-9]+:.+ ]]; then
  echo "ERROR: --force reason must start with a Jira key and colon." >&2
  echo "       Example: --force \"SCRUM-1821: recover contaminated staging soak\"" >&2
  exit 2
fi

if [ -z "$BUILD_SHA" ]; then
  BUILD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
fi

OWNER="${USER:-unknown}@$(hostname -s 2>/dev/null || echo host)"

# ─── Helpers ─────────────────────────────────────────────────────────

# stderr-safe banner
info() { echo -e "[deploy.sh] $*" >&2; }

# Best-effort Slack post; never fails the deploy if Slack hiccups.
# CodeRabbit MAJOR (2026-05-09): use jq to escape user-supplied content
# (FORCE_REASON can contain quotes/newlines that break raw JSON building),
# and add curl timeouts so a stalled webhook can't hang the deploy.
post_slack() {
  local msg="$1"
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    jq -nc --arg text "$msg" '{text: $text}' \
      | curl -sS --connect-timeout 5 --max-time 15 \
        -X POST -H "Content-Type: application/json" \
        --data-binary @- "${SLACK_WEBHOOK_URL}" >/dev/null 2>&1 || true
  fi
}

require_env() {
  local var="$1"
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is required (export it or pull from gcloud secrets)." >&2
    exit 2
  fi
}

require_env STAGING_SUPABASE_URL
require_env STAGING_SUPABASE_SERVICE_ROLE_KEY

PG_REST="${STAGING_SUPABASE_URL}/rest/v1"
AUTH=( -H "apikey: ${STAGING_SUPABASE_SERVICE_ROLE_KEY}"
       -H "Authorization: Bearer ${STAGING_SUPABASE_SERVICE_ROLE_KEY}" )

check_lease() {
  local pr="$1"
  # Codex P1 + CodeRabbit CRITICAL (2026-05-09): the previous `body != "[]"`
  # check accepted ANY non-empty PostgREST response — including 401 / 403 /
  # 5xx error JSON — as a valid lease, defeating the whole point of this
  # wrapper. Now: require HTTP 200 AND a JSON array with at least one row.
  # On any other condition, return failure so deploy.sh refuses to proceed
  # (or audits the bypass via --force).
  local resp body code
  resp=$(curl -sS --connect-timeout 5 --max-time 15 \
    -w $'\n__HTTP__%{http_code}' \
    "${AUTH[@]}" \
    "${PG_REST}/staging_lease?pr_number=eq.${pr}&select=pr_number,acquired_by,acquired_at" \
    2>/dev/null) || return 1
  body="${resp%$'\n'__HTTP__*}"
  code="${resp##*__HTTP__}"
  if [ "$code" != "200" ]; then
    info "WARN: lease lookup returned HTTP $code — treating as no lease."
    return 1
  fi
  if ! jq -e 'type == "array" and length > 0' >/dev/null 2>&1 <<<"$body"; then
    return 1
  fi
  echo "$body"
  return 0
}

record_deploy() {
  # Calls the public.record_staging_deploy RPC (added by
  # staging_only_deploy_log_and_lease_pk migration). On success, prints
  # `Staging deploy log id: <N>` so operators can paste it into the PR's
  # `## Staging Soak Evidence` block (required by check-staging-evidence
  # for T2/T3 tiers). If the migration isn't applied, warn and continue —
  # the deploy itself is still recorded in Cloud Run revision history.
  #
  # CodeRabbit MAJOR (2026-05-09): the previous version captured only the
  # HTTP code and discarded the response body, so the row id was unreachable.
  local revision="$1" lease_ok="$2"
  local payload
  payload=$(jq -n \
    --argjson pr "$PR" \
    --arg image "$IMAGE" \
    --arg sha "$BUILD_SHA" \
    --arg rev "$revision" \
    --arg tag "$TAG" \
    --argjson promoted "$([ $PROMOTE -eq 1 ] && echo true || echo false)" \
    --arg owner "$OWNER" \
    --argjson forced "$([ $FORCE -eq 1 ] && echo true || echo false)" \
    --arg reason "$FORCE_REASON" \
    --argjson lease_ok "$lease_ok" \
    '{p_pr_number: $pr, p_image: $image, p_build_sha: $sha,
      p_revision_name: $rev, p_tag: $tag, p_promoted: $promoted,
      p_deployed_by: $owner, p_forced: $forced,
      p_force_reason: (if $reason == "" then null else $reason end),
      p_lease_ok: $lease_ok}')

  local resp body code deploy_log_id
  resp=$(curl -sS --connect-timeout 5 --max-time 15 \
    -w $'\n__HTTP__%{http_code}' \
    -X POST "${PG_REST}/rpc/record_staging_deploy" \
    "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null) || true

  body="${resp%$'\n'__HTTP__*}"
  code="${resp##*__HTTP__}"

  if [ "$code" != "200" ] && [ "$code" != "201" ]; then
    info "WARN: staging_deploy_log RPC returned HTTP $code — audit row NOT written."
    info "      Apply scripts/staging/migrations/staging_only_deploy_log_and_lease_pk.sql"
    info "      via Supabase MCP to enable audit. Continuing with deploy."
    return 0
  fi

  # PostgREST returns the scalar bigint either as a bare number `42` or
  # wrapped in a one-row array `[{"record_staging_deploy":42}]` depending
  # on the Accept header. Cover both so we always pull the id when present.
  deploy_log_id=$(jq -r '
    if type == "number" then tostring
    elif type == "array" and length > 0 then
      (.[0] | if type == "number" then tostring else (to_entries[0].value | tostring) end)
    else "" end' <<<"$body" 2>/dev/null)

  if [ -n "$deploy_log_id" ] && [ "$deploy_log_id" != "null" ]; then
    info "staging_deploy_log id: $deploy_log_id"
    # Echo a machine-parseable line on stdout so the soak harness/operator
    # can grep it for the PR evidence block.
    echo "STAGING_DEPLOY_LOG_ID=$deploy_log_id"
  fi
}

require_promote_authorization() {
  if [ $PROMOTE -eq 0 ]; then
    return 0
  fi

  if [ -z "$PROMOTE_TOKEN" ]; then
    echo "ERROR: --promote requires STAGING_PROMOTE_TOKEN or --promote-token." >&2
    echo "       Pull the per-day token from Secret Manager before promoting." >&2
    exit 2
  fi

  local expected
  expected="${STAGING_PROMOTE_EXPECTED_TOKEN:-}"
  if [ -z "$expected" ]; then
    local secret_name="${STAGING_PROMOTE_SECRET:-staging-promote-token}"
    expected=$(gcloud secrets versions access latest \
      --secret="$secret_name" \
      --project="$PROJECT" 2>/dev/null || true)
  fi

  if [ -z "$expected" ]; then
    echo "ERROR: could not read expected staging promote token from Secret Manager." >&2
    echo "       Set STAGING_PROMOTE_SECRET or STAGING_PROMOTE_EXPECTED_TOKEN for tests." >&2
    exit 2
  fi

  if [ "$PROMOTE_TOKEN" != "$expected" ]; then
    echo "ERROR: STAGING_PROMOTE_TOKEN does not match the current per-day promote token." >&2
    exit 2
  fi
}

check_image_exists() {
  info "checking Artifact Registry image exists..."
  if ! gcloud artifacts docker images describe "$IMAGE" \
    --project="$PROJECT" \
    --format="value(image_summary.fully_qualified_digest)" >/dev/null 2>&1; then
    echo "ERROR: image does not exist or is not readable: $IMAGE" >&2
    echo "       Build/push the worker image before running the staging deploy wrapper." >&2
    exit 1
  fi
}

check_recent_revision_collision() {
  local now window revisions traffic conflicts
  now="${STAGING_DEPLOY_NOW_EPOCH:-$(date -u +%s)}"
  window="${STAGING_DEPLOY_COLLISION_WINDOW_SECONDS:-300}"

  if ! revisions=$(gcloud run revisions list \
    --service="$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT" \
    --sort-by="~metadata.creationTimestamp" \
    --limit=10 \
    --format=json 2>/dev/null); then
    echo "ERROR: could not inspect recent Cloud Run revisions for $SERVICE." >&2
    echo "       Refusing to deploy because collision detection could not run." >&2
    exit 1
  fi

  traffic=$(gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT" \
    --format=json\(status.traffic\) 2>/dev/null || true)
  if [ -z "$traffic" ]; then
    traffic='{}'
  fi

  conflicts=$(jq -nr \
    --arg pr "$PR" \
    --argjson now "$now" \
    --argjson window "$window" \
    --argjson revisions "$revisions" \
    --argjson traffic "$traffic" '
    def epoch:
      if type == "string" then (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601?)
      else null end;
    def tag_pr:
      if type == "string" and test("^pr-[0-9]+$") then sub("^pr-"; "")
      else null end;
    ($traffic.status.traffic // []
      | map(select(.revisionName != null and .tag != null) | { key: .revisionName, value: (.tag | tag_pr) })
      | from_entries) as $pr_by_revision
    |
    [
      $revisions[]?
      | .metadata as $m
      | ($m.creationTimestamp | epoch) as $created
      | ($m.labels.pr // $pr_by_revision[$m.name] // "unlabeled") as $revision_pr
      | select($created != null)
      | select(($now - $created) >= 0 and ($now - $created) <= $window)
      | select($revision_pr != $pr)
      | "recent Cloud Run revision \($m.name // "unknown") from PR #\($revision_pr) is \($now - $created | floor)s old"
    ] | .[]')

  if [ -n "$conflicts" ]; then
    echo "ERROR: refusing staging deploy because another lease holder deployed recently:" >&2
    echo "$conflicts" | sed 's/^/  - /' >&2
    echo "       Wait for the 5-minute collision window to pass or coordinate in #eng-staging." >&2
    exit 1
  fi
}

# ─── 1. Lease check ──────────────────────────────────────────────────
LEASE_OK=true
if LEASE_BODY=$(check_lease "$PR"); then
  info "lease present for PR #$PR: $LEASE_BODY"
else
  LEASE_OK=false
  if [ $FORCE -eq 1 ]; then
    info "WARN: deploying WITHOUT lease (--force \"$FORCE_REASON\")."
    info "      An audit row will be written to staging_deploy_log."
  else
    cat >&2 <<EOF
ERROR: no staging_lease row for PR #$PR.

Acquire one first:
  ./scripts/staging/claim.sh acquire $PR "<short reason>"

Or, if you have explicit human authorization to bypass (e.g. fixing a
contaminated soak from a different session), re-run with:
  ./scripts/staging/deploy.sh ... --force "<why bypass is justified>"

Force is logged to staging_deploy_log for audit.
EOF
    exit 1
  fi
fi

require_promote_authorization

# ─── 2. Pre-deploy banner ────────────────────────────────────────────
info "------------------------------------------------------------"
info "  service:   $SERVICE  (project=$PROJECT  region=$REGION)"
info "  PR:        #$PR"
info "  tag:       $TAG"
info "  image:     $IMAGE"
info "  build_sha: $BUILD_SHA"
info "  promote:   $([ $PROMOTE -eq 1 ] && echo "YES (will route main-URL traffic)" || echo "no (tag URL only)")"
info "  forced:    $([ $FORCE -eq 1 ] && echo "YES — $FORCE_REASON" || echo "no")"
info "  by:        $OWNER"
info "------------------------------------------------------------"

if [ $DRY_RUN -eq 1 ]; then
  info "DRY RUN — not deploying."
  exit 0
fi

check_image_exists
check_recent_revision_collision

# ─── 3. Deploy with tag, no traffic shift by default ─────────────────
GCLOUD_FLAGS=(
  --image="$IMAGE"
  --tag="$TAG"
  --update-env-vars=BUILD_SHA="$BUILD_SHA"
  --update-labels=pr="$PR",deployed-by-script=deploy-sh,scrum1803=enforced
  --region="$REGION"
  --project="$PROJECT"
  --quiet
)

if [ $PROMOTE -eq 1 ]; then
  # gcloud's default behavior on `services update --tag` without
  # `--no-traffic` will shift traffic to the new revision. Keep that.
  :
else
  GCLOUD_FLAGS+=( --no-traffic )
fi

info "deploying..."
gcloud run services update "$SERVICE" "${GCLOUD_FLAGS[@]}" >&2

# ─── 4. Resolve tag URL for the soak harness ─────────────────────────
# Cloud Run exposes per-tag URLs at `<tag>---<service-host>`. We compute it
# from the service's main URL rather than parsing the traffic stanza, because
# `gcloud run services describe --format="value(status.traffic.url)"`
# returns a list whose order is not stable. The host transform is documented
# Cloud Run behavior (see https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration#tags).
RAW_URL=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" --project="$PROJECT" \
  --format="value(status.url)")

if [ -z "$RAW_URL" ]; then
  info "ERROR: could not read $SERVICE main URL — gcloud describe failed."
  exit 1
fi
# RAW_URL: https://<service>-<projectnum>.<region>.run.app
# TAG_URL: https://<tag>---<service>-<projectnum>.<region>.run.app
TAG_URL="${RAW_URL/https:\/\//https://${TAG}---}"

# Resolve the new revision name for the audit row
REVISION_NAME=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" --project="$PROJECT" \
  --format="value(status.latestCreatedRevisionName)")

info "deployed revision: $REVISION_NAME"
info "tag URL:           $TAG_URL"

# ─── 5. Audit log ────────────────────────────────────────────────────
record_deploy "$REVISION_NAME" "$LEASE_OK"

# ─── 6. Slack notify (force/promote always; routine deploys silent) ──
# Routine tag-only deploys are noisy, so we don't Slack them. Force and
# promote both cross safety boundaries (lease bypass, main-URL traffic
# shift) and SHOULD ping #eng-staging so a human notices in-band.
if [ $FORCE -eq 1 ]; then
  post_slack ":rotating_light: *FORCE DEPLOY* to ${SERVICE} by ${OWNER} for PR #${PR} — reason: ${FORCE_REASON} — image \`${IMAGE}\` rev \`${REVISION_NAME}\`. Audit row in \`staging_deploy_log\`."
fi
if [ $PROMOTE -eq 1 ]; then
  post_slack ":arrow_forward: *PROMOTE* on ${SERVICE} by ${OWNER}: PR #${PR} tag \`${TAG}\` revision \`${REVISION_NAME}\` is now serving 100% of main-URL traffic."
fi

# ─── 7. Print one machine-parseable line for the soak harness ────────
echo "STAGING_API_BASE=$TAG_URL"
