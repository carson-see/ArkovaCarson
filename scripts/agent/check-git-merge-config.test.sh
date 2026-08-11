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

report() { # report <name> <want> <got> <output>
  if [[ "$3" == "$2" ]]; then
    echo "  PASS  $1  exit=$3"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1  exit=$3 want=$2"
    echo "        ${4}" | head -3
    FAIL=$((FAIL + 1))
  fi
}

run_case() {
  local name="$1" want="$2" key="${3:-}" value="${4:-}"
  local dir output got
  dir=$(mktemp -d)
  git -C "$dir" init -q .
  [[ -n "$key" ]] && git -C "$dir" config --local "$key" "$value"
  output=$( (cd "$dir" && bash "$GUARD") 2>&1 )
  got=$?
  rm -rf "$dir"
  report "$name" "$want" "$got" "$output"
}

# Same assertion, but the driver arrives through the ENVIRONMENT instead of
# config — the shape `git -c` / `--config-env` takes when git hands its settings
# to a subprocess. Nothing is written to any config file, so these cases are
# only reachable from a process git itself launched: a hook.
run_env_case() { # run_env_case <name> <want> <VAR=VAL>...
  local name="$1" want="$2"
  shift 2
  local dir output got
  dir=$(mktemp -d)
  git -C "$dir" init -q .
  output=$( (cd "$dir" && env "$@" bash "$GUARD") 2>&1 )
  got=$?
  rm -rf "$dir"
  report "$name" "$want" "$got" "$output"
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
echo "--- the one-off vector: git -c / --config-env ----------------"
# `git -c merge.union.driver=true merge origin/main` does exactly what the
# 2026-07-28 config did, and writes nothing for this guard to find. Git does
# export it to its subprocesses though, so the guard reaches it from a hook —
# that is what `.githooks/pre-merge-commit` is for, and what these cases pin.
# End-to-end coverage of the vector (real merges, both hooks) lives in
# check-unsafe-git-merge.test.sh.
run_env_case "GIT_CONFIG_PARAMETERS union driver denied" 1 \
  "GIT_CONFIG_PARAMETERS='merge.union.driver'='true'"
run_env_case "…with placeholders denied" 1 \
  "GIT_CONFIG_PARAMETERS='merge.union.driver'='true %O %A %B'"
run_env_case "…a REAL driver under a built-in name denied" 1 \
  "GIT_CONFIG_PARAMETERS='merge.union.driver'='/usr/local/bin/m %O %A %B'"
run_env_case "…a no-op under a custom name denied" 1 \
  "GIT_CONFIG_PARAMETERS='merge.custom.driver'='true'"
run_env_case "GIT_CONFIG_COUNT/KEY/VALUE form denied" 1 \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=merge.union.driver GIT_CONFIG_VALUE_0=true
run_env_case "unrelated env config allowed" 0 \
  "GIT_CONFIG_PARAMETERS='merge.conflictStyle'='zdiff3'"
run_env_case "real custom driver in env allowed" 0 \
  "GIT_CONFIG_PARAMETERS='merge.ours-json.driver'='jq -s \".[0]\" %A > %A.tmp && mv %A.tmp %A'"

echo ""
echo "--- summary --------------------------------------------------"
echo "PASS=${PASS} FAIL=${FAIL}"
[[ "$FAIL" -eq 0 ]]
