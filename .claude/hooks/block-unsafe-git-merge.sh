#!/usr/bin/env bash
# .claude/hooks/block-unsafe-git-merge.sh
#
# PreToolUse hook on Bash. Blocks any command that injects a merge DRIVER —
# whether one-off (`git -c` / `--config-env` / `GIT_CONFIG_*` in the env) or
# persisted (`git config merge.<x>.driver …`). Exit 2 + stderr blocks the call.
#
# Why this exists as a separate layer. `scripts/agent/check-git-merge-config.sh`
# reads git CONFIG, so it catches the persisted form a session later and cannot
# see the one-off form at all:
#
#     git -c merge.union.driver=true merge origin/main
#
# has exactly the effect of the `.git/config` entry behind the 2026-07-28
# incident — it shadows git's BUILT-IN union driver, which `.gitattributes`
# requests for ~200 agents.md files, with the shell no-op `true` (writes nothing
# to %A, exits 0). Every conflicting agents.md merge then silently keeps "ours"
# and discards "theirs": no conflict markers, no error, no non-zero exit. It
# leaves no config trace for the session-start guard to find.
#
# On 2026-08-11 an agent merging main into PR #2060 was instructed to run that
# exact command, ran it, and dropped 100 lines of main's agents.md content
# across src/lib/agents.md and src/pages/agents.md. The session-start guard had
# just reported "OK". The only thing that caught it was
# scripts/ci/check-agents-md-append-only.ts — after the merge was committed and
# pushed. This hook is the earliest point that failure can be stopped: before
# the working tree is touched at all.
#
# THE CORRECT COMMAND IS A PLAIN `git merge origin/main`. `.gitattributes`
# (`agents.md merge=union`) plus git's built-in union driver already combine
# both sides. Any `merge.union.driver` value — config or `-c` — makes it worse,
# never better; the built-in needs no driver config to work.
#
# Diagnostics and remediation are deliberately NOT blocked: the guard's own fix
# hint prints `git config --get-regexp …` and `git config --unset …`, and
# blocking those would make the recovery path unrunnable by the agent that just
# tripped this. Tests: scripts/agent/check-unsafe-git-merge.test.sh.

set -u
input="$(cat)"
cmd="$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except: pass' 2>/dev/null || true)"

[ -z "$cmd" ] && exit 0

quote="[\"']"
driver="merge\\.[A-Za-z0-9_.-]+\\.driver"

explain() {
  printf 'BLOCKED by .claude/hooks/block-unsafe-git-merge.sh: %s\n' "$1" >&2
  cat >&2 <<'EOF'

  A merge driver named `union`, `text` or `binary` OVERRIDES git's built-in
  algorithm of that name. `.gitattributes` requests `merge=union` for ~200
  agents.md files, so a no-op driver (`true`, `:`, `exit 0`, `cat %A`) makes
  every conflicting agents.md merge silently keep "ours" and discard "theirs" —
  no conflict markers, no error, exit 0. That is the 2026-07-28 incident, and
  the `-c` form reproduced it on PR #2060 (100 lines of main dropped) because it
  leaves no config trace for the session-start guard to find.

  The correct command is a plain:

      git merge origin/main

  `.gitattributes` + git's BUILT-IN union driver already do the right thing.
  Any `merge.union.driver` value makes it worse, never better.

  Still allowed: `git config --get-regexp '^merge\..*\.driver'` (diagnose) and
  `git config --unset merge.union.driver` (remediate).

  If you are only DOCUMENTING the bad command, write the file with the Edit or
  Write tool rather than a shell heredoc — this hook reads the command text.
EOF
  exit 2
}

# 1. One-off injection: `git -c merge.<x>.driver=…` / `--config-env`.
#    `-c` is not merge-specific — rebase, cherry-pick, revert and `stash pop`
#    all run merge drivers — so the injection is what is blocked, not the
#    subcommand it rides on.
if printf '%s' "$cmd" | /usr/bin/grep -qE -- "-c[[:space:]]+${quote}?${driver}[[:space:]]*="; then
  explain 'one-off merge-driver injection via `git -c`.'
fi
if printf '%s' "$cmd" | /usr/bin/grep -qE -- "--config-env([[:space:]]|=)+${quote}?${driver}="; then
  explain 'one-off merge-driver injection via `git --config-env`.'
fi

# 2. The same thing through the environment git reads config from.
if printf '%s' "$cmd" | /usr/bin/grep -qE "GIT_CONFIG_PARAMETERS=.*${driver}"; then
  explain 'merge-driver injection via GIT_CONFIG_PARAMETERS.'
fi
if printf '%s' "$cmd" | /usr/bin/grep -qE "GIT_CONFIG_KEY_[0-9]+=${quote}?${driver}"; then
  explain 'merge-driver injection via GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n.'
fi

# 3. Turning off .githooks/pre-merge-commit, which is the git-level backstop for
#    everything above when the merge is run outside this tool.
if printf '%s' "$cmd" | /usr/bin/grep -qE 'ARKOVA_SKIP_MERGE_GUARD='; then
  explain 'ARKOVA_SKIP_MERGE_GUARD disables the pre-merge-commit driver check.'
fi

# 4. Persisting it — the 2026-07-28 config itself. Judged per segment: a read
#    flag anywhere in a compound line must not launder a write in another
#    segment (`git config --get-regexp … && git config --local merge…driver x`).
while IFS= read -r segment; do
  [ -z "$segment" ] && continue
  printf '%s' "$segment" | /usr/bin/grep -qE '(^|[^A-Za-z0-9_./-])git([[:space:]]|$)' || continue
  printf '%s' "$segment" | /usr/bin/grep -qE 'config([[:space:]]|$)' || continue
  printf '%s' "$segment" | /usr/bin/grep -qE "$driver" || continue
  # Reads and removals are the documented diagnosis/fix path.
  printf '%s' "$segment" |
    /usr/bin/grep -qE -- '--(unset|get|list|show-origin|show-scope|name-only)' && continue
  explain 'writing a merge driver into git config (this is the 2026-07-28 config).'
done < <(printf '%s\n' "$cmd" | /usr/bin/tr ';&|' '\n')

exit 0
