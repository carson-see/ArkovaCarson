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
echo "--- BYPASS: a leading + on a refspec forces with no flag -------"
# Rule 2 looks for a force FLAG (--force / -f / --force-with-lease). A leading
# `+` on a refspec is the OTHER way to force an update -- it is per-refspec and
# needs no flag anywhere on the line -- so every case below returned exit 0
# against the hook as it stood on 2026-08-11 (probed, not theorised). This is a
# distinct rule gap from the global-option bypasses above, not another instance
# of them: normalizing the line does not help, because there is no flag to find.
run_case "refspec: +main"                       $BLOCKED 'git push origin +main'
run_case "refspec: +main:main"                  $BLOCKED 'git push origin +main:main'
run_case "refspec: +HEAD:master"                $BLOCKED 'git push origin +HEAD:master'
run_case "refspec: +HEAD:main"                  $BLOCKED 'git push origin +HEAD:main'
run_case "refspec: +master"                     $BLOCKED 'git push origin +master'
# The destination is what makes it destructive; the source can be anything.
run_case "refspec: +feature:main"               $BLOCKED 'git push origin +feature:main'
# Fully-qualified refs are the same push, spelled longhand.
run_case "refspec: +refs/heads/main"            $BLOCKED 'git push origin +refs/heads/main'
run_case "refspec: +refs/heads/x:refs/heads/main" $BLOCKED \
  'git push origin +refs/heads/x:refs/heads/main'
# A safe refspec first must not launder an unsafe one after it.
run_case "refspec: safe one then +main"         $BLOCKED \
  'git push origin +feature:feature +main'
run_case "refspec: quoted"                      $BLOCKED 'git push origin "+main"'
run_case "refspec: in a compound command"       $BLOCKED \
  'npm test && git push origin +main'
# Composes with the global-option normalization: the `-c` splits the token run
# AND there is no force flag, so this needs both fixes to be caught.
run_case "refspec: -c global option then +main" $BLOCKED \
  'git -c user.name=x push origin +main'
run_case "refspec: -C global option then +main" $BLOCKED \
  'git -C /some/path push origin +HEAD:master'

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
echo "--- the refspec rule must not over-match ------------------------"
# The refspec rule is the one place in this hook where a ref NAME decides the
# verdict, so `\b(main|master)\b` is the wrong tool: \b treats `-`, `.` and `/`
# as word boundaries, which makes `\bmain\b` match inside `+docs/main-page`,
# `+main-page` and `+release/main-v2`. Every case below is a legitimate forced
# push to somewhere that is not main, and each one is what a naive \b matcher
# would have broken.
run_case "refspec: +feature:feature"        $ALLOWED 'git push origin +feature:feature'
run_case "refspec: branch named +main-page" $ALLOWED 'git push origin +main-page'
run_case "refspec: path containing main"    $ALLOWED 'git push origin +docs/main-page'
run_case "refspec: dst path containing main" $ALLOWED \
  'git push origin +feature:docs/main-page'
run_case "refspec: dotted name w/ main"     $ALLOWED 'git push origin +release.main.v2'
run_case "refspec: main as a substring"     $ALLOWED 'git push origin +mainline'
run_case "refspec: main as a suffix"        $ALLOWED 'git push origin +remainder'
run_case "refspec: master as a prefix"      $ALLOWED 'git push origin +masterclass'
# Source main, destination a feature branch. This force-updates `feature` FROM
# `main` and does nothing to main's history, so it is not what rule 2 guards.
# It is also the exact case a "does the line contain +...main" matcher gets
# wrong, which is why the destination is read after the colon.
run_case "refspec: +main:feature"           $ALLOWED 'git push origin +main:feature'
run_case "refspec: +master:feature"         $ALLOWED 'git push origin +master:feature'
# A plain (non-forced) push has no `+` and is not this rule's business.
run_case "refspec: unforced push to main"   $ALLOWED 'git push origin main'
run_case "refspec: unforced HEAD:main"      $ALLOWED 'git push origin HEAD:main'
# `+` outside a push refspec position must not trip it.
run_case "refspec: + in a pathspec"         $ALLOWED 'git add "src/a+main.ts"'
run_case "refspec: + in a log range"        $ALLOWED 'git log --grep="+main" --oneline'

echo ""
echo "--- BYPASS: whole-repo force push names no branch ---------------"
# Rules 2 and 2b both decide on a NAME -- rule 2 needs a literal main/master on
# the line, rule 2b needs main/master as a `+`-refspec destination. These two
# forms force-update every branch on the remote, main included, and name none
# of them, so neither rule could fire. Both returned exit 0 against the pre-fix
# hook (probed, not theorised). First recorded as open in PR #2178/#2181; the
# fix in #2181 merged into a stacked base and never reached main (SCRUM-3492).
run_case "whole-repo: --force --all"            $BLOCKED 'git push --force --all origin'
run_case "whole-repo: --all --force"            $BLOCKED 'git push --all --force origin'
run_case "whole-repo: -f --all"                 $BLOCKED 'git push -f --all origin'
run_case "whole-repo: --force-with-lease --all" $BLOCKED \
  'git push --force-with-lease --all origin'
# --mirror needs no force flag: it force-updates every ref by definition, and
# additionally DELETES remote refs that are absent locally.
run_case "whole-repo: --mirror"                 $BLOCKED 'git push --mirror origin'
run_case "whole-repo: --mirror, no remote"      $BLOCKED 'git push --mirror'
run_case "whole-repo: --mirror at end of line"  $BLOCKED 'git push origin --mirror'
# Composes with the global-option normalization, same as rule 2b does.
run_case "whole-repo: -c global then --mirror"  $BLOCKED \
  'git -c user.name=x push --mirror origin'
run_case "whole-repo: -C global then --all"     $BLOCKED \
  'git -C /some/path push --force --all origin'
run_case "whole-repo: after &&"                 $BLOCKED \
  'npm test && git push --force --all origin'
# A shell OPERATOR may follow the flag with no space in between -- bash ends the
# word at `;`, `&`, `|`, `>`, `<` and `)` on its own. Terminating the flag on
# whitespace-or-end-of-line alone therefore left the whole rule bypassable by
# typing one extra character: `git push --mirror;echo done` is the same
# whole-repo force push as `git push --mirror`, and returned exit 0. Found in
# review of this change; the flag boundary is a negated ref-name class instead.
run_case "whole-repo: --mirror then &&"         $BLOCKED 'git push --mirror&&echo done'
run_case "whole-repo: --mirror then ;"          $BLOCKED 'git push --mirror;echo done'
run_case "whole-repo: --mirror then |"          $BLOCKED 'git push --mirror|tee log'
run_case "whole-repo: --mirror then redirect"   $BLOCKED 'git push --mirror>log'
run_case "whole-repo: --mirror in a subshell"   $BLOCKED '(git push --mirror)'
run_case "whole-repo: --all then &&"            $BLOCKED 'git push --force --all&&echo done'
run_case "whole-repo: --all then redirect"      $BLOCKED 'git push --force --all>log 2>&1'
# `--mirror` takes no value, so `--mirror=x` is not valid git -- but the guard
# must not be the thing that decides that. Fail closed on the prefix.
run_case "whole-repo: --mirror=x"               $BLOCKED 'git push --mirror=x origin'

echo ""
echo "--- the whole-repo rule must not over-match ---------------------"
# An UNFORCED push of every branch is not destructive -- it is still rejected
# non-fast-forward -- so `--all` blocks only alongside a force flag.
run_case "whole-repo: --all, no force flag" $ALLOWED 'git push --all origin'
run_case "whole-repo: --tags"               $ALLOWED 'git push --tags origin'
# The flag boundary widened above must still end at the FLAG. A longer option
# that merely starts with the same letters is a different option and must not
# be read as `--all` / `--mirror`.
run_case "whole-repo: longer --all* flag"   $ALLOWED 'git push --force --allow-x origin'
run_case "whole-repo: longer --mirror* flag" $ALLOWED 'git push --mirrored origin'
# `--mirror` is a clone flag too, and there it is read-only.
run_case "whole-repo: clone --mirror"       $ALLOWED \
  'git clone --mirror https://example.invalid/r.git'
# The rule keeps each match inside ONE shell command, so a later unrelated
# `git clone --mirror` is not attributed back to the push before it.
run_case "whole-repo: push then clone"      $ALLOWED \
  'git push origin feature && git clone --mirror https://example.invalid/r.git'
run_case "whole-repo: message mentioning it" $ALLOWED \
  'git commit -m "docs: explain push --mirror"'

echo ""
echo "--- BYPASS: a wildcard destination expands to main --------------"
# The same "no name on the line" gap as above, one step subtler. Rule 2b
# requires a literal main/master destination COMPONENT, so a refspec whose
# destination is a glob at branch level slipped past it while expanding to
# every branch on the remote. Each case returned exit 0 against the pre-fix
# hook. Recovered from the orphaned PR #2181 diff and re-probed here.
run_case "wildcard: +refs/heads/*:refs/heads/*" $BLOCKED \
  'git push origin +refs/heads/*:refs/heads/*'
run_case "wildcard: +refs/*:refs/*"             $BLOCKED 'git push origin +refs/*:refs/*'
run_case "wildcard: +refs/heads/*"              $BLOCKED 'git push origin +refs/heads/*'
run_case "wildcard: +*:*"                       $BLOCKED 'git push origin +*:*'
run_case "wildcard: quoted"                     $BLOCKED \
  'git push origin "+refs/heads/*:refs/heads/*"'
run_case "wildcard: -c global then +refs/*"     $BLOCKED \
  'git -c a=b push origin +refs/heads/*:refs/heads/*'
# Forced by FLAG instead of by `+` -- the same push, spelled the other way.
run_case "wildcard: force flag, no +"           $BLOCKED \
  'git push --force origin refs/heads/*:refs/heads/*'
run_case "wildcard: -f, no +"                   $BLOCKED 'git push -f origin refs/*:refs/*'
run_case "wildcard: force flag after refspec"   $BLOCKED \
  'git push origin refs/heads/*:refs/heads/* --force'

echo ""
echo "--- the wildcard rule must not over-match -----------------------"
# Branch LEVEL is what decides, not the mere presence of a `*`. The wildcard
# has to sit where the branch's own name sits -- bare `*`, `refs/*`,
# `refs/heads/*` -- to be able to expand to main. One level deeper it cannot.
run_case "wildcard: unforced refs/heads/*"  $ALLOWED \
  'git push origin refs/heads/*:refs/heads/*'
run_case "wildcard: dst below branch level" $ALLOWED \
  'git push origin +feature:refs/heads/feature/*'
run_case "wildcard: dst below level, flag"  $ALLOWED \
  'git push --force origin refs/heads/feature/*:refs/heads/feature/*'
run_case "wildcard: +refs/heads/feature/*"  $ALLOWED 'git push origin +refs/heads/feature/*'
# Tags are not branches; this cannot touch main's history.
run_case "wildcard: tags glob"              $ALLOWED 'git push origin +refs/tags/*:refs/tags/*'
# A shell glob in a LATER command must not be read as this push's destination.
run_case "wildcard: glob in a later command" $ALLOWED \
  'git push --force origin claude/my-feature && ls *.ts'
run_case "wildcard: glob after a ;"         $ALLOWED \
  'git push --force origin claude/my-feature; echo *'
run_case "wildcard: glob in a message"      $ALLOWED 'git commit -m "ci: match refs/heads/*"'

echo ""
echo "--- BYPASS: a backslash-newline continuation splits the line ----"
# Every rule here greps, and grep is LINE-oriented. A shell line continuation
# is one command to bash but two lines to grep, so the anchor and the flag land
# on opposite sides of the split and no rule can see both. This defeats every
# rule family in the file at once, rule 1 included. Probed: all exit 0.
run_case "continuation: before +main"       $BLOCKED $'git push origin \\\n  +main'
run_case "continuation: before --force"     $BLOCKED $'git push \\\n  --force origin main'
run_case "continuation: before --no-verify" $BLOCKED $'git commit -m x \\\n  --no-verify'
run_case "continuation: inside gh pr merge" $BLOCKED $'gh pr \\\n  merge 123 --squash'
run_case "continuation: after git"          $BLOCKED $'git \\\n  push --force origin main'
run_case "continuation: before --mirror"    $BLOCKED $'git push \\\n  --mirror origin'

echo ""
echo "--- joining continuations must not join separate commands -------"
# Only a BACKSLASH-newline is a continuation. A bare newline is a command
# SEPARATOR, and joining those too would splice unrelated commands into one
# line -- the case below would become "...claude/my-feature git log main" and
# trip rule 2. That is the difference between a stricter guard and a broken one.
run_case "separator: two commands, no backslash" $ALLOWED \
  $'git push --force origin claude/my-feature\ngit log main'
run_case "separator: benign continuation"        $ALLOWED \
  $'git push --set-upstream \\\n  origin claude/my-feature'
run_case "separator: continuation in a commit"   $ALLOWED \
  $'git commit -m "wip" \\\n  --allow-empty'

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

# Rules 2c and 2d scan forward from `git push` with `[^;&|]*` before matching,
# so a long single-command push line is the shape that exercises THEM (the
# cases above exit at rule 2, or never reach a push at all). A long refspec
# list that matches nothing forces the full failed scan.
big_refspecs=""
for _ in $(seq 1 200); do big_refspecs+="claude/feature-branch "; done
run_case_bounded "200 refspecs, none of them main"       $ALLOWED \
  "git push origin ${big_refspecs}" 10
run_case_bounded "200 refspecs then a wildcard dst"      $BLOCKED \
  "git push --force origin ${big_refspecs}refs/heads/*" 10

echo ""
echo "--- rule 1: the read-only help form must not block --------------"
# SCRUM-3656. `gh pr merge --help` prints usage and merges nothing, and the
# guard blocking it broke ordinary doc work (it fired on any command merely
# CONTAINING the merge string). The carve-out is token-exact in the
# next-token position ONLY; every blocked case below pins why it is narrow.
run_case "merge --help allowed"             $ALLOWED 'gh pr merge --help'
run_case "merge -h allowed"                 $ALLOWED 'gh pr merge -h'
run_case "merge --help piped"               $ALLOWED 'gh pr merge --help | cat'
run_case "merge -h then &&"                 $ALLOWED 'gh pr merge -h && echo done'
run_case "subshell merge --help allowed"    $ALLOWED '(gh pr merge --help)'
# A selector before --help still shows help in gh, but this guard cannot
# cheaply tell that from a flag VALUE, so anything but the immediate
# next-token form stays blocked -- over-block, the safe direction.
run_case "merge 123 --help still blocked"   $BLOCKED 'gh pr merge 123 --squash --help'
# --help in a VALUE position is a REAL merge (its body is "--help").
run_case "merge --body --help blocked"      $BLOCKED 'gh pr merge 123 --body --help'
# --help=false DISABLES help and the merge runs: exact-token match, never a
# prefix match.
run_case "merge --help=false blocked"       $BLOCKED 'gh pr merge --help=false'
# A quoted token is not the exact token; over-block, safe direction.
run_case "merge quoted --help blocked"      $BLOCKED 'gh pr merge "--help"'
# A newline is a command SEPARATOR: line one is a real merge of the current
# branch's PR. The gap before the help token is space/tab only.
run_case "merge then newline --help"        $BLOCKED $'gh pr merge\n--help'
# EVERY merge occurrence on the line must be the help form.
run_case "help then a real merge"           $BLOCKED 'gh pr merge --help && gh pr merge 123 --merge'
run_case "bare merge still blocked"         $BLOCKED 'gh pr merge'
# The anchor class gained `(`: a subshell wrapper is the same command, and
# `(gh pr merge 123 --squash)` returned exit 0 against the pre-fix hook
# (probed 2026-08-30) because `(` was not in the separator class.
run_case "subshell merge blocked"           $BLOCKED '(gh pr merge 123 --squash)'

echo ""
echo "--- BYPASS: a transient user alias resolves inside git ----------"
# SCRUM-3702. `git -c alias.p=push p --force origin main`: the definition is
# a global option the normalizer used to STRIP, and `p` only becomes `push`
# inside git -- so every rule saw `git p ...` and the whole force-push family
# was fail-open behind one flag. Each case below returned exit 0 against the
# pre-fix hook.
run_case "alias: -c alias.p=push"               $BLOCKED 'git -c alias.p=push p --force origin main'
run_case "alias: attached -calias.p=push"       $BLOCKED 'git -calias.p=push p -f origin main'
run_case "alias: whole def quoted"              $BLOCKED "git -c 'alias.fp=push --force' fp origin main"
run_case "alias: value quoted"                  $BLOCKED "git -c alias.fp='push --force' fp origin main"
run_case "alias: chain a->b->push"              $BLOCKED 'git -c alias.a=b -c alias.b=push a --force origin main'
run_case "alias: chain tail keeps flags"        $BLOCKED 'git -c alias.a="b --force" -c alias.b=push a origin main'
run_case "alias: commit --no-verify"            $BLOCKED 'git -c alias.ci=commit ci --no-verify -m x'
run_case "alias: shell (!) expansion"           $BLOCKED "git -c 'alias.x=!git push --force origin main' x"
run_case "alias: quoted invocation"             $BLOCKED 'git -c alias.p=push "p" --force origin main'
run_case "alias: after &&"                      $BLOCKED 'npm test && git -c alias.p=push p --force origin main'
run_case "alias: +refspec via alias"            $BLOCKED 'git -c alias.p=push p origin +main'
run_case "alias: stacked with other globals"    $BLOCKED 'git --no-pager -c alias.p=push p --force origin main'
# Chasing a chain INTO a shadowing alias must stop at the builtin: git
# ignores alias.push, so `a` expands to the REAL push here.
run_case "alias: chain into shadowed push"      $BLOCKED 'git -c alias.push=status -c alias.a=push a --force origin main'
# An env-indirect definition cannot be resolved by a text hook; fail CLOSED
# on the construction itself.
run_case "alias: --config-env= def"             $BLOCKED 'git --config-env=alias.p=EV p --force origin main'
run_case "alias: --config-env separated"        $BLOCKED 'git --config-env alias.p=EV p --force origin main'
run_case "alias: --config-env quoted"           $BLOCKED "git --config-env='alias.p=EV' p -f origin main"

echo ""
echo "--- alias resolution must not over-match or launder --------------"
# git IGNORES an alias that shadows a builtin: `git -c alias.push=status
# push --force origin main` runs the REAL push. Resolution must therefore
# never substitute away the verbs the rules anchor on. Both were blocked
# before the alias fix and must stay blocked after it -- they are what stops
# the resolver from becoming a laundering primitive.
run_case "shadowed push stays blocked"      $BLOCKED 'git -c alias.push=status push --force origin main'
run_case "shadowed commit stays blocked"    $BLOCKED 'git -c alias.commit=status commit --no-verify -m x'
# Benign aliases and benign expansions stay allowed.
run_case "alias to a benign subcommand"     $ALLOWED 'git -c alias.s=status s'
run_case "alias to pull, naming main"       $ALLOWED 'git -c alias.p=pull p origin main'
run_case "alias defined but not invoked"    $ALLOWED 'git -c alias.p=push status'
run_case "alias defined, other subcommand"  $ALLOWED 'git -c alias.p=push fetch origin main'
run_case "alias push to a feature branch"   $ALLOWED 'git -c alias.p=push p origin feature-branch'
run_case "alias named force, benign use"    $ALLOWED 'git -c alias.force=push force origin feature-branch'
run_case "prose defining an alias"          $ALLOWED 'git commit -m "docs: git -c alias.p=push explains the bypass"'
run_case "config-env that is not an alias"  $ALLOWED 'git --config-env=user.name=EV commit -m x'
# Quoting the FULL bypass in prose now trips the guard against it -- the same
# accepted over-block class as quoting `git push --force origin main`
# directly (see scripts/agent/agents.md, 2026-08-23); recorded here so the
# class cannot flip silently in either direction.
run_case "prose quoting the full bypass"    $BLOCKED 'echo "git -c alias.p=push p --force origin main"'
# An alias cycle cannot run anything (git refuses alias loops); resolution
# must terminate and leave the name in place rather than hang or guess.
run_case_bounded "alias cycle stays bounded"    $ALLOWED \
  'git -c alias.a=b -c alias.b=a a --force origin main' 10
big_aliases=""
for _ in $(seq 1 200); do big_aliases+="-c alias.p=push "; done
run_case_bounded "200 alias defs then invocation"   $BLOCKED \
  "git ${big_aliases}p --force origin main" 10
run_case_bounded "200 alias defs then benign work"  $ALLOWED \
  "git ${big_aliases}status --porcelain" 10

echo ""
echo "--- sibling hook: staging-evidence gh calls are time-bounded ----"
# SCRUM-3656. check-staging-evidence-pre-merge.sh makes a network call
# (`gh pr view`) from inside a PreToolUse hook. Un-timeouted, a hung call
# wedges the session's Bash tool at the exact moment the agent runs a
# `gh pr ready`. Static half: the calls must go through the bounded runner.
STAGING_HOOK="${REPO_ROOT}/.claude/hooks/check-staging-evidence-pre-merge.sh"
if /usr/bin/grep -q 'bounded_gh pr view' "$STAGING_HOOK"; then
  echo "  PASS  staging hook routes pr view through bounded_gh"
  PASS=$((PASS + 1))
else
  echo "  FAIL  staging hook does not route pr view through a bounded runner"
  FAIL=$((FAIL + 1))
fi
if /usr/bin/grep -qE '\$\(gh pr view' "$STAGING_HOOK"; then
  echo "  FAIL  staging hook still calls gh pr view unbounded"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  no unbounded gh pr view call remains"
  PASS=$((PASS + 1))
fi
# Functional half: with gh shimmed to hang for 60s and a 1s budget, the hook
# must come back quickly AND fail closed (deny). Clocked like
# run_case_bounded, because an unbounded hook presents as a hang, not as a
# failed assert.
shim_dir=$(mktemp -d)
printf '#!/bin/bash\nexec sleep 60\n' >"${shim_dir}/gh"
chmod +x "${shim_dir}/gh"
out_f=$(mktemp)
{ payload 'gh pr ready 123' \
    | ARKOVA_HOOK_GH_TIMEOUT=1 PATH="${shim_dir}:${PATH}" bash "$STAGING_HOOK" \
        >"$out_f" 2>/dev/null
  echo $? >"${out_f}.rc"; } &
pid=$!
waited=0
hung=false
while kill -0 "$pid" 2>/dev/null; do
  if (( waited >= 150 )); then   # 15s ceiling; the bounded path takes ~1-2s
    kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    hung=true
    break
  fi
  sleep 0.1
  waited=$((waited + 1))
done
if [[ "$hung" == "true" ]]; then
  echo "  FAIL  staging hook hung >15s on a stalled gh (no effective timeout)"
  FAIL=$((FAIL + 1))
else
  wait "$pid" 2>/dev/null
  staging_rc=$(cat "${out_f}.rc" 2>/dev/null || echo 99)
  if [[ "$staging_rc" == "0" ]] \
     && /usr/bin/grep -q '"permissionDecision": "deny"' "$out_f"; then
    echo "  PASS  stalled gh: hook returned within budget and failed closed"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  stalled gh: expected exit 0 + deny JSON, got rc=${staging_rc}"
    sed 's/^/        /' "$out_f"
    FAIL=$((FAIL + 1))
  fi
fi
rm -rf "$shim_dir" "$out_f" "${out_f}.rc"

echo ""
echo "--- summary ----------------------------------------------------"
echo "PASS=${PASS} FAIL=${FAIL}"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
exit 0
