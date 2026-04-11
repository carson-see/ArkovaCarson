#!/usr/bin/env bash
#
# Publish @arkova/sdk and @arkova/embed to npm (INT-01 / INT-03).
#
# Prerequisites:
#   1. `@arkova` npm scope exists and you have owner/maintainer permissions.
#      If not: `npm org create arkova` (as the scope owner).
#   2. NPM_TOKEN exported with publish permission for @arkova scope.
#      Or: `npm login` interactively before running this script.
#   3. First publish of a scoped package requires --access public.
#
# Usage:
#   scripts/publish-packages.sh               # live publish
#   scripts/publish-packages.sh --dry-run     # prepare, pack, skip upload
#   scripts/publish-packages.sh --only=sdk    # publish only one package
#   scripts/publish-packages.sh --only=embed
#
# IMPORTANT: npm publishes are effectively irreversible within 72 hours
# for scoped packages. This script prints the tarball contents and asks
# for confirmation unless --dry-run or NON_INTERACTIVE=1 is set.

set -euo pipefail

DRY_RUN=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

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

  npm install --silent
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

publish_one "sdk"   "$REPO_ROOT/packages/sdk"
publish_one "embed" "$REPO_ROOT/packages/embed"

echo "== Done."
