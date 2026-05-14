#!/usr/bin/env bash
# Remove stale Cloud Run traffic tags for PRs that have been closed for >7 days.
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
  sed -n '2,28p' "$0"
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

tags=$(jq -r '
  .status.traffic[]?
  | select((.tag // "") | test("^pr-[0-9]+$"))
  | [.tag, (.revisionName // "")] | @tsv
' <<<"$traffic_json")

if [[ -z "$tags" ]]; then
  info "No pr-* traffic tags found on $SERVICE."
  exit 0
fi

removed=0
while IFS=$'\t' read -r tag revision; do
  [[ -n "$tag" ]] || continue
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

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "would remove tag $tag (PR #$pr closed $((age / 86400))d ago; revision $revision)"
  else
    gcloud run services update-traffic "$SERVICE" \
      --remove-tags="$tag" \
      --region="$REGION" \
      --project="$PROJECT" \
      --quiet
    echo "removed tag $tag (PR #$pr closed $((age / 86400))d ago; revision $revision)"
  fi
  removed=$((removed + 1))
done <<<"$tags"

info "candidate tags processed: $removed"
