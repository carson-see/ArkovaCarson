#!/usr/bin/env bash
# scripts/staging/deploy.test.sh — local smoke tests for deploy.sh.
#
# These run pure-bash tests of arg parsing + the lease-check branch.
# They do NOT actually call gcloud or write to Supabase. The dry-run
# path stops before any side-effect commands.
#
# Usage:
#   ./scripts/staging/deploy.test.sh
#
# Exit code 0 if all assertions pass, non-zero on first failure.

set -uo pipefail

DEPLOY=./scripts/staging/deploy.sh
PASS=0
FAIL=0

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $label  exit=$actual"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label  exit=$actual  (expected $expected)"
    FAIL=$((FAIL + 1))
  fi
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
}

run() {
  # Run deploy.sh, capture combined stdout+stderr and exit code.
  out=$(STAGING_SUPABASE_URL=https://invalid.example \
        STAGING_SUPABASE_SERVICE_ROLE_KEY=invalid \
        "$@" 2>&1)
  echo "$out"
  return $?
}

echo "─── arg validation ─────────────────────────────────────────"

out=$($DEPLOY 2>&1); rc=$?
assert_exit  "no args"                      2 "$rc"
assert_match "no args complains about --pr" "ERROR: --pr is required" "$out"

out=$($DEPLOY --image foo 2>&1); rc=$?
assert_exit  "missing --pr"                 2 "$rc"

out=$($DEPLOY --pr 742 2>&1); rc=$?
assert_exit  "missing --image"              2 "$rc"

out=$(STAGING_SUPABASE_URL=x STAGING_SUPABASE_SERVICE_ROLE_KEY=x \
      $DEPLOY --pr abc --image foo 2>&1); rc=$?
assert_exit  "non-numeric --pr"             2 "$rc"
assert_match "rejects non-numeric --pr"     "must be a numeric PR number" "$out"

out=$(STAGING_SUPABASE_URL=x STAGING_SUPABASE_SERVICE_ROLE_KEY=x \
      $DEPLOY --pr 742 --image foo --force "" 2>&1); rc=$?
assert_exit  "--force without reason"       2 "$rc"
assert_match "rejects empty --force reason" "non-empty reason" "$out"

out=$($DEPLOY --pr 742 --image foo --bogus 2>&1); rc=$?
assert_exit  "unknown flag"                 2 "$rc"

echo ""
echo "─── prod-service guard (CRITICAL) ──────────────────────────"

# This is the safety net that makes 'this script can't reach prod'. If it
# regresses, the test fails. STAGING_CLOUD_RUN_SERVICE='arkova-worker' (prod)
# must be REJECTED before any other arg parsing.
out=$(STAGING_CLOUD_RUN_SERVICE=arkova-worker $DEPLOY --pr 742 --image foo 2>&1); rc=$?
assert_exit  "prod service name rejected"   2 "$rc"
assert_match "prod-service guard error"     "does not end in '-staging'" "$out"

out=$(STAGING_CLOUD_RUN_SERVICE=arkova-worker-staging \
      STAGING_SUPABASE_URL=https://invalid.example \
      STAGING_SUPABASE_SERVICE_ROLE_KEY=invalid \
      $DEPLOY --pr 99999 --image foo --dry-run 2>&1); rc=$?
# This will fail the lease check (HTTP error from invalid host). Expect
# either exit=1 (lease lookup failed → no lease found → exit 1) or any
# non-zero exit before reaching gcloud.
if [ "$rc" -ne 0 ]; then
  echo "  PASS  staging service name accepted past guard (lease check then errors as expected, rc=$rc)"
  PASS=$((PASS + 1))
else
  echo "  FAIL  staging service should have failed lease check, got rc=$rc"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "─── lease check (live staging Supabase, requires creds) ────"

if [ -n "${SKIP_LIVE_TESTS:-}" ]; then
  echo "  SKIP  live lease-check tests (SKIP_LIVE_TESTS set)"
elif ! command -v gcloud >/dev/null 2>&1; then
  echo "  SKIP  no gcloud installed"
else
  STAGING_URL=$(gcloud secrets versions access latest --secret=supabase-url-staging --project=arkova1 2>/dev/null || true)
  STAGING_KEY=$(gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1 2>/dev/null || true)
  if [ -z "$STAGING_URL" ] || [ -z "$STAGING_KEY" ]; then
    echo "  SKIP  staging secrets not readable (run gcloud auth)"
  else
    # PR 99999 has no lease — must exit 1 with the lease error.
    out=$(STAGING_SUPABASE_URL="$STAGING_URL" STAGING_SUPABASE_SERVICE_ROLE_KEY="$STAGING_KEY" \
          $DEPLOY --pr 99999 --image us-central1-docker.pkg.dev/foo/bar:baz --dry-run 2>&1); rc=$?
    assert_exit  "no-lease blocks deploy"       1 "$rc"
    assert_match "no-lease error message"       "no staging_lease row for PR #99999" "$out"

    # --force "<reason>" overrides the lease check, dry-run halts before gcloud
    out=$(STAGING_SUPABASE_URL="$STAGING_URL" STAGING_SUPABASE_SERVICE_ROLE_KEY="$STAGING_KEY" \
          $DEPLOY --pr 99999 --image us-central1-docker.pkg.dev/foo/bar:baz \
                  --force "smoke test" --dry-run 2>&1); rc=$?
    assert_exit  "--force bypasses lease (dry-run)" 0 "$rc"
    assert_match "--force prints WARN"              "deploying WITHOUT lease" "$out"
  fi
fi

echo ""
echo "─── summary ─────────────────────────────────────────────────"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[ "$FAIL" -eq 0 ] || exit 1
exit 0
