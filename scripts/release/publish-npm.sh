#!/usr/bin/env bash
#
# scripts/release/publish-npm.sh — publish `arkova` (packages/sdk) and
# `arkova-mcp-server` (sdks/mcp-server) to npm.
#
# Both packages are UNSCOPED as of the 2026-08-18 CTO ruling — parity with
# the PyPI package, which already publishes unscoped as `arkova`. An
# unscoped name needs NO npm org: first-publish ownership is per-package,
# per-account, first-come. Both names were confirmed free via
# `npm view <name>` (E404) on 2026-08-18 — see packages/sdk/agents.md and
# sdks/mcp-server/agents.md for the full history (including the superseded
# 2026-08-01 `@carsonarkova/sdk` scoped-package attempt).
#
# This script is IDEMPOTENT: if a package's current package.json version is
# already live on the registry, that package's publish step is SKIPPED
# instead of failing on npm's "cannot publish over previously published
# version" error. Re-running after a partial failure (e.g. sdk published,
# mcp-server's tests then failed) only finishes what's left.
#
# Usage:
#   scripts/release/publish-npm.sh                # live publish, both packages
#   scripts/release/publish-npm.sh --dry-run       # build+test+pack only, no publish
#   scripts/release/publish-npm.sh --only=sdk      # just packages/sdk (npm name: arkova)
#   scripts/release/publish-npm.sh --only=mcp-server
#
# Prerequisites (operator-only — the machine that authored this script has
# NO npm auth and never ran `npm login` or `npm publish`):
#   1. `npm login` (interactive) as the npm user that should own these
#      unscoped names going forward. Whoever runs this first owns them.
#   2. That's it — no `npm org create`, no scope, no NPM_TOKEN needed for a
#      manual/interactive publish (NPM_TOKEN is only for the separate CI
#      path, .github/workflows/publish-sdk.yml, which covers packages/sdk
#      only and is tag-triggered).
#
# What this script deliberately does NOT do:
#   - Never runs `npm login` itself, interactively or otherwise — this
#     script only ever checks whether a login already exists.
#   - Never reads or writes NPM_TOKEN / CI secrets.
#   - Never publishes packages/embed (@arkova/embed) or anything under
#     sdks/langchain* — out of scope for this script; see
#     scripts/publish-packages.sh for embed.

set -euo pipefail

DRY_RUN=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: $0 [--dry-run] [--only=sdk|mcp-server]" >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "== Checking npm authentication"
if WHOAMI="$(npm whoami 2>/dev/null)"; then
  echo "-- authenticated as: $WHOAMI"
elif [[ "$DRY_RUN" == "1" ]]; then
  echo "-- not authenticated (npm whoami failed) — continuing, this is --dry-run"
else
  cat >&2 <<'EOF'

Not authenticated to npm (`npm whoami` failed).

This script never runs `npm login` for you — log in interactively first:

    npm login

Then re-run this script. If you only want to verify build/test/pack without
publishing, use --dry-run (which does not require a login).
EOF
  exit 1
fi

# short_name : package_dir (relative to repo root) : published npm name
PACKAGES=(
  "sdk:packages/sdk:arkova"
  "mcp-server:sdks/mcp-server:arkova-mcp-server"
)

# Compares the local package.json version against what's already live on
# the registry. Treats "not found on the registry at all" (first-ever
# publish, or --dry-run against a not-yet-authenticated session) as
# "not already published" rather than an error.
already_published() {
  local npm_name="$1" local_version="$2" live_version
  live_version="$(npm view "$npm_name" version 2>/dev/null || true)"
  [[ -n "$live_version" && "$live_version" == "$local_version" ]]
}

publish_one() {
  local short_name="$1" pkg_dir="$2" npm_name="$3"

  if [[ -n "$ONLY" && "$ONLY" != "$short_name" ]]; then
    echo "== Skipping $short_name (--only=$ONLY)"
    return 0
  fi

  echo
  echo "== $short_name  ($pkg_dir -> npm: $npm_name)"
  cd "$REPO_ROOT/$pkg_dir"

  local local_version
  local_version="$(node -p "require('./package.json').version")"

  if already_published "$npm_name" "$local_version"; then
    echo "-- $npm_name@$local_version is already live on npm — skipping (idempotent)"
    return 0
  fi

  echo "-- npm ci --ignore-scripts"
  npm ci --ignore-scripts

  if node -p "require('./package.json').scripts?.typecheck || ''" | grep -q .; then
    echo "-- npm run typecheck"
    npm run typecheck
  fi

  echo "-- npm test"
  npm test

  echo "-- npm run build"
  npm run build

  echo "-- npm pack --dry-run (final tarball-contents sanity check)"
  npm pack --dry-run

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "-- DRY RUN: skipping npm publish for $npm_name@$local_version"
    return 0
  fi

  echo "-- npm publish --access public"
  npm publish --access public
}

for entry in "${PACKAGES[@]}"; do
  short_name="${entry%%:*}"
  rest="${entry#*:}"
  pkg_dir="${rest%%:*}"
  npm_name="${rest#*:}"
  publish_one "$short_name" "$pkg_dir" "$npm_name"
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "== DRY RUN complete — no packages were published."
  exit 0
fi

echo
echo "== Confirming published versions"
npm view arkova version && npm view arkova-mcp-server version

echo
echo "== Done."
