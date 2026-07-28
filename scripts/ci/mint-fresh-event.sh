#!/usr/bin/env bash
# scripts/ci/mint-fresh-event.sh — SCRUM-3026 sanctioned re-trigger helper.
#
# Root cause: `github.sha` and `github.event.pull_request.*` in a GitHub
# Actions `pull_request` job are FROZEN at the moment the triggering webhook
# event was delivered. Re-checking a PR via the GitHub UI "Re-run jobs",
# `gh run rerun`, a branch-protection re-request, or a Mergify re-check that
# does not create a brand-new webhook delivery, replays that frozen snapshot
# untouched — a PR body edit made afterward, or a base that has moved because
# other PRs merged in the same wave, is invisible to the rerun. This voided
# RC-manifest base coverage during the 2026-07-27 10-PR wave and hid
# post-event body edits from the Staging Soak Evidence Gate.
#
# `.github/workflows/staging-evidence.yml` now resolves PR state LIVE via
# `gh api` at job-run time, which closes most of the gap. But the only way to
# get GitHub to deliver a genuinely FRESH `pull_request` webhook event (with a
# fresh `github.sha` merge-preview ref) is a new `synchronize` (a push that
# moves the branch tip), or an explicit `edited`/`labeled`/`unlabeled` event.
# This script mints a `synchronize` by pushing a TREE-IDENTICAL empty commit
# — it never touches source, never force-pushes, and never rewrites history.
# Optionally (--bump-head-sha) it also fires an `edited` event by updating the
# `PR head SHA:` line in the PR body to the new commit via `gh pr edit`, per
# memory/feedback_pr_head_sha_in_evidence_block.md ("a new commit invalidates
# the body's PR head SHA; bump via `gh pr edit`").
#
# Usage:
#   scripts/ci/mint-fresh-event.sh --pr <number> [--bump-head-sha] [--dry-run]
#                                  [--message <text>] [--repo <owner/repo>]
#
# Examples:
#   scripts/ci/mint-fresh-event.sh --pr 1722 --dry-run
#   scripts/ci/mint-fresh-event.sh --pr 1722 --bump-head-sha
#
# Requires: git, gh (authenticated), jq. Must be run from a clean worktree
# checked out on the PR's own branch (refuses to run otherwise — this is a
# re-trigger tool, not a way to smuggle unrelated changes into the diff).
#
# Exit codes: 0 success, 2 usage error, 1 precondition/runtime failure.
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<'EOF'
Usage: scripts/ci/mint-fresh-event.sh --pr <number> [options]

Mints a fresh GitHub PR event (tree-identical empty commit + push) so
event-driven CI gates (e.g. the Staging Soak Evidence Gate) re-evaluate the
PR's CURRENT head, base, labels, and body instead of replaying a stale
`gh run rerun` snapshot of the frozen triggering event.

Options:
  --pr <number>        Required. The PR number to re-trigger.
  --bump-head-sha       After pushing, update the `PR head SHA:` line in the
                        PR body (via `gh pr edit`) to the new HEAD commit.
                        No-op with a warning if the body has no such line —
                        this script never injects evidence-block structure.
  --message <text>      Custom empty-commit message. Defaults to a
                        SCRUM-3026-tagged message.
  --repo <owner/repo>   Target repo for `gh` calls. Defaults to the repo
                        `gh` auto-detects from the current directory.
  --dry-run             Print what would happen; makes no commit, push, or
                        PR edit. Still validates preconditions.
  -h, --help             Show this help text.

Exit codes: 0 success, 2 usage error, 1 precondition/runtime failure.
EOF
}

PR_NUMBER=""
BUMP_HEAD_SHA="false"
DRY_RUN="false"
REPO_ARG=()
COMMIT_MESSAGE="chore(ci): mint fresh PR event — re-trigger checks (SCRUM-3026, scripts/ci/mint-fresh-event.sh)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      PR_NUMBER="${2:-}"
      shift 2
      ;;
    --bump-head-sha)
      BUMP_HEAD_SHA="true"
      shift
      ;;
    --message)
      COMMIT_MESSAGE="${2:-}"
      shift 2
      ;;
    --repo)
      REPO_ARG=(-R "${2:-}")
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: ${SCRIPT_NAME}: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${PR_NUMBER}" ]]; then
  echo "ERROR: ${SCRIPT_NAME}: --pr <number> is required." >&2
  usage >&2
  exit 2
fi
if [[ ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: ${SCRIPT_NAME}: --pr requires a numeric PR number; got '${PR_NUMBER}'." >&2
  exit 2
fi

for bin in git gh jq; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "ERROR: ${SCRIPT_NAME}: required binary '${bin}' not found on PATH." >&2
    exit 1
  fi
done

# Refuse a dirty worktree. --allow-empty ignores staged/unstaged changes
# anyway, but a dirty tree here almost always means the operator meant to
# commit real work, not just mint a re-trigger event — fail loud instead of
# silently discarding that intent from the empty commit.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: ${SCRIPT_NAME}: working tree is not clean. Commit or stash first — this script only pushes a tree-identical empty commit, never your pending changes." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${CURRENT_BRANCH}" == "HEAD" ]]; then
  echo "ERROR: ${SCRIPT_NAME}: detached HEAD — check out the PR's branch first." >&2
  exit 1
fi

PR_JSON="$(gh pr view "${PR_NUMBER}" "${REPO_ARG[@]+"${REPO_ARG[@]}"}" --json number,headRefName,baseRefName,state,body,url)"
PR_HEAD_REF="$(jq -r '.headRefName' <<<"${PR_JSON}")"
PR_STATE="$(jq -r '.state' <<<"${PR_JSON}")"
PR_URL="$(jq -r '.url' <<<"${PR_JSON}")"

if [[ "${CURRENT_BRANCH}" != "${PR_HEAD_REF}" ]]; then
  echo "ERROR: ${SCRIPT_NAME}: current branch '${CURRENT_BRANCH}' does not match PR #${PR_NUMBER}'s head branch '${PR_HEAD_REF}'. Check out the PR's own branch before minting an event for it." >&2
  exit 1
fi

if [[ "${PR_STATE}" != "OPEN" ]]; then
  echo "ERROR: ${SCRIPT_NAME}: PR #${PR_NUMBER} is not OPEN (state=${PR_STATE}). Refusing to push to a closed/merged PR's branch." >&2
  exit 1
fi

echo "PR #${PR_NUMBER} (${PR_URL}) — branch '${PR_HEAD_REF}', state ${PR_STATE}."

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dry-run] Would create an empty commit: \"${COMMIT_MESSAGE}\""
  echo "[dry-run] Would push '${CURRENT_BRANCH}' to origin (fires a fresh 'synchronize' event)."
  if [[ "${BUMP_HEAD_SHA}" == "true" ]]; then
    CURRENT_BODY_DRY_RUN="$(jq -r '.body // ""' <<<"${PR_JSON}")"
    if grep -qE '^[[:space:]]*[-*]?[[:space:]]*(\*\*|\*|_)?PR head SHA(\*\*|\*|_)?:' <<<"${CURRENT_BODY_DRY_RUN}"; then
      echo "[dry-run] Would update the 'PR head SHA:' line in the PR body to the new HEAD commit (fires a fresh 'edited' event)."
    else
      echo "[dry-run] --bump-head-sha requested, but no 'PR head SHA:' line found in the current body — would skip the body edit."
    fi
  fi
  exit 0
fi

git commit --allow-empty -m "${COMMIT_MESSAGE}"
NEW_SHA="$(git rev-parse HEAD)"
git push origin "HEAD:${CURRENT_BRANCH}"
echo "Pushed tree-identical empty commit ${NEW_SHA} to '${CURRENT_BRANCH}' — a fresh 'synchronize' event is on its way to GitHub."

if [[ "${BUMP_HEAD_SHA}" == "true" ]]; then
  CURRENT_BODY="$(gh pr view "${PR_NUMBER}" "${REPO_ARG[@]+"${REPO_ARG[@]}"}" --json body -q .body)"
  HEAD_SHA_LINE_RE='^[[:space:]]*[-*]?[[:space:]]*(\*\*|\*|_)?PR head SHA(\*\*|\*|_)?:'
  if ! grep -qE "${HEAD_SHA_LINE_RE}" <<<"${CURRENT_BODY}"; then
    echo "WARNING: ${SCRIPT_NAME}: no 'PR head SHA:' line found in the PR body — skipping the body edit. Add the field manually if the evidence block needs it." >&2
  else
    UPDATED_BODY="$(perl -pe "s/(^[ \\t]*[-*]?[ \\t]*(?:\\*\\*|\\*|_)?PR head SHA(?:\\*\\*|\\*|_)?:)[^\\n]*/\\1 ${NEW_SHA}/" <<<"${CURRENT_BODY}")"
    if [[ "${UPDATED_BODY}" == "${CURRENT_BODY}" ]]; then
      echo "WARNING: ${SCRIPT_NAME}: 'PR head SHA:' line matched but body was unchanged after substitution — leaving the body as-is." >&2
    else
      printf '%s' "${UPDATED_BODY}" | gh pr edit "${PR_NUMBER}" "${REPO_ARG[@]+"${REPO_ARG[@]}"}" --body-file -
      echo "Updated the 'PR head SHA:' line in the PR body to ${NEW_SHA} — a fresh 'edited' event is on its way to GitHub."
    fi
  fi
fi

echo "Done. CI gates on PR #${PR_NUMBER} will re-run against current PR state."
