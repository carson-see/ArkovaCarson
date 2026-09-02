#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres
PSQL=/opt/homebrew/bin/psql
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGDIR="${1:?usage: run-0431-proof.sh <supabase/migrations dir>}"
"$PSQL" -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ark0431;" -c "CREATE DATABASE ark0431;"
for f in fixture-0429.sql fixture-0430.sql fixture-0431.sql; do
  "$PSQL" -d ark0431 -v ON_ERROR_STOP=1 -q -f "$HERE/$f"
done
for m in 0429_suborg_tenancy_foundations 0430_suborg_credit_rpc_caller_identity 0431_suborg_suspension_audit_fix_and_caller_identity 0432_suborg_rpc_role_enum_coercion_fix; do
  "$PSQL" -d ark0431 -v ON_ERROR_STOP=1 -q -f "$MIGDIR/$m.sql"
done
"$PSQL" -d ark0431 -v ON_ERROR_STOP=1 -f "$HERE/verify-0431.sql"
