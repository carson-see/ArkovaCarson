#!/usr/bin/env bash
# scripts/staging/janitor.test.sh — local smoke tests for orphan tag cleanup.

set -uo pipefail

JANITOR=./scripts/staging/cleanup-orphan-tags.sh
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

assert_no_match() {
  local label="$1" pattern="$2" output="$3"
  if echo "$output" | grep -qE "$pattern"; then
    echo "  FAIL  $label  unexpectedly matched /$pattern/"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS  $label  no match /$pattern/"
    PASS=$((PASS + 1))
  fi
  return 0
}

echo "─── orphan tag janitor ─────────────────────────────────────"

TMP_DIR=$(mktemp -d)
FAKEBIN="${TMP_DIR}/bin"
mkdir -p "${FAKEBIN}"

cat >"${FAKEBIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "$args" >>"${STAGING_FAKE_GCLOUD_LOG}"
if [[ "$args" == *"run services describe"* ]]; then
  printf '{"status":{"traffic":[{"tag":"pr-742","revisionName":"arkova-worker-staging-00042-old"},{"tag":"pr-999","revisionName":"arkova-worker-staging-00099-open"}]}}\n'
  exit 0
fi
if [[ "$args" == *"run services update-traffic"* ]]; then
  exit 0
fi
exit 0
EOF
chmod +x "${FAKEBIN}/gcloud"

cat >"${FAKEBIN}/gh" <<'EOF'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/pulls/742"* ]]; then
  printf '{"number":742,"state":"closed","closed_at":"2026-05-01T12:00:00Z","merged_at":"2026-05-01T12:00:00Z"}\n'
  exit 0
fi
if [[ "$args" == *"/pulls/999"* ]]; then
  printf '{"number":999,"state":"open","closed_at":null,"merged_at":null}\n'
  exit 0
fi
exit 1
EOF
chmod +x "${FAKEBIN}/gh"

GCLOUD_LOG="${TMP_DIR}/gcloud.log"
out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" \
      STAGING_JANITOR_NOW_EPOCH=1778760000 GITHUB_REPOSITORY=carson-see/ArkovaCarson \
      $JANITOR 2>&1); rc=$?
assert_exit  "janitor default dry-run succeeds" 0 "$rc"
assert_match "old closed PR tag selected" "would remove tag pr-742" "$out"
assert_no_match "open PR tag retained" "remove tag pr-999" "$out"

out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" \
      STAGING_JANITOR_NOW_EPOCH=1778760000 GITHUB_REPOSITORY=carson-see/ArkovaCarson \
      $JANITOR --apply 2>&1); rc=$?
assert_exit  "janitor apply succeeds" 0 "$rc"
assert_match "apply removes old closed tag" "removed tag pr-742" "$out"

echo ""
echo "─── summary ─────────────────────────────────────────────────"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
