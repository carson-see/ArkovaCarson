#!/usr/bin/env bash
# scripts/agent/check-git-merge-driver-flag.test.sh
#
# Tests the PreToolUse ADAPTER, .claude/hooks/check-git-merge-driver-flag.sh:
# real hook JSON on stdin, exit 2 to block, exit 0 to allow, and a fail-open
# path when the guard is absent.
#
# The detection rules themselves are NOT retested here — they live in
# check-git-merge-config.sh's --command mode and are covered by
# check-git-merge-config.test.sh. This file only asserts that the adapter reads
# the command out of the hook payload and maps the guard's exit code correctly.
#
# Touches nothing outside its temp dirs.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=${SCRIPT_DIR%/scripts/agent}
HOOK="${REPO_ROOT}/.claude/hooks/check-git-merge-driver-flag.sh"
PASS=0
FAIL=0

# Build the PreToolUse payload the harness actually sends, so quoting and
# unicode in the command survive the round trip.
payload() {
  printf '%s' "$1" | /usr/bin/python3 -c 'import json,sys
print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.stdin.read()}}))'
}

run_case() {
  local name="$1" want="$2" cmd="$3"
  local output got
  output=$(payload "$cmd" | bash "$HOOK" 2>&1)
  got=$?
  if [[ "$got" == "$want" ]]; then
    echo "  PASS  ${name}  exit=${got}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  ${name}  exit=${got} want=${want}"
    echo "        ${output}" | head -3
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "--- blocks (exit 2) ------------------------------------------"
run_case "the 2026-08-11 PR #2061 command" 2 "git -c merge.union.driver=true merge origin/main"
run_case "quoted driver with placeholders" 2 "git -c merge.union.driver='true %O %A %B' merge origin/main"
run_case "GIT_CONFIG_PARAMETERS form"      2 "GIT_CONFIG_PARAMETERS=\"'merge.union.driver=true'\" git merge origin/main"

echo ""
echo "--- allows (exit 0) ------------------------------------------"
run_case "plain merge"                     0 "git merge origin/main"
run_case "documented fix: --unset"         0 "git config --local --unset merge.union.driver"
run_case "documented verify: --get-regexp" 0 "git config --get-regexp '^merge\\..*\\.driver'"
run_case "the agents.md verification step" 0 "git diff origin/main HEAD -- '*agents.md' | grep -E '^-[^-]'"
run_case "unrelated command"               0 "npm test"

echo ""
echo "--- malformed / empty payloads must not block ----------------"
# A hook that dies on unexpected stdin would break every Bash call in the
# session, so these must all fall through to exit 0.
for bad_name in "not json" "empty string" "no tool_input" "null command"; do
  case "$bad_name" in
    "not json")      bad='this is not json' ;;
    "empty string")  bad='' ;;
    "no tool_input") bad='{"tool_name":"Bash"}' ;;
    "null command")  bad='{"tool_name":"Bash","tool_input":{"command":null}}' ;;
  esac
  out=$(printf '%s' "$bad" | bash "$HOOK" 2>&1)
  got=$?
  if [[ "$got" == 0 ]]; then
    echo "  PASS  ${bad_name} falls through  exit=0"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  ${bad_name}  exit=${got} want=0"
    echo "        ${out}" | head -3
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "--- fails OPEN when the guard is missing ---------------------"
# A checkout that predates the guard must not have every Bash call bricked.
tmp=$(mktemp -d)
mkdir -p "${tmp}/.claude/hooks"
cp "$HOOK" "${tmp}/.claude/hooks/"
out=$(payload "git -c merge.union.driver=true merge origin/main" | bash "${tmp}/.claude/hooks/$(basename "$HOOK")" 2>&1)
got=$?
rm -rf "$tmp"
if [[ "$got" == 0 ]]; then
  echo "  PASS  no guard present -> allow  exit=0"
  PASS=$((PASS + 1))
else
  echo "  FAIL  no guard present  exit=${got} want=0"
  echo "        ${out}" | head -3
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- registered in .claude/settings.json ----------------------"
# The guard is inert unless the harness is told to run it.
if /usr/bin/python3 -c "
import json,sys
s=json.load(open('${REPO_ROOT}/.claude/settings.json'))
hooks=[h['command'] for g in s['hooks']['PreToolUse'] if g.get('matcher')=='Bash' for h in g['hooks']]
sys.exit(0 if any('check-git-merge-driver-flag.sh' in c for c in hooks) else 1)
" 2>/dev/null; then
  echo "  PASS  wired into the PreToolUse Bash chain"
  PASS=$((PASS + 1))
else
  echo "  FAIL  NOT wired into .claude/settings.json — the hook would never run"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- summary --------------------------------------------------"
echo "PASS=${PASS} FAIL=${FAIL}"
[[ "$FAIL" -eq 0 ]]
