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
# scripts/ops/gcloud-auth-preflight.sh runs before anything else and rejects a
# local interactive account. Answer as the identity it accepts (or as
# STAGING_FAKE_GCLOUD_ACCOUNT, so the rejection path can be tested too) — the
# guard is then genuinely exercised rather than bypassed, and this suite stays
# hermetic instead of depending on the operator's own gcloud login.
if [[ "$args" == *"auth list"* ]]; then
  printf '%s\n' "${STAGING_FAKE_GCLOUD_ACCOUNT:-270018525501-compute@developer.gserviceaccount.com}"
  exit 0
fi
if [[ "$args" == *"run revisions list"* ]]; then
  printf '[{"metadata":{"name":"arkova-worker-staging-00042-old","creationTimestamp":"2026-05-01T00:00:00Z"}},{"metadata":{"name":"arkova-worker-staging-00099-open","creationTimestamp":"2026-05-01T00:00:00Z"}},{"metadata":{"name":"arkova-worker-staging-00050-trainold","creationTimestamp":"2026-05-01T00:00:00Z"}},{"metadata":{"name":"arkova-worker-staging-00060-trainnew","creationTimestamp":"2026-05-14T00:00:00Z"}},{"metadata":{"name":"arkova-worker-staging-00070-serving","creationTimestamp":"2026-05-01T00:00:00Z"}}]\n'
  exit 0
fi
if [[ "$args" == *"run services describe"* ]]; then
  printf '{"status":{"traffic":[{"tag":"pr-742","revisionName":"arkova-worker-staging-00042-old"},{"tag":"pr-999","revisionName":"arkova-worker-staging-00099-open"},{"tag":"train-c-ce","revisionName":"arkova-worker-staging-00050-trainold"},{"tag":"train-c-recent","revisionName":"arkova-worker-staging-00060-trainnew"},{"tag":"train-migration-t3","revisionName":"arkova-worker-staging-00070-serving","percent":100}]}}\n'
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

# ── BUG-2026-08-22-001: the tag namespace is wider than `pr-<N>` ──────────────
#
# Eight retired-but-tagged revisions on arkova-worker-staging were holding warm
# instances running in-process node-cron against the LIVE rig. This janitor is
# the tool that should have prevented that, but its matcher was `^pr-[0-9]+$`,
# so two of those eight — `train-c-ce` and `train-c-1154-cfaee18e` — were
# invisible to it. A namespace-limited janitor reads as "cleanup is handled".
#
# Non-`pr-` tags have no PR to ask about, so they age out on the REVISION's
# creationTimestamp instead. And no tag is ever pulled off a revision that is
# actually serving traffic, whatever its age.

out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" \
      STAGING_JANITOR_NOW_EPOCH=1778760000 GITHUB_REPOSITORY=carson-see/ArkovaCarson \
      $JANITOR 2>&1); rc=$?
assert_exit  "janitor still succeeds with mixed tag namespaces" 0 "$rc"
assert_match "old non-pr soak tag selected" "would remove tag train-c-ce" "$out"
assert_no_match "recent non-pr soak tag retained" "remove tag train-c-recent" "$out"
assert_no_match "serving revision's tag never removed" "remove tag train-migration-t3" "$out"
assert_match "pr-* behaviour unchanged alongside" "would remove tag pr-742" "$out"
assert_no_match "open PR tag still retained" "remove tag pr-999" "$out"

# The auth guard is load-bearing: this janitor mutates a shared Cloud Run
# service. Prove it still refuses a local interactive account — otherwise the
# fake above would be silently disabling the very guard it stands in for.
out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" \
      STAGING_FAKE_GCLOUD_ACCOUNT="carson@arkova.io" \
      STAGING_JANITOR_NOW_EPOCH=1778760000 GITHUB_REPOSITORY=carson-see/ArkovaCarson \
      $JANITOR 2>&1); rc=$?
assert_exit  "janitor refuses a local interactive account" 2 "$rc"
assert_match "refusal names the enterprise-identity requirement" "requires enterprise GCP identity" "$out"
assert_no_match "refusal removes nothing" "would remove tag" "$out"

echo ""
echo "─── summary ─────────────────────────────────────────────────"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
