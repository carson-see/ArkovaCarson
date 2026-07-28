#!/usr/bin/env bash
# scripts/ci/mint-fresh-event.test.sh — local smoke tests for
# mint-fresh-event.sh (SCRUM-3026). Stubs `git` and `gh` so no network call
# or real repo mutation happens; asserts on exit codes, printed output, and
# the exact arguments the stubs recorded.

set -uo pipefail

SUT="./scripts/ci/mint-fresh-event.sh"
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
  echo "SKIP mint-fresh-event tests: jq is required"
  exit 0
fi
if ! command -v perl >/dev/null 2>&1; then
  echo "SKIP mint-fresh-event tests: perl is required"
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
  return 0
}

assert_match() {
  local label="$1" pattern="$2" output="$3"
  if echo "$output" | grep -qE "$pattern"; then
    echo "  PASS  $label  matched /$pattern/"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label  did not match /$pattern/"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
  return 0
}

assert_not_match() {
  local label="$1" pattern="$2" output="$3"
  if echo "$output" | grep -qE "$pattern"; then
    echo "  FAIL  $label  unexpectedly matched /$pattern/"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS  $label  did not match /$pattern/"
    PASS=$((PASS + 1))
  fi
  return 0
}

assert_file_not_exists() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    echo "  FAIL  $label  unexpectedly exists: $path"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  fi
  return 0
}

TMP_DIR=$(mktemp -d)
FAKEBIN="${TMP_DIR}/bin"
mkdir -p "${FAKEBIN}"
CALL_LOG="${TMP_DIR}/calls.log"
EDIT_BODY_CAPTURE="${TMP_DIR}/edit-body.txt"

# ── fake git ──────────────────────────────────────────────────────────────
cat >"${FAKEBIN}/git" <<'GITEOF'
#!/usr/bin/env bash
echo "git $*" >> "${CALL_LOG}"
case "$1 $2" in
  "status --porcelain")
    if [[ "${FAKE_DIRTY:-0}" == "1" ]]; then
      printf ' M some-file.ts\n'
    fi
    exit 0
    ;;
esac
case "$1" in
  rev-parse)
    if [[ "$2" == "--abbrev-ref" ]]; then
      echo "${FAKE_BRANCH:-feature/test-branch}"
    else
      echo "${FAKE_NEW_SHA:-1111111111111111111111111111111111111111}"
    fi
    exit 0
    ;;
  commit)
    echo "COMMIT_CALLED" >> "${TMP_DIR}/git-commit-called"
    exit 0
    ;;
  push)
    echo "PUSH_CALLED" >> "${TMP_DIR}/git-push-called"
    exit 0
    ;;
esac
exit 0
GITEOF
chmod +x "${FAKEBIN}/git"

# ── fake gh ───────────────────────────────────────────────────────────────
cat >"${FAKEBIN}/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "gh $*" >> "${CALL_LOG}"
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  # Distinguish `pr view N --json ...multi...` from `pr view N --json body -q .body`
  if [[ "$*" == *"-q .body"* ]]; then
    printf '%s' "${FAKE_BODY:-}"
    exit 0
  fi
  body_json=$(printf '%s' "${FAKE_BODY:-}" | jq -Rs .)
  printf '{"number": %s, "headRefName": "%s", "baseRefName": "main", "state": "%s", "body": %s, "url": "https://github.com/x/y/pull/%s"}\n' \
    "${FAKE_PR:-123}" "${FAKE_PR_HEAD_BRANCH:-${FAKE_BRANCH:-feature/test-branch}}" "${FAKE_STATE:-OPEN}" "${body_json}" "${FAKE_PR:-123}"
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "edit" ]]; then
  cat > "${EDIT_BODY_CAPTURE}"
  exit 0
fi
exit 0
GHEOF
chmod +x "${FAKEBIN}/gh"

run_sut() {
  PATH="${FAKEBIN}:$PATH" \
    CALL_LOG="${CALL_LOG}" EDIT_BODY_CAPTURE="${EDIT_BODY_CAPTURE}" TMP_DIR="${TMP_DIR}" \
    FAKE_PR="${FAKE_PR:-123}" FAKE_BRANCH="${FAKE_BRANCH:-feature/test-branch}" \
    FAKE_PR_HEAD_BRANCH="${FAKE_PR_HEAD_BRANCH:-${FAKE_BRANCH:-feature/test-branch}}" \
    FAKE_STATE="${FAKE_STATE:-OPEN}" FAKE_DIRTY="${FAKE_DIRTY:-0}" \
    FAKE_BODY="${FAKE_BODY:-}" FAKE_NEW_SHA="${FAKE_NEW_SHA:-1111111111111111111111111111111111111111}" \
    "$SUT" "$@"
}

reset_state() {
  rm -f "${CALL_LOG}" "${EDIT_BODY_CAPTURE}" "${TMP_DIR}/git-commit-called" "${TMP_DIR}/git-push-called"
  unset FAKE_PR FAKE_BRANCH FAKE_PR_HEAD_BRANCH FAKE_STATE FAKE_DIRTY FAKE_BODY FAKE_NEW_SHA
}

echo "─── usage / argument validation ────────────────────────────"

reset_state
out=$(run_sut 2>&1); rc=$?
assert_exit  "missing --pr fails" 2 "$rc"
assert_match "missing --pr error message" "\-\-pr <number> is required" "$out"

out=$(run_sut --pr abc 2>&1); rc=$?
assert_exit  "non-numeric --pr fails" 2 "$rc"
assert_match "non-numeric --pr error message" "requires a numeric PR number" "$out"

out=$(run_sut --bogus-flag 2>&1); rc=$?
assert_exit  "unknown flag fails" 2 "$rc"

out=$(run_sut --pr 123 --help 2>&1); rc=$?
assert_exit  "--help succeeds" 0 "$rc"
assert_match "--help prints usage" "Usage: scripts/ci/mint-fresh-event.sh" "$out"

echo ""
echo "─── dry-run ─────────────────────────────────────────────────"

reset_state
FAKE_BODY='## Staging Soak Evidence
Tier: T1
PR head SHA: 0000000000000000000000000000000000000000
'
out=$(run_sut --pr 123 --bump-head-sha --dry-run 2>&1); rc=$?
assert_exit  "dry-run succeeds" 0 "$rc"
assert_match "dry-run announces no commit" "\[dry-run\] Would create an empty commit" "$out"
assert_match "dry-run announces no push" "\[dry-run\] Would push" "$out"
assert_match "dry-run announces head-sha bump" "Would update the 'PR head SHA:' line" "$out"
assert_file_not_exists "dry-run never calls git commit" "${TMP_DIR}/git-commit-called"
assert_file_not_exists "dry-run never calls git push" "${TMP_DIR}/git-push-called"
assert_file_not_exists "dry-run never calls gh pr edit" "${EDIT_BODY_CAPTURE}"

echo ""
echo "─── precondition failures ───────────────────────────────────"

reset_state
FAKE_DIRTY=1
out=$(run_sut --pr 123 2>&1); rc=$?
assert_exit  "dirty tree fails closed" 1 "$rc"
assert_match "dirty tree error message" "working tree is not clean" "$out"
assert_file_not_exists "dirty tree never calls git commit" "${TMP_DIR}/git-commit-called"

reset_state
FAKE_BRANCH="feature/other-branch"
FAKE_PR_HEAD_BRANCH="feature/expected-branch"
out=$(run_sut --pr 123 2>&1); rc=$?
assert_exit  "branch mismatch fails closed" 1 "$rc"
assert_match "branch mismatch error message" "does not match PR #123's head branch" "$out"
assert_file_not_exists "branch mismatch never calls git commit" "${TMP_DIR}/git-commit-called"

reset_state
FAKE_STATE="MERGED"
out=$(run_sut --pr 123 2>&1); rc=$?
assert_exit  "non-open PR fails closed" 1 "$rc"
assert_match "non-open PR error message" "is not OPEN" "$out"
assert_file_not_exists "non-open PR never calls git commit" "${TMP_DIR}/git-commit-called"

echo ""
echo "─── real run (stubbed) ──────────────────────────────────────"

reset_state
out=$(run_sut --pr 123 2>&1); rc=$?
assert_exit  "plain run succeeds" 0 "$rc"
assert_match "plain run creates empty commit" "" "$([[ -f "${TMP_DIR}/git-commit-called" ]] && echo present)"
if [[ -f "${TMP_DIR}/git-commit-called" ]]; then
  echo "  PASS  plain run calls git commit"
  PASS=$((PASS + 1))
else
  echo "  FAIL  plain run calls git commit"
  FAIL=$((FAIL + 1))
fi
if [[ -f "${TMP_DIR}/git-push-called" ]]; then
  echo "  PASS  plain run calls git push"
  PASS=$((PASS + 1))
else
  echo "  FAIL  plain run calls git push"
  FAIL=$((FAIL + 1))
fi
assert_file_not_exists "plain run never calls gh pr edit" "${EDIT_BODY_CAPTURE}"
assert_match "commit message carries SCRUM-3026" "commit --allow-empty -m chore\(ci\): mint fresh PR event" "$(cat "${CALL_LOG}")"

echo ""
echo "─── --bump-head-sha updates the PR head SHA line ────────────"

reset_state
FAKE_NEW_SHA="2222222222222222222222222222222222222222"
FAKE_BODY='## Staging Soak Evidence
Tier: T1
PR head SHA: 0000000000000000000000000000000000000000
Rollback plan: revert
'
out=$(run_sut --pr 123 --bump-head-sha 2>&1); rc=$?
assert_exit  "bump-head-sha run succeeds" 0 "$rc"
if [[ -f "${EDIT_BODY_CAPTURE}" ]]; then
  echo "  PASS  bump-head-sha calls gh pr edit"
  PASS=$((PASS + 1))
  body_out=$(cat "${EDIT_BODY_CAPTURE}")
  assert_match     "updated body has new sha" "PR head SHA: 2222222222222222222222222222222222222222" "$body_out"
  assert_not_match "updated body drops old sha" "PR head SHA: 0000000000000000000000000000000000000000" "$body_out"
  assert_match     "updated body preserves unrelated fields" "Rollback plan: revert" "$body_out"
else
  echo "  FAIL  bump-head-sha calls gh pr edit"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "─── --bump-head-sha with no matching line skips the edit ────"

reset_state
FAKE_BODY='## Staging Soak Evidence
Tier: T0
'
out=$(run_sut --pr 123 --bump-head-sha 2>&1); rc=$?
assert_exit  "bump-head-sha with no field still succeeds" 0 "$rc"
assert_match "warns when no PR head SHA line exists" "no 'PR head SHA:' line found" "$out"
assert_file_not_exists "no gh pr edit call when field is absent" "${EDIT_BODY_CAPTURE}"

echo ""
echo "─── summary ─────────────────────────────────────────────────"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
