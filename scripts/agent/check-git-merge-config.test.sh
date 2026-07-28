#!/usr/bin/env bash
# scripts/agent/check-git-merge-config.test.sh
#
# Pure-bash tests for check-git-merge-config.sh, in the style of
# check-claude-bootstrap.test.sh. Each case builds a throwaway repo, sets one
# merge-driver config, and asserts the guard's exit code. Touches nothing
# outside its temp dir.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
GUARD="${SCRIPT_DIR}/check-git-merge-config.sh"
PASS=0
FAIL=0

run_case() {
  local name="$1" want="$2" key="${3:-}" value="${4:-}"
  local dir output got
  dir=$(mktemp -d)
  git -C "$dir" init -q .
  [[ -n "$key" ]] && git -C "$dir" config --local "$key" "$value"
  output=$( (cd "$dir" && bash "$GUARD") 2>&1 )
  got=$?
  rm -rf "$dir"
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
echo "--- built-in driver shadowing -------------------------------"
run_case "clean repo passes"                    0
run_case "merge.union.driver=true denied"       1 merge.union.driver 'true'
# The incident config was a bare `true`, but drivers are conventionally written
# with gitattributes(5) placeholders — the guard must not be fooled by args.
run_case "union driver with %O %A %B denied"    1 merge.union.driver 'true %O %A %B'
run_case "union with a REAL driver denied"      1 merge.union.driver '/usr/local/bin/merge-union %O %A %B'
run_case "merge.text.driver denied"             1 merge.text.driver 'true'
run_case "merge.binary.driver denied"           1 merge.binary.driver 'true'

echo ""
echo "--- no-op commands under a NON-built-in name ----------------"
run_case "custom driver = true denied"          1 merge.custom.driver 'true'
run_case "custom driver = true %O %A %B denied" 1 merge.custom.driver 'true %O %A %B'
run_case "custom driver = ':' denied"           1 merge.custom.driver ':'
run_case "custom driver = /bin/true denied"     1 merge.custom.driver '/bin/true %A'
run_case "custom driver = 'exit 0' denied"      1 merge.custom.driver 'exit 0'
run_case "custom driver = 'cat %A' denied"      1 merge.custom.driver 'cat %A'

echo ""
echo "--- legitimate custom drivers still allowed ------------------"
run_case "real custom driver allowed"           0 merge.ours-json.driver 'jq -s ".[0]" %A > %A.tmp && mv %A.tmp %A'
run_case "non-driver merge config allowed"      0 merge.conflictStyle 'zdiff3'
run_case "truthy-prefixed name allowed"         0 merge.truthy.driver '/opt/bin/truthy-merge %O %A %B'

echo ""
echo "--- summary --------------------------------------------------"
echo "PASS=${PASS} FAIL=${FAIL}"
[[ "$FAIL" -eq 0 ]]
