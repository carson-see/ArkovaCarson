#!/usr/bin/env bash
# scripts/agent/block-pr-merge.test.sh
#
# Pure-bash tests for .claude/hooks/block-pr-merge.sh, in the style of
# check-claude-bootstrap.test.sh (build a hook JSON payload, assert the exit
# code). Exit 2 = the call is blocked; exit 0 = the call is allowed. These
# tests spawn no network calls and mutate nothing outside this process.
#
# Why this suite exists (2026-08-11 enforcement audit): every rule in the hook
# anchored its regex on the sub-command being IMMEDIATELY adjacent to `git`,
# e.g. `git[[:space:]]+(push|commit).*--no-verify`. Any of git's *global*
# options between the two -- `-c k=v`, `-C <path>`, `--git-dir=`, `--no-pager`
# -- splits that token run and the guard silently does not fire. Observed
# empirically: `git -c user.email=a@b.c commit -m probe --no-verify` executed
# in a live Claude session with the hook active.
#
# This is the same bug class as the union merge-driver trap (see the 2026-07-28
# section of scripts/agent/agents.md) and as the supabase global-flag bypass
# already pinned in check-claude-bootstrap.test.sh -- a transient global flag
# slipping past a guard that assumed adjacency.
#
# The fix must NORMALIZE (strip git's global options so the sub-command becomes
# adjacent) rather than drop the adjacency anchor. Dropping the anchor would
# over-match any command line that merely mentions "push --force ... main" --
# a commit message, a doc edit, an echo. The "must not over-match" group below
# is what holds that line, and is as load-bearing as the bypass group.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd -P)
HOOK="${REPO_ROOT}/.claude/hooks/block-pr-merge.sh"
PASS=0
FAIL=0

# FAIL, do not skip -- same reasoning as check-claude-bootstrap.test.sh. The
# hook itself hard-depends on /usr/bin/python3 to parse its stdin payload, so a
# runner without it cannot exercise the guard at all. Reporting green for a
# suite that did not execute reads as validation of whatever is in flight.
if [[ ! -x /usr/bin/python3 ]]; then
  echo "FAIL block-pr-merge tests: /usr/bin/python3 is required and was not found."
  echo "     The hook under test invokes it directly. Refusing to report success"
  echo "     for a suite that did not execute."
  exit 1
fi

if [[ ! -f "$HOOK" ]]; then
  echo "FAIL block-pr-merge tests: hook not found at ${HOOK}"
  exit 1
fi

# Build the PreToolUse payload. The command is passed through the environment,
# not interpolated into the python source, so that quotes and backslashes in the
# case under test cannot break (or escape) the generator.
payload() {
  ARKOVA_TEST_CMD="$1" /usr/bin/python3 -c 'import json, os
print(json.dumps({"tool_name": "Bash",
                  "tool_input": {"command": os.environ["ARKOVA_TEST_CMD"]}}))'
}

# run_case <name> <want-exit> <command>
run_case() {
  local name="$1" want="$2" cmd="$3"
  local out got
  out=$(payload "$cmd" | bash "$HOOK" 2>&1)
  got=$?
  if [[ "$got" == "$want" ]]; then
    echo "  PASS  ${name}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  ${name}  exit=${got} want=${want}"
    echo "        cmd: ${cmd}"
    [[ -n "$out" ]] && echo "        out: ${out}"
    FAIL=$((FAIL + 1))
  fi
}

# run_case_bounded <name> <want-exit> <command> [limit-deciseconds]
#
# Same assertion as run_case, but wall-clocked. The normalizer nests quantifiers
# (a token repeat over a word repeat), which is the shape that backtracks
# exponentially the moment its alternatives stop being mutually exclusive. This
# hook runs on EVERY Bash tool call, so that regression presents as a frozen
# session rather than a failed assert -- it has to be caught by the clock.
run_case_bounded() {
  local name="$1" want="$2" cmd="$3" limit_ds="${4:-100}"
  local out_f pid waited=0 got
  out_f=$(mktemp)
  { payload "$cmd" | bash "$HOOK" >"$out_f" 2>&1; echo $? >"${out_f}.rc"; } &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= limit_ds )); then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      rm -f "$out_f" "${out_f}.rc"
      echo "  FAIL  ${name}  unfinished after $((limit_ds / 10))s (catastrophic backtracking?)"
      FAIL=$((FAIL + 1))
      return
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
  got=$(cat "${out_f}.rc" 2>/dev/null || echo 99)
  rm -f "$out_f" "${out_f}.rc"
  if [[ "$got" == "$want" ]]; then
    echo "  PASS  ${name}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  ${name}  exit=${got} want=${want}"
    FAIL=$((FAIL + 1))
  fi
}

BLOCKED=2
ALLOWED=0

echo ""
echo "--- baseline: the three rules still fire -----------------------"
run_case "gh pr merge blocked"              $BLOCKED 'gh pr merge 123 --squash'
run_case "gh pr merge after && blocked"     $BLOCKED 'gh pr checks 1 && gh pr merge 1 --merge'
run_case "raw API PUT merge blocked"        $BLOCKED 'gh api -X PUT /repos/o/r/pulls/1/merge'
run_case "raw API POST merge blocked"       $BLOCKED 'gh api -X POST /repos/o/r/pulls/1/merge'
run_case "force-push main blocked"          $BLOCKED 'git push --force origin main'
run_case "force-push main (flags after)"    $BLOCKED 'git push origin main --force'
run_case "force-push master via -f"         $BLOCKED 'git push -f origin master'
run_case "force-with-lease main blocked"    $BLOCKED 'git push --force-with-lease origin main'
run_case "commit --no-verify blocked"       $BLOCKED 'git commit -m wip --no-verify'
run_case "push --no-verify blocked"         $BLOCKED 'git push --no-verify origin feature'

echo ""
echo "--- baseline: legitimate work still allowed --------------------"
run_case "push to feature branch"           $ALLOWED 'git push origin claude/serene-hodgkin-635c85'
run_case "ordinary commit"                  $ALLOWED 'git commit -m "fix: tighten guard"'
run_case "force-push to a feature branch"   $ALLOWED 'git push --force origin claude/my-feature'
run_case "git status"                       $ALLOWED 'git status --porcelain'
run_case "gh pr view"                       $ALLOWED 'gh pr view 123 --json state'
run_case "gh pr ready"                      $ALLOWED 'gh pr ready 123'
run_case "marketing-repo carve-out"         $ALLOWED 'gh pr merge 5 --repo carson-see/arkova-marketing --squash'

echo ""
echo "--- BYPASS: git global options split the token run -------------"
# Every case below was probed against the pre-fix hook and returned exit 0,
# i.e. the guarded operation would have executed.
run_case "bypass: -c before commit --no-verify" $BLOCKED \
  'git -c user.email=a@b.c -c user.name=x commit -q -m probe --no-verify'
run_case "bypass: -c before force-push main"    $BLOCKED \
  'git -c core.pager=cat push --force origin main'
run_case "bypass: -C <path> before force-push"  $BLOCKED \
  'git -C /some/path push --force origin main'
run_case "bypass: --git-dir= and --work-tree="  $BLOCKED \
  'git --git-dir=.git --work-tree=. push -f origin main'
run_case "bypass: --no-pager before force-push" $BLOCKED \
  'git --no-pager push --force origin master'
run_case "bypass: -c attached short form"       $BLOCKED \
  'git -cuser.name=x commit --no-verify -m y'
run_case "bypass: -C attached short form"       $BLOCKED \
  'git -C/some/path push --force origin main'
run_case "bypass: --config-env="                $BLOCKED \
  'git --config-env=user.name=EV push --force origin main'
run_case "bypass: --exec-path="                 $BLOCKED \
  'git --exec-path=/usr/libexec/git-core commit --no-verify -m z'
run_case "bypass: --namespace="                 $BLOCKED \
  'git --namespace=ns push -f origin main'
run_case "bypass: --attr-source="               $BLOCKED \
  'git --attr-source=HEAD commit --no-verify -m q'
run_case "bypass: separated --git-dir <path>"   $BLOCKED \
  'git --git-dir .git push --force origin main'
run_case "bypass: separated --work-tree <path>" $BLOCKED \
  'git --work-tree . commit --no-verify -m x'
run_case "bypass: stacked global options"       $BLOCKED \
  'git -C . -c a=b --no-pager push --force-with-lease origin main'
# A bot identity with a space is the realistic shape of this bypass, and a
# naive \S+ value matcher stops at the space and leaves the guard blind.
run_case "bypass: quoted -c value with a space" $BLOCKED \
  'git -c user.name="Claude Bot" commit --no-verify -m x'
run_case "bypass: single-quoted -c value"       $BLOCKED \
  "git -c user.name='Claude Bot' push --force origin main"
run_case "bypass: global flags after &&"        $BLOCKED \
  'npm test && git -c a=b push --force origin main'

echo ""
echo "--- the fix must not over-match --------------------------------"
# Normalizing must only remove git's own leading global options. It must never
# turn a line that merely *mentions* a forbidden operation into a blocked one,
# and it must never start blocking ordinary flagged git work.
run_case "message mentioning push --force"  $ALLOWED \
  'git commit -m "docs: never push --force to main"'
run_case "message mentioning -f main"       $ALLOWED \
  'git commit -m "block -f pushes to main"'
run_case "-c then a benign subcommand"      $ALLOWED 'git -c a=b status --porcelain'
run_case "-c then push to feature branch"   $ALLOWED 'git -c a=b push origin feature-branch'
run_case "-c then ordinary commit"          $ALLOWED 'git -c a=b commit -m "ok"'
run_case "-c then log naming main"          $ALLOWED 'git -c a=b log --oneline main'
run_case "--no-pager log naming main"       $ALLOWED 'git --no-pager log --format=%s main'
run_case "-C then diff naming main"         $ALLOWED 'git -C . diff main --stat'
run_case "fetch from main"                  $ALLOWED 'git fetch origin main'
run_case "rebase onto main"                 $ALLOWED 'git -c a=b rebase origin/main'

echo ""
echo "--- the normalizer itself is present and parses -----------------"
# The hook falls back to the raw command when the normalizer cannot be run, so
# a missing or syntactically broken normalize-git-command.py silently returns
# the guard to pre-fix strength. That is precisely the fail-open this whole
# suite exists to prevent, and no other assertion here would notice it.
NORMALIZER="${REPO_ROOT}/.claude/hooks/normalize-git-command.py"
if [[ -f "$NORMALIZER" ]]; then
  echo "  PASS  normalizer present"
  PASS=$((PASS + 1))
else
  echo "  FAIL  normalizer missing at ${NORMALIZER}"
  FAIL=$((FAIL + 1))
fi
if /usr/bin/python3 -c 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")' \
     "$NORMALIZER" 2>/dev/null; then
  echo "  PASS  normalizer parses"
  PASS=$((PASS + 1))
else
  echo "  FAIL  normalizer does not parse"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "--- pathological input must not hang the hook ------------------"
# Long runs of global options, with both a matching and a non-matching tail so
# the normalizer is forced through a full failed scan as well as a successful
# one. Measured at 0.000s for n=200 across six adversarial shapes on 2026-08-11;
# a one-second budget is ~1000x headroom and still catches an exponential blowup.
big_flags=""
for _ in $(seq 1 200); do big_flags+="-c a=b "; done
big_mixed=""
for _ in $(seq 1 200); do big_mixed+="-C . --no-pager -c a=b "; done

run_case_bounded "200 global options then a force-push"  $BLOCKED \
  "git ${big_flags}push --force origin main" 10
run_case_bounded "200 mixed global options then commit"  $BLOCKED \
  "git ${big_mixed}commit --no-verify -m x" 10
run_case_bounded "200 global options, no subcommand"     $ALLOWED \
  "git ${big_flags}!" 10
run_case_bounded "200 global options then benign work"   $ALLOWED \
  "git ${big_flags}status --porcelain" 10

echo ""
echo "--- summary ----------------------------------------------------"
echo "PASS=${PASS} FAIL=${FAIL}"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
exit 0
