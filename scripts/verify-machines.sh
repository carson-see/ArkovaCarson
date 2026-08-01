#!/usr/bin/env bash
#
# Run `tla-precheck check` over every machines/*.machine.ts.
#
# WHY THIS EXISTS: `tla-precheck` resolves its tsconfig as
# `resolve(process.cwd(), "tsconfig.json")` — cwd-relative, with no upward
# search. Run from the repo root it picks up the ROOT tsconfig, whose
# `allowImportingTsExtensions: true` collides with the emit `check` performs
# (it force-overrides `noEmit: false`), failing with TS5096 before TLC ever
# starts. It must run from `machines/`, which has its own tsconfig. CI does
# this via `working-directory: machines`; this script makes the same thing
# reproducible from anywhere, so CLAUDE.md §4's "re-verify with check"
# mandate does not depend on the caller's cwd.
#
# Usage:
#   scripts/verify-machines.sh                      # all machines, default tier
#   scripts/verify-machines.sh --tier nightly       # extra flags forwarded
#   scripts/verify-machines.sh bitcoinAnchor        # only matching machines
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MACHINES_DIR="$REPO_ROOT/machines"
BIN="$REPO_ROOT/node_modules/.bin/tla-precheck"

# Split args into name filters and flags forwarded to tla-precheck.
FILTERS=()
FORWARD=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) FORWARD+=("$1"); [[ $# -gt 1 && "$2" != -* ]] && { FORWARD+=("$2"); shift; } ;;
    *)  FILTERS+=("$1") ;;
  esac
  shift
done

if [[ ! -x "$BIN" ]]; then
  echo "error: $BIN not found. Run 'npm ci' first." >&2
  echo "       (Do NOT fall back to 'npx tla-precheck' — npx installs its own" >&2
  echo "        typescript, not the repo-pinned 6.0.3, which reintroduces TS5103.)" >&2
  exit 1
fi

shopt -s nullglob
ALL=("$MACHINES_DIR"/*.machine.ts)
shopt -u nullglob

if [[ ${#ALL[@]} -eq 0 ]]; then
  echo "error: no *.machine.ts found in $MACHINES_DIR" >&2
  exit 1
fi

TARGETS=()
for path in "${ALL[@]}"; do
  name="$(basename "$path")"
  if [[ ${#FILTERS[@]} -eq 0 ]]; then
    TARGETS+=("$name")
  else
    for f in "${FILTERS[@]}"; do
      [[ "$name" == *"$f"* ]] && { TARGETS+=("$name"); break; }
    done
  fi
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "error: no machine matched filter: ${FILTERS[*]}" >&2
  exit 1
fi

cd "$MACHINES_DIR"

FAILED=()
for machine in "${TARGETS[@]}"; do
  echo "=== tla-precheck check $machine"
  if "$BIN" check "$machine" "${FORWARD[@]+"${FORWARD[@]}"}"; then
    echo "--- PASS $machine"
  else
    echo "--- FAIL $machine"
    FAILED+=("$machine")
  fi
done

echo
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED (${#FAILED[@]}/${#TARGETS[@]}): ${FAILED[*]}"
  exit 1
fi
echo "PASSED ${#TARGETS[@]}/${#TARGETS[@]}: ${TARGETS[*]}"
