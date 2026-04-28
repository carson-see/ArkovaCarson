#!/usr/bin/env bash
#
# enforce-tdd.sh — TDD Enforcement Gate
#
# Checks that production code changes are accompanied by corresponding test changes.
# Used as both a pre-commit hook (local) and a CI job (GitHub Actions).
#
# Exit codes:
#   0 — Pass (test files accompany production changes, or no production changes)
#   1 — Fail (production code changed without test changes)
#
# Usage:
#   Pre-commit:  scripts/enforce-tdd.sh --staged
#   CI (PR):     scripts/enforce-tdd.sh --diff <base_sha>
#   CI (push):   scripts/enforce-tdd.sh --diff HEAD~1
#
# Override:
#   Set SKIP_TDD_CHECK=1 or include "[skip-tdd]" in the commit message.
#   (Abuse of this is visible in git log and flagged in code review.)

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────

# Directories containing production source code
PROD_DIRS="src/hooks src/lib src/pages src/components services/worker/src"

# Patterns that are NOT production code (even if in prod dirs)
EXCLUDE_PATTERNS="\.test\.\|\.spec\.\|__mocks__\|test/\|\.stories\.\|\.d\.ts$"

# Test file patterns
TEST_PATTERNS="\.test\.\|\.spec\.\|tests/\|e2e/"

# Files that are exempt from TDD requirement (config, types, copy, CSS)
EXEMPT_PATTERNS="\.css$\|\.json$\|copy\.ts$\|routes\.ts$\|database\.types\.ts$\|\.d\.ts$\|index\.ts$"

# ── Parse args ────────────────────────────────────────────────────────

MODE=""
BASE_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --staged) MODE="staged"; shift ;;
    --diff) MODE="diff"; BASE_SHA="${2:-HEAD~1}"; shift 2 ;;
    *) echo "Usage: $0 --staged | --diff <base_sha>"; exit 1 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Usage: $0 --staged | --diff <base_sha>"
  exit 1
fi

# ── Skip checks ──────────────────────────────────────────────────────

if [[ "${SKIP_TDD_CHECK:-}" == "1" ]]; then
  echo "TDD check skipped (SKIP_TDD_CHECK=1)"
  exit 0
fi

# Check commit message(s) for [skip-tdd]. In staged mode we look at the
# pending commit; in --diff (CI) mode we scan every commit between BASE
# and HEAD so a [skip-tdd] marker on any commit in the PR opts the whole
# PR out (matching how operators document the skip in git log).
if [[ "$MODE" == "staged" ]]; then
  COMMIT_MSG_FILE="${GIT_COMMIT_MSG_FILE:-.git/COMMIT_EDITMSG}"
  if [[ -f "$COMMIT_MSG_FILE" ]] && grep -qi '\[skip-tdd\]' "$COMMIT_MSG_FILE"; then
    echo "TDD check skipped ([skip-tdd] in commit message)"
    exit 0
  fi
elif [[ "$MODE" == "diff" ]]; then
  if git log --format=%B "$BASE_SHA..HEAD" 2>/dev/null | grep -qi '\[skip-tdd\]'; then
    echo "TDD check skipped ([skip-tdd] found in PR commit messages)"
    exit 0
  fi
fi

# ── Get changed files ────────────────────────────────────────────────

if [[ "$MODE" == "staged" ]]; then
  CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)
else
  CHANGED_FILES=$(git diff --name-only --diff-filter=ACMR "$BASE_SHA" HEAD 2>/dev/null || git diff --name-only --diff-filter=ACMR HEAD~1 HEAD)
fi

if [[ -z "$CHANGED_FILES" ]]; then
  echo "No changed files — TDD check passes"
  exit 0
fi

# ── Classify files ───────────────────────────────────────────────────

PROD_FILES=""
TEST_FILES=""
HAS_PROD_CHANGES=false
HAS_TEST_CHANGES=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  # Skip exempt files
  if echo "$file" | grep -q "$EXEMPT_PATTERNS"; then
    continue
  fi

  # Check if it's a test file
  if echo "$file" | grep -q "$TEST_PATTERNS"; then
    TEST_FILES="${TEST_FILES}${file}\n"
    HAS_TEST_CHANGES=true
    continue
  fi

  # Check if it's in a production directory and not excluded
  for dir in $PROD_DIRS; do
    if [[ "$file" == ${dir}/* ]] && ! echo "$file" | grep -q "$EXCLUDE_PATTERNS"; then
      PROD_FILES="${PROD_FILES}${file}\n"
      HAS_PROD_CHANGES=true
      break
    fi
  done
done <<< "$CHANGED_FILES"

# ── Enforce TDD ──────────────────────────────────────────────────────

if $HAS_PROD_CHANGES && ! $HAS_TEST_CHANGES; then
  echo ""
  echo "============================================================"
  echo "  TDD ENFORCEMENT FAILED"
  echo "============================================================"
  echo ""
  echo "Production code was changed without any corresponding test changes."
  echo ""
  echo "Changed production files:"
  echo -e "$PROD_FILES" | sed '/^$/d' | sed 's/^/  - /'
  echo ""
  echo "TDD Mandate (CLAUDE.md §0): Red-Green-Refactor."
  echo "No production code without a corresponding test written first."
  echo ""
  echo "To fix:"
  echo "  1. Write/update tests that cover your changes"
  echo "  2. Stage the test files alongside production files"
  echo "  3. Commit again"
  echo ""
  echo "To skip (emergencies only, visible in git log):"
  echo "  SKIP_TDD_CHECK=1 git commit -m 'fix: ...' "
  echo "  or include [skip-tdd] in the commit message"
  echo ""
  echo "============================================================"
  exit 1
fi

if $HAS_PROD_CHANGES && $HAS_TEST_CHANGES; then
  echo "TDD check passed — production changes accompanied by test changes"
fi

if ! $HAS_PROD_CHANGES; then
  echo "TDD check passed — no production code changes"
fi

exit 0
