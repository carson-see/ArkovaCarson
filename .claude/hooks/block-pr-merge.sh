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
if printf '%s' "$cmd" | /usr/bin/grep -qE 'git[[:space:]]+push.*(--force\b|-f\b|--force-with-lease\b).*\b(main|master)\b'; then
  printf 'BLOCKED: force-push to main/master. CLAUDE.md forbids destructive git ops without explicit approval.\n' >&2
  exit 2
fi
if printf '%s' "$cmd" | /usr/bin/grep -qE 'git[[:space:]]+push.*\b(main|master)\b.*(--force\b|-f\b|--force-with-lease\b)'; then
  printf 'BLOCKED: force-push to main/master. CLAUDE.md forbids destructive git ops without explicit approval.\n' >&2
  exit 2
fi

# 3. push/commit --no-verify (skipping hooks). CLAUDE.md mandate.
if printf '%s' "$cmd" | /usr/bin/grep -qE 'git[[:space:]]+(push|commit).*--no-verify\b'; then
  printf 'BLOCKED: --no-verify skips hooks. CLAUDE.md forbids unless Carson explicitly OKs.\n' >&2
  exit 2
fi

exit 0
