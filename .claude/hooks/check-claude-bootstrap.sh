#!/usr/bin/env bash
# .claude/hooks/check-claude-bootstrap.sh
#
# PreToolUse hook on Bash. For staging/prod-sensitive commands, require the
# current worktree to acknowledge the current CLAUDE.md hash first.
#
# This is intentionally narrower than "all commands": agents can still read,
# inspect, and run local tests while orienting. Mutating staging/prod-adjacent
# surfaces and PR readiness/merge actions require an explicit bootstrap pass.
#
# stdin: hook input JSON (Claude Code PreToolUse contract)
# stdout: hook output JSON when blocking; empty when allowing
# exit:   0 always (Claude Code uses JSON output for permission decisions)

set -uo pipefail

emit_deny_static() {
  local msg="$1"
  printf '{\n'
  printf '  "hookSpecificOutput": {\n'
  printf '    "hookEventName": "PreToolUse",\n'
  printf '    "permissionDecision": "deny",\n'
  printf '    "permissionDecisionReason": "%s"\n' "$msg"
  printf '  }\n'
  printf '}\n'
}

deny() {
  local msg="$1"
  jq -n --arg msg "$msg" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $msg
    }
  }'
  exit 0
}

hash_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$file" | awk '{print $1}'
    return 0
  fi
  return 1
}

resolve_repo_root() {
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -d "${CLAUDE_PROJECT_DIR}" ]]; then
    (cd "${CLAUDE_PROJECT_DIR}" && pwd -P)
    return 0
  fi
  git rev-parse --show-toplevel 2>/dev/null || pwd -P
}

resolve_state_dir() {
  local repo_root="$1"
  local git_dir

  if [[ -n "${ARKOVA_CLAUDE_BOOTSTRAP_STATE_DIR:-}" ]]; then
    printf '%s\n' "${ARKOVA_CLAUDE_BOOTSTRAP_STATE_DIR}"
    return 0
  fi

  git_dir=$(git -C "$repo_root" rev-parse --git-dir 2>/dev/null || true)
  if [[ -z "$git_dir" ]]; then
    printf '%s\n' "${repo_root}/.git"
    return 0
  fi
  if [[ "$git_dir" = /* ]]; then
    printf '%s\n' "$git_dir"
  else
    printf '%s\n' "${repo_root}/${git_dir}"
  fi
}

is_sensitive_command() {
  local cmd="$1"

  if grep -Eq '(^|[[:space:];&|])(\./)?scripts/staging/' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])(npm|pnpm|yarn)([[:space:]]+run)?[[:space:]]+staging:' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])(npx[[:space:]]+)?supabase[[:space:]]+db[[:space:]]+push' <<<"$cmd" \
     && grep -Eq '(^|[[:space:]])--linked([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])(npx[[:space:]]+)?supabase[[:space:]]+db[[:space:]]+reset([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])(npx[[:space:]]+)?supabase[[:space:]]+migration[[:space:]]+repair([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])(npx[[:space:]]+)?supabase[[:space:]]+migration[[:space:]]+list' <<<"$cmd" \
     && grep -Eq '(^|[[:space:]])--linked([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])(npx[[:space:]]+)?supabase[[:space:]]+link([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])gcloud[[:space:]]+run[[:space:]]+deploy([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])gcloud[[:space:]]+run[[:space:]]+services[[:space:]]+(update|replace|delete)([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])gcloud[[:space:]]+run[[:space:]]+jobs[[:space:]]+(execute|update|create|delete)([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+ready([[:space:]]|$)' <<<"$cmd" \
     && ! grep -Eq '(^|[[:space:]])--undo([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -Eq '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+edit([[:space:]]|$)' <<<"$cmd" \
     && grep -Eq '(^|[[:space:]])--body([[:space:]]|$|=)' <<<"$cmd"; then
    return 0
  fi

  return 1
}

if ! command -v jq >/dev/null 2>&1; then
  emit_deny_static "CLAUDE.md bootstrap hook requires jq so staging/prod-sensitive Bash commands can be parsed safely. Install jq (brew install jq), read CLAUDE.md, then run scripts/agent/ack-claude-bootstrap.sh."
  exit 0
fi

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

if [[ "$tool" != "Bash" ]] || [[ -z "$cmd" ]]; then
  exit 0
fi

if ! is_sensitive_command "$cmd"; then
  exit 0
fi

repo_root=$(resolve_repo_root)
claude_md="${repo_root}/CLAUDE.md"
if [[ ! -f "$claude_md" ]]; then
  deny "Staging/prod-sensitive command blocked: could not find CLAUDE.md at ${claude_md}. Start from the Arkova repo root, read current CLAUDE.md, then run scripts/agent/ack-claude-bootstrap.sh."
fi

current_hash=$(hash_file "$claude_md" || true)
if [[ -z "$current_hash" ]]; then
  deny "Staging/prod-sensitive command blocked: could not compute CLAUDE.md hash. Install shasum, sha256sum, or openssl; read current CLAUDE.md; then run scripts/agent/ack-claude-bootstrap.sh."
fi

state_dir=$(resolve_state_dir "$repo_root")
state_file="${state_dir}/arkova-claude-bootstrap-ack"
ack_hash=""
if [[ -f "$state_file" ]]; then
  ack_hash=$(awk -F= '/^claude_md_sha256=/ {print $2; exit}' "$state_file" 2>/dev/null || true)
fi

if [[ "$ack_hash" == "$current_hash" ]]; then
  exit 0
fi

deny "Read current CLAUDE.md before staging/prod/PR readiness operations, then run scripts/agent/ack-claude-bootstrap.sh from the repo root. If CLAUDE.md changed, context resumed, or a session/worktree was restarted, re-read the relevant sections and re-run scripts/agent/ack-claude-bootstrap.sh. Blocked command: ${cmd}"
