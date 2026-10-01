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
# This script checks every published version, not just the latest dist-tag:
# an already-live package.json version is SKIPPED. A failed or malformed
# registry lookup stops before building or publishing. Re-running after a
# partial failure can finish only the still-unpublished package.
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
# OPERATOR NOTE 1 — the CI publish identity (verified 2026-09-05).
#   .github/workflows/publish-sdk.yml (tag `sdk-v*`) publishes packages/sdk with
#   `secrets.NPM_TOKEN`. That token is mirrored from GCP Secret Manager
#   `arkova1/NPM` (single version, 2026-07-22) and authenticates as npm user
#   `crseeger`, who is the SOLE registry maintainer of both `arkova` and
#   `arkova-mcp-server` (checked with `npm view <pkg> maintainers`). It is a
#   user token, not an org-scoped one, so the unscoped names are publishable
#   with it. Caveat: `npm access list packages` answers 403 with this token
#   while `npm access get status arkova` succeeds, which is the signature of a
#   granular token; a package allow-list is only proven by a publish. If a
#   publish 403s, check the token's package scope on npmjs.com before anything
#   else. Rotating it means: new version on `arkova1/NPM` AND
#   `gh secret set NPM_TOKEN` — the two are not linked.
#
# OPERATOR NOTE 2 — sdks/mcp-server has NO CI publish workflow.
#   `.github/workflows/` contains publish-sdk.yml (packages/sdk) and
#   publish-python-sdk.yml (packages/arkova-py) and nothing else. Tagging does
#   not publish `arkova-mcp-server`; running THIS script with
#   `--only=mcp-server`, by hand, on an authenticated machine, is the only way
#   that package reaches the registry. Do not assume a release tag covered it.
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

# short_name : package_dir (relative to repo root). The published npm name
# is read from each package's own package.json "name" field (see
# publish_one) rather than hardcoded here a third time — packages/sdk and
# sdks/mcp-server already carry the source-of-truth name.
PACKAGES=(
  "sdk:packages/sdk"
  "mcp-server:sdks/mcp-server"
)

# Both names already exist on npm. Read their complete version lists so a
# historical version is recognized even when latest points elsewhere. An
# E404, auth failure, network failure, or malformed response is uncertain and
# requires an operator to resolve it before a manual release can continue.
publication_state() {
  local npm_name="$1" local_version="$2" versions_json state
  if ! versions_json="$(npm view "$npm_name" versions --json 2>/dev/null)"; then
    echo "Cannot confirm published versions for $npm_name; stopping before build/publish." >&2
    return 1
  fi
  if ! state="$(printf '%s' "$versions_json" | node -e '
    const fs = require("node:fs");
    const requested = process.argv[1];
    const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    const versions = Array.isArray(raw) ? raw : [raw];
    if (!version.test(requested) || versions.length === 0
      || versions.some(v => typeof v !== "string" || !version.test(v))) process.exit(1);
    process.stdout.write(versions.includes(requested) ? "published" : "absent");
  ' "$local_version")"; then
    echo "Invalid version list for $npm_name; stopping before build/publish." >&2
    return 1
  fi
  printf '%s\n' "$state"
}

publish_one() {
  local short_name="$1" pkg_dir="$2"

  if [[ -n "$ONLY" && "$ONLY" != "$short_name" ]]; then
    echo "== Skipping $short_name (--only=$ONLY)"
    return 0
  fi

  cd "$REPO_ROOT/$pkg_dir"

  local npm_name local_version
  npm_name="$(node -p "require('./package.json').name")"
  local_version="$(node -p "require('./package.json').version")"

  echo
  echo "== $short_name  ($pkg_dir -> npm: $npm_name)"

  local state
  state="$(publication_state "$npm_name" "$local_version")" || exit 1
  if [[ "$state" == published ]]; then
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
  pkg_dir="${entry#*:}"
  publish_one "$short_name" "$pkg_dir"
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "== DRY RUN complete — no packages were published."
  exit 0
fi

echo
echo "== Confirming selected exact package versions"
for entry in "${PACKAGES[@]}"; do
  short_name="${entry%%:*}"
  pkg_dir="${entry#*:}"
  if [[ -n "$ONLY" && "$ONLY" != "$short_name" ]]; then continue; fi

  npm_name="$(node -p 'require(process.argv[1]).name' "$REPO_ROOT/$pkg_dir/package.json")"
  local_version="$(node -p 'require(process.argv[1]).version' "$REPO_ROOT/$pkg_dir/package.json")"
  if ! published_version="$(npm view "$npm_name@$local_version" version --json 2>/dev/null)"; then
    echo "Could not confirm $npm_name@$local_version on the registry. Check propagation before retrying; do not blindly republish." >&2
    exit 1
  fi
  if ! printf '%s' "$published_version" | node -e '
    const fs = require("node:fs");
    let observed;
    try { observed = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    if (observed !== process.argv[1]) process.exit(1);
  ' "$local_version"; then
    echo "Registry exact-version readback did not match $npm_name@$local_version; stop and investigate." >&2
    exit 1
  fi
  echo "-- confirmed $npm_name@$local_version"
done

echo
echo "== Done."
