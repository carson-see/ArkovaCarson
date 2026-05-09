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

# Hard requirement: jq must be installed. Without it, the parsing below
# silently produces empty strings (because of the 2>/dev/null redirect),
# the early-exit at the tool/command check fires, and EVERY command is
# allowed through. That's fail-open on an enforcement hook — exactly
# the failure mode this hook exists to prevent. CodeRabbit flagged this
# in PR #733 review.
if ! command -v jq >/dev/null 2>&1; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Staging-evidence pre-merge hook requires jq. Install jq (brew install jq) so the hook can parse tool input and enforce CLAUDE.md sec 1.11 staging-soak evidence on gh pr ready / gh pr merge."
  }
}
EOF
  exit 0
fi

# Read full hook input
input=$(cat)

# Extract tool + command. jq -r returns "null" string when key absent;
# treat that as empty.
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

if [[ "$tool" != "Bash" ]] || [[ -z "$cmd" ]]; then
  exit 0
fi

# Match `gh pr ready` (without `--undo`) or `gh pr merge`. CodeRabbit
# 2026-05-08 review: the `--undo` guard must match `--undo` as a flag
# token, not as a raw substring. Otherwise a legitimate branch/URL that
# happens to contain "--undo" (e.g. `gh pr ready feature--undo-test`)
# falsely escapes the hook.
is_target=false
if [[ "$cmd" =~ (^|[[:space:]]|;|&&|\|\|)gh[[:space:]]+pr[[:space:]]+ready([[:space:]]|;|&&|\|\||$) ]] \
   && [[ ! "$cmd" =~ (^|[[:space:]])--undo([[:space:]]|;|&&|\|\||$) ]]; then
  is_target=true
elif [[ "$cmd" =~ (^|[[:space:]]|;|&&|\|\|)gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|;|&&|\|\||$) ]]; then
  is_target=true
fi

if [[ "$is_target" != "true" ]]; then
  exit 0
fi

# Reject compound commands containing multiple `gh pr (ready|merge)`.
# Only extracting the first match would let subsequent ones slip through
# unvalidated.
target_match_count=$(
  printf '%s' "$cmd" \
    | grep -coE 'gh[[:space:]]+pr[[:space:]]+(ready|merge)' \
    || true
)
if [[ "$target_match_count" -gt 1 ]]; then
  jq -n --arg msg 'Compound commands with multiple gh pr ready/merge invocations are not allowed. Run each PR operation separately so staging evidence can be validated per-PR.' '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $msg
    }
  }'
  exit 0
fi

# Extract the PR selector if one is present. `gh pr ready` and
# `gh pr merge` both accept `[<number> | <url> | <branch>]` per the
# GitHub CLI manual.
pr_selector=$(
  printf '%s' "$cmd" \
    | grep -oE 'gh[[:space:]]+pr[[:space:]]+(ready|merge)([[:space:]]+[^[:space:]-][^[:space:]]*)?' \
    | head -n1 \
    | awk '{print $4}'
)

# Fetch PR body. With an explicit selector pass it through; without
# one, gh resolves the current branch's PR (only safe when the
# command itself omitted a selector).
if [[ -n "${pr_selector:-}" ]]; then
  body=$(gh pr view "$pr_selector" --json body --jq '.body' 2>/dev/null || true)
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
