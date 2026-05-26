#!/usr/bin/env bash
# Fail-fast local workspace guard for Arkova agents/operators.

set -euo pipefail

WORKSPACE_ROOT="${ARKOVA_WORKSPACE_ROOT:-/Volumes/Extreme/Arkova}"
CANONICAL_REPO="${ARKOVA_CANONICAL_REPO:-${WORKSPACE_ROOT}/arkova-mvpcopy-main}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARNING: $*" >&2
}

canonical_physical=$(cd "$CANONICAL_REPO" 2>/dev/null && pwd -P) \
  || die "canonical repo not found at ${CANONICAL_REPO}"
workspace_physical=$(cd "$WORKSPACE_ROOT" 2>/dev/null && pwd -P) \
  || die "workspace root not found at ${WORKSPACE_ROOT}"
cwd_physical=$(pwd -P)

if [[ "$cwd_physical" == "$workspace_physical" ]]; then
  die "${WORKSPACE_ROOT} is a workspace container, not the Arkova git repo. cd ${CANONICAL_REPO}"
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then
  die "not inside an Arkova git checkout. cd ${CANONICAL_REPO}"
fi
repo_root=$(cd "$repo_root" && pwd -P)

if [[ "$repo_root" != "$canonical_physical" ]]; then
  # Approved worktree patterns — one per line for readability.
  case "$repo_root" in
    "$workspace_physical"/worktrees/* | \
    "$workspace_physical"/arkova-docusign-cors | \
    /Users/carson/.config/superpowers/worktrees/arkova-mvpcopy-main/*)
      if [[ "${ARKOVA_ALLOW_WORKTREE:-}" != "1" ]]; then
        die "currently in non-canonical worktree ${repo_root}. Re-run with ARKOVA_ALLOW_WORKTREE=1 only when this exact worktree is intentional."
      fi
      warn "using explicit non-canonical worktree: ${repo_root}"
      ;;
    *)
      die "repo root ${repo_root} is not the canonical checkout or an approved Arkova worktree"
      ;;
  esac
fi

# Accept HTTPS (with or without .git suffix) and SSH origin URLs for the same repo.
remote=$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)
case "$remote" in
  https://github.com/carson-see/ArkovaCarson.git | \
  https://github.com/carson-see/ArkovaCarson | \
  git@github.com:carson-see/ArkovaCarson.git | \
  git@github.com:carson-see/ArkovaCarson)
    ;; # valid origin
  *)
    die "unexpected origin remote for ${repo_root}: ${remote:-<none>}"
    ;;
esac

branch=$(git -C "$repo_root" branch --show-current 2>/dev/null || true)
if [[ -z "$branch" ]]; then
  branch="(detached)"
fi
head=$(git -C "$repo_root" rev-parse --short HEAD)
dirty_count=$(git -C "$repo_root" status --short | wc -l | tr -d ' ')

echo "Arkova workspace preflight OK"
echo "repo_root=${repo_root}"
echo "branch=${branch}"
echo "head=${head}"
echo "dirty_paths=${dirty_count}"
echo "origin=${remote}"

if [[ "$repo_root" == "$canonical_physical" && "$branch" != "main" ]]; then
  warn "canonical checkout is not on main; confirm this branch is intentional before changing code"
fi

if [[ -e "${workspace_physical}/supabase/.temp/linked-project.json" ]]; then
  warn "root-level ${WORKSPACE_ROOT}/supabase/.temp exists outside the repo; do not run Supabase commands from ${WORKSPACE_ROOT}"
fi

if [[ -d "${workspace_physical}/src" || -d "${workspace_physical}/services" ]]; then
  warn "root-level src/services directories exist outside the repo; do not treat ${WORKSPACE_ROOT} as a checkout"
fi
