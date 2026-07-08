#!/usr/bin/env bash
# scripts/staging/provision-isolated-rig.test.sh - local dry-run contract tests.
#
# These tests run the provisioner in its default dry-run mode only. They do not
# call Supabase, gcloud, or mutate any staging/live resources.

set -uo pipefail

PROVISION=./scripts/staging/provision-isolated-rig.sh
PASS=0
FAIL=0

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

assert_json_contract() {
  local label="$1" json="$2"
  if ADMISSION_JSON="$json" node <<'EOF'
const assert = require('node:assert/strict');

const payload = JSON.parse(process.env.ADMISSION_JSON);
const required = [
  'sha',
  'base_sha',
  'image_digest',
  'tag_url',
  'supabase_project_ref',
  'preflight_result',
  'harness_version',
  'tool_version',
  'owner',
  'stop_conditions',
];

for (const field of required) {
  assert.ok(Object.hasOwn(payload, field), `missing ${field}`);
  assert.notEqual(payload[field], '', `${field} must not be empty`);
}

assert.equal(payload.sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
assert.equal(payload.base_sha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
assert.equal(payload.image_digest, 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
assert.equal(payload.tag_url, 'https://lane-a---arkova-worker-s0e4-lane-a-staging.example.run.app');
assert.equal(payload.supabase_project_ref, 'sveujcebzkqxbhimotbb');
assert.equal(payload.preflight_result, 'environment_type=clean_mirror');
assert.equal(payload.harness_version, 'scripts/staging/load-harness.ts@aaaaaaaaaaaa');
assert.equal(payload.tool_version, 'scripts/staging/provision-isolated-rig.sh@aaaaaaaaaaaa');
assert.match(payload.owner, /^rig-owner@/);
assert.ok(Array.isArray(payload.stop_conditions), 'stop_conditions must be an array');
assert.ok(payload.stop_conditions.length >= 3, 'stop_conditions must be actionable');
assert.ok(payload.stop_conditions.some((condition) => /SHA mismatch/i.test(condition)));
assert.ok(payload.stop_conditions.some((condition) => /dirty preflight/i.test(condition)));
EOF
  then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        json: $json"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- admission JSON dry-run contract ------------------------"

out=$(
  GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  BASE_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  STAGING_IMAGE_DIGEST=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  STAGING_RIG_TAG_URL=https://lane-a---arkova-worker-s0e4-lane-a-staging.example.run.app \
  ADMISSION_SUPABASE_PROJECT_REF=sveujcebzkqxbhimotbb \
  STAGING_PREFLIGHT_RESULT=environment_type=clean_mirror \
  USER=rig-owner \
  "$PROVISION" --name s0e4-lane-a 2>&1
)
rc=$?
assert_exit "dry-run provision succeeds" 0 "$rc"

json=$(printf '%s\n' "$out" | sed -n 's/^ADMISSION_JSON=//p' | tail -1)
if [[ -n "$json" ]]; then
  echo "  PASS  admission JSON line emitted"
  PASS=$((PASS + 1))
else
  echo "  FAIL  admission JSON line emitted"
  echo "        output: $out"
  FAIL=$((FAIL + 1))
fi

if [[ -n "$json" ]]; then
  assert_json_contract "admission JSON has required rig evidence fields" "$json"
fi

if printf '%s\n' "$out" | grep -q '^executing:'; then
  echo "  FAIL  dry-run did not execute side-effect commands"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  dry-run did not execute side-effect commands"
  PASS=$((PASS + 1))
fi

echo ""
echo "--- summary -------------------------------------------------"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
