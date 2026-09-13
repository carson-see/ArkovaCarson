#!/usr/bin/env bash
# run-5024-rls-suite.sh — SCRUM-5024 referral-attribution RLS suite runner.
#
# Runs the LIVE-DB RLS suite backing PR #2905 (migrations 0455/0456) against a
# staging rig. This is a standalone vitest runner, NOT a probes/*.mjs module —
# train-cycle.mjs does not discover it, and this delivery does not invoke it.
#
# Usage:
#   ./run-5024-rls-suite.sh <branch-checkout-dir> <output-path>
#
#   <branch-checkout-dir>  A git checkout of the branch/PR head under soak
#                          (e.g. feat/scrum-5024-partner-referral-attribution).
#                          The suite file, its helpers and vitest.config.rls.ts
#                          all live THERE, not in this driver's own tree.
#   <output-path>          Where results land. A path ending .xml gets the
#                          vitest junit reporter; anything else gets the
#                          default reporter's plain text via `tee`.
#
# TEST FILE LOCATION — CORRECTED FROM THE ORIGINAL BRIEF. The brief pointed at
# `src/tests/rls`; the live-DB suite is NOT there. It is
# `tests/rls/referral-attribution.test.ts` (confirmed with
# `git grep -l referral <branch> -- tests/rls src/tests/rls`), and it imports
# its client helpers from `../../src/tests/rls/helpers` — that directory holds
# the SHARED helper module other RLS suites also use, not this suite itself.
# There is a second, narrower live-DB file worth running alongside it:
# `src/tests/scrum5024-referral-rpc-tenant-authority.test.ts`, which is scoped
# to the 0456 authority fix specifically. Both are run below; this script
# refuses to start if either is missing from the checkout, rather than
# silently reporting on whichever one happened to exist.
#
# ENVIRONMENT — names reused from ../common.mjs and ../setup.mjs so this
# composes with secrets the rest of this driver already has, then remapped to
# the names `src/tests/rls/helpers.ts` itself requires (`requireEnv`):
#   TRAIN_RIG_REF                       rig project ref (default: common.mjs's)
#   STAGING_SUPABASE_ANON_KEY           -> SUPABASE_ANON_KEY
#   STAGING_SUPABASE_SERVICE_ROLE_KEY   -> SUPABASE_SERVICE_ROLE_KEY
#   RLS_TEST_PASSWORD                   REQUIRED. NOT derived from anything
#     this driver seeds — `src/tests/rls/helpers.ts`'s DEMO_CREDENTIALS are
#     `supabase/seed.sql`'s FIXED demo accounts (carson@arkova.ai / betaCorp /
#     ORG_IDS.arkova, ORG_IDS.betaCorp), which are a DIFFERENT fixture set from
#     this driver's own `cto-train-b-0912-*` orgs (see probes/2905-referrals.mjs).
#     This suite is therefore only meaningful against a rig that actually has
#     `supabase/seed.sql` applied — true of an isolated rig provisioned by
#     `scripts/staging/provision-isolated-rig.sh` (its "seeds the baseline
#     fixture" step), NOT necessarily true of the standing rig. Verify the
#     seed is present (e.g. `organizations` row for ORG_IDS.arkova exists)
#     before trusting a red from this script as a real regression.
#
# PROD GUARD: refuses unconditionally if the resolved rig ref/URL names the
# prod project (vzwyaatejekddvltxyye). No override flag exists on purpose.

set -euo pipefail

PROD_REF="vzwyaatejekddvltxyye"

CHECKOUT_DIR="${1:-}"
OUTPUT_PATH="${2:-}"

if [[ -z "$CHECKOUT_DIR" || -z "$OUTPUT_PATH" ]]; then
  echo "usage: $0 <branch-checkout-dir> <output-path>" >&2
  exit 2
fi

if [[ ! -d "$CHECKOUT_DIR" ]]; then
  echo "refusing: checkout dir does not exist: $CHECKOUT_DIR" >&2
  exit 2
fi

RIG_REF="${TRAIN_RIG_REF:-xhvasifpunswhsgfsstd}"
if [[ "$RIG_REF" == "$PROD_REF" ]]; then
  echo "REFUSING: TRAIN_RIG_REF ($RIG_REF) is the PROD Supabase project ref. This script never runs against prod." >&2
  exit 1
fi

RESOLVED_SUPABASE_URL="${SUPABASE_URL:-https://${RIG_REF}.supabase.co}"
if [[ "$RESOLVED_SUPABASE_URL" == *"$PROD_REF"* ]]; then
  echo "REFUSING: resolved SUPABASE_URL ($RESOLVED_SUPABASE_URL) names the PROD ref. Aborting." >&2
  exit 1
fi

: "${STAGING_SUPABASE_ANON_KEY:?STAGING_SUPABASE_ANON_KEY required (see ../common.mjs)}"
: "${STAGING_SUPABASE_SERVICE_ROLE_KEY:?STAGING_SUPABASE_SERVICE_ROLE_KEY required (see ../common.mjs)}"
: "${RLS_TEST_PASSWORD:?RLS_TEST_PASSWORD required -- must match the TARGET RIG's supabase/seed.sql demo password, NOT this driver's own fixture password (state.password in state/fixtures.json)}"

export SUPABASE_URL="$RESOLVED_SUPABASE_URL"
export SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$STAGING_SUPABASE_SERVICE_ROLE_KEY"
export RLS_TEST_PASSWORD

SUITE_FILES=(
  "tests/rls/referral-attribution.test.ts"
  "src/tests/scrum5024-referral-rpc-tenant-authority.test.ts"
)

pushd "$CHECKOUT_DIR" >/dev/null

MISSING=0
for f in "${SUITE_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "refusing: expected suite file not found in checkout: $f" >&2
    MISSING=1
  fi
done
if [[ ! -f "vitest.config.rls.ts" ]]; then
  echo "refusing: vitest.config.rls.ts not found at checkout root — is this really the SCRUM-5024 branch?" >&2
  MISSING=1
fi
if [[ "$MISSING" -eq 1 ]]; then
  popd >/dev/null
  exit 2
fi

echo "[run-5024-rls-suite] target: $SUPABASE_URL (rig ref: $RIG_REF)"
echo "[run-5024-rls-suite] checkout: $CHECKOUT_DIR ($(git rev-parse --short HEAD 2>/dev/null || echo 'unknown HEAD'))"
echo "[run-5024-rls-suite] suite files: ${SUITE_FILES[*]}"
echo "[run-5024-rls-suite] output: $OUTPUT_PATH"

VITEST_ARGS=(run --config vitest.config.rls.ts "${SUITE_FILES[@]}")

set +e
if [[ "$OUTPUT_PATH" == *.xml ]]; then
  npx vitest "${VITEST_ARGS[@]}" --reporter=junit --outputFile="$OUTPUT_PATH"
  EXIT_CODE=$?
else
  npx vitest "${VITEST_ARGS[@]}" 2>&1 | tee "$OUTPUT_PATH"
  EXIT_CODE=${PIPESTATUS[0]}
fi
set -e

popd >/dev/null

echo "[run-5024-rls-suite] vitest exit code: $EXIT_CODE"
exit "$EXIT_CODE"
