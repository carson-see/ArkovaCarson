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
#   3. §1.3  — no banned UI terminology in .tsx/.jsx or src/lib/copy.ts (WARN)
#   4. §1.2/§4 — migration hygiene: never-modify, NNNN collision, ROLLBACK (BLOCK)
#
# 2026-08-02 enforcement audit. Probes showed this hook blocked 1 of the 8 rules
# it was credited with in CLAUDE.md. Four holes closed here:
#   A1  repo_root was resolved from CLAUDE_PROJECT_DIR/cwd, so a file inside a
#       git worktree never normalized to a repo-relative path and EVERY
#       path-scoped rule silently no-opped. Now resolved from the file's own
#       directory, and an un-normalizable path fails closed.
#   A2  §1.3 gated on .tsx/.jsx, so it had never read src/lib/copy.ts — the file
#       §1.3 designates as the home of all UI copy. Four banned terms were also
#       missing from the pattern.
#   A3  Secret detection required a variable-name prefix, so a bare service_role
#       JWT (the shape of a leak found the same day) passed. Now matches token
#       shape: Supabase role JWTs at all three base64 alignments, whsec_,
#       PEM private keys, AIza keys.
#   A4  Migration never-modify was gated behind ^[0-9]{4}_, leaving the
#       00000000000000_ baseline and the 0055b_ lettered family unprotected.
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

# Advisory only. This writes to stderr and exits 0 WITHOUT emitting a
# permissionDecision. Emitting `"allow"` here would be wrong: in the PreToolUse
# contract "allow" BYPASSES the permission system rather than merely declining
# to block, so a file flagged for banned terminology would be auto-approved and
# skip the confirmation an unflagged file still gets — the opposite of intent.
# Every other hook in this repo emits only "deny" and exits 0 silently to
# permit; this matches that convention.
warn() {
  printf '%s\n' "$1" >&2
  exit 0
}

# Missing jq: degrade, do not stop all work.
#
# Previously this denied EVERY Edit/Write/NotebookEdit, so a machine without jq
# could not modify a single file in the repo. That is a far larger blast radius
# than the Bash hooks, which only gate staging/prod-sensitive commands.
#
# Instead, run the one rule that must never silently lapse — the §1.4 secret
# block — directly against the raw stdin JSON. The secret patterns below are
# JSON-escape-safe (no quotes or backslashes), so they survive verbatim inside
# the encoded payload. Path-scoped rules (§1.6, §1.3) cannot be evaluated
# without parsing, so they are skipped and the caller is told so on stderr.
if ! command -v jq >/dev/null 2>&1; then
  raw_input=$(cat)
  if printf '%s' "$raw_input" | grep -qE "(sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN[A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]*(InJvbGUiOiJz|b2xlIjoic2Vy|cm9sZSI6InNl)|(SUPABASE_)?SERVICE_ROLE_KEY[^A-Za-z0-9]{1,8}ey[A-Za-z0-9._-]{10,}|BITCOIN_TREASURY_WIF[^A-Za-z0-9]{1,8}[A-Za-z0-9]{10,})"; then
    emit_deny_static "CLAUDE.md 1.4 VIOLATION - hardcoded secret detected (degraded scan: jq is not installed, so this hook matched the raw tool payload). Secrets load from environment variables only. Install jq (brew install jq) to restore full rule coverage."
    exit 0
  fi
  printf 'check-constitution-on-edit.sh: jq not installed — ran the secret scan in degraded mode and skipped the path-scoped rules (§1.6 worker fingerprint, §1.3 banned terms). Install jq (brew install jq) to restore full coverage.\n' >&2
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

# Normalize to a repo-relative path before any matching.
#
# The globs below were previously anchored `*/…`, which only ever matched
# absolute paths — so the SAME file produced opposite outcomes depending on
# whether the caller passed `<repo>/docs/x.md` or `docs/x.md`. Behavior must
# depend on the file, not on the caller's path form.
#
# The root MUST be resolved from the FILE's own directory, not from
# CLAUDE_PROJECT_DIR or the hook's cwd. This repo does its parallel work in
# git worktrees (memory/feedback_no_worktree_isolation.md), and a hook
# invoked from the parent checkout while editing a file inside a worktree
# resolved the parent as the root — the prefix strip then failed, rel_path
# stayed ABSOLUTE, and every path-scoped rule below silently no-opped. That
# voided the §1.6 privacy block and the migration never-modify block in
# exactly the trees where most edits happen.
resolve_root_for_file() {
  local dir
  dir=$(dirname -- "$1")
  # A new file's directory may not exist yet; walk up to the nearest that does.
  while [[ ! -d "$dir" && "$dir" != "/" && "$dir" != "." && "$dir" != "" ]]; do
    dir=$(dirname -- "$dir")
  done
  [[ -d "$dir" ]] || return 1
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null
}

repo_root=$(resolve_root_for_file "$file_path" || true)
if [[ -z "$repo_root" ]]; then
  repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)}"
fi
rel_path="${file_path#"${repo_root}/"}"
rel_path="${rel_path#./}"

# Fail CLOSED on a path that still refuses to normalize. An absolute rel_path
# means every glob below is about to no-op; treating that as "clean" is the bug
# this block exists to prevent, so say so rather than passing silently.
if [[ "$rel_path" == /* ]]; then
  deny "check-constitution-on-edit.sh could not resolve ${file_path} to a repo-relative path (repo root resolved to '${repo_root}'). The constitution's path-scoped rules (§1.6 worker fingerprint, migration hygiene, §1.3 terminology) cannot be evaluated, so this edit is blocked rather than silently unchecked. Edit from inside the repository or worktree that owns the file."
fi

# Self-exemption: these files quote the very patterns this hook blocks, so
# scanning them would make the enforcement machinery unable to describe itself.
#
# Scoped DELIBERATELY NARROW. `docs/*` used to be exempt here, which disabled
# the §1.4 secret block for every file under docs/ — including docs/runbooks/,
# which is exactly where an operator pastes a real key while writing up a
# procedure. Documentation now gets the secret scan like everything else; the
# path-scoped rules below are no-ops for docs anyway (§1.6 is services/worker/
# only, §1.3 is .tsx/.jsx only), so nothing is lost by removing the blanket.
#
# If a doc must legitimately show a key-shaped literal, use an obviously-fake
# token that does not match a live key shape (e.g. sk_live_EXAMPLE).
case "$rel_path" in
  .claude/hooks/*|scripts/agent/*.test.sh) exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Rule 1 (§1.4): hardcoded secrets — BLOCK
# ---------------------------------------------------------------------------
# Live/test Stripe keys, JWT-shaped service-role keys, and treasury WIFs assigned
# as literals. Requires an actual literal value, so `process.env.X` and empty
# placeholder strings pass.
#
# The variable-name-prefixed patterns are necessary but NOT sufficient. A real
# leak found on 2026-08-02 — a live service_role JWT sitting in a
# `curl -H "apikey: eyJ…"` string — carried no `SERVICE_ROLE_KEY=` prefix and
# passed this rule cleanly. Secrets do not only appear as named assignments, so
# the classes below match the TOKEN SHAPE itself, independent of any prefix:
#
#   * a Supabase JWT whose payload decodes to a service_role claim. The middle
#     segment base64url-encodes `"role":"service_role"`; base64 packs 3 bytes
#     into 4 chars, so that substring has exactly THREE possible encodings
#     depending on its byte offset in the JSON. All three are matched below —
#     matching only one (the offset-0 form, InJvbGUiOiJz) misses ~2/3 of real
#     tokens, which is verified: a realistically-ordered payload lands on the
#     offset-1 form.
#   * whsec_        Stripe webhook signing secrets (§1.4 mandates
#                   constructEvent, which is useless if the secret leaks)
#   * PEM private keys  GCP service-account / signing keys
#   * AIza…        Google/Gemini API keys
if printf '%s' "$new_text" | grep -qE "(sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN[A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]*(InJvbGUiOiJz|b2xlIjoic2Vy|cm9sZSI6InNl)|(SUPABASE_)?SERVICE_ROLE_KEY[[:space:]]*[:=][[:space:]]*[\"']ey[A-Za-z0-9._-]{10,}|BITCOIN_TREASURY_WIF[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9]{10,}|API_KEY_HMAC_SECRET[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9+/=]{16,})"; then
  deny "CLAUDE.md §1.4 VIOLATION — hardcoded secret detected in ${file_path}. API keys, service-role keys, HMAC secrets, and treasury WIFs load from environment variables only (see docs/reference/ENV.md). Never commit a literal secret. If this is a fixture, use an obviously-fake token that does not match a live key shape."
fi

# ---------------------------------------------------------------------------
# Rule 2 (§1.6): client-side processing boundary — BLOCK
# ---------------------------------------------------------------------------
if [[ "$rel_path" == services/worker/* ]] \
   && [[ "$rel_path" != services/worker/src/integrations/connectors/* ]]; then
  if printf '%s' "$new_text" | grep -qE '\b(generateFingerprint|fileHasher)\b'; then
    deny "CLAUDE.md §1.6 VIOLATION — \`generateFingerprint\` / \`fileHasher\` must never be imported in services/worker/ (attempted in ${file_path}). Documents never leave the user's device; fingerprinting for user uploads is browser-only. The only exception is §1.6A connector-fetched documents under services/worker/src/integrations/connectors/, which carries its own conditions (fetch -> SHA-256 in memory -> discard; never persisted, logged, or sent to Sentry)."
  fi
fi

# ---------------------------------------------------------------------------
# Rule 4 (§0 rule 10 / migration hygiene): NNNN collision + rollback — BLOCK/WARN
# ---------------------------------------------------------------------------
# Two PRs picking the same NNNN is the most common migration collision, and it
# is only discovered at merge time when Mergify dequeues the loser. The correct
# next number is max(main head, agents.md reservations) + 1 — checking only the
# local branch is what produces the collision.
# The never-modify rule applies to EVERY migration, not only NNNN-prefixed ones.
# It was previously gated behind the same `^[0-9]{4}_` pattern used for collision
# detection, which left two real families of migration unprotected:
#   * 00000000000000_baseline_at_main_HEAD.sql (14-digit timestamp prefix)
#   * lettered suffixes such as 0055b_seed_alignment_idempotent.sql, which
#     CLAUDE.md §1.11 documents as live and load-bearing
# Both have already run wherever they were applied, so both must be immutable.
if [[ "$rel_path" =~ ^supabase/migrations/[^/]*\.sql$ ]]; then
  abs_path="${repo_root}/${rel_path}"

  # Never modify an existing migration — it has already run wherever it was
  # applied, so editing it silently diverges environments. This must be checked
  # FIRST: an Edit's new_string is a fragment that will not carry the file's
  # `-- ROLLBACK:` header, so the rollback check below would otherwise fire and
  # report a misleading reason for what is really a never-modify violation.
  if [[ -f "$abs_path" ]]; then
    deny "Never modify an existing migration (${file_path}) — it has already run wherever it was applied, so editing it silently diverges environments. Write a compensating migration with the next free NNNN instead (CLAUDE.md §1.2 / §4)."
  fi
fi

# Collision + rollback checks apply only to a NEW numerically-prefixed migration.
# The optional letter suffix matches the 0055b_ family; the numeric prefix alone
# is what the ledger drift gate keys on.
if [[ "$rel_path" =~ ^supabase/migrations/([0-9]{4})[a-z]?_[^/]*\.sql$ ]]; then
  prefix="${BASH_REMATCH[1]}"

  if true; then
    taken=""
    # (a) any migration with this prefix already on origin/main
    if git -C "$repo_root" rev-parse --verify -q origin/main >/dev/null 2>&1; then
      taken=$(git -C "$repo_root" ls-tree --name-only origin/main supabase/migrations/ 2>/dev/null \
                | grep -E "^supabase/migrations/${prefix}_" | head -1)
    fi
    # (b) any migration with this prefix already in the working tree
    if [[ -z "$taken" ]]; then
      taken=$(ls "${repo_root}/supabase/migrations/${prefix}_"*.sql 2>/dev/null | head -1)
    fi
    if [[ -n "$taken" ]]; then
      deny "Migration number ${prefix} is already taken by: ${taken}. Pick the next free NNNN — it is max(origin/main head, reservations in supabase/migrations/agents.md) + 1, NOT just the highest file on your branch. Reserve your number in supabase/migrations/agents.md in the same commit. (CLAUDE.md §6 / memory/feedback_migration_number_vs_reservations.md; load the migration-procedure skill.)"
    fi

    # Every migration records a runnable inverse up front.
    if ! printf '%s' "$new_text" | grep -qiE '^[[:space:]]*--[[:space:]]*ROLLBACK:'; then
      deny "Migration ${file_path} has no \`-- ROLLBACK:\` comment. Every migration records its inverse DDL, runnable as written (CLAUDE.md §4). Migrations are T3: 48h soak, multiple trigger cycles, clean-mirror or isolated staging — load the migration-procedure and soak-evidence skills before continuing."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Rule 3 (§1.3): banned UI terminology — WARN
# ---------------------------------------------------------------------------
# Scope: component files AND src/lib/copy.ts.
#
# This rule previously gated on `\.(tsx|jsx)$` only — so it had NEVER scanned
# src/lib/copy.ts, which is a `.ts` file and which §1.3 designates as the home
# of ALL user-visible strings. The one file the rule most needs to read was the
# one file it could not see.
#
# Term list: §1.3's table bans twelve terms. Four of the most likely to appear
# in real product copy — Gas, Hash, Block, Transaction — were missing here, so
# "Transaction Hash and Gas per Block" passed silently.
#
# Severity stays ADVISORY on purpose. This is a legal/brand constraint, but
# copy.ts already carries pre-existing hits, and denying would block every edit
# to that file until it is cleaned. `npm run lint:copy` is the authoritative
# gate; this hook is an early warning, and CLAUDE.md §1.3 says so plainly.
#
# `Block` is matched as a standalone word only, so Blockchain, blockHeight and
# blocked do not trip it; \b already handles that. Bare `Hash`/`Block` in
# internal identifiers will produce some noise — acceptable for a warning, and
# the reason this is not a deny.
if [[ "$rel_path" =~ \.(tsx|jsx)$ || "$rel_path" == src/lib/copy.ts ]]; then
  hits=$(
    printf '%s' "$new_text" \
      | grep -oE '\b(Wallet|Blockchain|Bitcoin|Crypto|Testnet|Mainnet|UTXO|Broadcast|Gas|Hash|Block|Transaction)\b' \
      | sort -u | tr '\n' ' ' | sed 's/ $//'
  )
  if [[ -n "$hits" ]]; then
    warn "CLAUDE.md §1.3 WARNING — banned UI term(s) in ${file_path}: ${hits}. These must not appear in user-visible strings. Use the approved alternatives from src/lib/copy.ts (Wallet -> Fee Account / Billing Account, Transaction -> Network Receipt, Hash -> Fingerprint, Testnet/Mainnet -> Test Environment / Production Network). Internal identifiers may keep technical names; \`npm run lint:copy\` is the authoritative gate."
  fi
fi

exit 0
