#!/usr/bin/env bash
#
# Publish arkova (TS SDK) and @arkova/embed to npm (INT-01 / INT-03).
#
# NOTE: the two packages are on DIFFERENT footings as of 2026-08-18.
#   - `arkova` (packages/sdk) is UNSCOPED as of the 2026-08-18 CTO ruling —
#     parity with the PyPI package, which already publishes unscoped as
#     `arkova`. This supersedes the 2026-08-01 `@carsonarkova/sdk` scoped
#     rename (historical record: HANDOFF.md `## History`); an unscoped name
#     needs no npm org at all. See packages/sdk/agents.md. For this package
#     specifically, prefer scripts/release/publish-npm.sh — it also covers
#     sdks/mcp-server (unscoped `arkova-mcp-server`) and checks `npm whoami`
#     up front. This script remains the path for packages/embed and for
#     publishing both in one pass.
#   - @arkova/embed still targets the `arkova` scope; unaffected by the
#     2026-08-18 ruling (that decision was scoped to the TS SDK only, not
#     extended to embed).
#
# Prerequisites:
#   1. arkova (sdk): no org needed, just an authenticated npm user
#      (`npm login`) that hasn't been beaten to the name (it wasn't, as of
#      2026-08-18 — confirmed via `npm view arkova` returning E404).
#      @arkova/embed: the `arkova` npm scope must exist and you need
#      owner/maintainer permissions on it. If not: `npm org create arkova`
#      (as the scope owner).
#   2. NPM_TOKEN exported with publish permission for the relevant
#      package/scope. Or: `npm login` interactively before running this
#      script.
#   3. First publish of a SCOPED package requires --access public
#      (harmless no-op for the unscoped `arkova` package; this script
#      passes it unconditionally below).
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

publish_one "sdk"   "$REPO_ROOT/packages/sdk"
publish_one "embed" "$REPO_ROOT/packages/embed"

echo "== Done."
