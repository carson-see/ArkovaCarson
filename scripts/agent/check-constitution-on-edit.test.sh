#!/usr/bin/env bash
# scripts/agent/check-constitution-on-edit.test.sh
#
# Pure-bash tests for the constitution edit guard. No network, no Supabase,
# no gcloud, no mutation of any real resource.
#
# Every case in the "enforcement audit" sections below was probed against the
# pre-2026-08-02 hook and PASSED — i.e. the constitution rule it represents was
# documented in CLAUDE.md but not actually enforced. They exist so those holes
# cannot silently reopen.
#
# Secret-shaped fixtures are ASSEMBLED AT RUNTIME from fragments. Writing them
# as literals would (correctly) trip the very hook under test, and would also
# put real-looking key shapes into a committed file.

set -uo pipefail

HOOK="./.claude/hooks/check-constitution-on-edit.sh"
PASS=0
FAIL=0
TMP_DIR=""

cleanup() { [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]] && rm -rf "${TMP_DIR}"; return 0; }
trap cleanup EXIT

# FAIL rather than skip: a green check that did not execute is worse than none.
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL check-constitution-on-edit tests: jq is required and was not found."
  exit 1
fi

run_hook() { # file_path, content
  jq -n --arg fp "$1" --arg c "$2" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:$c}}' | "$HOOK" 2>/dev/null
}

assert_denied() { # label, file_path, content
  local out; out=$(run_hook "$2" "$3")
  if grep -qF '"permissionDecision": "deny"' <<<"$out"; then
    echo "  PASS  $1"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $1  (edit was NOT denied)"; FAIL=$((FAIL + 1))
  fi
}

assert_allowed() { # label, file_path, content
  local out; out=$(run_hook "$2" "$3")
  if [[ -z "$out" ]]; then
    echo "  PASS  $1"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $1  (expected clean pass)"; echo "        $out"; FAIL=$((FAIL + 1))
  fi
}

assert_warned() { # label, file_path, content
  local err out; err=$(mktemp)
  out=$(jq -n --arg fp "$2" --arg c "$3" \
        '{tool_name:"Write", tool_input:{file_path:$fp, content:$c}}' | "$HOOK" 2>"$err")
  if [[ -s "$err" ]] && ! grep -qF '"permissionDecision": "deny"' <<<"$out"; then
    echo "  PASS  $1"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $1  (expected an advisory warning on stderr)"; FAIL=$((FAIL + 1))
  fi
  rm -f "$err"
}

# --- runtime-assembled fixtures -------------------------------------------
SK="sk""_live_""ABCDEFGH12345678"
WH="whsec""_""ABCDEFGH1234567890abcd"
AI="AIza""SyA1234567890abcdefghijklmnopqrstu"
PEM="-----BEGIN ""PRIVATE KEY-----"
# A Supabase service_role JWT with a realistic claim ORDER, so the role claim
# lands on a non-zero base64 alignment. Matching only the offset-0 encoding
# misses roughly two thirds of real tokens.
JWT=$(python3 -c '
import base64, json
p = {"iss":"supabase","ref":"examplerefexampleref","role":"service_role","iat":1,"exp":2}
b = base64.urlsafe_b64encode(json.dumps(p, separators=(",",":")).encode()).decode().rstrip("=")
print("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + b + ".sig")')

REPO_ROOT=$(git rev-parse --show-toplevel)

echo "--- §1.4 secrets: shapes with no variable-name prefix ------"
assert_denied "sk_live_ literal (pre-existing coverage)" \
  "src/a.ts" "const k = \"${SK}\";"
assert_denied "bare service_role JWT, no SERVICE_ROLE_KEY= prefix" \
  "src/a.ts" "const headers = { apikey: \"${JWT}\" };"
assert_denied "Stripe webhook signing secret (whsec_)" \
  "src/a.ts" "const s = \"${WH}\";"
assert_denied "PEM private key block" \
  "src/a.ts" "${PEM}
MIIEvQIBADANBg"
assert_denied "Google/Gemini API key (AIza)" \
  "src/a.ts" "const k = \"${AI}\";"
assert_allowed "env-var reference is not a secret" \
  "src/a.ts" 'export const k = process.env.SUPABASE_SERVICE_ROLE_KEY;'

echo ""
echo "--- §1.6 + migrations: path normalization in worktrees -----"
# A hook invoked from one checkout while the edited file lives in another
# (a git worktree) previously failed to normalize the path, leaving rel_path
# absolute so EVERY path-scoped rule below silently no-opped.
assert_denied "§1.6 generateFingerprint in worker (relative path)" \
  "services/worker/src/x.ts" 'import { generateFingerprint } from "@/lib/f";'
assert_denied "§1.6 generateFingerprint in worker (ABSOLUTE path)" \
  "${REPO_ROOT}/services/worker/src/x.ts" 'import { generateFingerprint } from "@/lib/f";'
assert_allowed "§1.6A connector carve-out still permitted" \
  "services/worker/src/integrations/connectors/docusign.ts" \
  'import { generateFingerprint } from "@/lib/f";'

echo ""
echo "--- migration hygiene --------------------------------------"
EXISTING_NNNN=$(ls "${REPO_ROOT}/supabase/migrations/" | grep -E '^[0-9]{4}_' | tail -1)
assert_denied "never modify an existing NNNN migration (relative)" \
  "supabase/migrations/${EXISTING_NNNN}" 'ALTER TABLE t ADD COLUMN c int;'
assert_denied "never modify an existing NNNN migration (ABSOLUTE)" \
  "${REPO_ROOT}/supabase/migrations/${EXISTING_NNNN}" 'ALTER TABLE t ADD COLUMN c int;'

# The never-modify rule was gated behind ^[0-9]{4}_, so the timestamp-prefixed
# baseline and the lettered-suffix family (0055b_) had no protection at all.
BASELINE=$(ls "${REPO_ROOT}/supabase/migrations/" | grep -E '^0{6,}' | head -1)
if [[ -n "$BASELINE" ]]; then
  assert_denied "never modify the timestamp-prefixed baseline migration" \
    "supabase/migrations/${BASELINE}" 'ALTER TABLE t ADD COLUMN c int;'
fi
LETTERED=$(ls "${REPO_ROOT}/supabase/migrations/" | grep -E '^[0-9]{4}[a-z]_' | head -1)
if [[ -n "$LETTERED" ]]; then
  assert_denied "never modify a lettered-suffix migration (0055b_ family)" \
    "supabase/migrations/${LETTERED}" 'ALTER TABLE t ADD COLUMN c int;'
fi

assert_denied "new migration without a -- ROLLBACK: comment" \
  "supabase/migrations/9999_probe_only.sql" 'CREATE TABLE t(id int);'
assert_allowed "new migration with a -- ROLLBACK: comment" \
  "supabase/migrations/9998_probe_only.sql" '-- ROLLBACK: DROP TABLE t;
CREATE TABLE t(id int);'

echo ""
echo "--- §1.3 terminology (advisory; lint:copy is the real gate) -"
assert_warned "banned term in a .tsx component" \
  "src/components/X.tsx" 'export const t = "Your Wallet Balance";'
# These four terms were absent from the pattern entirely.
assert_warned "Gas / Hash / Block / Transaction now covered" \
  "src/components/X.tsx" 'export const t = "Transaction Hash and Gas per Block";'
# src/lib/copy.ts is a .ts file, and §1.3 designates it as the home of ALL UI
# copy — yet the rule gated on .tsx/.jsx and had never once read it.
assert_warned "src/lib/copy.ts is scanned despite being .ts" \
  "src/lib/copy.ts" 'export const t = "Your Wallet Balance in Bitcoin";'
assert_allowed "ordinary .ts file is not terminology-scanned" \
  "src/lib/other.ts" 'export const blockHeight = 42;'

echo ""
echo "--- must not regress ---------------------------------------"
assert_allowed "clean docs file" "docs/x.md" 'Ordinary documentation prose.'
assert_allowed "clean source file" "src/a.ts" 'export const x = 1;'

echo ""
echo "--- summary ------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
