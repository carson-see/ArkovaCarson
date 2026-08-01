#!/usr/bin/env bash
# .claude/hooks/session-context.sh
#
# SessionStart hook. Prints the operational facts a session needs BEFORE it acts
# — the ones that are expensive to learn late:
#
#   1. Whether CLAUDE.md is acknowledged (staging/prod Bash is denied until it is)
#   2. Whether the prod worker deploy is frozen
#   3. Active soaks (never disrupt one)
#   4. Concurrent worktrees / other live sessions in this checkout
#   5. Current branch, and whether it is main
#
# Item 4 exists because of a real incident: on 2026-08-01 a concurrent session
# running a PR rebase in the shared checkout ran `git stash` and silently
# reverted another session's uncommitted work. Everything was recoverable from
# the stash, but nothing had warned either session the other was there.
#
# Output is advisory context, never a block. Additional context is emitted on
# stdout, which Claude Code surfaces to the session.
#
# exit: always 0 — this hook must never be able to wedge a session.

set -uo pipefail

repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)}"
cd "$repo_root" 2>/dev/null || exit 0

out=""
add() { out+="$1"$'\n'; }

add "## Arkova session context (auto-generated)"
add ""

# --- 1. bootstrap ack -------------------------------------------------------
claude_md="${repo_root}/CLAUDE.md"
if [[ -f "$claude_md" ]]; then
  cur=""
  if command -v shasum >/dev/null 2>&1; then
    cur=$(shasum -a 256 "$claude_md" 2>/dev/null | awk '{print $1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    cur=$(sha256sum "$claude_md" 2>/dev/null | awk '{print $1}')
  fi
  git_dir=$(git rev-parse --git-dir 2>/dev/null || echo .git)
  [[ "$git_dir" != /* ]] && git_dir="${repo_root}/${git_dir}"
  ack=""
  [[ -f "${git_dir}/arkova-claude-bootstrap-ack" ]] && \
    ack=$(awk -F= '/^claude_md_sha256=/ {print $2; exit}' "${git_dir}/arkova-claude-bootstrap-ack" 2>/dev/null)
  if [[ -n "$cur" && "$cur" == "$ack" ]]; then
    add "- CLAUDE.md: **acknowledged** (staging/prod commands unblocked)."
  else
    add "- CLAUDE.md: **NOT acknowledged** — read it, then run \`scripts/agent/ack-claude-bootstrap.sh\`. Staging/prod-sensitive Bash and \`gh pr ready\`/\`merge\`/\`edit --body\` are denied until you do."
  fi
fi

# --- 2. branch --------------------------------------------------------------
branch=$(git branch --show-current 2>/dev/null || echo "?")
if [[ "$branch" == "main" ]]; then
  add "- Branch: **main** — code, migrations, RLS, CI, workflows, and CLAUDE.md rule changes need a feature branch (§0 rule 8). Pure docs may land directly."
else
  add "- Branch: \`${branch}\`"
fi

# --- 3. concurrent worktrees ------------------------------------------------
# Only count worktrees with recent filesystem activity — a stale agent worktree
# from weeks ago is not a live session and should not raise an alarm.
if command -v git >/dev/null 2>&1; then
  cutoff=$(( $(date +%s) - 3600 ))
  live=0
  while IFS= read -r wt; do
    [[ -z "$wt" || "$wt" == "$repo_root" ]] && continue
    [[ -d "$wt" ]] || continue
    m=$(stat -f %m "$wt" 2>/dev/null || stat -c %Y "$wt" 2>/dev/null || echo 0)
    [[ "$m" -gt "$cutoff" ]] && live=$((live+1))
  done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
  if [[ "$live" -gt 0 ]]; then
    add "- **${live} worktree(s) active in the last hour.** Another session may be live in this checkout. Work in your own \`git worktree\`, not the shared tree — a concurrent \`git stash\`/\`checkout\` there will silently revert your uncommitted edits."
  fi
fi

# --- 4. prod deploy freeze --------------------------------------------------
# Read the asserted flag from the deploy workflow. This is the committed
# assertion, NOT live prod — assert prod state directly before relying on it.
if [[ -f .github/workflows/deploy-worker.yml ]] \
   && grep -qE '^\s*DEPLOY_WORKER_PAUSED:\s*.?true' .github/workflows/deploy-worker.yml 2>/dev/null; then
  add "- **Worker deploy is PAUSED** (\`DEPLOY_WORKER_PAUSED=true\` in deploy-worker.yml). Merging does not deploy. Prod runs an older SHA than main — verify with \`/health\` before any claim about what is live."
fi

# --- 5. active soaks --------------------------------------------------------
# HANDOFF is the register of record for soaks. Surface the pointer, not a parse
# of it: a wrong soak summary is worse than none.
if [[ -f HANDOFF.md ]] && grep -qiE 'active soak|soak (start|clock)|72h soak' HANDOFF.md 2>/dev/null; then
  add "- HANDOFF.md references **soak activity** — read its Now/top block before touching any rig, PR, or deploy. A soaking PR is frozen evidence: no push, redeploy, rig write, or merge."
fi

add ""
add "Skills available for the recurring procedures: \`session-bootstrap\`, \`soak-evidence\`, \`migration-procedure\`, \`task-gates\`, \`infra-hygiene-sweep\`, \`pr-triage\`, \`prod-state-check\`."

printf '%s' "$out"
exit 0
