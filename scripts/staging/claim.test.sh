#!/usr/bin/env bash
# scripts/staging/claim.test.sh — local smoke tests for claim.sh status output.

set -uo pipefail

CLAIM=./scripts/staging/claim.sh
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

echo "─── claim status enrichment ────────────────────────────────"

TMP_DIR=$(mktemp -d)
FAKEBIN="${TMP_DIR}/bin"
mkdir -p "${FAKEBIN}"

cat >"${FAKEBIN}/curl" <<'EOF'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"staging_deploy_log"* ]]; then
  printf '[{"pr_number":742,"id":142,"tag":"pr-742","deployed_at":"2026-05-14T11:58:00Z"}]\n'
  exit 0
fi
if [[ "$args" == *"staging_lease"* ]]; then
  printf '[{"pr_number":742,"reason":"SOC2 soak","acquired_by":"test@host","acquired_at":"2026-05-14T11:55:00Z"}]\n'
  exit 0
fi
printf '[]\n'
EOF
chmod +x "${FAKEBIN}/curl"

out=$(PATH="${FAKEBIN}:$PATH" \
      STAGING_SUPABASE_URL=https://staging.example STAGING_SUPABASE_SERVICE_ROLE_KEY=test \
      $CLAIM status 2>&1); rc=$?
assert_exit  "status succeeds"       0 "$rc"
assert_match "status includes tag URL" "https://pr-742---arkova-worker-staging-270018525501.us-central1.run.app" "$out"
assert_match "status includes latest log id" '"latest_staging_deploy_log_id": 142' "$out"

echo ""
echo "─── summary ─────────────────────────────────────────────────"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
