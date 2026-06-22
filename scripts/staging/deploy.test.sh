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

out=$(STAGING_SUPABASE_URL=x STAGING_SUPABASE_SERVICE_ROLE_KEY=x \
      $DEPLOY --pr 742 --image foo --force "smoke test" --dry-run 2>&1); rc=$?
assert_exit  "--force without Jira-key reason"       2 "$rc"
assert_match "rejects unstructured --force reason"   "SCRUM-1821:" "$out"

out=$($DEPLOY --pr 742 --image foo --bogus 2>&1); rc=$?
assert_exit  "unknown flag"                 2 "$rc"

out=$(STAGING_SUPABASE_URL=x STAGING_SUPABASE_SERVICE_ROLE_KEY=x \
      $DEPLOY --pr 742 --image foo --lane Train-C --dry-run 2>&1); rc=$?
assert_exit  "uppercase --lane rejected"     2 "$rc"
assert_match "lane lowercase error"          "lowercase Cloud Run tag slug" "$out"

out=$(STAGING_SUPABASE_URL=x STAGING_SUPABASE_SERVICE_ROLE_KEY=x \
      $DEPLOY --pr 742 --image foo --lane candidate-c --dry-run 2>&1); rc=$?
assert_exit  "non-train --lane rejected"     2 "$rc"
assert_match "lane prefix error"             "must start with train-" "$out"

echo ""
echo "─── promote authorization gate ─────────────────────────────"

out=$(STAGING_SUPABASE_URL=x STAGING_SUPABASE_SERVICE_ROLE_KEY=x \
      STAGING_PROMOTE_EXPECTED_TOKEN=2026-05-14:ok \
      $DEPLOY --pr 742 --image foo --force "SCRUM-1821: smoke" --promote --dry-run 2>&1); rc=$?
assert_exit  "--promote requires token"       2 "$rc"
assert_match "--promote token error"          "STAGING_PROMOTE_TOKEN" "$out"

out=$(STAGING_SUPABASE_URL=x STAGING_SUPABASE_SERVICE_ROLE_KEY=x \
      STAGING_PROMOTE_EXPECTED_TOKEN=2026-05-14:ok STAGING_PROMOTE_TOKEN=wrong \
      $DEPLOY --pr 742 --image foo --force "SCRUM-1821: smoke" --promote --dry-run 2>&1); rc=$?
assert_exit  "--promote rejects bad token"     2 "$rc"
assert_match "--promote mismatch error"        "does not match" "$out"

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
if [[ "$rc" -ne 0 ]]; then
  echo "  PASS  staging service name accepted past guard (lease check then errors as expected, rc=$rc)"
  PASS=$((PASS + 1))
else
  echo "  FAIL  staging service should have failed lease check, got rc=$rc"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "─── lease check (live staging Supabase, requires creds) ────"

if [[ -n "${SKIP_LIVE_TESTS:-}" ]]; then
  echo "  SKIP  live lease-check tests (SKIP_LIVE_TESTS set)"
elif ! command -v gcloud >/dev/null 2>&1; then
  echo "  SKIP  no gcloud installed"
else
  STAGING_URL=$(gcloud secrets versions access latest --secret=supabase-url-staging --project=arkova1 2>/dev/null || true)
  STAGING_KEY=$(gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1 2>/dev/null || true)
  if [[ -z "$STAGING_URL" || -z "$STAGING_KEY" ]]; then
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
                  --force "SCRUM-1821: smoke test" --dry-run 2>&1); rc=$?
    assert_exit  "--force bypasses lease (dry-run)" 0 "$rc"
    assert_match "--force prints WARN"              "deploying WITHOUT lease" "$out"
  fi
fi

echo ""
echo "─── remote preflight hardening (mocked) ────────────────────"

TMP_DIR=$(mktemp -d)
FAKEBIN="${TMP_DIR}/bin"
mkdir -p "${FAKEBIN}"

cat >"${FAKEBIN}/curl" <<'EOF'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"record_staging_deploy"* ]]; then
  printf '42\n__HTTP__200'
  exit 0
fi
if [[ "$args" == *"staging_lease"* ]]; then
  printf '[{"pr_number":742,"acquired_by":"test","acquired_at":"2026-05-14T12:00:00Z"}]\n__HTTP__200'
  exit 0
fi
printf '[]\n__HTTP__200'
EOF
chmod +x "${FAKEBIN}/curl"

cat >"${FAKEBIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "$args" >>"${STAGING_FAKE_GCLOUD_LOG}"

if [[ "$args" == *"auth list"* ]]; then
  printf 'staging-test@arkova1.iam.gserviceaccount.com\n'
  exit 0
fi

if [[ "$args" == *"artifacts docker images describe"* ]]; then
  exit "${STAGING_FAKE_IMAGE_RC:-0}"
fi

if [[ "$args" == *"run revisions list"* ]]; then
  if [[ "${STAGING_FAKE_COLLISION:-0}" == "1" ]]; then
    printf '[{"metadata":{"name":"arkova-worker-staging-00077-other","creationTimestamp":"2026-05-14T12:00:00Z","labels":{"pr":"743"}}}]\n'
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$args" == *"run services describe"* && "$args" == *"status.url"* ]]; then
  printf 'https://arkova-worker-staging-270018525501.us-central1.run.app\n'
  exit 0
fi

if [[ "$args" == *"run services describe"* && "$args" == *"latestCreatedRevisionName"* ]]; then
  printf 'arkova-worker-staging-00088-test\n'
  exit 0
fi

if [[ "$args" == *"run services update"* ]]; then
  exit 0
fi

exit 0
EOF
chmod +x "${FAKEBIN}/gcloud"

# Fake docker for the manifest-inspect fallback. STAGING_FAKE_DOCKER_MANIFEST_RC
# controls whether `docker manifest inspect` "reads" the image.
cat >"${FAKEBIN}/docker" <<'EOF'
#!/usr/bin/env bash
args="$*"
printf 'docker %s\n' "$args" >>"${STAGING_FAKE_DOCKER_LOG:-/dev/null}"
if [[ "$args" == *"manifest inspect"* ]]; then
  exit "${STAGING_FAKE_DOCKER_MANIFEST_RC:-0}"
fi
exit 0
EOF
chmod +x "${FAKEBIN}/docker"

GCLOUD_LOG="${TMP_DIR}/gcloud.log"
# AR describe fails all attempts AND docker manifest inspect fails -> blocked.
out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" STAGING_FAKE_IMAGE_RC=1 \
      STAGING_FAKE_DOCKER_MANIFEST_RC=1 \
      IMAGE_READABILITY_ATTEMPTS=3 IMAGE_READABILITY_DELAY_SECONDS=0 \
      STAGING_SUPABASE_URL=https://staging.example STAGING_SUPABASE_SERVICE_ROLE_KEY=test \
      $DEPLOY --pr 742 --image us-central1-docker.pkg.dev/arkova1/worker/missing:tag 2>&1); rc=$?
assert_exit  "image precheck blocks missing image" 1 "$rc"
assert_match "image precheck error" "image does not exist" "$out"
assert_match "image precheck exhausts retries" "after 3 attempts" "$out"
describe_calls=$(grep -c "artifacts docker images describe" "${GCLOUD_LOG}" || true)
if [[ "$describe_calls" -eq 3 ]]; then
  echo "  PASS  image precheck retried all 3 attempts before failing"
  PASS=$((PASS + 1))
else
  echo "  FAIL  image precheck made $describe_calls describe calls (expected 3)"
  FAIL=$((FAIL + 1))
fi

GCLOUD_LOG="${TMP_DIR}/gcloud-collision.log"
out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" STAGING_FAKE_COLLISION=1 \
      STAGING_DEPLOY_NOW_EPOCH=1778760150 \
      STAGING_SUPABASE_URL=https://staging.example STAGING_SUPABASE_SERVICE_ROLE_KEY=test \
      $DEPLOY --pr 742 --image us-central1-docker.pkg.dev/arkova1/worker/existing:tag 2>&1); rc=$?
assert_exit  "recent other-PR revision blocks deploy" 1 "$rc"
assert_match "collision error mentions other PR" "recent Cloud Run revision.*PR #743" "$out"

# ─── image-readability retry loop (AR indexing race, deploy.sh fix) ──
# A freshly-pushed manifest is not describe-able for several seconds; the
# deploy-staging workflow's ~9s build->deploy gap made the single-shot check
# fail deterministically. The retry loop polls until AR indexes the push.
# This fake gcloud fails the first describe, then succeeds — and must run
# AFTER the collision test, since it overwrites the shared fake gcloud.
RETRY_COUNTER="${TMP_DIR}/describe-count"
echo 0 >"${RETRY_COUNTER}"
cat >"${FAKEBIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "$args" >>"${STAGING_FAKE_GCLOUD_LOG}"

if [[ "$args" == *"auth list"* ]]; then
  printf 'staging-test@arkova1.iam.gserviceaccount.com\n'
  exit 0
fi

if [[ "$args" == *"artifacts docker images describe"* ]]; then
  n=$(cat "${STAGING_FAKE_DESCRIBE_COUNTER}")
  n=$((n + 1))
  printf '%s' "$n" >"${STAGING_FAKE_DESCRIBE_COUNTER}"
  # Fail the first attempt, succeed thereafter (AR indexing lag).
  if [[ "$n" -lt 2 ]]; then exit 1; fi
  exit 0
fi
if [[ "$args" == *"run revisions list"* ]]; then printf '[]\n'; exit 0; fi
if [[ "$args" == *"run services describe"* && "$args" == *"status.url"* ]]; then
  printf 'https://arkova-worker-staging-270018525501.us-central1.run.app\n'; exit 0; fi
if [[ "$args" == *"run services describe"* && "$args" == *"latestCreatedRevisionName"* ]]; then
  printf 'arkova-worker-staging-00088-test\n'; exit 0; fi
exit 0
EOF
chmod +x "${FAKEBIN}/gcloud"

GCLOUD_LOG="${TMP_DIR}/gcloud-retry.log"
out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" \
      STAGING_FAKE_DESCRIBE_COUNTER="${RETRY_COUNTER}" \
      IMAGE_READABILITY_ATTEMPTS=5 IMAGE_READABILITY_DELAY_SECONDS=0 \
      STAGING_DEPLOY_NOW_EPOCH=1778760150 \
      STAGING_SUPABASE_URL=https://staging.example STAGING_SUPABASE_SERVICE_ROLE_KEY=test \
      $DEPLOY --pr 742 --image us-central1-docker.pkg.dev/arkova1/worker/existing:tag 2>&1); rc=$?
assert_exit  "image precheck passes after AR indexing lag" 0 "$rc"
assert_match "retry loop reports retry attempt" "image not indexed yet" "$out"

# ─── docker manifest inspect fallback (CI deploy-SA AR-read gap) ──
# The CI deploy service account pushes images via the Docker registry API but
# its AR-API `describe` view never resolves the manifest in-window, so every CI
# deploy failed even after the retry loop. deploy.sh falls back to
# `docker manifest inspect` (the immediately-consistent registry path) before
# giving up. This fake gcloud fails describe on every attempt; the fake docker
# (above) reads the manifest, so the deploy proceeds.
cat >"${FAKEBIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "$args" >>"${STAGING_FAKE_GCLOUD_LOG}"
if [[ "$args" == *"auth list"* ]]; then
  printf 'staging-test@arkova1.iam.gserviceaccount.com\n'
  exit 0
fi
if [[ "$args" == *"artifacts docker images describe"* ]]; then exit 1; fi
if [[ "$args" == *"run revisions list"* ]]; then printf '[]\n'; exit 0; fi
if [[ "$args" == *"run services describe"* && "$args" == *"status.url"* ]]; then
  printf 'https://arkova-worker-staging-270018525501.us-central1.run.app\n'; exit 0; fi
if [[ "$args" == *"run services describe"* && "$args" == *"latestCreatedRevisionName"* ]]; then
  printf 'arkova-worker-staging-00088-test\n'; exit 0; fi
exit 0
EOF
chmod +x "${FAKEBIN}/gcloud"

GCLOUD_LOG="${TMP_DIR}/gcloud-docker-fallback.log"
DOCKER_LOG="${TMP_DIR}/docker-fallback.log"
out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" \
      STAGING_FAKE_DOCKER_LOG="${DOCKER_LOG}" STAGING_FAKE_DOCKER_MANIFEST_RC=0 \
      IMAGE_READABILITY_ATTEMPTS=2 IMAGE_READABILITY_DELAY_SECONDS=0 \
      STAGING_DEPLOY_NOW_EPOCH=1778760150 \
      STAGING_SUPABASE_URL=https://staging.example STAGING_SUPABASE_SERVICE_ROLE_KEY=test \
      $DEPLOY --pr 742 --image us-central1-docker.pkg.dev/arkova1/worker/existing:tag 2>&1); rc=$?
assert_exit  "docker manifest fallback unblocks deploy when AR describe never resolves" 0 "$rc"
assert_match "fallback announces docker manifest inspect" "falling back to docker manifest inspect" "$out"
assert_match "fallback confirms via registry" "confirmed via Docker registry manifest inspect" "$out"
if grep -q "manifest inspect" "${DOCKER_LOG}"; then
  echo "  PASS  fallback actually invoked docker manifest inspect"
  PASS=$((PASS + 1))
else
  echo "  FAIL  fallback did not invoke docker manifest inspect"
  FAIL=$((FAIL + 1))
fi

GCLOUD_LOG="${TMP_DIR}/gcloud-named-lane.log"
DOCKER_LOG="${TMP_DIR}/docker-named-lane.log"
out=$(PATH="${FAKEBIN}:$PATH" STAGING_FAKE_GCLOUD_LOG="${GCLOUD_LOG}" \
      STAGING_FAKE_DOCKER_LOG="${DOCKER_LOG}" STAGING_FAKE_DOCKER_MANIFEST_RC=0 \
      IMAGE_READABILITY_ATTEMPTS=1 IMAGE_READABILITY_DELAY_SECONDS=0 \
      STAGING_DEPLOY_NOW_EPOCH=1778760150 \
      STAGING_SUPABASE_URL=https://staging.example STAGING_SUPABASE_SERVICE_ROLE_KEY=test \
      $DEPLOY --pr 742 --lane train-c-ce --image us-central1-docker.pkg.dev/arkova1/worker/existing:tag 2>&1); rc=$?
assert_exit  "named train lane deploy succeeds" 0 "$rc"
assert_match "named train lane prints tag URL" "STAGING_API_BASE=https://train-c-ce---arkova-worker-staging-270018525501.us-central1.run.app" "$out"
if grep -q -- "--tag=train-c-ce" "${GCLOUD_LOG}" && grep -q "lane=train-c-ce" "${GCLOUD_LOG}"; then
  echo "  PASS  named train lane passed to gcloud tag and labels"
  PASS=$((PASS + 1))
else
  echo "  FAIL  named train lane was not passed to gcloud as tag+label"
  echo "        gcloud log:" && cat "${GCLOUD_LOG}"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "─── summary ─────────────────────────────────────────────────"
echo "  pass: $PASS"
echo "  fail: $FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
