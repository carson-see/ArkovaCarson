#!/usr/bin/env bash
# .claude/hooks/check-constitution-on-edit.sh
#
# PreToolUse hook on Edit|Write. Enforces the CLAUDE.md constitution rules that
# can be checked from the pending file content, BEFORE it lands on disk.
#
# Replaces the nine `.claude/hookify.*.local.md` rule files (deleted 2026-08-01).
# Those were authored for a `hookify` plugin that is not installed, so none of
# them had ever executed; several also referenced structures removed in the
# 2026-04-21 CLAUDE.md refactor. This script keeps the three rules that carried
# real enforcement value and drops the rest.
#
# Rules enforced:
#   1. §1.4  — no hardcoded secrets (BLOCK)
#   2. §1.6  — no `generateFingerprint` / `fileHasher` in services/worker/ (BLOCK)
#   3. §1.3  — no banned UI terminology in user-visible .tsx/.jsx strings (WARN)
#
# Rule 2 carve-out: §1.6A permits server-side fingerprinting of connector-fetched
# documents. Files under services/worker/src/integrations/connectors/ are exempt
# from the fingerprint block; §1.6A's other conditions stay CI-enforced
# (SCRUM-2492), since they are not decidable from a single file's text.
#
# stdin: hook input JSON (Claude Code PreToolUse contract)
# stdout: hook output JSON when blocking/warning; empty when clean
# exit:   0 always (Claude Code uses JSON output for permission decisions)

set -uo pipefail

emit_deny_static() {
  printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "PreToolUse",\n    "permissionDecision": "deny",\n    "permissionDecisionReason": "%s"\n  }\n}\n' "$1"
}

deny() {
  jq -n --arg msg "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $msg
    }
  }'
  exit 0
}

warn() {
  jq -n --arg msg "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: $msg
    }
  }'
  exit 0
}

# Fail closed on a missing jq: without it the parsing below yields empty strings,
# every check silently passes, and this becomes a no-op enforcement hook — the
# exact failure mode documented in check-staging-evidence-pre-merge.sh.
if ! command -v jq >/dev/null 2>&1; then
  emit_deny_static "Constitution edit hook requires jq so pending file content can be parsed. Install jq (brew install jq)."
  exit 0
fi

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)

case "$tool" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
# Union of the payload shapes: Write uses .content, Edit uses .new_string.
new_text=$(printf '%s' "$input" | jq -r '[.tool_input.content, .tool_input.new_string, .tool_input.new_source] | map(select(. != null)) | join("\n")' 2>/dev/null)

[[ -z "$file_path" ]] && exit 0
[[ -z "$new_text" ]] && exit 0

# This hook's own tests and docs quote the very patterns it blocks. Exempt them
# so the enforcement machinery can describe itself without self-blocking.
case "$file_path" in
  */.claude/hooks/*|*/scripts/agent/*.test.sh|*/docs/*) exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Rule 1 (§1.4): hardcoded secrets — BLOCK
# ---------------------------------------------------------------------------
# Live/test Stripe keys, JWT-shaped service-role keys, and treasury WIFs assigned
# as literals. Requires an actual literal value, so `process.env.X` and empty
# placeholder strings pass.
if printf '%s' "$new_text" | grep -qE "(sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|(SUPABASE_)?SERVICE_ROLE_KEY[[:space:]]*[:=][[:space:]]*[\"']ey[A-Za-z0-9._-]{10,}|BITCOIN_TREASURY_WIF[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9]{10,}|API_KEY_HMAC_SECRET[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9+/=]{16,})"; then
  deny "CLAUDE.md §1.4 VIOLATION — hardcoded secret detected in ${file_path}. API keys, service-role keys, HMAC secrets, and treasury WIFs load from environment variables only (see docs/reference/ENV.md). Never commit a literal secret. If this is a fixture, use an obviously-fake token that does not match a live key shape."
fi

# ---------------------------------------------------------------------------
# Rule 2 (§1.6): client-side processing boundary — BLOCK
# ---------------------------------------------------------------------------
if [[ "$file_path" == *"services/worker/"* ]] \
   && [[ "$file_path" != *"services/worker/src/integrations/connectors/"* ]]; then
  if printf '%s' "$new_text" | grep -qE '\b(generateFingerprint|fileHasher)\b'; then
    deny "CLAUDE.md §1.6 VIOLATION — \`generateFingerprint\` / \`fileHasher\` must never be imported in services/worker/ (attempted in ${file_path}). Documents never leave the user's device; fingerprinting for user uploads is browser-only. The only exception is §1.6A connector-fetched documents under services/worker/src/integrations/connectors/, which carries its own conditions (fetch -> SHA-256 in memory -> discard; never persisted, logged, or sent to Sentry)."
  fi
fi

# ---------------------------------------------------------------------------
# Rule 3 (§1.3): banned UI terminology — WARN
# ---------------------------------------------------------------------------
# Component files only, and only on lines that look like user-visible copy
# (quoted strings or JSX text), so internal identifiers and imports don't trip it.
if [[ "$file_path" =~ \.(tsx|jsx)$ ]]; then
  hits=$(
    printf '%s' "$new_text" \
      | grep -oE '\b(Wallet|Blockchain|Bitcoin|Crypto|Testnet|Mainnet|UTXO|Broadcast)\b' \
      | sort -u | tr '\n' ' ' | sed 's/ $//'
  )
  if [[ -n "$hits" ]]; then
    warn "CLAUDE.md §1.3 WARNING — banned UI term(s) in ${file_path}: ${hits}. These must not appear in user-visible strings. Use the approved alternatives from src/lib/copy.ts (Wallet -> Fee Account / Billing Account, Transaction -> Network Receipt, Hash -> Fingerprint, Testnet/Mainnet -> Test Environment / Production Network). Internal identifiers may keep technical names; \`npm run lint:copy\` is the authoritative gate."
  fi
fi

exit 0
