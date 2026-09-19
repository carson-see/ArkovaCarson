#!/usr/bin/env bash
set -euo pipefail

# Native two-session regression for migration 0467. The caller owns a
# disposable PostgreSQL database with migrations applied and supplies an
# existing fixture organization. No hosted database is a valid target.
: "${DATABASE_URL:?disposable PostgreSQL DATABASE_URL required}"
: "${TEST_ORG_ID:?existing disposable fixture organization UUID required}"
test_now="${TEST_NOW:-2026-09-19T13:00:00Z}"
root_dir="$(cd "$(dirname "$0")/../../.." && pwd)"
assert_sql="$root_dir/services/worker/src/ai/ai-credit-concurrency.native.test.sql"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.ai_credits WHERE org_id = '$TEST_ORG_ID'::uuid;"

provision="BEGIN; SELECT pg_sleep(0.5); SELECT public.ensure_ai_credits_period('$TEST_ORG_ID'::uuid,1,'$test_now'::timestamptz); COMMIT;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$provision" >"$tmp_dir/provision-a" & a=$!
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$provision" >"$tmp_dir/provision-b" & b=$!
wait "$a"; wait "$b"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v test_org_id="$TEST_ORG_ID" \
  -v test_now="$test_now" -v expect_debit=false -f "$assert_sql" >/dev/null

debit="BEGIN; SELECT pg_sleep(0.5); SELECT public.deduct_ai_credits('$TEST_ORG_ID'::uuid,NULL,1); COMMIT;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$debit" >"$tmp_dir/debit-a" & a=$!
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$debit" >"$tmp_dir/debit-b" & b=$!
wait "$a"; wait "$b"
test "$(cat "$tmp_dir/debit-a" "$tmp_dir/debit-b" | grep -c '^t$')" -eq 1
test "$(cat "$tmp_dir/debit-a" "$tmp_dir/debit-b" | grep -c '^f$')" -eq 1
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v test_org_id="$TEST_ORG_ID" \
  -v test_now="$test_now" -v expect_debit=true -f "$assert_sql" >/dev/null
