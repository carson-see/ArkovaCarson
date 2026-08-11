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

# --- command-string mode (--command) -------------------------------------
#
# The config-scope cases above cannot see a TRANSIENT override: `git -c
# merge.union.driver=true merge origin/main` never touches any config file, so
# `git config --get-regexp` reports nothing and the guard passes while the merge
# silently discards "theirs". That is the 2026-08-11 PR #2061 loss. These cases
# drive the separate string-scanning mode used by the PreToolUse hook.
run_cmd_case() {
  local name="$1" want="$2" cmd="$3"
  local output got
  output=$(bash "$GUARD" --command "$cmd" 2>&1)
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
echo "--- transient -c overrides (the 2026-08-11 PR #2061 form) ----"
run_cmd_case "-c merge.union.driver=true denied"  1 "git -c merge.union.driver=true merge origin/main"
run_cmd_case "-c union w/ placeholders denied"    1 "git -c merge.union.driver='true %O %A %B' merge origin/main"
run_cmd_case "-c attached form denied"            1 "git -cmerge.union.driver=true merge origin/main"
run_cmd_case "-c merge.text.driver denied"        1 "git -c merge.text.driver=true merge origin/main"
run_cmd_case "-c merge.binary.driver denied"      1 "git -c merge.binary.driver=true merge origin/main"
# A transient override is never legitimate even under a non-built-in name: real
# drivers are configured persistently next to .gitattributes, where the
# config-scope check above adjudicates them on their merits.
run_cmd_case "-c non-builtin transient denied"    1 "git -c merge.custom.driver=true merge origin/main"
run_cmd_case "-c real driver still transient"     1 "git -c merge.custom.driver='/usr/local/bin/m %O %A %B' merge origin/main"
run_cmd_case "interleaved -c flags denied"        1 "git -c core.pager=cat -c merge.union.driver=true merge origin/main"
run_cmd_case "--config-env denied"                1 "git --config-env=merge.union.driver=DRV merge origin/main"
run_cmd_case "GIT_CONFIG_PARAMETERS denied"       1 "GIT_CONFIG_PARAMETERS=\"'merge.union.driver=true'\" git merge origin/main"

echo ""
echo "--- persisting a built-in driver via 'git config' ------------"
run_cmd_case "git config set union denied"        1 "git config merge.union.driver true"
run_cmd_case "git config --local set union denied" 1 "git config --local merge.union.driver 'true %O %A %B'"

echo ""
echo "--- the documented fix + verify commands must PASS -----------"
# fix_hint() tells the operator to run exactly these two. A guard that blocks
# its own remediation is worse than no guard.
run_cmd_case "--unset union allowed"              0 "git config --local --unset merge.union.driver"
run_cmd_case "--get-regexp allowed"               0 "git config --get-regexp '^merge\\..*\\.driver'"
run_cmd_case "--unset-all allowed"                0 "git config --unset-all merge.union.driver"

echo ""
echo "--- heredoc BODIES are text, not execution -------------------"
# Writing about this bug must not be blocked by the guard against it. The hook
# sees the whole Bash command string, heredoc body included, so a commit message
# or doc that quotes the offending command would trip it. Found by dogfooding:
# the commit that introduced this guard was blocked by its own commit message.
run_cmd_case "commit msg quoting the flag allowed" 0 "$(printf '%s\n' \
  "git commit -F - <<'MSG'" \
  "fix: block -c merge.union.driver=true overrides" \
  "" \
  "Running git -c merge.union.driver=true merge origin/main discards theirs." \
  "MSG")"
run_cmd_case "unquoted heredoc tag allowed"        0 "$(printf '%s\n' \
  "cat <<EOF > notes.md" \
  "never run git -c merge.union.driver=true merge origin/main" \
  "EOF")"
# ...but a REAL override after the heredoc closes is still a real override.
run_cmd_case "override AFTER heredoc still denied" 1 "$(printf '%s\n' \
  "git commit -F - <<'MSG'" \
  "harmless prose" \
  "MSG" \
  "git -c merge.union.driver=true merge origin/main")"
run_cmd_case "override BEFORE heredoc still denied" 1 "$(printf '%s\n' \
  "git -c merge.union.driver=true merge origin/main" \
  "cat <<'EOF'" \
  "prose" \
  "EOF")"

echo ""
echo "--- ordinary commands must PASS ------------------------------"
run_cmd_case "plain merge allowed"                0 "git merge origin/main"
run_cmd_case "unrelated -c allowed"               0 "git -c core.pager=cat merge origin/main"
run_cmd_case "non-driver merge config allowed"    0 "git config merge.conflictStyle zdiff3"
run_cmd_case "persisted custom driver allowed"    0 "git config merge.ours-json.driver 'jq -s .[0] %A'"
run_cmd_case "the agents.md verify step allowed"  0 "git diff origin/main HEAD -- '*agents.md' | grep -E '^-[^-]'"
run_cmd_case "unrelated command allowed"          0 "npm test"
run_cmd_case "empty command allowed"              0 ""

echo ""
echo "--- summary --------------------------------------------------"
echo "PASS=${PASS} FAIL=${FAIL}"
[[ "$FAIL" -eq 0 ]]
