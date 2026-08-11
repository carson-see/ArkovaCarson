#!/usr/bin/env bash
# scripts/agent/check-unsafe-git-merge.test.sh
#
# Pins the ONE-OFF merge-driver vector that `check-git-merge-config.sh` cannot
# see, and the two guards that close it.
#
#     git -c merge.union.driver=true merge origin/main
#
# has exactly the same effect as the persisted `.git/config` entry that caused
# the 2026-07-28 incident — it shadows git's BUILT-IN union driver (requested by
# `.gitattributes` for ~200 agents.md files) with the shell no-op `true`, so
# every conflicting agents.md merge silently keeps "ours", discards "theirs",
# and reports success. But `-c` writes nothing to config, so a guard that reads
# config from a SIBLING process is structurally blind to it. On 2026-08-11 an
# agent on PR #2060 was told to run that exact command, ran it, and dropped 100
# lines of main's agents.md content; the session-start guard had just printed
# "OK", and only `scripts/ci/check-agents-md-append-only.ts` caught it — after
# the bad merge was committed and pushed.
#
# The suite is organized as the argument itself:
#   1. what the two commands actually DO           (the invariant being protected)
#   2. why config inspection cannot see the `-c` form  (the hole, asserted)
#   3. `.githooks/pre-merge-commit` closes it      (git-level, any caller)
#   4. `.claude/hooks/block-unsafe-git-merge.sh`   (agent-level, before it runs)
#
# Everything runs in throwaway repos under $TMPDIR. Touches no remote, no PR, no
# staging, no evidence.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd -P)
GUARD="${SCRIPT_DIR}/check-git-merge-config.sh"
GIT_HOOK="${REPO_ROOT}/.githooks/pre-merge-commit"
INSTALLER="${SCRIPT_DIR}/install-git-merge-hooks.sh"
CLAUDE_HOOK="${REPO_ROOT}/.claude/hooks/block-unsafe-git-merge.sh"

# Hermetic git: a stray `merge.union.driver` in the developer's ~/.gitconfig
# would otherwise make section 1's "plain merge keeps both sides" case fail for
# a reason that has nothing to do with the code under test.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

PASS=0
FAIL=0

require() {
  # FAIL, never skip — a green check that silently skipped reads as validation
  # of whatever change is in flight (scripts/agent/agents.md, 2026-08-02).
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: '$1' is required by this suite." >&2
    exit 1
  }
}
require git
require python3

check() { # check <name> <want> <got>
  if [[ "$3" == "$2" ]]; then
    echo "  PASS  $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1  got=[$3] want=[$2]"
    FAIL=$((FAIL + 1))
  fi
}

has() { grep -qF -- "$2" "$1" && echo present || echo MISSING; }

# A scratch repo shaped like this one: `.gitattributes` asks for the BUILT-IN
# union driver on agents.md, and `feature` and `main` each append a distinct
# line to it. A correct merge of main into feature ends with BOTH lines.
# `check-git-merge-config.sh` is dropped in at its real repo-relative path so
# `.githooks/pre-merge-commit` resolves it exactly as it does in production.
make_union_repo() {
  local dir
  dir=$(mktemp -d)
  git -C "$dir" init -q -b main .
  git -C "$dir" config user.email t@t
  git -C "$dir" config user.name t
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config core.hooksPath "$dir/.git/hooks"
  printf 'agents.md merge=union\n' >"$dir/.gitattributes"
  printf -- '- base line one, long enough to be a real entry\n' >"$dir/agents.md"
  git -C "$dir" add -A
  git -C "$dir" commit -qm base
  git -C "$dir" checkout -qb feature
  printf -- '- OURS: line added on the feature branch\n' >>"$dir/agents.md"
  git -C "$dir" commit -qam feature
  git -C "$dir" checkout -q main
  printf -- '- THEIRS: line added on main\n' >>"$dir/agents.md"
  git -C "$dir" commit -qam mainside
  git -C "$dir" checkout -q feature
  mkdir -p "$dir/scripts/agent" "$dir/.githooks"
  cp "$GUARD" "$dir/scripts/agent/check-git-merge-config.sh"
  cp "$INSTALLER" "$dir/scripts/agent/install-git-merge-hooks.sh"
  cp "$GIT_HOOK" "$dir/.githooks/pre-merge-commit"
  chmod +x "$dir/.githooks/pre-merge-commit"
  printf '%s\n' "$dir"
}

install_git_hook() {
  mkdir -p "$1/.git/hooks"
  cp "$GIT_HOOK" "$1/.git/hooks/pre-merge-commit"
  chmod +x "$1/.git/hooks/pre-merge-commit"
}

# Feeds a Bash command to the PreToolUse hook in the payload shape Claude Code
# sends. Exit 2 = blocked, 0 = allowed.
run_hook_case() { # run_hook_case <name> <want-exit> <command>
  local name="$1" want="$2" cmd="$3" payload got
  payload=$(CMD="$cmd" python3 -c \
    'import json,os;print(json.dumps({"tool_name":"Bash","tool_input":{"command":os.environ["CMD"]}}))')
  printf '%s' "$payload" | bash "$CLAUDE_HOOK" >/dev/null 2>&1
  got=$?
  check "$name" "$want" "$got"
}

echo ""
echo "--- 1. what the two merge commands actually do ----------------"
# This section asserts git's behaviour, not ours. It is the reason every other
# rule here exists: if a future git made `-c` stop shadowing the built-in, or
# made the built-in stop combining, these are the cases that would say so.

dir=$(make_union_repo)
git -C "$dir" merge main -m merged >/dev/null 2>&1
check "plain 'git merge' exits 0" 0 $?
check "plain 'git merge' KEEPS theirs (built-in union)" present "$(has "$dir/agents.md" 'THEIRS: line added on main')"
check "plain 'git merge' KEEPS ours" present "$(has "$dir/agents.md" 'OURS: line added on the feature branch')"
check "plain 'git merge' leaves no conflict markers" MISSING "$(has "$dir/agents.md" '<<<<<<<')"
rm -rf "$dir"

dir=$(make_union_repo)
git -C "$dir" -c merge.union.driver=true merge main -m merged >/dev/null 2>&1
check "'-c merge.union.driver=true' still exits 0 (silent)" 0 $?
check "'-c merge.union.driver=true' DROPS theirs" MISSING "$(has "$dir/agents.md" 'THEIRS: line added on main')"
check "'-c ...' leaves no conflict markers to notice" MISSING "$(has "$dir/agents.md" '<<<<<<<')"
check "'-c ...' records the merge commit anyway" 2 "$(git -C "$dir" rev-list --parents -n1 HEAD | wc -w | tr -d ' ' | awk '{print $1-1}')"
rm -rf "$dir"

# `--config-env` is the same injection with the value read from the environment;
# it must be treated identically wherever `-c` is.
dir=$(make_union_repo)
DRIVER=true git -C "$dir" --config-env=merge.union.driver=DRIVER merge main -m merged >/dev/null 2>&1
check "'--config-env=merge.union.driver' DROPS theirs" MISSING "$(has "$dir/agents.md" 'THEIRS: line added on main')"
rm -rf "$dir"

echo ""
echo "--- 2. config inspection is blind to the one-off form ---------"
# Not a bug in the guard — a limit of WHERE it runs. Asserted so the limit is
# represented in tests rather than rediscovered by another dropped merge.

dir=$(make_union_repo)
(cd "$dir" && bash "$GUARD") >/dev/null 2>&1
check "guard passes in a repo about to take a '-c' merge" 0 $?
check "…and no driver is written to config by '-c'" "" \
  "$(git -C "$dir" config --get-regexp '^merge\..*\.driver' 2>/dev/null)"

# Git exports `-c` settings to its subprocesses as GIT_CONFIG_PARAMETERS, so a
# guard invoked FROM a git hook sees the same entry with origin `command line:`.
# That is the whole mechanism section 3 relies on.
(cd "$dir" && GIT_CONFIG_PARAMETERS="'merge.union.driver'='true'" bash "$GUARD") >/dev/null 2>&1
check "guard REJECTS it when git hands it the params" 1 $?
(cd "$dir" && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=merge.union.driver GIT_CONFIG_VALUE_0=true bash "$GUARD") >/dev/null 2>&1
check "guard REJECTS the GIT_CONFIG_COUNT form too" 1 $?
out=$( (cd "$dir" && GIT_CONFIG_PARAMETERS="'merge.union.driver'='true'" bash "$GUARD") 2>&1 )
check "…and does NOT tell you to '--unset' a one-off" no \
  "$(printf '%s' "$out" | grep -q -- '--unset' && echo yes || echo no)"
check "…and names the -c vector in the fix hint" yes \
  "$(printf '%s' "$out" | grep -q -- '-c ' && echo yes || echo no)"
rm -rf "$dir"

echo ""
echo "--- 3. .githooks/pre-merge-commit closes it -------------------"

dir=$(make_union_repo)
install_git_hook "$dir"
before=$(git -C "$dir" rev-parse HEAD)
git -C "$dir" -c merge.union.driver=true merge main -m merged >/dev/null 2>&1
check "hook fails the '-c' merge" 1 $?
check "…so no merge commit is recorded" "$before" "$(git -C "$dir" rev-parse HEAD)"
git -C "$dir" merge --abort >/dev/null 2>&1
rm -rf "$dir"

dir=$(make_union_repo)
install_git_hook "$dir"
before=$(git -C "$dir" rev-parse HEAD)
DRIVER=true git -C "$dir" --config-env=merge.union.driver=DRIVER merge main -m merged >/dev/null 2>&1
check "hook fails the '--config-env' merge" 1 $?
check "…so no merge commit is recorded" "$before" "$(git -C "$dir" rev-parse HEAD)"
git -C "$dir" merge --abort >/dev/null 2>&1
rm -rf "$dir"

dir=$(make_union_repo)
install_git_hook "$dir"
git -C "$dir" config --local merge.union.driver true
git -C "$dir" merge main -m merged >/dev/null 2>&1
check "hook also fails a merge under PERSISTED config" 1 $?
git -C "$dir" merge --abort >/dev/null 2>&1
rm -rf "$dir"

# The expensive failure mode for a merge hook is a false positive: it would
# push people to --no-verify, which turns every guard off at once.
dir=$(make_union_repo)
install_git_hook "$dir"
git -C "$dir" merge main -m merged >/dev/null 2>&1
check "hook lets a plain 'git merge' through" 0 $?
check "…and the plain merge still keeps theirs" present "$(has "$dir/agents.md" 'THEIRS: line added on main')"
rm -rf "$dir"

dir=$(make_union_repo)
install_git_hook "$dir"
git -C "$dir" config --local merge.ours-json.driver 'jq -s ".[0]" %A > %A.tmp && mv %A.tmp %A'
git -C "$dir" merge main -m merged >/dev/null 2>&1
check "hook lets a legitimate custom driver through" 0 $?
rm -rf "$dir"

# A guard that cannot be located must not fail open — but it must say so, and it
# must offer a named escape hatch rather than pushing anyone to --no-verify.
dir=$(make_union_repo)
install_git_hook "$dir"
rm -f "$dir/scripts/agent/check-git-merge-config.sh"
git -C "$dir" merge main -m merged >/dev/null 2>&1
check "hook fails CLOSED when the guard is missing" 1 $?
git -C "$dir" merge --abort >/dev/null 2>&1
ARKOVA_SKIP_MERGE_GUARD=1 git -C "$dir" merge main -m merged >/dev/null 2>&1
check "…with ARKOVA_SKIP_MERGE_GUARD=1 as the documented out" 0 $?
rm -rf "$dir"

echo ""
echo "--- 4. .claude/hooks/block-unsafe-git-merge.sh (agent-level) --"
# The incident was an agent following an instruction. This is the only layer
# that stops the command before the working tree is ever touched.

run_hook_case "blocks the exact PR #2060 command" 2 'git -c merge.union.driver=true merge origin/main'
run_hook_case "blocks it with the value quoted" 2 'git -c "merge.union.driver=true" merge origin/main'
run_hook_case "blocks it single-quoted" 2 "git -c 'merge.union.driver=true' merge origin/main"
run_hook_case "blocks a placeholder-style driver" 2 "git -c merge.union.driver='true %O %A %B' merge origin/main"
run_hook_case "blocks a REAL driver injected one-off" 2 'git -c merge.union.driver=/usr/local/bin/m merge origin/main'
run_hook_case "blocks a non-built-in driver name too" 2 'git -c merge.custom.driver=true merge origin/main'
run_hook_case "blocks --config-env" 2 'DRV=true git --config-env=merge.union.driver=DRV merge origin/main'
run_hook_case "blocks GIT_CONFIG_PARAMETERS" 2 "GIT_CONFIG_PARAMETERS=\"'merge.union.driver'='true'\" git merge origin/main"
run_hook_case "blocks GIT_CONFIG_KEY_n" 2 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=merge.union.driver GIT_CONFIG_VALUE_0=true git merge origin/main'
# -c is not merge-specific: rebase, cherry-pick, revert and stash pop all run
# merge drivers, so the injection is what gets blocked, not the subcommand.
run_hook_case "blocks it on rebase" 2 'git -c merge.union.driver=true rebase origin/main'
run_hook_case "blocks it on cherry-pick" 2 'git -c merge.union.driver=true cherry-pick abc1234'
run_hook_case "blocks it mid-compound-command" 2 'git fetch && git -c merge.union.driver=true merge origin/main'
run_hook_case "blocks it inside bash -c" 2 "bash -c 'git -c merge.union.driver=true merge origin/main'"
run_hook_case "blocks -C worktree flag ordering" 2 'git -C /repo -c merge.union.driver=true merge origin/main'
# Persisting it is the 2026-07-28 config; catching the write is a session
# earlier than catching the config.
run_hook_case "blocks writing it to config" 2 'git config --local merge.union.driver true'
run_hook_case "blocks a global config write" 2 'git config --global merge.union.driver true'
run_hook_case "blocks skipping the merge guard" 2 'ARKOVA_SKIP_MERGE_GUARD=1 git merge origin/main'

echo ""
echo "  (allowed — a false block here costs more than it saves)"
run_hook_case "allows the CORRECT command" 0 'git merge origin/main'
run_hook_case "allows a plain merge with a message" 0 'git merge origin/main -m "merge main"'
run_hook_case "allows an unrelated -c" 0 'git -c user.name=ci commit -m x'
run_hook_case "allows -c core.hooksPath" 0 'git -c core.hooksPath=.githooks merge origin/main'
# The guard's own fix hint prints these two. Blocking them would make the
# remediation path unrunnable by the agent that just tripped the guard.
run_hook_case "allows the DIAGNOSTIC read" 0 "git config --get-regexp '^merge\\..*\\.driver'"
run_hook_case "allows --show-origin read" 0 "git config --show-origin --get-regexp '^merge\\..*\\.driver'"
run_hook_case "allows the REMEDIATION unset" 0 'git config --local --unset merge.union.driver'
run_hook_case "allows --unset-all" 0 'git config --unset-all merge.union.driver'
run_hook_case "allows reading one key" 0 'git config --get merge.union.driver'
# Investigating the incident must not trip the guard that describes it.
run_hook_case "allows grepping for the string" 0 'grep -rn "merge.union.driver" docs/'
run_hook_case "allows the append-only backstop" 0 'node_modules/.bin/tsx scripts/ci/check-agents-md-append-only.ts'
run_hook_case "allows the session-start guard" 0 'bash scripts/agent/check-git-merge-config.sh'
run_hook_case "empty command is a no-op" 0 ''

echo ""
echo "--- 5. the installer that makes section 3 real ----------------"
# A hook nobody installs is not enforcement (CLAUDE.md's own budget rule). This
# checkout is the proof: `core.hooksPath` points at `.git/hooks`, which holds
# nothing but git's .sample files, so `.githooks/pre-commit` has never run here.
# ack-claude-bootstrap.sh calls this installer every session.

dir=$(make_union_repo)
(cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) >/dev/null 2>&1
check "installer exits 0" 0 $?
check "…and writes an executable pre-merge-commit" yes \
  "$([[ -x "$dir/.git/hooks/pre-merge-commit" ]] && echo yes || echo no)"
before=$(git -C "$dir" rev-parse HEAD)
git -C "$dir" -c merge.union.driver=true merge main -m merged >/dev/null 2>&1
check "…which then refuses the '-c' merge for real" 1 $?
check "…recording no merge commit" "$before" "$(git -C "$dir" rev-parse HEAD)"
git -C "$dir" merge --abort >/dev/null 2>&1
git -C "$dir" merge main -m merged >/dev/null 2>&1
check "…and still passes a plain merge" 0 $?
rm -rf "$dir"

dir=$(make_union_repo)
(cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) >/dev/null 2>&1
first=$(cat "$dir/.git/hooks/pre-merge-commit")
(cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) >/dev/null 2>&1
check "installer is idempotent (exit)" 0 $?
check "…and byte-identical on re-run" "$first" "$(cat "$dir/.git/hooks/pre-merge-commit")"
rm -rf "$dir"

# Five worktrees share one hooks dir here. Silently overwriting someone's hook
# would be a second, quieter data-loss bug than the one being fixed.
dir=$(make_union_repo)
mkdir -p "$dir/.git/hooks"
printf '#!/bin/sh\n# someone else already owns this\nexit 0\n' >"$dir/.git/hooks/pre-merge-commit"
chmod +x "$dir/.git/hooks/pre-merge-commit"
(cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) >/dev/null 2>&1
check "installer does not fail on a foreign hook" 0 $?
check "…and leaves it byte-for-byte alone" present \
  "$(has "$dir/.git/hooks/pre-merge-commit" 'someone else already owns this')"
out=$( (cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) 2>&1 )
check "…but says so out loud" yes \
  "$(printf '%s' "$out" | /usr/bin/grep -qi 'not installed\|already\|existing' && echo yes || echo no)"
rm -rf "$dir"

# When core.hooksPath already points at the tracked .githooks directory the hook
# is live from the repo itself; copying it into .git/hooks would fork it.
dir=$(make_union_repo)
git -C "$dir" config core.hooksPath "$dir/.githooks"
(cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) >/dev/null 2>&1
check "no-ops when .githooks is already the hooks path" 0 $?
check "…writing nothing into .git/hooks" no \
  "$([[ -e "$dir/.git/hooks/pre-merge-commit" ]] && echo yes || echo no)"
before=$(git -C "$dir" rev-parse HEAD)
git -C "$dir" -c merge.union.driver=true merge main -m merged >/dev/null 2>&1
check "…because the tracked hook is already enforcing" 1 $?
check "…recording no merge commit" "$before" "$(git -C "$dir" rev-parse HEAD)"
git -C "$dir" merge --abort >/dev/null 2>&1
rm -rf "$dir"

# Bootstrap must never be bricked by hook installation: a read-only or missing
# hooks path is a warning, not a failed session start.
dir=$(make_union_repo)
git -C "$dir" config core.hooksPath "$dir/nonexistent-hooks"
(cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) >/dev/null 2>&1
check "creates a missing hooks path rather than failing" 0 $?
rm -rf "$dir"

dir=$(mktemp -d) # not a git repo at all
(cd "$dir" && bash "$INSTALLER") >/dev/null 2>&1
check "outside a git repo it exits 0, not 1" 0 $?
rm -rf "$dir"

# The hooks dir is shared by every worktree, so the shim also fires on branches
# whose revision predates .githooks/pre-merge-commit. That is an older tree, not
# an anomaly: it must pass quietly rather than print on every unrelated merge.
dir=$(make_union_repo)
(cd "$dir" && bash scripts/agent/install-git-merge-hooks.sh) >/dev/null 2>&1
rm -f "$dir/.githooks/pre-merge-commit"
out=$(git -C "$dir" merge main -m merged 2>&1)
check "shim passes a revision without the tracked hook" 0 $?
check "…silently" no "$(printf '%s' "$out" | /usr/bin/grep -qi 'pre-merge-commit' && echo yes || echo no)"
rm -rf "$dir"

echo ""
echo "--- summary --------------------------------------------------"
echo "PASS=${PASS} FAIL=${FAIL}"
[[ "$FAIL" -eq 0 ]]
