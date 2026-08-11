#!/usr/bin/env bash
# .claude/hooks/block-pr-merge.sh
#
# PreToolUse hook on Bash. Blocks agent-driven PR merges, force-pushes to
# main/master, and --no-verify hook skips. Exit 2 + stderr blocks the call
# (see Claude Code hooks docs).
#
# Enforces CLAUDE.md §0 rule 8 ("Never work on main") and §1.13 ("Tiered merge —
# Claude never merges to main, ever"). Merges land through Mergify once CI is
# green and the Staging Soak Evidence Gate passes; Carson retains final
# admin-merge authority.
#
# Promoted into the repo 2026-08-01. This previously existed only at
# ~/.claude/hooks/block-pr-merge.sh, so merge protection depended on which
# machine the session happened to run on — a cloud agent, a fresh clone, or a
# teammate's laptop got no protection at all. It is version-controlled here so
# the guarantee travels with the repo. The user-level copy is now redundant and
# may be deleted.

set -u
input="$(cat)"
cmd="$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except: pass' 2>/dev/null || true)"

[ -z "$cmd" ] && exit 0

# Join backslash-newline continuations before anything looks at the command.
#
# grep is LINE-oriented: `.*` never spans a newline. Every rule below is shaped
# `git…push.*<thing>`, so a backslash-newline between the two halves -- one
# command to bash, two lines to grep -- walked past all of them. Confirmed by
# probe 2026-08-11: `git push origin \<newline>  +main`, `git push \<newline>
# --force origin main` and `git commit -m x \<newline> --no-verify` all returned
# exit 0. Same "the token run got split" family as the global-option bypass,
# reached by a different route.
#
# ONLY backslash-newline is joined, never a bare newline. Collapsing real
# newlines would let `.*` reach across independent commands, so an unrelated
# later line mentioning `main` would arm a rule that an earlier `git push` line
# started -- turning a fail-open into a noisy fail-closed. Bash itself treats
# exactly this sequence as a line continuation, so this matches what will run.
cmd="${cmd//\\$'\n'/ }"

# Strip git's *global* options so the sub-command sits adjacent to `git` again.
#
# Every rule below anchors on adjacency (`git[[:space:]]+(push|commit)`), but
# git accepts global options between the two: `git -c k=v commit --no-verify`,
# `git -C <path> push --force main`, `--git-dir=`, `--no-pager`. Each one splits
# the token run and the guard silently does not fire. Observed empirically
# 2026-08-11: `git -c user.email=a@b.c commit -m probe --no-verify` executed in
# a live session with this hook active. Same bug class as the union merge-driver
# trap (see the 2026-07-28 section of scripts/agent/agents.md) and the supabase
# global-flag bypass pinned in scripts/agent/check-claude-bootstrap.test.sh.
#
# This NORMALIZES rather than dropping the adjacency anchor. An anchorless
# regex would block any line that merely mentions "push --force ... main" — a
# commit message, a doc edit, an echo. Both directions are pinned by
# scripts/agent/block-pr-merge.test.sh; do not relax either one.
#
# The rewrite itself lives in a committed sibling file, normalize-git-command.py.
# It is deliberately NOT inlined: as a heredoc nested inside `$( )` it is one
# stray character away from making bash consume to EOF, which takes down every
# Bash tool call in the session this hook is supposed to protect; and writing it
# to a temp file to execute adds a disk write plus an exec to a security control.
# A sibling file has neither problem and is independently testable.
#
# Resolved from this script's own directory, not the cwd, so it is found the same
# way from a git worktree as from the repo root.
#
# Fails CLOSED to the raw command: if python3 or the normalizer is missing, or
# the rewrite yields nothing, the rules below still run against the raw command
# at their pre-normalization strength.
_hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
norm="$(ARKOVA_HOOK_CMD="$cmd" /usr/bin/python3 \
  "${_hook_dir}/normalize-git-command.py" 2>/dev/null || true)"
[ -z "$norm" ] && norm="$cmd"

# Carve-out (operator-authorized 2026-07-02): carson-see/arkova-marketing is a
# static Vercel marketing site with no staging rig. Merge-gating is N/A there,
# and Carson granted the agent merge authority for that repo only. This exempts
# ONLY `gh pr merge` commands that explicitly name that repo; the app repo and
# all force-push / --no-verify rules below stay fully enforced.
if printf '%s' "$cmd" | /usr/bin/grep -qE 'gh[[:space:]]+pr[[:space:]]+merge\b' \
   && printf '%s' "$cmd" | /usr/bin/grep -qE 'carson-see/arkova-marketing'; then
  exit 0
fi

# 1. gh pr merge / raw-API PUT|POST to /merge
if printf '%s' "$cmd" | /usr/bin/grep -qE '(^|[[:space:];&|`])gh[[:space:]]+pr[[:space:]]+merge\b'; then
  printf 'BLOCKED by .claude/hooks/block-pr-merge.sh: `gh pr merge` is human-only per CLAUDE.md §0 rule 8 + §1.13 (Claude never merges to main). Mergify auto-merges once CI is green and the Staging Soak Evidence Gate passes; Carson can admin-merge directly.\n' >&2
  exit 2
fi
if printf '%s' "$cmd" | /usr/bin/grep -qE 'gh[[:space:]]+api.*-X[[:space:]]+PUT.*/pulls/[0-9]+/merge'; then
  printf 'BLOCKED: raw GH API PR-merge call. Same rule as above (CLAUDE.md §0 rule 8 / §1.13).\n' >&2
  exit 2
fi
if printf '%s' "$cmd" | /usr/bin/grep -qE 'gh[[:space:]]+api.*-X[[:space:]]+POST.*/pulls/[0-9]+/merge'; then
  printf 'BLOCKED: raw GH API PR-merge call. Same rule as above (CLAUDE.md §0 rule 8 / §1.13).\n' >&2
  exit 2
fi

# 2. Force-push to main / master (any remote), both flag orderings.
# Matches on "$norm" so a global option before `push` cannot split the run.
if printf '%s' "$norm" | /usr/bin/grep -qE 'git[[:space:]]+push.*(--force\b|-f\b|--force-with-lease\b).*\b(main|master)\b'; then
  printf 'BLOCKED: force-push to main/master. CLAUDE.md forbids destructive git ops without explicit approval.\n' >&2
  exit 2
fi
if printf '%s' "$norm" | /usr/bin/grep -qE 'git[[:space:]]+push.*\b(main|master)\b.*(--force\b|-f\b|--force-with-lease\b)'; then
  printf 'BLOCKED: force-push to main/master. CLAUDE.md forbids destructive git ops without explicit approval.\n' >&2
  exit 2
fi

# 2b. Forced refspec push to main / master. The two rules above only look for a
# force FLAG, but a leading `+` on a refspec forces the update per-refspec with
# no flag anywhere on the line. Confirmed by probe 2026-08-11: `git push origin
# +main`, `+main:main` and `+HEAD:master` all returned exit 0 from this hook.
# Independent of the global-option bypass class above -- normalizing the line
# cannot help when there is no flag to find -- so it is its own rule.
#
# The DESTINATION decides. `+feature:main` overwrites main and must block;
# `+main:feature` force-updates `feature` FROM main, leaves main's history
# alone, and must not. So the ref is read after the colon when there is one and
# from the whole token when there is not, with `refs/heads/` allowed as a
# longhand prefix on either side.
#
# A WILDCARD destination also matches, because a glob covers main without ever
# spelling it: `+refs/heads/*:refs/heads/*` and `+refs/*:refs/*` are force-
# pushes to main that the literal-destination form missed (probed, exit 0).
# This over-blocks a glob that provably cannot reach main, e.g. `+docs/*` --
# deliberate, and pinned as such in the test suite. The rule cannot know which
# refs a glob covers; over-blocking a destructive push costs one question to
# Carson, under-blocking costs main.
#
# Boundaries are spelled as explicit character classes rather than `\b`, because
# \b treats `-`, `.` and `/` as word boundaries: `\bmain\b` matches inside
# `+docs/main-page` and `+main-page`, which would block legitimate forced pushes
# to branches that merely contain the substring. Ref-name characters (alnum plus
# . _ - /) are excluded on both sides so only an exact `main`/`master`
# destination matches, and `:` is excluded from the trailing class as well --
# that one exclusion is the whole of what keeps `+main:feature` allowed. Both
# directions are pinned by scripts/agent/block-pr-merge.test.sh; the over-match
# cases there are as load-bearing as the bypass cases.
#
# Matches on "$norm" so a global option before `push` cannot split the run.
if printf '%s' "$norm" | /usr/bin/grep -qE 'git[[:space:]]+push.*[^-_./A-Za-z0-9]\+([^[:space:]:]*:)?(refs/heads/)?(main|master|[^[:space:]:]*\*)([^-_./:A-Za-z0-9]|$)'; then
  printf 'BLOCKED: forced refspec push to main/master -- a leading `+` on a refspec forces the update with no --force flag. CLAUDE.md forbids destructive git ops without explicit approval.\n' >&2
  exit 2
fi

# 3. push/commit --no-verify (skipping hooks). CLAUDE.md mandate.
# Matches on "$norm" — see rule 2.
if printf '%s' "$norm" | /usr/bin/grep -qE 'git[[:space:]]+(push|commit).*--no-verify\b'; then
  printf 'BLOCKED: --no-verify skips hooks. CLAUDE.md forbids unless Carson explicitly OKs.\n' >&2
  exit 2
fi

exit 0
