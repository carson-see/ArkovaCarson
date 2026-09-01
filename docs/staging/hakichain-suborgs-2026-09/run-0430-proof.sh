#!/usr/bin/env bash
# Rebuilds a throwaway DB, applies 0429+0430, runs the 0430 behaviour proof.
set -euo pipefail
export LC_ALL=C LANG=C PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres
PSQL=/opt/homebrew/bin/psql
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGDIR="${1:?usage: run-0430-proof.sh <supabase/migrations dir>}"
"$PSQL" -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ark0430;" -c "CREATE DATABASE ark0430;"
"$PSQL" -d ark0430 -v ON_ERROR_STOP=1 -q -f "$HERE/fixture-0429.sql"
"$PSQL" -d ark0430 -v ON_ERROR_STOP=1 -q -f "$HERE/fixture-0430.sql"
"$PSQL" -d ark0430 -v ON_ERROR_STOP=1 -q -f "$MIGDIR/0429_suborg_tenancy_foundations.sql"
"$PSQL" -d ark0430 -v ON_ERROR_STOP=1 -q -f "$MIGDIR/0430_suborg_credit_rpc_caller_identity.sql"
"$PSQL" -d ark0430 -v ON_ERROR_STOP=1 -f "$HERE/verify-0430.sql"
