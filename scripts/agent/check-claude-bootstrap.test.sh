#!/usr/bin/env bash
# scripts/agent/check-claude-bootstrap.test.sh
#
# Pure-bash smoke tests for the Claude bootstrap guard. These tests do not
# call GitHub, Supabase, gcloud, or mutate production/staging resources.

set -uo pipefail

HOOK="./.claude/hooks/check-claude-bootstrap.sh"
ACK="./scripts/agent/ack-claude-bootstrap.sh"
PASS=0
FAIL=0
TMP_DIR=""

cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
  return 0
}
trap cleanup EXIT

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP check-claude-bootstrap tests: jq is required"
  exit 0
fi

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS  $label  exit=$actual"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label  exit=$actual  (expected $expected)"
    FAIL=$((FAIL + 1))
  fi
}

assert_empty() {
  local label="$1" output="$2"
  if [[ -z "$output" ]]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" output="$3"
  if grep -qF "$needle" <<<"$output"; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        expected to contain: $needle"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

run_hook() {
  local cmd="$1"
  jq -n --arg cmd "$cmd" '{tool_name:"Bash", tool_input:{command:$cmd}}' \
    | CLAUDE_PROJECT_DIR="${PROJECT_DIR}" \
      ARKOVA_CLAUDE_BOOTSTRAP_STATE_DIR="${STATE_DIR}" \
      "$HOOK"
}

run_ack() {
  CLAUDE_PROJECT_DIR="${PROJECT_DIR}" \
    ARKOVA_CLAUDE_BOOTSTRAP_STATE_DIR="${STATE_DIR}" \
    "$ACK"
}

TMP_DIR=$(mktemp -d)
PROJECT_DIR="${TMP_DIR}/project"
STATE_DIR="${TMP_DIR}/state"
mkdir -p "${PROJECT_DIR}" "${STATE_DIR}"
cat >"${PROJECT_DIR}/CLAUDE.md" <<'EOF'
# CLAUDE.md

Bootstrap contract for this test fixture.
EOF

echo "--- non-sensitive commands ---------------------------------"
out=$(run_hook "npm test" 2>&1); rc=$?
assert_exit "non-sensitive command allowed" 0 "$rc"
assert_empty "non-sensitive command emits no hook decision" "$out"

out=$(run_hook "gh pr view 840 --json state" 2>&1); rc=$?
assert_exit "read-only gh pr view allowed" 0 "$rc"
assert_empty "read-only gh pr view emits no hook decision" "$out"

echo ""
echo "--- sensitive commands require CLAUDE.md acknowledgement ---"
out=$(run_hook "./scripts/staging/deploy.sh --pr 840 --image us-central1-docker.pkg.dev/example/app:sha" 2>&1); rc=$?
assert_exit "staging deploy hook exits cleanly for Claude" 0 "$rc"
assert_contains "staging deploy denied before ack" '"permissionDecision": "deny"' "$out"
assert_contains "denial names CLAUDE.md" 'Read current CLAUDE.md' "$out"

out=$(run_hook "npx supabase db push --linked" 2>&1); rc=$?
assert_exit "linked supabase hook exits cleanly for Claude" 0 "$rc"
assert_contains "linked supabase denied before ack" '"permissionDecision": "deny"' "$out"

gcloud_word="gcloud"
staging_service="arkova-worker-staging"
out=$(run_hook "$gcloud_word run services update $staging_service --image example" 2>&1); rc=$?
assert_exit "gcloud run update hook exits cleanly for Claude" 0 "$rc"
assert_contains "gcloud run update denied before ack" '"permissionDecision": "deny"' "$out"

out=$(run_hook "gh pr merge 840 --squash" 2>&1); rc=$?
assert_exit "gh merge hook exits cleanly for Claude" 0 "$rc"
assert_contains "gh merge denied before ack" '"permissionDecision": "deny"' "$out"

echo ""
echo "--- acknowledgement enables current CLAUDE.md only ---------"
ack_out=$(run_ack 2>&1); ack_rc=$?
assert_exit "ack script succeeds" 0 "$ack_rc"
assert_contains "ack output includes hash" "CLAUDE.md acknowledged" "$ack_out"

out=$(run_hook "./scripts/staging/deploy.sh --pr 840 --image us-central1-docker.pkg.dev/example/app:sha" 2>&1); rc=$?
assert_exit "staging deploy allowed after ack" 0 "$rc"
assert_empty "staging deploy emits no hook decision after ack" "$out"

cat >>"${PROJECT_DIR}/CLAUDE.md" <<'EOF'

Rule changed; stale acknowledgements must fail.
EOF
out=$(run_hook "./scripts/staging/deploy.sh --pr 840 --image us-central1-docker.pkg.dev/example/app:sha" 2>&1); rc=$?
assert_exit "stale CLAUDE.md hash hook exits cleanly for Claude" 0 "$rc"
assert_contains "stale CLAUDE.md denied" '"permissionDecision": "deny"' "$out"
assert_contains "stale denial mentions re-run ack" "re-run scripts/agent/ack-claude-bootstrap.sh" "$out"

echo ""
echo "--- summary ------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
exit 0
