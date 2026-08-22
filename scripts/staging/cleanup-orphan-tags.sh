#!/usr/bin/env bash
# Remove stale Cloud Run traffic tags from a staging service.
#
# A tagged revision stays REFERENCED by the service, and a referenced revision
# with min-instances >= 1 keeps a warm instance running in-process node-cron.
# That is BUG-2026-08-22-001: eight retired-but-tagged revisions on
# arkova-worker-staging were each running the GDPR retention cron against the
# live rig database. Untagging is what stops it.
#
# `pr-<N>` tags age out on their PR's close date; every other tag (named train
# and soak tags) ages out on its revision's creationTimestamp. A revision that
# is serving traffic is never untagged, at any age.
#
# Intended Cloud Scheduler target: run this script from a small authenticated
# maintenance job with gcloud + gh credentials. Dry-run is the default.

set -euo pipefail

PROJECT="${STAGING_GCP_PROJECT:-arkova1}"
REGION="${STAGING_GCP_REGION:-us-central1}"
SERVICE="${STAGING_CLOUD_RUN_SERVICE:-arkova-worker-staging}"
REPO="${GITHUB_REPOSITORY:-carson-see/ArkovaCarson}"
OLDER_THAN_DAYS="${STAGING_ORPHAN_TAG_DAYS:-7}"
DRY_RUN=1

usage() {
  sed -n '2,12p' "$0"
  echo
  echo "Usage: $0 [--dry-run|--apply] [--older-than-days N] [--repo owner/name]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --apply) DRY_RUN=0; shift ;;
    --older-than-days) OLDER_THAN_DAYS="${2:?}"; shift 2 ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$SERVICE" in
  *-staging) ;;
  *)
    echo "ERROR: STAGING_CLOUD_RUN_SERVICE='$SERVICE' does not end in '-staging'." >&2
    exit 2
    ;;
esac

case "$OLDER_THAN_DAYS" in
  *[!0-9]*|"") echo "ERROR: --older-than-days must be numeric" >&2; exit 2 ;;
  *) ;;
esac

NOW_EPOCH="${STAGING_JANITOR_NOW_EPOCH:-$(date -u +%s)}"
THRESHOLD_SECONDS=$((OLDER_THAN_DAYS * 24 * 60 * 60))

info() { echo "[cleanup-orphan-tags] $*" >&2; }

AUTH_GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/ops/gcloud-auth-preflight.sh"
if [[ -f "$AUTH_GUARD" ]]; then
  # shellcheck source=scripts/ops/gcloud-auth-preflight.sh
  source "$AUTH_GUARD"
  arkova_require_enterprise_gcloud_auth "staging tag cleanup" "gcloud"
fi

closed_epoch_for_pr() {
  local pr="$1" pr_json
  if ! pr_json=$(gh api "repos/${REPO}/pulls/${pr}" 2>/dev/null); then
    info "WARN: could not read PR #${pr}; keeping tag pr-${pr}."
    return 1
  fi

  jq -r '
    if .state != "closed" then empty
    else ((.merged_at // .closed_at // empty) | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)
    end
  ' <<<"$pr_json"
}

traffic_json=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --format=json)

# Revision creation times, for tags that have no PR to ask about.
revisions_json=$(gcloud run revisions list \
  --service="$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --format=json)

created_epoch_for_revision() {
  local revision="$1"
  jq -r --arg rev "$revision" '
    .[]? | select(.metadata.name == $rev)
    | (.metadata.creationTimestamp // empty)
    | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601
  ' <<<"$revisions_json"
}

# EVERY tag, not just `pr-<N>`.
#
# BUG-2026-08-22-001: this selector was `^pr-[0-9]+$`. Eight retired-but-tagged
# revisions on arkova-worker-staging were holding warm instances running
# in-process node-cron against the LIVE rig database, and two of them
# (`train-c-ce`, `train-c-1154-cfaee18e`) were outside that pattern — so the
# janitor reported "cleanup handled" while leaving the contaminating pair in
# place. A tag keeps a revision referenced by the service, and a referenced
# revision with min-instances >= 1 keeps an instance warm, whatever the tag is
# named. The namespace of tags is not the namespace of PR numbers.
#
# `percent` is carried through so a revision actually serving traffic is never
# untagged out from under itself.
tags=$(jq -r '
  .status.traffic[]?
  | select((.tag // "") != "")
  | [.tag, (.revisionName // ""), ((.percent // 0) | tostring)] | @tsv
' <<<"$traffic_json")

if [[ -z "$tags" ]]; then
  info "No traffic tags found on $SERVICE."
  exit 0
fi

removed=0
while IFS=$'\t' read -r tag revision percent; do
  [[ -n "$tag" ]] || continue

  # Never pull a tag off a revision that is serving. Age is irrelevant here:
  # an in-flight soak's tag URL is live evidence, and removing it would break
  # the running window.
  if [[ "${percent:-0}" != "0" ]]; then
    info "keeping $tag; revision $revision is serving ${percent}% of traffic."
    continue
  fi

  if [[ "$tag" =~ ^pr-[0-9]+$ ]]; then
    pr="${tag#pr-}"
    closed_epoch=$(closed_epoch_for_pr "$pr" || true)
    if [[ -z "$closed_epoch" ]]; then
      info "keeping $tag; PR #$pr is open or close time is unavailable."
      continue
    fi

    age=$((NOW_EPOCH - closed_epoch))
    if [[ "$age" -lt "$THRESHOLD_SECONDS" ]]; then
      info "keeping $tag; PR #$pr closed less than ${OLDER_THAN_DAYS}d ago."
      continue
    fi
    reason="PR #$pr closed $((age / 86400))d ago"
  else
    # No PR to consult (named train/soak tags: `train-c-ce`, `train-6`, …).
    # Age out on the revision's own creation time instead. Conservative: an
    # unreadable timestamp keeps the tag.
    created_epoch=$(created_epoch_for_revision "$revision" || true)
    if [[ -z "$created_epoch" ]]; then
      info "keeping $tag; no creationTimestamp for revision $revision."
      continue
    fi

    age=$((NOW_EPOCH - created_epoch))
    if [[ "$age" -lt "$THRESHOLD_SECONDS" ]]; then
      info "keeping $tag; revision $revision is less than ${OLDER_THAN_DAYS}d old."
      continue
    fi
    reason="revision created $((age / 86400))d ago"
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "would remove tag $tag ($reason; revision $revision)"
  else
    gcloud run services update-traffic "$SERVICE" \
      --remove-tags="$tag" \
      --region="$REGION" \
      --project="$PROJECT" \
      --quiet
    echo "removed tag $tag ($reason; revision $revision)"
  fi
  removed=$((removed + 1))
done <<<"$tags"

info "candidate tags processed: $removed"
