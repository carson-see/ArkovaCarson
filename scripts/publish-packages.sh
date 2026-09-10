#!/usr/bin/env bash
#
# Publish @arkova/embed to npm (INT-03).
#
# SCOPE: embed ONLY. `arkova` (packages/sdk) used to be published from here
# too, and must not be again — this script's path for it was strictly weaker
# than scripts/release/publish-npm.sh, which additionally checks `npm whoami`
# before doing anything, skips a version already live on the registry instead
# of failing on npm's "cannot publish over previously published version", and
# covers sdks/mcp-server in the same pass. Two publish paths for one package
# means the weaker one eventually gets used; the second one is now removed
# rather than documented-against. `--only=sdk` exits 2 with the redirect.
#
# @arkova/embed still targets the `arkova` npm SCOPE. The 2026-08-18 CTO
# ruling that made the TS SDK unscoped (parity with the PyPI package, which
# already publishes unscoped as `arkova`, superseding the 2026-08-01
# `@carsonarkova/sdk` attempt) was scoped to the TS SDK only and was NOT
# extended to embed. See packages/sdk/agents.md for that history.
#
# Prerequisites:
#   1. The `arkova` npm scope must exist and you need owner/maintainer
#      permissions on it. If not: `npm org create arkova` (as the scope
#      owner).
#   2. NPM_TOKEN exported with publish permission on that scope, or
#      `npm login` interactively before running this script.
#   3. First publish of a SCOPED package requires --access public (passed
#      unconditionally below).
#
# Usage:
#   scripts/publish-packages.sh               # live publish (@arkova/embed)
#   scripts/publish-packages.sh --dry-run     # prepare, pack, skip upload
#   scripts/publish-packages.sh --only=embed  # explicit; same as no --only
#
# IMPORTANT: npm publishes are effectively irreversible within 72 hours
# for scoped packages. This script prints the tarball contents and asks
# for confirmation unless --dry-run or NON_INTERACTIVE=1 is set.

set -euo pipefail

DRY_RUN=0
ONLY=""
usage() {
  echo "Usage: $0 [--dry-run] [--only=embed]" >&2
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    *) echo "Unknown flag: $arg" >&2; usage; exit 1 ;;
  esac
done

case "$ONLY" in
  sdk)
    echo "ERROR: this script no longer publishes packages/sdk (the npm package 'arkova')." >&2
    echo "       use scripts/release/publish-npm.sh --only=sdk" >&2
    exit 2
    ;;
  ""|embed) ;;
  *)
    echo "Unknown --only target: $ONLY" >&2
    usage
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

publish_one() {
  local pkg_name="$1"
  local pkg_dir="$2"

  if [[ -n "$ONLY" && "$ONLY" != "$pkg_name" ]]; then
    echo "== Skipping $pkg_name (--only=$ONLY)"
    return 0
  fi

  echo "== Preparing $pkg_name ($pkg_dir)"
  cd "$pkg_dir"

  npm ci --ignore-scripts --silent
  if [[ -f package.json && $(node -p "require('./package.json').scripts?.build || ''") ]]; then
    npm run build
  fi
  if [[ -f package.json && $(node -p "require('./package.json').scripts?.test || ''") ]]; then
    npm test
  fi

  echo "-- Packing $pkg_name to inspect tarball contents"
  npm pack --dry-run

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "-- DRY RUN: skipping npm publish for $pkg_name"
    return 0
  fi

  if [[ -z "${NON_INTERACTIVE:-}" ]]; then
    read -r -p "Publish $pkg_name to npm? [y/N] " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo "-- Aborted $pkg_name"
      return 0
    fi
  fi

  # First publish of scoped packages needs --access public
  echo "-- npm publish --access public"
  npm publish --access public
}

publish_one "embed" "$REPO_ROOT/packages/embed"

echo "== Done."
