#!/usr/bin/env bash
# .claude/hooks/check-prod-migration-apply.sh
#
# PreToolUse hook on the Supabase MCP `apply_migration` path.
#
# WHY THIS EXISTS. CLAUDE.md §1.2 says the MCP apply path is "knowingly
# unenforceable and is on the operator" — and it is the path that caused every
# one of these:
#
#   2026-08-11  0401/0402  every open PR red for most of a day
#   2026-08-27  0418/0419  mutual orphan deadlock, #2336 <-> #2355
#   2026-08-30  0425       36 open PRs, surfaced on #2249 (zero migrations)
#
# It was unenforceable only because no PreToolUse matcher covered MCP tools —
# .claude/settings.json matched `Bash` and `Edit|Write|NotebookEdit` and nothing
# else. That is a wiring gap, not a law of nature.
#
# WHAT IT ENFORCES. Not "never apply before merge" — the migration-drift gate
# REQUIRES a PR's migration to be present in prod before it can go green, so
# migrate-before-merge is a legitimate, documented flow. What every incident
# actually violated is the narrower rule the exemptions file repeats in a dozen
# _history entries: AN OUT-OF-BAND PROD APPLY AND ITS EXEMPTION MUST LAND IN THE
# SAME MOTION. So a prod apply is allowed when the migration's numeric prefix is
# EITHER already on origin/main OR already listed in exemptPrefixes. Write the
# exemption first, then apply, and the board never goes red.
#
# SCOPE (stated honestly). Only `apply_migration`, only against the prod project
# ref. Staging and isolated rigs are untouched. DDL smuggled through
# `execute_sql` is NOT covered — matching arbitrary SQL for schema changes is a
# false-positive minefield, and the ledger row it writes is caught by
# check-ledger-numeric-integrity.ts after the fact.
#
# stdin: hook input JSON (Claude Code PreToolUse contract)
# stdout: hook output JSON when blocking; empty when allowing
# exit:   0 always (Claude Code uses JSON output for permission decisions)

set -uo pipefail

# Mirrors .github/workflows/migration-drift.yml's SUPABASE_PROJECT_REF default.
# A unit test pins these two together so they cannot drift apart.
PROD_REF="${ARKOVA_PROD_SUPABASE_REF:-vzwyaatejekddvltxyye}"

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}"
EXEMPTIONS="$REPO/scripts/ci/snapshots/ledger-numeric-exemptions.json"

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

allow() { exit 0; }

command -v jq >/dev/null 2>&1 || allow

input="$(cat)"
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty')"

# Only the MCP apply_migration path. Server prefixes are UUIDs and vary.
case "$tool_name" in
  *apply_migration) ;;
  *) allow ;;
esac

project_id="$(printf '%s' "$input" | jq -r '.tool_input.project_id // empty')"
mig_name="$(printf '%s' "$input" | jq -r '.tool_input.name // empty')"

# Not prod -> staging rig or isolated soak rig. Never gated here.
[ "$project_id" = "$PROD_REF" ] || allow

# Deliberate, explicit operator override. Must carry a reason.
if [ -n "${ARKOVA_ALLOW_UNRECONCILED_PROD_APPLY:-}" ]; then
  allow
fi

prefix="$(printf '%s' "$mig_name" | sed -n 's/^\([0-9]\{4\}\)_.*/\1/p')"

if [ -z "$prefix" ]; then
  deny "BLOCKED: prod apply_migration with a non-numeric migration name ('${mig_name}').

CLAUDE.md §0 rule 10 requires the prod ledger row to carry the migration's NUMERIC prefix (NNNN). A free-text name records a timestamp-style version, which is exactly how an orphan row becomes invisible to its owning PR.

Name the migration NNNN_snake_case matching its supabase/migrations/NNNN_*.sql file, then re-run.

Deliberate exception: set ARKOVA_ALLOW_UNRECONCILED_PROD_APPLY=1 for this session, and record why in the PR or HANDOFF entry."
fi

on_main=0
if git -C "$REPO" cat-file -e "origin/main:supabase/migrations" 2>/dev/null; then
  if git -C "$REPO" ls-tree --name-only origin/main supabase/migrations/ 2>/dev/null \
      | grep -qE "^supabase/migrations/${prefix}[a-z]?_"; then
    on_main=1
  fi
fi

exempt=0
if [ -f "$EXEMPTIONS" ]; then
  if jq -e --arg p "$prefix" '(.exemptPrefixes // []) | index($p)' "$EXEMPTIONS" >/dev/null 2>&1; then
    exempt=1
  fi
fi

if [ "$on_main" -eq 1 ] || [ "$exempt" -eq 1 ]; then
  allow
fi

deny "BLOCKED: applying migration ${prefix} to PROD (${PROD_REF}) would create an orphan ledger row.

${prefix}_*.sql is NOT on origin/main, and ${prefix} is NOT in scripts/ci/snapshots/ledger-numeric-exemptions.json.

The moment this lands, 'Check supabase/migrations vs prod' fails for every PR that touches supabase/migrations/ — it is a Mergify queue gate. This exact sequence caused the 0401/0402 (08-11), 0418/0419 (08-27) and 0425 (08-30) board stalls.

THE RULE (from a dozen _history entries in that file): an out-of-band prod apply and its exemption land in the SAME MOTION.

Do this instead:
  1. Add \"${prefix}\" to exemptPrefixes in scripts/ci/snapshots/ledger-numeric-exemptions.json.
  2. Add a dated _history entry naming the owning PR and 'REMOVE ${prefix} when #NNNN merges'.
  3. Re-run this apply.
  4. Remove the exemption when the owning PR lands the file on main.

Or merge the owning PR first, so the file is on main before the apply.

Deliberate exception (Carson/operator call, CLAUDE.md §1.11A): set ARKOVA_ALLOW_UNRECONCILED_PROD_APPLY=1 for this session and record why."
