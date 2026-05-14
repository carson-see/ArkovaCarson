#!/usr/bin/env bash
# scripts/staging/rotate-deploy-iam.test.sh — local smoke tests for IAM rotation.

set -uo pipefail

SCRIPT=./scripts/staging/rotate-deploy-iam.sh
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
  return 0
}

assert_match() {
  local label="$1" pattern="$2" output="$3"
  if echo "$output" | grep -qE -- "$pattern"; then
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
  if echo "$output" | grep -qE -- "$pattern"; then
    echo "  FAIL  $label  unexpectedly matched /$pattern/"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS  $label  no match /$pattern/"
    PASS=$((PASS + 1))
  fi
  return 0
}

echo "─── deploy-only IAM rotation ───────────────────────────────"

out=$($SCRIPT 2>&1); rc=$?
assert_exit  "default dry-run succeeds" 0 "$rc"
assert_match "dry-run creates deploy SA" "service-accounts create arkova-staging-deployer" "$out"
assert_match "dry-run grants run developer" "add-iam-policy-binding arkova1.*roles/run.developer" "$out"
assert_match "run developer is service-scoped" "--condition=.*arkova_staging_deploy_only.*arkova-worker-staging" "$out"
assert_match "dry-run revokes compute run developer" "remove-iam-policy-binding arkova1.*270018525501-compute@developer.gserviceaccount.com.*roles/run.developer" "$out"
assert_match "dry-run prints rollback" "--rollback --apply --confirm SCRUM-1821" "$out"
assert_no_match "dry-run does not execute gcloud" "^executing:" "$out"

out=$($SCRIPT --apply 2>&1); rc=$?
assert_exit  "apply requires confirm token" 2 "$rc"
assert_match "apply confirm error" "--confirm SCRUM-1821" "$out"

out=$($SCRIPT --apply --confirm SCRUM-1821 --service arkova-worker-staging-preview 2>&1); rc=$?
assert_exit  "apply rejects non-approved service" 2 "$rc"
assert_match "apply service guard error" "only supports service 'arkova-worker-staging'" "$out"

out=$($SCRIPT --apply --confirm SCRUM-1821 --project test-project 2>&1); rc=$?
assert_exit  "apply rejects non-approved project" 2 "$rc"
assert_match "apply project guard error" "only supports project 'arkova1'" "$out"

out=$(STAGING_DEPLOY_CONDITION_EXPR='resource.name.startsWith("projects/arkova1")' \
      $SCRIPT --apply --confirm SCRUM-1821 2>&1); rc=$?
assert_exit  "apply rejects condition override" 2 "$rc"
assert_match "apply condition override error" "may not override the staging service condition" "$out"

out=$($SCRIPT --rollback 2>&1); rc=$?
assert_exit  "rollback dry-run succeeds" 0 "$rc"
assert_match "rollback re-grants compute" "add-iam-policy-binding arkova1.*270018525501-compute@developer.gserviceaccount.com.*roles/run.developer" "$out"
assert_match "rollback removes deploy SA role" "remove-iam-policy-binding arkova1.*arkova-staging-deployer@arkova1.iam.gserviceaccount.com.*roles/run.developer" "$out"
assert_match "rollback removes conditioned role" "--condition=.*arkova_staging_deploy_only" "$out"

out=$($SCRIPT --rollback --service arkova-worker-staging-preview 2>&1); rc=$?
assert_exit  "rollback rejects non-approved service" 2 "$rc"
assert_match "rollback service guard error" "only supports service 'arkova-worker-staging'" "$out"

out=$($SCRIPT --rollback --project test-project 2>&1); rc=$?
assert_exit  "rollback rejects non-approved project" 2 "$rc"
assert_match "rollback project guard error" "only supports project 'arkova1'" "$out"

out=$($SCRIPT --project test-project --region europe-west1 --service arkova-worker-staging-preview --deploy-sa-id custom-deployer 2>&1); rc=$?
assert_exit  "custom project dry-run succeeds" 0 "$rc"
assert_match "custom deploy SA recomputed after args" "custom-deployer@test-project.iam.gserviceaccount.com" "$out"
assert_match "custom condition uses project region service" "projects/test-project/locations/europe-west1/services/arkova-worker-staging-preview" "$out"

echo ""
echo "─── summary ─────────────────────────────────────────────────"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
