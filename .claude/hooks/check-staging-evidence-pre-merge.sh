#!/usr/bin/env bash
# .claude/hooks/check-staging-evidence-pre-merge.sh
#
# PreToolUse hook on Bash. Blocks the agent from transitioning a Draft PR
# to Ready (`gh pr ready` without --undo) or merging (`gh pr merge`)
# unless the PR body carries a `## Staging Soak Evidence` section with a
# valid `Tier: T[123]` declaration.
#
# Enforces CLAUDE.md §1.11 / §1.12. There is no override label — the
# `staging-soak-skip` label was destroyed on 2026-05-07.
#
# Permissive on:
#   - any non-Bash tool (passes through)
#   - bash commands that don't match `gh pr ready` (no --undo) or `gh pr merge`
#   - `gh pr ready --undo` (Ready → Draft is fine; no soak needed)
#
# Strict on:
#   - `gh pr ready [PR]`           — Draft → Ready
#   - `gh pr ready [PR] --comment` — same
#   - `gh pr merge [PR] ...`       — any merge variant
#
# stdin: hook input JSON (Claude Code PreToolUse contract)
# stdout: hook output JSON when blocking; empty when allowing
# exit:   0 always (Claude Code uses JSON output for permission decisions)

set -uo pipefail

# Read full hook input
input=$(cat)

# Extract tool + command. jq -r returns "null" string when key absent;
# treat that as empty.
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

if [[ "$tool" != "Bash" ]] || [[ -z "$cmd" ]]; then
  exit 0
fi

# Match `gh pr ready` (NOT followed by --undo anywhere in the same command)
# or `gh pr merge`.
is_ready_no_undo=false
is_merge=false
if [[ "$cmd" =~ (^|[[:space:]]|;|&&|\|\|)gh[[:space:]]+pr[[:space:]]+ready([[:space:]]|$) ]]; then
  if [[ "$cmd" != *"--undo"* ]]; then
    is_ready_no_undo=true
  fi
fi
if [[ "$cmd" =~ (^|[[:space:]]|;|&&|\|\|)gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$) ]]; then
  is_merge=true
fi

if [[ "$is_ready_no_undo" != "true" ]] && [[ "$is_merge" != "true" ]]; then
  exit 0
fi

# Extract PR number if present (`gh pr ready 731` or `gh pr merge 731 ...`).
# Tolerate `gh pr ready` with no number — gh defaults to current branch.
pr_num=$(printf '%s' "$cmd" | grep -oE 'gh[[:space:]]+pr[[:space:]]+(ready|merge)[[:space:]]+[0-9]+' | grep -oE '[0-9]+$' || true)

# Fetch PR body. If no PR number, gh resolves the current branch's PR.
if [[ -n "$pr_num" ]]; then
  body=$(gh pr view "$pr_num" --json body --jq '.body' 2>/dev/null || true)
else
  body=$(gh pr view --json body --jq '.body' 2>/dev/null || true)
fi

# If we couldn't fetch a PR body, fail safe — block with a clear message.
if [[ -z "$body" ]]; then
  jq -n --arg msg 'Could not resolve a PR for this branch. Open a PR (gh pr create) before transitioning to Ready or merging. Staging soak evidence is mandatory per CLAUDE.md §1.11 / §1.12.' '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $msg
    }
  }'
  exit 0
fi

# Check for evidence section header AND a Tier declaration.
has_section=false
has_tier=false
if printf '%s' "$body" | grep -qiE '^##[[:space:]]+Staging[[:space:]]+Soak[[:space:]]+Evidence[[:space:]]*$'; then
  has_section=true
fi
if printf '%s' "$body" | grep -qiE '^[[:space:]]*[-*]?[[:space:]]*Tier:[[:space:]]+T[123]\b'; then
  has_tier=true
fi

if [[ "$has_section" == "true" ]] && [[ "$has_tier" == "true" ]]; then
  # All good — let the command through.
  exit 0
fi

# Block with structured reason.
missing=()
[[ "$has_section" != "true" ]] && missing+=('## Staging Soak Evidence section')
[[ "$has_tier" != "true" ]] && missing+=('Tier: T[123] declaration')
missing_joined=$(IFS=" + "; echo "${missing[*]}")

reason="Staging soak evidence is mandatory per CLAUDE.md §1.11 / §1.12; no override label exists (staging-soak-skip was destroyed 2026-05-07). PR body is missing: ${missing_joined}. Apply this branch to arkova-staging, deploy arkova-worker-staging at the candidate SHA, run the soak, and add the evidence block to the PR before transitioning to Ready or merging."

jq -n --arg msg "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $msg
  }
}'
exit 0
